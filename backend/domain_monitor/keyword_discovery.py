"""Similar Domain Discovery.

Given a keyword, build a real candidate pool (deterministic name variations +
configured source matches), verify every candidate over RDAP or WHOIS, keep
only the interesting lifecycle states, score SEO opportunity and return the
nearest N. Nothing is ever reported as a result until a registry lookup has
confirmed it exists: no candidate is fabricated into a row to pad the table.
"""

from __future__ import annotations

import csv
import hashlib
import io
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import backlinks
import crawl4ai_source
import domain_monitor
import domain_sources
import enrichment
import history_client
import similar_domains
import source_config
import storage
from models import (
    CAT_30,
    CAT_60,
    CAT_EXPIRED,
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_SAFE,
    CAT_UNKNOWN,
    LOOKUP_NOT_FOUND,
    LOOKUP_OK,
    LOOKUP_UNSUPPORTED_TLD,
    DomainRecord,
    normalize_domain,
    registrable_name,
    tld_of,
)
from rdap_client import RdapClient, verification_source_of

logger = logging.getLogger(__name__)

SEARCH_MODES = ("similar", "exact", "contains")
DEFAULT_SEARCH_MODE = "similar"

# Kept for payloads written by the previous Keyword Discovery UI.
LEGACY_MATCH_TYPES = {"contains": "contains", "starts_with": "similar", "ends_with": "similar"}

EXPIRY_WINDOWS = (30, 60)
DEFAULT_EXPIRY_WINDOW = 60
DEFAULT_CACHE_HOURS = 12

INTERESTING_CATEGORIES = (
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_EXPIRED,
    CAT_30,
    CAT_60,
)

LIFECYCLE_FILTERS = {
    "all": INTERESTING_CATEGORIES,
    "pending_delete": (CAT_PENDING_DELETE,),
    "redemption": (CAT_REDEMPTION,),
    "expired": (CAT_EXPIRED,),
    "lte_30": (CAT_PENDING_DELETE, CAT_REDEMPTION, CAT_EXPIRED, CAT_30),
    "lte_60": INTERESTING_CATEGORIES,
    "low_spam": INTERESTING_CATEGORIES,
}

# Lifecycle urgency, 0-100. Feeds the ranking formula.
LIFECYCLE_SCORE = {
    CAT_PENDING_DELETE: 100,
    CAT_REDEMPTION: 90,
    CAT_EXPIRED: 80,
    CAT_30: 70,
    CAT_60: 50,
    CAT_SAFE: 0,
    CAT_UNKNOWN: 0,
}

LIFECYCLE_BUCKETS = {
    CAT_PENDING_DELETE: "pending_delete",
    CAT_REDEMPTION: "redemption",
    CAT_EXPIRED: "expired",
    CAT_30: "lte_30",
    CAT_60: "days_31_60",
    CAT_SAFE: "safe",
    CAT_UNKNOWN: "unknown",
}

SOURCE_LABELS = {
    "manual": "Manual Import",
    "zone": "Zone File",
    "feed": "External Feed",
    "crawl4ai": "Crawl4AI",
    "watchlist": "Watchlist",
    "demo": "Demo Fixture",
    "database": "Candidate Database",
    "generated": "Name Variations",
}

MAX_REJECTION_ROWS = 250


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


SEO_ENRICH_LIMIT = max(1, _env_int("SIMILAR_DOMAIN_SEO_ENRICH_LIMIT", 60))
CACHE_HOURS = max(1, _env_int("KEYWORD_DISCOVERY_CACHE_HOURS", DEFAULT_CACHE_HOURS))
MIN_SIMILARITY = max(0, min(100, _env_int("SIMILAR_DOMAIN_MIN_SIMILARITY", 55)))
# At or above this, and with the whole keyword present in the name, a
# candidate counts as a strict match. Anything else is a Broader Match and
# can only ever fill slots left over after the strict results.
STRICT_MIN_SIMILARITY = max(
    MIN_SIMILARITY, min(100, _env_int("SIMILAR_DOMAIN_STRICT_MIN_SIMILARITY", 70))
)

MATCH_LEVELS = ("exact", "strict", "broader")
MATCH_LEVEL_RANK = {"exact": 0, "strict": 1, "broader": 2}
MATCH_LEVEL_LABELS = {
    "exact": "Exact Match",
    "strict": "Strict Match",
    "broader": "Broader Match",
}

# Lifecycle buckets that represent a real, actionable opportunity. Anything
# else is reported in its own group rather than padding the main table.
ACTIONABLE_BUCKETS = ("pending_delete", "redemption", "expired", "lte_30", "days_31_60")

