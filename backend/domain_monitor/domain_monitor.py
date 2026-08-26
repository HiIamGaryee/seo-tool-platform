from __future__ import annotations

import csv
import io
import logging
import os
import threading
import uuid
from dataclasses import asdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable, Optional

import classifier
import domain_sources
import source_config
import storage
from source_adapters import InlineListSource
from models import (
    CAT_30,
    CAT_60,
    CAT_EXPIRED,
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_UNKNOWN,
    LOOKUP_FAILED,
    LOOKUP_NOT_FOUND,
    LOOKUP_OK,
    LOOKUP_UNSUPPORTED_TLD,
    PRI_UNKNOWN,
    DomainRecord,
    normalize_domain,
    tld_of,
)
from rdap_client import RdapClient, RdapError

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


ALLOW_WHOIS_FALLBACK = os.environ.get("DOMAIN_MONITOR_WHOIS_FALLBACK", "0") == "1"

EXPORT_FIELDS = [
    ("domain", "Domain"),
    ("category", "Lifecycle Status"),
    ("expiration_date", "Expiry Date"),
    ("days_left", "Days Left"),
    ("registry_status", "Registry Status"),
    ("registrar", "Registrar"),
    ("priority", "Priority"),
    ("referring_domains", "Referring Domains"),
    ("total_backlinks", "Backlinks"),
    ("follow_percentage", "Follow %"),
    ("domain_age_years", "Domain Age (years)"),
    ("primary_topic", "Primary Topic"),
    ("relevance_band", "Topical Relevance"),
    ("spam_risk_level", "Spam Risk"),
    ("spam_risk_score", "Spam Score"),
    ("seo_score", "SEO Score"),
    ("seo_confidence", "Score Confidence"),
    ("seo_coverage_pct", "Model Coverage %"),
    ("historical_stability", "Historical Stability"),
    ("first_archive_seen", "First Seen"),
    ("snapshot_count", "Archive Captures"),
    ("last_rdap_checked", "Last RDAP Check"),
    ("last_backlink_checked", "Last Backlink Refresh"),
    ("last_history_checked", "Last Archive Refresh"),
    ("watchlisted", "Watchlist"),
    ("notes", "Notes"),
]

_LOOKUP_ERROR_KINDS = {
    "not_found": LOOKUP_NOT_FOUND,
    "unsupported_tld": LOOKUP_UNSUPPORTED_TLD,
}


