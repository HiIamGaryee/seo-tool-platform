from __future__ import annotations

import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

import anchors
import backlinks
import config_loader
import history_client
import scoring
import spam
import storage
import topics
from models import normalize_domain

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# External SEO data is expensive and changes slowly, so each source keeps its
# own TTL rather than sharing the RDAP cadence.
BACKLINK_TTL_HOURS = _env_int("DOMAIN_MONITOR_BACKLINK_TTL_HOURS", 168)
HISTORY_TTL_DAYS = _env_int("DOMAIN_MONITOR_HISTORY_TTL_DAYS", 14)
ENRICH_WORKERS = max(1, min(_env_int("DOMAIN_MONITOR_ENRICH_CONCURRENCY", 6), 16))
ENRICH_BATCH_SIZE = max(1, _env_int("DOMAIN_MONITOR_ENRICH_BATCH", 20))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return storage.now_iso()


def _age_years(registration_date: Optional[str]) -> Optional[float]:
    """Domain age from the RDAP creation date. None when the registry hides it."""
    if not registration_date:
        return None
    try:
        created = datetime.fromisoformat(registration_date[:10]).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    return max(0.0, (_now() - created).days / 365.25)


def _stale(stamp: Optional[str], max_age_days: float) -> bool:
    if not stamp:
        return True
    try:
        checked = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return True
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=timezone.utc)
    return (_now() - checked).total_seconds() > max_age_days * 86400


class EnrichmentState:
    """Live progress for an enrichment pass, polled by the dashboard."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = self._idle()

    @staticmethod
    def _idle() -> dict[str, Any]:
        return {
            "run_id": None,
            "status": "idle",
            "phase": "idle",
            "checked": 0,
            "total": 0,
            "with_backlinks": 0,
            "with_history": 0,
            "scored": 0,
            "unscored": 0,
            "high_opportunity": 0,
            "high_spam": 0,
            "failed": 0,
            "provider": None,
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

    def begin(self, run_id: str, provider: str) -> None:
        with self._lock:
            self._state = self._idle()
            self._state.update(
                run_id=run_id, status="running", phase="enriching",
                provider=provider, started_at=_iso(),
            )

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def bump(self, result: dict[str, Any]) -> None:
        with self._lock:
            state = self._state
            state["checked"] += 1
            if result.get("referring_domains") is not None:
                state["with_backlinks"] += 1
            if result.get("snapshot_count") is not None:
                state["with_history"] += 1
            if result.get("seo_score") is not None:
                state["scored"] += 1
                if result["seo_score"] >= 80:
                    state["high_opportunity"] += 1
            else:
                state["unscored"] += 1
            if result.get("spam_risk_level") in ("High", "Very High"):
                state["high_spam"] += 1

    def fail(self) -> None:
        with self._lock:
            self._state["checked"] += 1
            self._state["failed"] += 1

    def finish(self, error: Optional[str] = None) -> None:
        with self._lock:
            self._state.update(
                status="error" if error else "completed",
                phase="error" if error else "done",
                finished_at=_iso(),
                error=error,
            )


ENRICHMENT = EnrichmentState()


def _niche_keyword_set(niches: Iterable[str]) -> set[str]:
    """Flat token set for the admin's target niches, used by anchor bucketing."""
    configured = config_loader.topics()
    words: set[str] = set()
    for niche in niches:
        for keyword in configured.get(niche, []):
            words.update(keyword.lower().split())
    return words