# Rejection reasons that describe a verification OUTCOME rather than a user
# filter choice. These become the Non-actionable Candidates group.
NON_ACTIONABLE_REASONS = {
    "safe_beyond_window": "Verified · Safe beyond the expiry window",
    "outside_expiry_window": "Verified · Outside the selected expiry window",
    "no_expiry_data": "Verified · No expiry date published",
    "lookup_failed": "Lookup failed",
    "unsupported_tld": "Unsupported TLD",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return storage.now_iso()


def _parse_iso(stamp: Optional[str]) -> Optional[datetime]:
    if not stamp:
        return None
    try:
        value = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def _debug(message: str, *args: Any) -> None:
    """Stage logging, on only when DOMAIN_RADAR_DEBUG is set. Never secrets."""
    if similar_domains.debug_enabled():
        logger.info("[domain-radar] " + message, *args)


def parse_query(raw: Any) -> similar_domains.ParsedQuery:
    """Parse a keyword, full domain, or URL. Digits are never stripped."""
    return similar_domains.parse_query(raw)


def normalize_keyword(raw: Any) -> str:
    """The second-level label to search on, with every character intact.

    Kept as a named helper because callers and tests use it, but it now goes
    through the full parser, so `saibo898.net` yields `saibo898` rather than
    being rejected as "not a domain fragment".
    """
    return parse_query(raw).keyword


def match_level_of(
    domain: str,
    keyword: str,
    similarity: int,
    exact_candidate: Optional[str],
) -> str:
    """exact / strict / broader for one candidate.

    A fuzzy match means characters of the keyword are missing or rearranged,
    so it is always Broader no matter how well it scores.
    """
    breakdown = similar_domains.similarity_breakdown(domain, keyword)
    if exact_candidate:
        # A TLD was entered, so only that one domain is the exact hit; the same
        # name on another TLD is a strict match, not an exact one.
        if domain == exact_candidate:
            return "exact"
    elif breakdown.match_kind == "exact":
        # Bare keyword: any TLD carrying exactly this name is an exact hit.
        return "exact"
    if breakdown.match_kind != "fuzzy" and similarity >= STRICT_MIN_SIMILARITY:
        return "strict"
    return "broader"


# --- request ----------------------------------------------------------------

@dataclass
class SimilarDomainRequest:
    keyword: str
    search_mode: str = DEFAULT_SEARCH_MODE
    expiry_window: int = DEFAULT_EXPIRY_WINDOW
    tld: Optional[str] = None
    limit: int = 30
    lifecycle_filter: str = "all"
    include_available: bool = False
    # The parsed input. `keyword` above is its second-level label and is the
    # only thing similarity is ever measured against.
    query: Optional[similar_domains.ParsedQuery] = None

    @property
    def raw_query(self) -> str:
        return self.query.raw_query if self.query else self.keyword

    @property
    def exact_candidate(self) -> Optional[str]:
        return self.query.exact_candidate if self.query else None

    @property
    def entered_tld(self) -> Optional[str]:
        return self.query.tld if self.query else None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "SimilarDomainRequest":
        parsed = parse_query(payload.get("keyword"))
        keyword = parsed.keyword

        raw_mode = str(payload.get("search_mode") or "").strip().lower()
        if not raw_mode:
            legacy = str(payload.get("match_type") or "").strip().lower()
            raw_mode = LEGACY_MATCH_TYPES.get(legacy, DEFAULT_SEARCH_MODE)
        if raw_mode not in SEARCH_MODES:
            raise ValueError("search_mode must be similar, exact, or contains")

        try:
            window = int(payload.get("expiry_window") or DEFAULT_EXPIRY_WINDOW)
        except (TypeError, ValueError):
            raise ValueError("expiry_window must be a number")
        # A stored search from the old UI could carry 90/180/365; clamp rather
        # than reject so recent-search chips keep working.
        window = 30 if window <= 30 else 60

        tld = None
        raw_tld = str(payload.get("tld") or "").strip().lower()
        if raw_tld and raw_tld != "any":
            tld = similar_domains.normalize_tld(raw_tld)
            if not tld:
                raise ValueError("tld must be a valid TLD like .com")

        result_limit = similar_domains.limits().result_limit
        try:
            limit = int(payload.get("limit") or result_limit)
        except (TypeError, ValueError):
            raise ValueError("limit must be a number")
        limit = max(1, min(limit, result_limit))

        lifecycle_filter = str(payload.get("lifecycle_filter") or "all").strip().lower()
        if lifecycle_filter not in LIFECYCLE_FILTERS:
            raise ValueError("lifecycle_filter is not supported")

        include_available = bool(
            payload.get("include_available", payload.get("include_safe", False))
        )

        return cls(
            keyword=keyword,
            search_mode=raw_mode,
            expiry_window=window,
            tld=tld,
            limit=limit,
            lifecycle_filter=lifecycle_filter,
            include_available=include_available,
            query=parsed,
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "keyword": self.keyword,
            "raw_query": self.raw_query,
            "entered_tld": self.entered_tld,
            "exact_candidate": self.exact_candidate,
            "search_mode": self.search_mode,
            "expiry_window": self.expiry_window,
            "tld": self.tld,
            "limit": self.limit,
            "lifecycle_filter": self.lifecycle_filter,
            "include_available": self.include_available,
        }

    def tld_list(self) -> tuple[str, ...]:
        """Expansion order: an explicit UI filter wins, then the entered TLD."""
        if self.tld:
            return (self.tld,)
        return similar_domains.ordered_tlds(
            similar_domains.configured_tlds(), self.entered_tld
        )

    @property
    def generates(self) -> bool:
        return self.search_mode in ("similar", "exact")


# Back-compat alias: server.py and older callers import this name.
KeywordDiscoveryRequest = SimilarDomainRequest


# --- ranking ----------------------------------------------------------------

def lifecycle_score(category: Optional[str]) -> int:
    return LIFECYCLE_SCORE.get(category or CAT_UNKNOWN, 0)


def final_rank_score(row: dict[str, Any]) -> float:
    """Transparent weighted score. Weights come from the environment."""
    weights = similar_domains.rank_weights()
    similarity = float(row.get("similarity_score") or 0)
    lifecycle = float(lifecycle_score(row.get("category")))
    seo = float(row.get("seo_score") or 0)
    total = (
        similarity * weights.similarity
        + lifecycle * weights.lifecycle
        + seo * weights.seo
    )
    return round(total, 2)


def _score_parts(row: dict[str, Any]) -> dict[str, Any]:
    weights = similar_domains.rank_weights()
    return {
        "similarity": {
            "value": int(row.get("similarity_score") or 0),
            "weight": round(weights.similarity, 4),
        },
        "lifecycle": {
            "value": lifecycle_score(row.get("category")),
            "weight": round(weights.lifecycle, 4),
        },
        "seo": {
            "value": int(row.get("seo_score") or 0),
            "weight": round(weights.seo, 4),
        },
    }


# --- state ------------------------------------------------------------------

def _empty_diagnostics() -> dict[str, Any]:
    return {
        "generated": 0,
        "source_matches": 0,
        "unique_candidates": 0,
        "skipped_over_cap": 0,
        "verify_attempted": 0,
        "rdap_verified": 0,
        "whois_verified": 0,
        "verified": 0,
        "cache_reused": 0,
        "lookup_failed": 0,
        "unsupported_tld": 0,
        "available_unregistered": 0,
        "no_expiry_data": 0,
        "safe_beyond_window": 0,
        "outside_expiry_window": 0,
        "below_similarity_floor": 0,
        "filtered_by_lifecycle": 0,
        "filtered_by_spam": 0,
        "eligible": 0,
        "seo_analyzed": 0,
        "level_exact": 0,
        "level_strict": 0,
        "level_broader": 0,
        "actionable": 0,
        "available": 0,
        "non_actionable": 0,
        "results": 0,
    }


class SimilarDomainState:
    """Live progress for one discovery run, polled by the dashboard."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = self._idle()

    @staticmethod
    def _idle() -> dict[str, Any]:
        return {
            "run_id": None,
            "status": "idle",
            "phase": "idle",
            "keyword": None,
            "filters": {},
            "message": None,
            "stage_label": None,
            "sources_total": 0,
            "sources_completed": 0,
            "generated": 0,
            "source_matches": 0,
            "unique_candidates": 0,
            "verify_total": 0,
            "verified": 0,
            "eligible": 0,
            "enriched": 0,
            "seo_total": 0,
            "result_count": 0,
            # Legacy field names the previous UI polled.
            "candidates_found": 0,
            "candidate_matches": 0,
            "results": [],
            "available_results": [],
            "available_count": 0,
            "non_actionable": [],
            "non_actionable_count": 0,
            "query": {},
            "strict_min_similarity": STRICT_MIN_SIMILARITY,
            "min_similarity": MIN_SIMILARITY,
            "history": [],
            "source_counts": {},
            "source_details": [],
            "diagnostics": _empty_diagnostics(),
            "rejections": [],
            "gemini": {},
            "weights": {},
            "tlds": [],
            "debug": False,
            "no_sources_configured": False,
            "cache_hit": False,
            "cache_key": None,
            "cache_expires_at": None,
            "duration_ms": None,
            "started_at": None,
            "finished_at": None,
            "error": None,
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def is_running(self) -> bool:
        with self._lock:
            return self._state["status"] == "running"

    def begin(self, run_id: str, request: SimilarDomainRequest) -> None:
        with self._lock:
            self._state = self._idle()
            self._state.update(
                run_id=run_id,
                status="running",
                phase="generating",
                keyword=request.keyword,
                filters=request.to_payload(),
                started_at=_iso(),
                debug=similar_domains.debug_enabled(),
                tlds=list(request.tld_list()),
                query=(request.query.to_debug() if request.query else {}),
            )

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def stage(self, phase: str, message: str, **fields: Any) -> None:
        with self._lock:
            self._state.update(phase=phase, message=message, stage_label=message, **fields)
        _debug("%s — %s", phase, message)

    def increment(self, key: str, amount: int = 1) -> int:
        with self._lock:
            value = int(self._state.get(key) or 0) + amount
            self._state[key] = value
            return value

    def finish(self, *, error: Optional[str] = None) -> None:
        with self._lock:
            self._state.update(
                status="error" if error else "completed",
                phase="error" if error else "done",
                finished_at=_iso(),
                error=error,
            )


STATE = SimilarDomainState()
KeywordDiscoveryState = SimilarDomainState


class _Rejections:
    """Bounded per-domain accept/reject log, surfaced in the debug panel."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def add(
        self,
        domain: str,
        *,
        accepted: bool,
        reason: str,
        detail: str,
        similarity: int,
        category: Optional[str] = None,
        verification_source: str = "unknown",
    ) -> None:
        if len(self._rows) >= MAX_REJECTION_ROWS:
            return
        self._rows.append(
            {
                "domain": domain,
                "accepted": accepted,
                "reason": reason,
                "detail": detail,
                "similarity_score": similarity,
                "category": category,
                "verification_source": verification_source,
            }
        )

    def rows(self) -> list[dict[str, Any]]:
        return sorted(
            self._rows,
            key=lambda row: (not row["accepted"], -int(row["similarity_score"] or 0), row["domain"]),
        )