class ScanState:
    """Live progress for one scan, polled by the dashboard.

    A scan runs on a worker thread so the HTTP request returns immediately and
    the UI never blocks.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = self._idle()

    @staticmethod
    def _idle() -> dict[str, Any]:
        return {
            "scan_id": None,
            "status": "idle",
            "phase": "idle",
            "checked": 0,
            "total": 0,
            "collected": 0,
            "discovered": 0,
            "valid": 0,
            "unique": 0,
            "duplicates": 0,
            "invalid": 0,
            "truncated": False,
            "skipped_cached": 0,
            "expired": 0,
            "expiring_30": 0,
            "expiring_31_60": 0,
            "redemption": 0,
            "pending_delete": 0,
            "unknown": 0,
            "failed": 0,
            "sources": {},
            "source_reports": [],
            "no_sources_configured": False,
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

    def begin(self, scan_id: str) -> None:
        with self._lock:
            self._state = self._idle()
            self._state.update(
                scan_id=scan_id,
                status="running",
                phase="collecting",
                started_at=storage.now_iso(),
            )

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def bump(self, category: str) -> None:
        key = {
            CAT_EXPIRED: "expired",
            CAT_30: "expiring_30",
            CAT_60: "expiring_31_60",
            CAT_REDEMPTION: "redemption",
            CAT_PENDING_DELETE: "pending_delete",
            CAT_UNKNOWN: "unknown",
        }.get(category)
        with self._lock:
            self._state["checked"] += 1
            if key:
                self._state[key] += 1

    def fail(self) -> None:
        with self._lock:
            self._state["checked"] += 1
            self._state["failed"] += 1

    def finish(self, error: Optional[str] = None) -> None:
        with self._lock:
            self._state.update(
                status="error" if error else "completed",
                phase="error" if error else "done",
                finished_at=storage.now_iso(),
                error=error,
            )


SCAN = ScanState()


def verify_domain(
    client: RdapClient,
    domain: str,
    source: Optional[str],
    first_seen: Optional[str],
) -> DomainRecord:
    """RDAP-verify one domain and classify it.

    Never raises: a failed lookup becomes a record with lookup_status set, so
    one bad domain cannot stop a scan.
    """
    record = DomainRecord(
        id=domain,
        domain=domain,
        tld=tld_of(domain),
        source=source,
        first_seen=first_seen,
        last_checked=storage.now_iso(),
        quality_score=classifier.quality_score(domain),
    )

    try:
        result = client.lookup(domain)
    except RdapError as exc:
        record.lookup_status = _LOOKUP_ERROR_KINDS.get(exc.kind, LOOKUP_FAILED)
        record.lookup_error = str(exc)
        record.category = CAT_UNKNOWN
        record.priority = PRI_UNKNOWN
        return record
    except Exception as exc:  # defensive: an unexpected error is still one row
        logger.warning("Unexpected lookup error for %s: %s", domain, exc)
        record.lookup_status = LOOKUP_FAILED
        record.lookup_error = f"Unexpected error: {exc}"
        return record

    record.expiration_date = result.expiration_date
    record.registration_date = result.registration_date
    record.registry_status = result.registry_status
    record.registrar = result.registrar
    record.nameservers = result.nameservers
    record.rdap_source = result.rdap_source
    record.days_left = classifier.days_left_from(result.expiration_date)
    record.category, record.priority = classifier.classify(
        result.registry_status, record.days_left
    )
    record.lookup_status = LOOKUP_OK
    # Availability is deliberately left unknown: an expired or pending-delete
    # domain is not necessarily registrable, and RDAP cannot tell us that.
    record.available = None
    return record


def run_scan(
    domains: Optional[Iterable[str]] = None,
    use_sources: bool = True,
    force: bool = False,
    limit: Optional[int] = None,
    state: ScanState = SCAN,
    scan_id: Optional[str] = None,
    source_kinds: Optional[Iterable[str]] = None,
    enrich: bool = False,
) -> dict[str, Any]:
    """Discover candidates from configured sources, then RDAP-verify them.

    Pipeline: sources -> normalise -> deduplicate -> store -> RDAP -> classify.
    Deduplication happens before any lookup, RDAP stays the authority on
    lifecycle, and a domain checked inside the cache TTL is skipped entirely.
    """
    settings = source_config.load_settings()

    if scan_id is None:
        scan_id = uuid.uuid4().hex[:12]
        state.begin(scan_id)

    client = RdapClient(
        timeout=settings.rdap_timeout,
        max_retries=settings.rdap_max_retries,
        min_host_interval=settings.rdap_min_host_interval,
        allow_whois_fallback=ALLOW_WHOIS_FALLBACK,
        pool_size=settings.rdap_concurrency,
    )

    try:
        storage.migrate()

        # --- discovery -----------------------------------------------------
        sources: list[Any] = []
        if domains:
            sources.append(InlineListSource(settings, list(domains)))
        if use_sources:
            configured, settings = domain_sources.build_sources(settings, source_kinds)
            sources.extend(configured)

        collection = domain_sources.collect(sources, settings)
        origin = collection.origins
        kind_by_name = {
            report.name: report.kind for report in collection.reports
        }

        state.update(
            collected=collection.unique,
            discovered=collection.discovered,
            valid=collection.valid,
            unique=collection.unique,
            duplicates=collection.duplicates,
            invalid=collection.invalid,
            truncated=collection.truncated,
            sources=collection.per_source(),
            source_reports=[asdict(report) for report in collection.reports],
            no_sources_configured=not collection.any_source_configured and not domains,
            phase="verifying",
        )

        if collection.domains:
            storage.add_candidates(collection.domains, "discovery")
            storage.link_sources(origin, kind_by_name)

        # --- decide what to verify ----------------------------------------
        explicit = {d for d in (normalize_domain(x) for x in (domains or [])) if d}
        if explicit:
            # An explicit request re-checks exactly those domains, cached or not,
            # so a single-row recheck never fans out across the whole table.
            pending = [row for row in storage.all_domains() if row["domain"] in explicit]
        elif force:
            pending = storage.all_domains()
        else:
            pending = storage.domains_needing_rdap(settings.rdap_cache_hours, limit)
        if limit:
            pending = pending[: int(limit)]

        stored_total = storage.stats()["total"]
        state.update(
            total=len(pending),
            skipped_cached=max(0, stored_total - len(pending)),
        )

        if not pending:
            state.finish()
            return state.snapshot()

        # --- RDAP verification in bounded batches -------------------------
        batch_size = settings.scan_batch_size
        batch_count = (len(pending) + batch_size - 1) // batch_size
        written: list[DomainRecord] = []

        for index in range(0, len(pending), batch_size):
            chunk = pending[index : index + batch_size]
            logger.info(
                "[rdap] checking batch %d / %d (%d domains)",
                index // batch_size + 1,
                batch_count,
                len(chunk),
            )

            with ThreadPoolExecutor(max_workers=settings.rdap_concurrency) as pool:
                futures = {
                    pool.submit(
                        verify_domain,
                        client,
                        row["domain"],
                        origin.get(row["domain"]) or row.get("source"),
                        row.get("first_seen"),
                    ): row["domain"]
                    for row in chunk
                }
                for future in as_completed(futures):
                    domain = futures[future]
                    try:
                        record = future.result()
                    except Exception as exc:  # verify_domain absorbs its own errors
                        logger.warning("[rdap] worker crashed on %s: %s", domain, exc)
                        state.fail()
                        continue

                    if record.lookup_status == LOOKUP_OK:
                        state.bump(record.category)
                        logger.info(
                            "[rdap] %s -> %s",
                            record.domain,
                            (record.registry_status or [record.category])[0],
                        )
                    else:
                        state.fail()
                        logger.info("[rdap] %s -> %s", record.domain, record.lookup_status)

                    written.append(record)
                    storage.record_status_history(
                        record.domain,
                        {
                            "registry_status": record.registry_status,
                            "expiration_date": record.expiration_date,
                            "category": record.category,
                            "days_left": record.days_left,
                            "checked_at": record.last_checked,
                        },
                    )

            # Flush per batch so a long scan is durable as it goes.
            if written:
                storage.upsert_many(written)
                written = []

        state.finish()
    except Exception as exc:
        logger.exception("Scan %s failed", scan_id)
        state.finish(error=str(exc))
    finally:
        client.close()

    if enrich:
        # Only interesting lifecycle states are enriched, so SEO API calls are
        # not spent on domains that are years from expiring.
        try:
            import enrichment

            enrichment.start_enrichment_async()
        except Exception as exc:
            logger.warning("Could not chain enrichment after scan: %s", exc)

    return state.snapshot()


def start_scan_async(**kwargs: Any) -> dict[str, Any]:
    """Kick off a scan on a background thread. Refuses to double-run.

    The state is marked running before the thread starts, so the caller's
    first poll always sees a live scan rather than a stale idle snapshot.
    """
    if SCAN.is_running():
        return {"started": False, "reason": "A scan is already running", **SCAN.snapshot()}

    scan_id = uuid.uuid4().hex[:12]
    SCAN.begin(scan_id)
    thread = threading.Thread(
        target=run_scan,
        kwargs={**kwargs, "scan_id": scan_id},
        daemon=True,
        name="domain-scan",
    )
    thread.start()
    return {"started": True, **SCAN.snapshot()}


def import_domains(text: str, source: str = "import") -> dict[str, Any]:
    """Parse a pasted / uploaded TXT or CSV blob into candidate rows.

    Every line is validated as a hostname before it reaches the database; the
    raw text is never executed, resolved as a path, or used to build a URL.
    """
    storage.migrate()

    valid: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    duplicates_in_file = 0

    for cell in domain_sources.parse_candidate_lines(text):
        domain = normalize_domain(cell)
        if not domain:
            if len(invalid) < 50:
                invalid.append(cell[:100])
            continue
        if domain in seen:
            duplicates_in_file += 1
            continue
        seen.add(domain)
        valid.append(domain)

    inserted, already_present = storage.add_candidates(valid, source)
    _append_to_import_source(valid)

    return {
        "imported": inserted,
        "duplicates": already_present + duplicates_in_file,
        "invalid": len(invalid),
        "invalid_samples": invalid[:10],
        "total_lines_parsed": len(valid) + len(invalid) + duplicates_in_file,
    }


def _append_to_import_source(domains: Iterable[str]) -> None:
    """Mirror imported candidates into the ManualFileSource file.

    Manual import stays a real, re-readable source so a scheduled scan can
    reproduce the same candidate set without the dashboard.
    """
    domains = list(domains)
    if not domains:
        return
    path = domain_sources.manual_import_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = set()
        if path.exists():
            existing = {
                line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
            }
        fresh = [d for d in domains if d not in existing]
        if fresh:
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(fresh) + "\n")
    except OSError as exc:
        logger.warning("Could not mirror import into %s: %s", path, exc)


def _export_cell(row: dict[str, Any], key: str) -> Any:
    """One export cell. Missing data stays blank; it is never coerced to zero."""
    if key == "registry_status":
        return ", ".join(row.get("registry_status") or [])
    if key == "follow_percentage":
        follow = row.get("follow_backlinks")
        total = row.get("total_backlinks")
        if follow is None or not total:
            return ""
        return round(follow / total * 100, 1)
    if key == "watchlisted":
        return "yes" if row.get("watchlisted") else "no"
    if key == "domain_age_years":
        age = row.get("domain_age_years")
        return "" if age is None else round(float(age), 1)
    value = row.get(key)
    return "" if value is None else value


def export_rows(**filters: Any) -> tuple[list[str], list[list[Any]]]:
    """Header labels plus the filtered rows, shared by CSV and XLSX export."""
    rows = storage.iter_filtered(**filters)
    header = [label for _, label in EXPORT_FIELDS]
    body = [[_export_cell(row, key) for key, _ in EXPORT_FIELDS] for row in rows]
    return header, body


def export_csv(**filters: Any) -> str:
    """Render the current filtered result set as CSV text."""
    header, body = export_rows(**filters)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(body)
    return buffer.getvalue()


def export_xlsx(**filters: Any) -> bytes:
    """Render the same rows as a workbook, reusing the project's pandas stack."""
    import pandas as pd

    header, body = export_rows(**filters)
    frame = pd.DataFrame(body, columns=header)
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        frame.to_excel(writer, index=False, sheet_name="SEO Domain Radar")
    return buffer.getvalue()