def enrich_domain(
    domain: str,
    registration_date: Optional[str],
    history: history_client.HistoryClient,
    provider: backlinks.BacklinkProvider,
    niches: list[str],
    stamps: Optional[dict[str, Any]] = None,
    force: bool = False,
) -> dict[str, Any]:
    """Run the full SEO pipeline for one domain and return the storable payload.

    Never raises: a failing external source degrades that one field and the
    rest of the pipeline still produces a result.
    """
    stamps = stamps or {}
    payload: dict[str, Any] = {}
    snapshot_rows: list[dict[str, Any]] = []

    # --- archive history ---------------------------------------------------
    history_result = history_client.HistoryResult(queried=False)
    reuse_history = not force and not _stale(stamps.get("last_history_checked"), HISTORY_TTL_DAYS)
    if reuse_history:
        cached = storage.get_snapshots(domain)
        snapshot_rows = cached
        stored = storage.get_domain(domain) or {}
        history_result = history_client.HistoryResult(
            queried=bool(stored.get("snapshot_count") is not None),
            snapshot_count=stored.get("snapshot_count"),
            first_seen=stored.get("first_archive_seen"),
            last_seen=stored.get("last_archive_seen"),
        )
    else:
        try:
            history_result = history.lookup(domain)
        except Exception as exc:  # one archive failure must not stop the run
            logger.warning("Archive lookup failed for %s: %s", domain, exc)
            history_result = history_client.HistoryResult(queried=True, error=str(exc))

        payload.update(
            first_archive_seen=history_result.first_seen,
            last_archive_seen=history_result.last_seen,
            snapshot_count=history_result.snapshot_count,
            snapshot_count_truncated=int(bool(history_result.snapshot_count_truncated)),
            archive_error=history_result.error,
            last_history_checked=_iso(),
        )
        snapshot_rows = [
            {
                "year": s.year,
                "timestamp": s.timestamp,
                "title": s.title,
                "meta_description": s.meta_description,
                "language": s.language,
                "is_redirect": s.is_redirect,
            }
            for s in history_result.snapshots
        ]

    timeline = topics.topic_timeline(snapshot_rows)
    for row, entry in zip(snapshot_rows, timeline):
        row["topic"] = entry.get("topic")
    switch_count = topics.count_topic_switches(timeline) if snapshot_rows else None

    # --- backlink provider -------------------------------------------------
    reuse_backlinks = not force and not _stale(
        stamps.get("last_backlink_checked"), BACKLINK_TTL_HOURS / 24.0
    )
    if reuse_backlinks:
        stored = storage.get_domain(domain) or {}
        metrics = backlinks.BacklinkMetrics(
            provider=stored.get("backlink_provider") or "cache",
            queried=stored.get("referring_domains") is not None,
            referring_domains=stored.get("referring_domains"),
            total_backlinks=stored.get("total_backlinks"),
            follow_backlinks=stored.get("follow_backlinks"),
            nofollow_backlinks=stored.get("nofollow_backlinks"),
            lost_backlinks=stored.get("lost_backlinks"),
            new_backlinks=stored.get("new_backlinks"),
            top_referring_domains=stored.get("top_referring_domains") or [],
            top_referring_tlds=stored.get("top_referring_tlds") or [],
            anchor_counts=[
                {"anchor": a.get("text"), "count": a.get("count")}
                for a in (stored.get("top_anchors") or [])
            ]
            or None,
            error=stored.get("backlink_error"),
        )
    else:
        try:
            metrics = provider.get_domain_metrics(domain)
        except Exception as exc:
            logger.warning("Backlink lookup failed for %s: %s", domain, exc)
            metrics = backlinks.BacklinkMetrics(
                provider=getattr(provider, "name", "unknown"), queried=True, error=str(exc)
            )

        payload.update(
            backlink_provider=metrics.provider,
            backlink_error=metrics.error,
            referring_domains=metrics.referring_domains,
            total_backlinks=metrics.total_backlinks,
            follow_backlinks=metrics.follow_backlinks,
            nofollow_backlinks=metrics.nofollow_backlinks,
            lost_backlinks=metrics.lost_backlinks,
            new_backlinks=metrics.new_backlinks,
            top_referring_domains=metrics.top_referring_domains,
            top_referring_tlds=metrics.top_referring_tlds,
            last_backlink_checked=_iso(),
        )

    # --- derived analysis --------------------------------------------------
    niche_words = _niche_keyword_set(niches)
    spam_words = spam.spam_keyword_set()

    anchor_profile = anchors.build_profile(
        metrics.anchor_counts, domain, spam_words, niche_words
    )

    evidence = topics.TextEvidence(
        titles=[s["title"] for s in snapshot_rows if s.get("title")],
        metas=[s["meta_description"] for s in snapshot_rows if s.get("meta_description")],
        urls=[domain],
        anchors=[a.text for a in anchor_profile.top_anchors],
    )

    topic_result = topics.classify(evidence)
    relevance_score, relevance_band = topics.relevance(evidence, niches)

    spam_assessment = spam.assess(
        domain=domain,
        evidence=evidence,
        anchor_profile=anchor_profile,
        topic_switch_count=switch_count,
        referring_domains=metrics.referring_domains,
        new_backlinks=metrics.new_backlinks,
        lost_backlinks=metrics.lost_backlinks,
        total_backlinks=metrics.total_backlinks,
    )

    age = _age_years(registration_date)

    score = scoring.compute(
        domain=domain,
        metrics=metrics,
        history=history_result,
        anchor_profile=anchor_profile,
        spam_assessment=spam_assessment,
        switch_count=switch_count,
        relevance_score=relevance_score,
        relevance_band=relevance_band,
        age_years=age,
        niches_configured=bool(niches),
    )

    payload.update(
        domain_age_years=age,
        anchor_total=anchor_profile.total,
        branded_pct=anchor_profile.branded_pct,
        generic_pct=anchor_profile.generic_pct,
        exact_match_pct=anchor_profile.exact_match_pct,
        suspicious_anchor_pct=anchor_profile.suspicious_pct,
        top_anchors=[
            {"text": a.text, "count": a.count, "share_pct": a.share_pct, "kind": a.kind}
            for a in anchor_profile.top_anchors
        ],
        primary_topic=topic_result.primary_topic,
        secondary_topics=topic_result.secondary_topics,
        topic_match_count=topic_result.topic_match_count or None,
        topic_match_strength=topic_result.match_strength if topic_result.has_data else None,
        historical_topic=topics.dominant_topic(timeline),
        topic_switch_count=switch_count,
        historical_stability=topics.stability_label(switch_count) if switch_count is not None else None,
        relevance_score=relevance_score,
        relevance_band=relevance_band if relevance_score is not None else None,
        spam_risk_score=spam_assessment.score,
        spam_risk_level=spam_assessment.level,
        spam_signals=[asdict(s) for s in spam_assessment.signals],
        spam_categories=spam_assessment.detected_categories,
        seo_base_score=score.base_score,
        spam_penalty=score.spam_penalty,
        seo_score=score.final_score,
        seo_label=score.label,
        seo_confidence=score.confidence,
        seo_coverage_pct=score.completeness_pct,
        seo_unscored_reason=score.unscored_reason,
        score_components=[asdict(c) for c in score.components],
        score_reasons=score.reasons,
        score_concerns=score.concerns,
    )

    payload["_snapshots"] = snapshot_rows
    payload["_refreshed_history"] = not reuse_history
    return payload