# --- candidate collection ---------------------------------------------------

def _matches_mode(domain: str, request: SimilarDomainRequest) -> tuple[bool, int]:
    """Does a source domain qualify, and how similar is it?

    Cheap gates first so a large zone file is not scored character by
    character for every row.
    """
    if request.tld and tld_of(domain) != request.tld:
        return False, 0
    name = registrable_name(domain).lower()
    squashed = name.replace("-", "")
    keyword = request.keyword

    if request.search_mode == "exact":
        if squashed != keyword:
            return False, 0
        return True, similar_domains.similarity_score(domain, keyword)

    if request.search_mode == "contains":
        if keyword not in name and keyword not in squashed:
            return False, 0
        return True, similar_domains.similarity_score(domain, keyword)

    # similar: containment, or a close-enough fuzzy neighbour.
    if keyword not in squashed:
        if abs(len(squashed) - len(keyword)) > 6:
            return False, 0
        if squashed[:1] != keyword[:1] and squashed[-1:] != keyword[-1:]:
            return False, 0
    score = similar_domains.similarity_score(domain, keyword)
    return score >= MIN_SIMILARITY, score


def _generate_pool(
    request: SimilarDomainRequest,
    state: SimilarDomainState,
) -> dict[str, int]:
    """Stage 1: deterministic name variations. Candidates only, never results."""
    if not request.generates:
        state.stage("generating", "Skipping name generation for this search mode", generated=0)
        return {}

    caps = similar_domains.limits()
    pool = similar_domains.generate_candidates(
        request.query or similar_domains.parse_query(request.keyword),
        tlds=request.tld_list(),
        max_generated=caps.max_generated,
        exact_only=request.search_mode == "exact",
    )

    generated = {candidate.domain: candidate.similarity for candidate in pool}
    state.stage(
        "generating",
        f"Generating candidate names... {len(generated):,} candidates",
        generated=len(generated),
    )
    _debug(
        "candidate generation: %d names across %d TLDs, exact_candidate=%s, first=%s",
        len(generated),
        len(request.tld_list()),
        request.exact_candidate or "-",
        ", ".join(candidate.domain for candidate in pool[:5]),
    )
    return generated