def main_cli() -> None:
    """Entry point for a scheduled scan.

    Wire this into whatever scheduler you already run, e.g. a daily crontab
    line. No scheduler package is bundled.

        cd backend && python3 domain_monitor/domain_monitor.py --force
    """
    import argparse

    parser = argparse.ArgumentParser(description="Run a Domain Monitor scan")
    parser.add_argument("--force", action="store_true", help="Re-check every stored domain")
    parser.add_argument("--limit", type=int, default=None, help="Cap domains checked this run")
    parser.add_argument("--no-sources", action="store_true", help="Skip configured sources")
    parser.add_argument(
        "--sources",
        default="",
        help="Comma-separated source kinds to use (default: all enabled)",
    )
    parser.add_argument(
        "--enrich", action="store_true", help="Chain SEO enrichment after the scan"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    kinds = [k.strip() for k in args.sources.split(",") if k.strip()] or None
    result = run_scan(
        use_sources=not args.no_sources,
        force=args.force,
        limit=args.limit,
        source_kinds=kinds,
        enrich=args.enrich,
    )
    if result.get("no_sources_configured"):
        print("No domain sources configured. Import a TXT/CSV list or set DOMAIN_SOURCES.")
        return
    print(
        f"discovered {result['discovered']}, valid {result['valid']}, "
        f"unique {result['unique']}, duplicates {result['duplicates']}"
    )
    print(
        f"scan {result['scan_id']}: {result['checked']}/{result['total']} checked, "
        f"{result['expired']} expired, {result['expiring_30']} <=30d, "
        f"{result['expiring_31_60']} 31-60d, {result['redemption']} redemption, "
        f"{result['pending_delete']} pending delete, {result['failed']} failed"
    )


if __name__ == "__main__":
    main_cli()