def persist(domain: str, payload: dict[str, Any]) -> None:
    """Write one enrichment result, including its history rows."""
    snapshots = payload.pop("_snapshots", [])
    refreshed_history = payload.pop("_refreshed_history", False)

    storage.save_enrichment(domain, payload)
    if refreshed_history:
        storage.replace_snapshots(domain, snapshots)
    storage.record_metric_history(
        domain,
        {
            "referring_domains": payload.get("referring_domains"),
            "total_backlinks": payload.get("total_backlinks"),
            "spam_risk_score": payload.get("spam_risk_score"),
            "seo_score": payload.get("seo_score"),
        },
    )


def run_enrichment(
    domains: Optional[Iterable[str]] = None,
    force: bool = False,
    limit: Optional[int] = None,
    state: EnrichmentState = ENRICHMENT,
    run_id: Optional[str] = None,
    include_safe: bool = False,
) -> dict[str, Any]:
    """Enrich stored domains with archive, backlink, topic and score data.

    By default only interesting lifecycle states (pending delete, redemption,
    expired, expiring) plus watchlisted domains are enriched, ordered by
    urgency, so expensive external calls are not wasted on Safe domains. Runs
    under bounded concurrency; one domain's failure is recorded and the pass
    continues.
    """
    provider = backlinks.build_provider()
    provider_name = getattr(provider, "name", "unknown")

    if run_id is None:
        run_id = uuid.uuid4().hex[:12]
        state.begin(run_id, provider_name)
    else:
        state.update(provider=provider_name)

    history = history_client.HistoryClient(pool_size=ENRICH_WORKERS)

    try:
        storage.migrate()
        niches = storage.target_niches()

        explicit = {d for d in (normalize_domain(x) for x in (domains or [])) if d}
        if explicit:
            pending = [row for row in storage.all_domains() if row["domain"] in explicit]
            pending = [
                {**row, **(storage.get_domain(row["domain"]) or {})} for row in pending
            ]
        else:
            # Only lifecycle states worth paying for, unless the caller opts out.
            # A Safe domain is not an acquisition candidate, so it does not get
            # billed against the backlink or archive budget.
            categories = () if include_safe else None
            pending = storage.domains_needing_enrichment_scoped(
                0 if force else BACKLINK_TTL_HOURS,
                0 if force else HISTORY_TTL_DAYS,
                limit,
                categories,
            )
        if limit:
            pending = pending[: int(limit)]

        state.update(total=len(pending))
        logger.info(
            "[enrich] %d domains queued (provider=%s, include_safe=%s)",
            len(pending),
            provider_name,
            include_safe,
        )
        if not pending:
            state.finish()
            return state.snapshot()

        batch: list[tuple[str, dict[str, Any]]] = []
        with ThreadPoolExecutor(max_workers=ENRICH_WORKERS) as pool:
            futures = {
                pool.submit(
                    enrich_domain,
                    row["domain"],
                    row.get("registration_date"),
                    history,
                    provider,
                    niches,
                    row,
                    force,
                ): row["domain"]
                for row in pending
            }
            for future in as_completed(futures):
                domain = futures[future]
                try:
                    payload = future.result()
                except Exception as exc:
                    logger.warning("Enrichment crashed for %s: %s", domain, exc)
                    state.fail()
                    continue

                state.bump(payload)
                batch.append((domain, payload))
                if len(batch) >= ENRICH_BATCH_SIZE:
                    for name, data in batch:
                        persist(name, data)
                    batch = []

        for name, data in batch:
            persist(name, data)

        state.finish()
    except Exception as exc:
        logger.exception("Enrichment run %s failed", run_id)
        state.finish(error=str(exc))
    finally:
        history.close()
        close = getattr(provider, "close", None)
        if callable(close):
            close()

    return state.snapshot()