def _search_sources(
    request: SimilarDomainRequest,
    settings: source_config.SourceSettings,
    state: SimilarDomainState,
) -> tuple[dict[str, int], dict[str, set[str]], dict[str, str], list[dict[str, Any]], bool]:
    """Stage 2: match the keyword against every configured real source."""
    matched: dict[str, int] = {}
    origins: dict[str, set[str]] = {}
    origin_kinds: dict[str, str] = {}
    source_details: list[dict[str, Any]] = []
    any_configured = False

    adapters, _ = domain_sources.build_sources(settings)
    total = len(adapters) + 1  # +1 for the stored candidate database
    state.stage(
        "searching_sources",
        "Searching configured sources...",
        sources_total=total,
        sources_completed=0,
        source_matches=0,
    )

    def record(domain: str, score: int, source_name: str, kind: str) -> None:
        origins.setdefault(domain, set()).add(source_name)
        origin_kinds[source_name] = kind
        previous = matched.get(domain)
        if previous is None or score > previous:
            matched[domain] = score

    completed = 0
    for adapter in adapters:
        started = time.monotonic()
        searched = 0
        hits = 0
        status = "success"
        error: Optional[str] = None
        configured = adapter.is_configured()
        if configured:
            any_configured = True
            try:
                for raw in adapter.fetch_domains():
                    searched += 1
                    domain = normalize_domain(raw)
                    if not domain:
                        continue
                    ok, score = _matches_mode(domain, request)
                    if not ok:
                        continue
                    hits += 1
                    record(domain, score, adapter.name, adapter.kind)
            except Exception as exc:
                # One broken source must never take the run down.
                status = "error"
                error = str(exc)
                logger.warning("[domain-radar] source %s failed: %s", adapter.name, exc)
        else:
            status = "not_configured"

        source_details.append(
            {
                "name": adapter.name,
                "kind": adapter.kind,
                "label": adapter.label,
                "status": status,
                "configured": configured,
                "searched": searched,
                "matched": hits,
                "duration_ms": int((time.monotonic() - started) * 1000),
                "error": error,
                "detail": adapter.describe(),
            }
        )
        completed += 1
        state.update(
            sources_completed=completed,
            source_matches=len(matched),
            source_details=source_details,
            message=f"Searching configured sources... {completed} / {total}",
        )
        _debug(
            "source %s: status=%s searched=%d matched=%d",
            adapter.name,
            status,
            searched,
            hits,
        )

    # The stored candidate database is always searched: it is the accumulated
    # result of every previous scan and import.
    started = time.monotonic()
    stored = storage.all_domains()
    hits = 0
    for row in stored:
        domain = row.get("domain")
        if not domain:
            continue
        ok, score = _matches_mode(domain, request)
        if not ok:
            continue
        hits += 1
        record(domain, score, "database", "database")
    if stored:
        any_configured = True
    source_details.append(
        {
            "name": "database",
            "kind": "database",
            "label": SOURCE_LABELS["database"],
            "status": "success",
            "configured": True,
            "searched": len(stored),
            "matched": hits,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "error": None,
            "detail": f"Searching {len(stored):,} stored candidates",
        }
    )
    completed += 1
    state.update(
        sources_completed=completed,
        source_matches=len(matched),
        source_details=source_details,
        message=f"Searching configured sources... {len(matched):,} source matches",
    )
    _debug("source pass complete: %d matches across %d sources", len(matched), completed)

    configured_rows = domain_sources.source_status(settings)
    no_sources_configured = not any_configured and not any(row["configured"] for row in configured_rows)
    return matched, origins, origin_kinds, source_details, no_sources_configured


# --- verification -----------------------------------------------------------

def _rdap_stale(stamp: Optional[str], ttl_hours: int) -> bool:
    checked = _parse_iso(stamp)
    if not checked:
        return True
    return (_now() - checked) > timedelta(hours=float(ttl_hours))


@dataclass
class VerifiedRow:
    row: dict[str, Any]
    similarity: int
    verification_source: str
    from_cache: bool


def _verify_candidates(
    request: SimilarDomainRequest,
    candidates: list[tuple[str, int]],
    origins: dict[str, set[str]],
    settings: source_config.SourceSettings,
    state: SimilarDomainState,
    diagnostics: dict[str, Any],
) -> list[VerifiedRow]:
    """Stage 4: RDAP first, WHOIS second. Nothing is trusted until this runs."""
    total = len(candidates)
    state.stage(
        "verifying",
        f"RDAP / WHOIS verification... 0 / {total}",
        verify_total=total,
        verified=0,
    )
    client = RdapClient(
        timeout=settings.rdap_timeout,
        max_retries=settings.rdap_max_retries,
        min_host_interval=settings.rdap_min_host_interval,
        allow_whois_fallback=domain_monitor.ALLOW_WHOIS_FALLBACK,
        pool_size=settings.rdap_concurrency,
    )
    verified: list[VerifiedRow] = []
    written: list[DomainRecord] = []
    similarity_by_domain = dict(candidates)

    try:
        batch_size = max(1, settings.scan_batch_size)
        domains = [domain for domain, _ in candidates]
        for index in range(0, len(domains), batch_size):
            chunk = domains[index : index + batch_size]
            with ThreadPoolExecutor(max_workers=settings.rdap_concurrency) as pool:
                futures: dict[Any, tuple[str, bool]] = {}
                for domain in chunk:
                    stored = storage.get_domain(domain)
                    if stored and not _rdap_stale(stored.get("last_rdap_checked"), settings.rdap_cache_hours):
                        futures[pool.submit(lambda row=stored: row)] = (domain, True)
                        continue
                    first_source = next(iter(origins.get(domain) or {"generated"}))
                    first_seen = stored.get("first_seen") if stored else None
                    futures[
                        pool.submit(
                            domain_monitor.verify_domain,
                            client,
                            domain,
                            first_source,
                            first_seen,
                        )
                    ] = (domain, False)

                for future in as_completed(futures):
                    domain, from_cache = futures[future]
                    try:
                        result = future.result()
                    except Exception as exc:
                        logger.warning("[domain-radar] verify worker failed on %s: %s", domain, exc)
                        diagnostics["lookup_failed"] += 1
                        state.increment("verified")
                        continue

                    if isinstance(result, DomainRecord):
                        written.append(result)
                        storage.record_status_history(
                            result.domain,
                            {
                                "registry_status": result.registry_status,
                                "expiration_date": result.expiration_date,
                                "category": result.category,
                                "days_left": result.days_left,
                                "checked_at": result.last_checked,
                            },
                        )
                        row = result.to_dict()
                    else:
                        row = dict(result)

                    source = verification_source_of(row.get("rdap_source"))
                    diagnostics["verify_attempted"] += 1
                    if from_cache:
                        diagnostics["cache_reused"] += 1
                    if row.get("lookup_status") == LOOKUP_OK:
                        diagnostics["verified"] += 1
                        if source == "whois":
                            diagnostics["whois_verified"] += 1
                        elif source == "rdap":
                            diagnostics["rdap_verified"] += 1
                    verified.append(
                        VerifiedRow(
                            row=row,
                            similarity=similarity_by_domain.get(domain, 0),
                            verification_source=source,
                            from_cache=from_cache,
                        )
                    )

                    count = state.increment("verified")
                    state.update(message=f"RDAP / WHOIS verification... {count} / {total}")
                    if similar_domains.debug_enabled():
                        statuses = row.get("registry_status") or []
                        _debug(
                            "[rdap] %s status=%s expires=%s via=%s%s",
                            domain,
                            ",".join(str(s) for s in statuses) or row.get("lookup_status"),
                            row.get("expiration_date") or "-",
                            source,
                            " (cached)" if from_cache else "",
                        )
                        if similar_domains.rdap_verbose():
                            logger.debug("[domain-radar][rdap-raw] %s %s", domain, row)

            if written:
                storage.upsert_many(written)
                written = []
    finally:
        client.close()

    return verified


# --- lifecycle filter -------------------------------------------------------

def _classify_candidate(
    item: VerifiedRow,
    request: SimilarDomainRequest,
    diagnostics: dict[str, Any],
    rejections: _Rejections,
) -> Optional[dict[str, Any]]:
    """Stage 5. Returns the enriched row when eligible, None when rejected.

    A 404 from the registry means unregistered, which is emphatically not the
    same thing as expired: it lands in its own bucket and only reaches the
    results when Include Available is on.
    """
    row = item.row
    domain = row["domain"]
    status = row.get("lookup_status")
    category = row.get("category")
    days_left = row.get("days_left")

    if status == LOOKUP_NOT_FOUND:
        diagnostics["available_unregistered"] += 1
        if not request.include_available:
            rejections.add(
                domain,
                accepted=False,
                reason="available_unregistered",
                detail="Not present in the registry — available, not expired",
                similarity=item.similarity,
                category="Available",
                verification_source=item.verification_source,
            )
            return None
        bucket = "available"
    elif status == LOOKUP_UNSUPPORTED_TLD:
        diagnostics["unsupported_tld"] += 1
        rejections.add(
            domain,
            accepted=False,
            reason="unsupported_tld",
            detail="No RDAP endpoint and no WHOIS fallback for this TLD",
            similarity=item.similarity,
            verification_source=item.verification_source,
        )
        return None
    elif status != LOOKUP_OK:
        diagnostics["lookup_failed"] += 1
        rejections.add(
            domain,
            accepted=False,
            reason="lookup_failed",
            detail=str(row.get("lookup_error") or "Registry lookup failed"),
            similarity=item.similarity,
            verification_source=item.verification_source,
        )
        return None
    else:
        bucket = LIFECYCLE_BUCKETS.get(category or CAT_UNKNOWN, "unknown")

    if item.similarity < MIN_SIMILARITY:
        diagnostics["below_similarity_floor"] += 1
        rejections.add(
            domain,
            accepted=False,
            reason="below_similarity_floor",
            detail=f"Similarity {item.similarity} is under the floor of {MIN_SIMILARITY}",
            similarity=item.similarity,
            category=category,
            verification_source=item.verification_source,
        )
        return None

    if bucket != "available":
        if category == CAT_SAFE:
            diagnostics["safe_beyond_window"] += 1
            detail = (
                f"Expires in {days_left} days" if days_left is not None else "Not expiring soon"
            )
            rejections.add(
                domain,
                accepted=False,
                reason="safe_beyond_window",
                detail=detail,
                similarity=item.similarity,
                category=category,
                verification_source=item.verification_source,
            )
            return None
        if category == CAT_UNKNOWN:
            diagnostics["no_expiry_data"] += 1
            rejections.add(
                domain,
                accepted=False,
                reason="no_expiry_data",
                detail="Registered, but the registry published no expiry date",
                similarity=item.similarity,
                category=category,
                verification_source=item.verification_source,
            )
            return None
        if category == CAT_60 and request.expiry_window < 60:
            diagnostics["outside_expiry_window"] += 1
            rejections.add(
                domain,
                accepted=False,
                reason="outside_expiry_window",
                detail=f"Expires in {days_left} days, outside the {request.expiry_window}-day window",
                similarity=item.similarity,
                category=category,
                verification_source=item.verification_source,
            )
            return None
        wanted = LIFECYCLE_FILTERS.get(request.lifecycle_filter, INTERESTING_CATEGORIES)
        if category not in wanted:
            diagnostics["filtered_by_lifecycle"] += 1
            rejections.add(
                domain,
                accepted=False,
                reason="filtered_by_lifecycle",
                detail=f"{category} is outside the selected lifecycle filter",
                similarity=item.similarity,
                category=category,
                verification_source=item.verification_source,
            )
            return None

    diagnostics["eligible"] += 1
    breakdown = similar_domains.similarity_breakdown(domain, request.keyword)
    level = match_level_of(domain, request.keyword, item.similarity, request.exact_candidate)
    diagnostics[f"level_{level}"] = int(diagnostics.get(f"level_{level}") or 0) + 1
    return {
        **row,
        "similarity_score": item.similarity,
        "match_level": level,
        "match_level_label": MATCH_LEVEL_LABELS[level],
        "exact_match": level == "exact",
        "similarity_match_kind": breakdown.match_kind,
        "similarity_second_level": breakdown.second_level,
        "similarity_tld_score": breakdown.tld_score,
        "similarity_edit_distance": breakdown.edit_distance,
        "lifecycle_bucket": bucket,
        "lifecycle_score": lifecycle_score(category),
        "verification_source": item.verification_source,
        "verified_from_cache": item.from_cache,
    }


# --- SEO enrichment ---------------------------------------------------------