def start_enrichment_async(**kwargs: Any) -> dict[str, Any]:
    """Kick off enrichment on a background thread. Refuses to double-run."""
    if ENRICHMENT.is_running():
        return {
            "started": False,
            "reason": "An enrichment pass is already running",
            **ENRICHMENT.snapshot(),
        }

    run_id = uuid.uuid4().hex[:12]
    ENRICHMENT.begin(run_id, backlinks.configured_provider_name() or "none")
    thread = threading.Thread(
        target=run_enrichment,
        kwargs={**kwargs, "run_id": run_id},
        daemon=True,
        name="domain-enrich",
    )
    thread.start()
    return {"started": True, **ENRICHMENT.snapshot()}


def data_sources() -> list[dict[str, Any]]:
    """Status of every external source, for the Data Sources panel."""
    provider = backlinks.provider_status()
    return [
        {
            "key": "rdap",
            "label": "RDAP",
            "status": "Connected",
            "available": True,
            "detail": "IANA bootstrap registry",
        },
        {
            "key": "wayback",
            "label": "Wayback Machine",
            "status": "Available" if history_client.ENABLED else "Disabled",
            "available": history_client.ENABLED,
            "detail": f"CDX index, {history_client.SNAPSHOT_SAMPLE_SIZE} snapshots sampled per domain",
        },
        {
            "key": "backlinks",
            "label": "Backlink Provider",
            "status": (provider["provider"] or "").title() if provider["configured"] else "Not Configured",
            "available": provider["configured"],
            "detail": provider["reason"] or f"Provider: {provider['provider']}",
        },
    ]