def _enrich_shortlist(domains: list[str], state: SimilarDomainState) -> None:
    if not domains:
        return
    provider = backlinks.build_provider()
    history = history_client.HistoryClient(pool_size=enrichment.ENRICH_WORKERS)
    niches = storage.target_niches()
    enriched = 0
    try:
        with ThreadPoolExecutor(max_workers=enrichment.ENRICH_WORKERS) as pool:
            futures = {}
            for domain in domains:
                row = storage.get_domain(domain)
                if not row:
                    continue
                futures[
                    pool.submit(
                        enrichment.enrich_domain,
                        domain,
                        row.get("registration_date"),
                        history,
                        provider,
                        niches,
                        row,
                        False,
                    )
                ] = domain
            for future in as_completed(futures):
                domain = futures[future]
                try:
                    payload = future.result()
                except Exception as exc:
                    logger.warning("[domain-radar] SEO enrichment failed for %s: %s", domain, exc)
                    continue
                enrichment.persist(domain, payload)
                enriched += 1
                state.update(
                    enriched=enriched,
                    message=f"SEO enrichment... {enriched} / {len(domains)}",
                )
    finally:
        history.close()
        close = getattr(provider, "close", None)
        if callable(close):
            close()


def _result_sources(domain: str, origins: dict[str, set[str]], generated: bool) -> tuple[list[str], list[str]]:
    names = set(origins.get(domain) or set())
    for row in storage.sources_for_domain(domain):
        names.add(str(row.get("source_name") or ""))
    if generated and not names:
        names.add("generated")
    names = {name for name in names if name}
    labels = [SOURCE_LABELS.get(name, name) for name in sorted(names)]
    return sorted(names), labels


def _decorate(
    request: SimilarDomainRequest,
    rows: list[dict[str, Any]],
    origins: dict[str, set[str]],
    generated_pool: dict[str, int],
    diagnostics: dict[str, Any],
    rejections: _Rejections,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Stage 7: rank the survivors and split them into groups.

    Returns (actionable, available). Never pads either list to reach the
    limit: if seven real domains qualify, seven is what comes back.
    """
    decorated: list[dict[str, Any]] = []
    for row in rows:
        if request.lifecycle_filter == "low_spam" and row.get("spam_risk_level") not in (None, "Low"):
            diagnostics["filtered_by_spam"] += 1
            rejections.add(
                row["domain"],
                accepted=False,
                reason="filtered_by_spam",
                detail=f"Spam risk {row.get('spam_risk_level')} excluded by Low Spam Only",
                similarity=int(row.get("similarity_score") or 0),
                category=row.get("category"),
                verification_source=str(row.get("verification_source") or "unknown"),
            )
            continue
        source_names, source_labels = _result_sources(
            row["domain"], origins, row["domain"] in generated_pool
        )
        decorated.append(
            {
                **row,
                "final_rank_score": final_rank_score(row),
                "score_parts": _score_parts(row),
                "source_names": source_names,
                "source_labels": source_labels,
                # Legacy aliases so nothing downstream breaks on rename.
                "keyword_match_score": int(row.get("similarity_score") or 0),
                "keyword_match_type": row.get("similarity_match_kind"),
            }
        )

    # Exact first, then strict, then broader. A Broader Match can never
    # outrank a strict one however well it scores.
    decorated.sort(
        key=lambda row: (
            MATCH_LEVEL_RANK.get(row.get("match_level"), 2),
            -float(row.get("final_rank_score") or 0),
            -int(row.get("similarity_score") or 0),
            -int(row.get("similarity_tld_score") or 0),
            storage.LIFECYCLE_RANK.get(row.get("category"), 7),
            row["domain"],
        )
    )

    actionable: list[dict[str, Any]] = []
    available: list[dict[str, Any]] = []
    for row in decorated:
        if row.get("lifecycle_bucket") in ACTIONABLE_BUCKETS:
            actionable.append(row)
        elif row.get("lifecycle_bucket") == "available":
            available.append(row)

    for index, row in enumerate(actionable, start=1):
        row["rank"] = index
    for index, row in enumerate(available, start=1):
        row["rank"] = index

    for row in decorated:
        rejections.add(
            row["domain"],
            accepted=True,
            reason="accepted",
            detail=f"{row.get('category')} · similarity {row.get('similarity_score')} · {row.get('match_level_label')}",
            similarity=int(row.get("similarity_score") or 0),
            category=row.get("category"),
            verification_source=str(row.get("verification_source") or "unknown"),
        )

    diagnostics["actionable"] = len(actionable)
    diagnostics["available"] = len(available)
    return actionable[: request.limit], available[: request.limit]


def _non_actionable_rows(rejections: _Rejections) -> list[dict[str, Any]]:
    """Verified-but-unusable candidates, for the collapsed group in the UI.

    Only verification outcomes appear here — a domain excluded by the user's
    own lifecycle or spam filter is not "non-actionable", it was filtered.
    """
    out: list[dict[str, Any]] = []
    for row in rejections.rows():
        if row["accepted"]:
            continue
        reason = row["reason"]
        if reason not in NON_ACTIONABLE_REASONS:
            continue
        out.append(
            {
                "domain": row["domain"],
                "reason": NON_ACTIONABLE_REASONS[reason],
                "reason_code": reason,
                "detail": row["detail"],
                "similarity_score": row["similarity_score"],
                "category": row["category"],
                "verification_source": row["verification_source"],
                "verification_status": (
                    "Verified"
                    if reason in ("safe_beyond_window", "outside_expiry_window", "no_expiry_data")
                    else "Unverified"
                ),
            }
        )
    return out


# --- orchestration ----------------------------------------------------------

def _cache_key(payload: dict[str, Any]) -> str:
    wire = "|".join(
        [
            "v3",
            payload["keyword"],
            payload.get("raw_query") or payload["keyword"],
            payload.get("entered_tld") or "-",
            payload["search_mode"],
            str(payload["expiry_window"]),
            payload.get("tld") or "*",
            str(payload["limit"]),
            payload["lifecycle_filter"],
            "1" if payload.get("include_available") else "0",
        ]
    )
    return hashlib.sha256(wire.encode("utf-8")).hexdigest()


def _cache_expiry() -> str:
    return (_now() + timedelta(hours=CACHE_HOURS)).isoformat(timespec="seconds")


def history(limit: int = 8) -> dict[str, Any]:
    storage.migrate()
    return {"items": storage.list_keyword_history(limit)}


def snapshot() -> dict[str, Any]:
    storage.migrate()
    current = STATE.snapshot()
    current["history"] = storage.list_keyword_history(8)
    current["debug"] = similar_domains.debug_enabled()
    return current


def run_similar_domain_discovery(
    request: SimilarDomainRequest,
    *,
    run_id: Optional[str] = None,
    state: SimilarDomainState = STATE,
) -> dict[str, Any]:
    started = time.monotonic()
    if run_id is None:
        run_id = uuid.uuid4().hex[:12]
        state.begin(run_id, request)

    # Everything below runs on a worker thread. Any escape from here would
    # leave the state stuck at "running" and block every later run, so the
    # whole body is guarded and setup failures are reported like any other.
    try:
        return _execute(request, run_id, state, started=started)
    except Exception as exc:
        logger.exception("Similar domain discovery %s failed during setup", run_id)
        state.finish(error=str(exc))
        return state.snapshot()


def _execute(
    request: SimilarDomainRequest,
    run_id: str,
    state: SimilarDomainState,
    *,
    started: float,
) -> dict[str, Any]:
    storage.migrate()
    settings = source_config.load_settings()
    caps = similar_domains.limits()
    weights = similar_domains.rank_weights()
    cache_key = _cache_key(request.to_payload())

    _debug(
        "search started raw_query=%s normalized_domain=%s second_level_domain=%s "
        "tld=%s exact_candidate=%s mode=%s window=%s tld_filter=%s",
        request.raw_query,
        (request.query.normalized_domain if request.query else None) or "-",
        request.keyword,
        (request.entered_tld or "-").lstrip("."),
        request.exact_candidate or "-",
        request.search_mode,
        request.expiry_window,
        request.tld or "any",
    )

    cached = storage.get_keyword_cache(cache_key)
    if cached:
        # The cached payload already carries most state keys, so merge rather
        # than passing them twice as kwargs.
        response = dict(cached.get("response") or {})
        response.update(
            run_id=run_id,
            status="completed",
            phase="done",
            cache_hit=True,
            cache_key=cache_key,
            cache_expires_at=cached.get("expires_at"),
            finished_at=_iso(),
            history=storage.list_keyword_history(8),
            debug=similar_domains.debug_enabled(),
        )
        state.update(**response)
        _debug("cache hit for %s (%d results)", request.keyword, int(response.get("result_count") or 0))
        return state.snapshot()

    diagnostics = _empty_diagnostics()
    rejections = _Rejections()

    try:
        state.update(
            cache_key=cache_key,
            weights={
                "similarity": round(weights.similarity, 4),
                "lifecycle": round(weights.lifecycle, 4),
                "seo": round(weights.seo, 4),
            },
            tlds=list(request.tld_list()),
        )

        gemini_before = crawl4ai_source.gemini_stats()

        # 1. deterministic name variations
        generated_pool = _generate_pool(request, state)
        diagnostics["generated"] = len(generated_pool)

        # 2. real configured sources
        source_pool, origins, origin_kinds, source_details, no_sources = _search_sources(
            request, settings, state
        )
        diagnostics["source_matches"] = len(source_pool)

        gemini_after = crawl4ai_source.gemini_stats()
        gemini_delta = {
            key: gemini_after.get(key, 0) - gemini_before.get(key, 0)
            for key in ("calls", "success", "failures", "domains")
        }
        gemini_delta.update(
            configured=gemini_after.get("configured"),
            model=gemini_after.get("model"),
            provider=gemini_after.get("provider"),
            reason=gemini_after.get("reason"),
            last_status=gemini_after.get("last_status"),
            last_error=gemini_after.get("last_error"),
            last_duration_ms=gemini_after.get("last_duration_ms"),
        )
        state.update(gemini=gemini_delta)

        if no_sources and not generated_pool:
            state.update(
                status="completed",
                phase="done",
                no_sources_configured=True,
                message="No discovery sources configured.",
                source_details=source_details,
                diagnostics=diagnostics,
                history=storage.list_keyword_history(8),
            )
            return state.snapshot()

        # 3. merge + dedupe, keeping the best similarity per domain
        merged: dict[str, int] = dict(generated_pool)
        for domain, score in source_pool.items():
            merged[domain] = max(score, merged.get(domain, 0))
        candidates = sorted(merged.items(), key=lambda item: (-item[1], len(item[0]), item[0]))
        diagnostics["unique_candidates"] = len(candidates)
        state.stage(
            "deduplicating",
            f"Deduplicating... {len(candidates):,} unique candidates",
            unique_candidates=len(candidates),
            candidates_found=len(candidates),
            candidate_matches=len(candidates),
        )

        if len(candidates) > caps.max_verified:
            diagnostics["skipped_over_cap"] = len(candidates) - caps.max_verified
            logger.info(
                "[domain-radar] verification capped at %d of %d candidates (closest kept)",
                caps.max_verified,
                len(candidates),
            )
            candidates = candidates[: caps.max_verified]

        # 4. RDAP / WHOIS
        verified = _verify_candidates(
            request, candidates, origins, settings, state, diagnostics
        )

        for item in verified:
            if item.row.get("lookup_status") == LOOKUP_OK:
                for name in origins.get(item.row["domain"]) or set():
                    storage.link_sources({item.row["domain"]: name}, {name: origin_kinds.get(name)})

        # 5. lifecycle filter
        state.stage("lifecycle_filter", "Lifecycle filtering...")
        eligible = [
            row
            for row in (
                _classify_candidate(item, request, diagnostics, rejections) for item in verified
            )
            if row
        ]
        state.stage(
            "lifecycle_filter",
            f"Lifecycle filtering... {len(eligible):,} eligible",
            eligible=len(eligible),
            diagnostics=diagnostics,
        )

        # 6. SEO enrichment on the closest eligible rows only
        eligible.sort(
            key=lambda row: (
                -int(row.get("similarity_score") or 0),
                storage.LIFECYCLE_RANK.get(row.get("category"), 7),
                row["domain"],
            )
        )
        enrich_targets = [row["domain"] for row in eligible[:SEO_ENRICH_LIMIT]]
        state.stage(
            "seo_analysis",
            f"SEO enrichment... 0 / {len(enrich_targets)}",
            enriched=0,
            seo_total=len(enrich_targets),
        )
        _enrich_shortlist(enrich_targets, state)
        diagnostics["seo_analyzed"] = len(enrich_targets)

        # Re-read so the freshly persisted SEO metrics reach the ranking stage.
        by_domain = {row["domain"]: row for row in eligible}
        final_rows: list[dict[str, Any]] = []
        for domain, row in by_domain.items():
            stored = storage.get_domain(domain)
            final_rows.append({**row, **(stored or {})} if stored else row)
            if stored:
                final_rows[-1].update(
                    {
                        key: row[key]
                        for key in (
                            "similarity_score",
                            "match_level",
                            "match_level_label",
                            "exact_match",
                            "similarity_match_kind",
                            "similarity_second_level",
                            "similarity_tld_score",
                            "similarity_edit_distance",
                            "lifecycle_bucket",
                            "lifecycle_score",
                            "verification_source",
                            "verified_from_cache",
                        )
                    }
                )

        # 7. ranking
        state.stage("ranking", "Ranking...")
        results, available_results = _decorate(
            request, final_rows, origins, generated_pool, diagnostics, rejections
        )
        non_actionable = _non_actionable_rows(rejections)
        diagnostics["results"] = len(results)
        diagnostics["non_actionable"] = len(non_actionable)
        duration_ms = int((time.monotonic() - started) * 1000)

        summary = (
            f"{len(results)} matching opportunit{'y' if len(results) == 1 else 'ies'} found"
            if results
            else "0 lifecycle matches found"
        )

        response = {
            "keyword": request.keyword,
            "filters": request.to_payload(),
            "sources_total": len(source_details),
            "sources_completed": len(source_details),
            "generated": diagnostics["generated"],
            "source_matches": diagnostics["source_matches"],
            "unique_candidates": diagnostics["unique_candidates"],
            "verify_total": len(candidates),
            "verified": diagnostics["verify_attempted"],
            "eligible": len(eligible),
            "enriched": len(enrich_targets),
            "seo_total": len(enrich_targets),
            "result_count": len(results),
            "candidates_found": diagnostics["unique_candidates"],
            "candidate_matches": diagnostics["unique_candidates"],
            "results": results,
            "available_results": available_results,
            "available_count": len(available_results),
            "non_actionable": non_actionable,
            "non_actionable_count": len(non_actionable),
            "query": (request.query.to_debug() if request.query else {}),
            "strict_min_similarity": STRICT_MIN_SIMILARITY,
            "min_similarity": MIN_SIMILARITY,
            "source_counts": {detail["label"]: detail["matched"] for detail in source_details},
            "source_details": source_details,
            "diagnostics": diagnostics,
            "rejections": rejections.rows(),
            "gemini": gemini_delta,
            "weights": {
                "similarity": round(weights.similarity, 4),
                "lifecycle": round(weights.lifecycle, 4),
                "seo": round(weights.seo, 4),
            },
            "tlds": list(request.tld_list()),
            "no_sources_configured": False,
            "cache_hit": False,
            "cache_key": cache_key,
            "cache_expires_at": _cache_expiry(),
            "duration_ms": duration_ms,
            "message": summary,
            "stage_label": summary,
        }

        storage.set_keyword_cache(
            cache_key,
            request.to_payload(),
            response,
            _iso(),
            response["cache_expires_at"],
        )
        storage.add_keyword_history(request.keyword, request.to_payload(), len(results))
        state.update(**response, phase="done", history=storage.list_keyword_history(8))
        state.finish()
        _debug(
            "search completed keyword=%s results=%d duration=%.1fs",
            request.keyword,
            len(results),
            duration_ms / 1000,
        )
    except Exception as exc:
        logger.exception("Similar domain discovery %s failed", run_id)
        state.update(diagnostics=diagnostics, rejections=rejections.rows())
        state.finish(error=str(exc))
    return state.snapshot()


# Back-compat alias.
run_keyword_discovery = run_similar_domain_discovery


def start_similar_domain_discovery(payload: dict[str, Any]) -> dict[str, Any]:
    if STATE.is_running():
        return {"started": False, "reason": "A discovery run is already running", **snapshot()}

    request = SimilarDomainRequest.from_payload(payload)
    run_id = uuid.uuid4().hex[:12]
    STATE.begin(run_id, request)
    thread = threading.Thread(
        target=run_similar_domain_discovery,
        kwargs={"request": request, "run_id": run_id},
        daemon=True,
        name="similar-domain-discovery",
    )
    thread.start()
    return {"started": True, **snapshot()}


start_keyword_discovery = start_similar_domain_discovery


EXPORT_FIELDS = [
    ("rank", "Rank"),
    ("domain", "Domain"),
    ("similarity_score", "Similarity"),
    ("match_level_label", "Match Level"),
    ("category", "Lifecycle"),
    ("expiration_date", "Expiry"),
    ("days_left", "Days Left"),
    ("referring_domains", "RD"),
    ("total_backlinks", "Backlinks"),
    ("spam_risk_level", "Spam Risk"),
    ("seo_score", "SEO Score"),
    ("verification_source", "Verified By"),
    ("final_rank_score", "Final Score"),
]

KEYWORD_EXPORT_FIELDS = EXPORT_FIELDS


def export_results(cache_key: str, fmt: str = "csv") -> bytes | str:
    cached = storage.get_keyword_cache(cache_key)
    if not cached:
        raise ValueError("Discovery cache not found")
    results = list((cached.get("response") or {}).get("results") or [])
    header = [label for _, label in EXPORT_FIELDS]
    body = [
        [("" if row.get(key) is None else row.get(key)) for key, _ in EXPORT_FIELDS]
        for row in results
    ]
    if fmt == "xlsx":
        import pandas as pd

        frame = pd.DataFrame(body, columns=header)
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            frame.to_excel(writer, index=False, sheet_name="Similar Domains")
        return buffer.getvalue()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(body)
    return buffer.getvalue()
