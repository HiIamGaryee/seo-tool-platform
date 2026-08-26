from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import schema
from models import DomainRecord, tld_of

logger = logging.getLogger(__name__)

DB_PATH = Path(
    os.environ.get(
        "DOMAIN_MONITOR_DB",
        str(Path(__file__).resolve().parent / "data" / "domain_monitor.db"),
    )
)

SCHEMA_VERSION = schema.SCHEMA_VERSION

# Columns the API is allowed to sort by. Anything else falls back to priority.
SORTABLE = {
    "domain": "domain",
    "tld": "tld",
    "expiration_date": "expiration_date",
    "days_left": "days_left",
    "registrar": "registrar",
    "category": "category",
    "priority": "priority_rank",
    "quality_score": "quality_score",
    "last_checked": "last_checked",
    "first_seen": "first_seen",
    "seo_score": "seo_score",
    "referring_domains": "referring_domains",
    "total_backlinks": "total_backlinks",
    "spam_risk_score": "spam_risk_score",
    "domain_age_years": "domain_age_years",
    "primary_topic": "primary_topic",
}

# Lower rank = more urgent, so the default listing leads with what matters.
PRIORITY_RANK = {
    "Critical": 0,
    "Very High": 1,
    "High": 2,
    "Medium": 3,
    "Watch": 4,
    "Low": 5,
    "Unknown": 6,
}

_CREATE = """
CREATE TABLE IF NOT EXISTS domains (
    id                TEXT PRIMARY KEY,
    domain            TEXT NOT NULL UNIQUE,
    tld               TEXT NOT NULL,
    expiration_date   TEXT,
    days_left         INTEGER,
    registry_status   TEXT NOT NULL DEFAULT '[]',
    registrar         TEXT,
    registration_date TEXT,
    nameservers       TEXT NOT NULL DEFAULT '[]',
    category          TEXT NOT NULL,
    priority          TEXT NOT NULL,
    priority_rank     INTEGER NOT NULL DEFAULT 6,
    quality_score     INTEGER,
    available         INTEGER,
    lookup_status     TEXT NOT NULL DEFAULT 'ok',
    lookup_error      TEXT,
    rdap_source       TEXT,
    source            TEXT,
    first_seen        TEXT NOT NULL,
    last_checked      TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_category ON domains(category);
CREATE INDEX IF NOT EXISTS idx_domains_priority ON domains(priority_rank);
CREATE INDEX IF NOT EXISTS idx_domains_tld ON domains(tld);
CREATE INDEX IF NOT EXISTS idx_domains_checked ON domains(last_checked);

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def migrate() -> None:
    """Create or upgrade the schema in place. Idempotent and additive.

    Version 2 adds the SEO columns and the history tables via ALTER TABLE, so
    an existing database keeps every row it already had.
    """
    with _lock, connect() as conn:
        conn.executescript(_CREATE)

        existing = {row["name"] for row in conn.execute("PRAGMA table_info(domains)")}
        added = 0
        for column, ddl in schema.SEO_COLUMNS:
            if column not in existing:
                conn.execute(f"ALTER TABLE domains ADD COLUMN {column} {ddl}")
                added += 1

        conn.executescript(schema.HISTORY_TABLES)

        # Backfill the RDAP stamp for rows written before the split.
        conn.execute(
            "UPDATE domains SET last_rdap_checked = last_checked "
            "WHERE last_rdap_checked IS NULL AND last_checked IS NOT NULL"
        )

        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES('version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )

    if added:
        logger.info("Domain radar schema upgraded: %d new columns", added)
    logger.info("Domain radar schema ready at %s (v%d)", DB_PATH, SCHEMA_VERSION)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data.pop("priority_rank", None)
    for key in schema.JSON_COLUMNS:
        if key in data:
            try:
                data[key] = json.loads(data.get(key) or "[]")
            except ValueError:
                data[key] = []
    for flag in ("available", "watchlisted", "snapshot_count_truncated"):
        if flag in data:
            value = data.get(flag)
            data[flag] = None if value is None else bool(value)
    return data


def upsert_many(records: Iterable[DomainRecord]) -> int:
    """Batch-write records. Existing rows keep their original first_seen."""
    rows = [
        (
            r.id,
            r.domain,
            r.tld or tld_of(r.domain),
            r.expiration_date,
            r.days_left,
            json.dumps(r.registry_status or []),
            r.registrar,
            r.registration_date,
            json.dumps(r.nameservers or []),
            r.category,
            r.priority,
            PRIORITY_RANK.get(r.priority, 6),
            r.quality_score,
            None if r.available is None else int(r.available),
            r.lookup_status,
            r.lookup_error,
            r.rdap_source,
            r.source,
            r.first_seen or now_iso(),
            r.last_checked,
        )
        for r in records
    ]
    if not rows:
        return 0

    with _lock, connect() as conn:
        conn.executemany(
            """
            INSERT INTO domains (
                id, domain, tld, expiration_date, days_left, registry_status,
                registrar, registration_date, nameservers, category, priority,
                priority_rank, quality_score, available, lookup_status,
                lookup_error, rdap_source, source, first_seen, last_checked
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(domain) DO UPDATE SET
                expiration_date   = excluded.expiration_date,
                days_left         = excluded.days_left,
                registry_status   = excluded.registry_status,
                registrar         = excluded.registrar,
                registration_date = excluded.registration_date,
                nameservers       = excluded.nameservers,
                category          = excluded.category,
                priority          = excluded.priority,
                priority_rank     = excluded.priority_rank,
                quality_score     = excluded.quality_score,
                available         = excluded.available,
                lookup_status     = excluded.lookup_status,
                lookup_error      = excluded.lookup_error,
                rdap_source       = excluded.rdap_source,
                source            = COALESCE(excluded.source, domains.source),
                last_checked      = excluded.last_checked
            """,
            rows,
        )
    return len(rows)


def add_candidates(domains: Iterable[str], source: str) -> tuple[int, int]:
    """Register unverified candidates. Returns (inserted, already_present)."""
    from classifier import quality_score
    from models import CAT_UNKNOWN, PRI_UNKNOWN

    unique = list(dict.fromkeys(domains))
    if not unique:
        return 0, 0

    stamp = now_iso()
    rows = [
        (
            d,
            d,
            tld_of(d),
            CAT_UNKNOWN,
            PRI_UNKNOWN,
            PRIORITY_RANK[PRI_UNKNOWN],
            quality_score(d),
            source,
            stamp,
        )
        for d in unique
    ]

    with _lock, connect() as conn:
        before = conn.execute("SELECT COUNT(*) FROM domains").fetchone()[0]
        conn.executemany(
            """
            INSERT INTO domains (
                id, domain, tld, category, priority, priority_rank,
                quality_score, source, first_seen
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(domain) DO NOTHING
            """,
            rows,
        )
        after = conn.execute("SELECT COUNT(*) FROM domains").fetchone()[0]

    inserted = after - before
    return inserted, len(unique) - inserted


def get_domain(domain: str) -> Optional[dict[str, Any]]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM domains WHERE domain = ?", (domain,)).fetchone()
    return _row_to_dict(row) if row else None


RD_WINDOWS = {
    "0-10": "referring_domains IS NOT NULL AND referring_domains <= 10",
    "11-50": "referring_domains BETWEEN 11 AND 50",
    "51-100": "referring_domains BETWEEN 51 AND 100",
    "100+": "referring_domains > 100",
}

AGE_WINDOWS = {
    "<1": "domain_age_years IS NOT NULL AND domain_age_years < 1",
    "1-3": "domain_age_years >= 1 AND domain_age_years < 3",
    "3-5": "domain_age_years >= 3 AND domain_age_years < 5",
    "5-10": "domain_age_years >= 5 AND domain_age_years < 10",
    "10+": "domain_age_years >= 10",
}

EXPIRY_WINDOWS = {
    "expired": "days_left IS NOT NULL AND days_left < 0",
    "0-30": "days_left BETWEEN 0 AND 30",
    "31-60": "days_left BETWEEN 31 AND 60",
    "60+": "days_left > 60",
}


def _build_filters(
    search: Optional[str],
    category: Optional[str],
    priority: Optional[str],
    tld: Optional[str],
    status: Optional[str],
    days: Optional[str],
    seo_min: Optional[int] = None,
    spam_level: Optional[str] = None,
    relevance: Optional[str] = None,
    topic: Optional[str] = None,
    referring: Optional[str] = None,
    age: Optional[str] = None,
    watchlisted: Optional[bool] = None,
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    if search:
        clauses.append("domain LIKE ?")
        params.append(f"%{search.strip().lower()}%")
    if category:
        clauses.append("category = ?")
        params.append(category)
    if priority:
        clauses.append("priority = ?")
        params.append(priority)
    if tld:
        clauses.append("tld = ?")
        params.append(tld if tld.startswith(".") else f".{tld}")
    if status:
        clauses.append("LOWER(REPLACE(REPLACE(registry_status,' ',''),'\"','')) LIKE ?")
        params.append(f"%{status.replace(' ', '').lower()}%")

    if days and days in EXPIRY_WINDOWS:
        clauses.append(EXPIRY_WINDOWS[days])

    # SEO filters. Each requires the metric to be present, so a NULL never
    # silently satisfies a numeric threshold.
    if seo_min is not None:
        clauses.append("seo_score IS NOT NULL AND seo_score >= ?")
        params.append(int(seo_min))
    if spam_level:
        clauses.append("spam_risk_level = ?")
        params.append(spam_level)
    if relevance:
        clauses.append("relevance_band = ?")
        params.append(relevance)
    if topic:
        clauses.append("primary_topic = ?")
        params.append(topic)
    if referring and referring in RD_WINDOWS:
        clauses.append(RD_WINDOWS[referring])
    if age and age in AGE_WINDOWS:
        clauses.append(AGE_WINDOWS[age])
    if watchlisted:
        clauses.append("watchlisted = 1")

    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def list_domains(
    search: Optional[str] = None,
    category: Optional[str] = None,
    priority: Optional[str] = None,
    tld: Optional[str] = None,
    status: Optional[str] = None,
    days: Optional[str] = None,
    seo_min: Optional[int] = None,
    spam_level: Optional[str] = None,
    relevance: Optional[str] = None,
    topic: Optional[str] = None,
    referring: Optional[str] = None,
    age: Optional[str] = None,
    watchlisted: Optional[bool] = None,
    page: int = 1,
    limit: int = 20,
    sort: str = "priority",
    order: str = "asc",
) -> dict[str, Any]:
    """Filtered, sorted, paginated listing. All inputs are whitelisted."""
    where, params = _build_filters(
        search, category, priority, tld, status, days,
        seo_min, spam_level, relevance, topic, referring, age, watchlisted,
    )
    column = SORTABLE.get(sort, "priority_rank")
    direction = "DESC" if str(order).lower() == "desc" else "ASC"
    page = max(1, int(page))
    limit = max(1, min(int(limit), 200))
    offset = (page - 1) * limit

    with connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM domains{where}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM domains{where} "
            f"ORDER BY {column} IS NULL, {column} {direction}, domain ASC "
            f"LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()

    return {
        "items": [_row_to_dict(r) for r in rows],
        "total": total,
        "page": page,
        "limit": limit,
        "pages": (total + limit - 1) // limit if total else 0,
    }


def iter_filtered(**filters: Any) -> list[dict[str, Any]]:
    """Every row matching the filters, ignoring pagination. Used by export."""
    where, params = _build_filters(
        filters.get("search"),
        filters.get("category"),
        filters.get("priority"),
        filters.get("tld"),
        filters.get("status"),
        filters.get("days"),
        filters.get("seo_min"),
        filters.get("spam_level"),
        filters.get("relevance"),
        filters.get("topic"),
        filters.get("referring"),
        filters.get("age"),
        filters.get("watchlisted"),
    )
    column = SORTABLE.get(filters.get("sort") or "priority", "priority_rank")
    direction = "DESC" if str(filters.get("order", "asc")).lower() == "desc" else "ASC"
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM domains{where} ORDER BY {column} IS NULL, {column} {direction}, domain ASC",
            params,
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def stats() -> dict[str, Any]:
    """Summary counters for the dashboard cards."""
    from models import (
        CAT_30,
        CAT_60,
        CAT_EXPIRED,
        CAT_PENDING_DELETE,
        CAT_REDEMPTION,
        CAT_SAFE,
        CAT_UNKNOWN,
    )

    with connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM domains").fetchone()[0]
        by_category = {
            row["category"]: row["n"]
            for row in conn.execute("SELECT category, COUNT(*) AS n FROM domains GROUP BY category")
        }
        by_priority = {
            row["priority"]: row["n"]
            for row in conn.execute("SELECT priority, COUNT(*) AS n FROM domains GROUP BY priority")
        }
        tlds = [
            {"tld": row["tld"], "count": row["n"]}
            for row in conn.execute(
                "SELECT tld, COUNT(*) AS n FROM domains GROUP BY tld ORDER BY n DESC, tld ASC LIMIT 25"
            )
        ]
        never = conn.execute("SELECT COUNT(*) FROM domains WHERE last_checked IS NULL").fetchone()[0]
        failed = conn.execute(
            "SELECT COUNT(*) FROM domains WHERE lookup_status != 'ok'"
        ).fetchone()[0]
        last_checked = conn.execute("SELECT MAX(last_checked) FROM domains").fetchone()[0]

    return {
        "total": total,
        "expired": by_category.get(CAT_EXPIRED, 0),
        "expiring_30": by_category.get(CAT_30, 0),
        "expiring_31_60": by_category.get(CAT_60, 0),
        "redemption": by_category.get(CAT_REDEMPTION, 0),
        "pending_delete": by_category.get(CAT_PENDING_DELETE, 0),
        "safe": by_category.get(CAT_SAFE, 0),
        "unknown": by_category.get(CAT_UNKNOWN, 0),
        "never_checked": never,
        "lookup_failed": failed,
        "by_category": by_category,
        "by_priority": by_priority,
        "tlds": tlds,
        "last_checked": last_checked,
    }


def domains_needing_check(ttl_hours: int, limit: Optional[int] = None) -> list[dict[str, Any]]:
    """Domains never checked, or last checked longer ago than the cache TTL.

    This is the cache: a domain verified inside the TTL is skipped entirely, so
    a repeated scan costs no RDAP traffic.
    """
    sql = (
        "SELECT domain, source, first_seen FROM domains "
        "WHERE last_checked IS NULL "
        "   OR julianday('now') - julianday(last_checked) > ? / 24.0 "
        "ORDER BY last_checked IS NOT NULL, priority_rank ASC, domain ASC"
    )
    params: list[Any] = [float(ttl_hours)]
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def all_domains() -> list[dict[str, Any]]:
    with connect() as conn:
        return [dict(r) for r in conn.execute("SELECT domain, source, first_seen FROM domains")]


# ---------------------------------------------------------------------------
# SEO enrichment persistence
# ---------------------------------------------------------------------------

DEFAULT_TARGET_NICHES: list[str] = []
DEFAULT_CRAWL4AI_SOURCES: list[dict[str, Any]] = []


def save_enrichment(domain: str, payload: dict[str, Any]) -> None:
    """Write SEO fields for one domain.

    Only keys present in `payload` are written, so a backlink refresh does not
    wipe archive data collected on a different schedule.
    """
    writable = {name for name, _ in schema.SEO_COLUMNS}
    updates = {k: v for k, v in payload.items() if k in writable}
    if not updates:
        return

    for key in schema.JSON_COLUMNS:
        if key in updates and not isinstance(updates[key], (str, type(None))):
            updates[key] = json.dumps(updates[key])

    assignments = ", ".join(f"{key} = ?" for key in updates)
    with _lock, connect() as conn:
        conn.execute(
            f"UPDATE domains SET {assignments} WHERE domain = ?",
            [*updates.values(), domain],
        )


def record_status_history(domain: str, record: dict[str, Any]) -> None:
    """Append a lifecycle observation. Never overwrites an earlier one."""
    with _lock, connect() as conn:
        conn.execute(
            "INSERT INTO domain_status_history "
            "(domain, registry_status, expiration_date, category, days_left, checked_at) "
            "VALUES (?,?,?,?,?,?)",
            (
                domain,
                json.dumps(record.get("registry_status") or []),
                record.get("expiration_date"),
                record.get("category"),
                record.get("days_left"),
                record.get("checked_at") or now_iso(),
            ),
        )


def record_metric_history(domain: str, record: dict[str, Any]) -> None:
    """Append an SEO metric snapshot for future trend analysis.

    Skipped when every metric is None: an empty row would pollute the trend.
    """
    values = (
        record.get("referring_domains"),
        record.get("total_backlinks"),
        record.get("spam_risk_score"),
        record.get("seo_score"),
    )
    if all(value is None for value in values):
        return

    with _lock, connect() as conn:
        conn.execute(
            "INSERT INTO seo_metric_history "
            "(domain, referring_domains, total_backlinks, spam_risk_score, seo_score, captured_at) "
            "VALUES (?,?,?,?,?,?)",
            (domain, *values, record.get("captured_at") or now_iso()),
        )


def replace_snapshots(domain: str, snapshots: list[dict[str, Any]]) -> None:
    """Swap in the latest archive sample for one domain."""
    with _lock, connect() as conn:
        conn.execute("DELETE FROM domain_snapshots WHERE domain = ?", (domain,))
        if snapshots:
            conn.executemany(
                "INSERT INTO domain_snapshots "
                "(domain, year, timestamp, title, meta_description, language, topic, is_redirect) "
                "VALUES (?,?,?,?,?,?,?,?)",
                [
                    (
                        domain,
                        snap.get("year"),
                        snap.get("timestamp"),
                        snap.get("title"),
                        snap.get("meta_description"),
                        snap.get("language"),
                        snap.get("topic"),
                        int(bool(snap.get("is_redirect"))),
                    )
                    for snap in snapshots
                ],
            )


def get_snapshots(domain: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT year, timestamp, title, meta_description, language, topic, is_redirect "
            "FROM domain_snapshots WHERE domain = ? ORDER BY year ASC, timestamp ASC",
            (domain,),
        ).fetchall()
    return [{**dict(r), "is_redirect": bool(r["is_redirect"])} for r in rows]


def get_metric_history(domain: str, limit: int = 60) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT referring_domains, total_backlinks, spam_risk_score, seo_score, captured_at "
            "FROM seo_metric_history WHERE domain = ? ORDER BY captured_at DESC LIMIT ?",
            (domain, int(limit)),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def get_status_history(domain: str, limit: int = 60) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT registry_status, expiration_date, category, days_left, checked_at "
            "FROM domain_status_history WHERE domain = ? ORDER BY checked_at DESC LIMIT ?",
            (domain, int(limit)),
        ).fetchall()
    out = []
    for row in reversed(rows):
        data = dict(row)
        try:
            data["registry_status"] = json.loads(data.get("registry_status") or "[]")
        except ValueError:
            data["registry_status"] = []
        out.append(data)
    return out


def set_watchlist(domain: str, watchlisted: bool, notes: Optional[str] = None) -> bool:
    """Toggle the shortlist flag and optionally replace the note."""
    with _lock, connect() as conn:
        if notes is None:
            cursor = conn.execute(
                "UPDATE domains SET watchlisted = ? WHERE domain = ?",
                (int(watchlisted), domain),
            )
        else:
            cursor = conn.execute(
                "UPDATE domains SET watchlisted = ?, notes = ? WHERE domain = ?",
                (int(watchlisted), notes, domain),
            )
        return cursor.rowcount > 0


def get_setting(key: str, default: Any = None) -> Any:
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except ValueError:
        return default


def set_setting(key: str, value: Any) -> None:
    with _lock, connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )


def prune_keyword_cache() -> int:
    with _lock, connect() as conn:
        cursor = conn.execute(
            "DELETE FROM keyword_search_cache WHERE julianday(expires_at) <= julianday('now')"
        )
        return cursor.rowcount


def get_keyword_cache(cache_key: str) -> Optional[dict[str, Any]]:
    prune_keyword_cache()
    with connect() as conn:
        row = conn.execute(
            "SELECT cache_key, request_json, response_json, created_at, expires_at "
            "FROM keyword_search_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if not row:
        return None
    data = dict(row)
    try:
        data["request"] = json.loads(data.pop("request_json") or "{}")
    except ValueError:
        data["request"] = {}
    try:
        data["response"] = json.loads(data.pop("response_json") or "{}")
    except ValueError:
        data["response"] = {}
    return data


def set_keyword_cache(
    cache_key: str,
    request_payload: dict[str, Any],
    response_payload: dict[str, Any],
    created_at: str,
    expires_at: str,
) -> None:
    with _lock, connect() as conn:
        conn.execute(
            """
            INSERT INTO keyword_search_cache
                (cache_key, request_json, response_json, created_at, expires_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(cache_key) DO UPDATE SET
                request_json  = excluded.request_json,
                response_json = excluded.response_json,
                created_at    = excluded.created_at,
                expires_at    = excluded.expires_at
            """,
            (
                cache_key,
                json.dumps(request_payload),
                json.dumps(response_payload),
                created_at,
                expires_at,
            ),
        )


def add_keyword_history(
    keyword: str,
    filters: dict[str, Any],
    result_count: int,
    searched_at: Optional[str] = None,
) -> int:
    with _lock, connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO keyword_search_history
                (keyword, filters_json, result_count, searched_at)
            VALUES (?,?,?,?)
            """,
            (keyword, json.dumps(filters), int(result_count), searched_at or now_iso()),
        )
        return int(cursor.lastrowid)


def clear_keyword_history() -> int:
    """Drop every stored search. Cached results are left alone."""
    with _lock, connect() as conn:
        return int(conn.execute("DELETE FROM keyword_search_history").rowcount)


def list_keyword_history(limit: int = 8) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 50))
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT keyword, filters_json, result_count, searched_at
            FROM keyword_search_history
            ORDER BY searched_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row)
        try:
            data["filters"] = json.loads(data.pop("filters_json") or "{}")
        except ValueError:
            data["filters"] = {}
        out.append(data)
    return out


def target_niches() -> list[str]:
    value = get_setting("target_niches", DEFAULT_TARGET_NICHES)
    return [str(v) for v in value] if isinstance(value, list) else []


def crawl4ai_sources() -> list[dict[str, Any]]:
    value = get_setting("crawl4ai_sources", DEFAULT_CRAWL4AI_SOURCES)
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def save_crawl4ai_sources(items: list[dict[str, Any]]) -> None:
    set_setting("crawl4ai_sources", items)


def upsert_crawl4ai_source(item: dict[str, Any]) -> dict[str, Any]:
    current = crawl4ai_sources()
    updated = False
    for index, row in enumerate(current):
        if row.get("id") == item.get("id"):
            current[index] = item
            updated = True
            break
    if not updated:
        current.append(item)
    save_crawl4ai_sources(current)
    return item


def prune_crawl_source_cache() -> int:
    with _lock, connect() as conn:
        cursor = conn.execute(
            "DELETE FROM crawl_source_cache WHERE julianday(expires_at) <= julianday('now')"
        )
        return cursor.rowcount


def get_crawl_source_cache(source_id: str) -> Optional[dict[str, Any]]:
    prune_crawl_source_cache()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT source_id, source_name, source_url, status, error, pages_crawled,
                   candidate_count, domains_json, sample_json, crawled_at, expires_at
            FROM crawl_source_cache WHERE source_id = ?
            """,
            (source_id,),
        ).fetchone()
    if not row:
        return None
    data = dict(row)
    for key in ("domains_json", "sample_json"):
        try:
            data[key[:-5]] = json.loads(data.pop(key) or "[]")
        except ValueError:
            data[key[:-5]] = []
    return data


def set_crawl_source_cache(
    source_id: str,
    source_name: str,
    source_url: str,
    status: str,
    error: Optional[str],
    pages_crawled: int,
    candidate_count: int,
    domains: list[str],
    sample: list[str],
    crawled_at: str,
    expires_at: str,
) -> None:
    with _lock, connect() as conn:
        conn.execute(
            """
            INSERT INTO crawl_source_cache
                (source_id, source_name, source_url, status, error, pages_crawled,
                 candidate_count, domains_json, sample_json, crawled_at, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(source_id) DO UPDATE SET
                source_name     = excluded.source_name,
                source_url      = excluded.source_url,
                status          = excluded.status,
                error           = excluded.error,
                pages_crawled   = excluded.pages_crawled,
                candidate_count = excluded.candidate_count,
                domains_json    = excluded.domains_json,
                sample_json     = excluded.sample_json,
                crawled_at      = excluded.crawled_at,
                expires_at      = excluded.expires_at
            """,
            (
                source_id,
                source_name,
                source_url,
                status,
                error,
                int(pages_crawled),
                int(candidate_count),
                json.dumps(domains),
                json.dumps(sample),
                crawled_at,
                expires_at,
            ),
        )


def clear_crawl_source_cache(source_id: Optional[str] = None) -> int:
    with _lock, connect() as conn:
        if source_id:
            cursor = conn.execute("DELETE FROM crawl_source_cache WHERE source_id = ?", (source_id,))
        else:
            cursor = conn.execute("DELETE FROM crawl_source_cache")
        return cursor.rowcount


def crawl_source_cache_rows() -> list[dict[str, Any]]:
    prune_crawl_source_cache()
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT source_id, source_name, source_url, status, error, pages_crawled,
                   candidate_count, domains_json, sample_json, crawled_at, expires_at
            FROM crawl_source_cache
            ORDER BY crawled_at DESC, source_name ASC
            """
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row)
        for key in ("domains_json", "sample_json"):
            try:
                data[key[:-5]] = json.loads(data.pop(key) or "[]")
            except ValueError:
                data[key[:-5]] = []
        out.append(data)
    return out


def seo_stats() -> dict[str, Any]:
    """SEO counters for the summary cards, plus per-source refresh stamps."""
    cfg_labels = {"high_opportunity_min": 80}
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
              COUNT(*)                                                        AS total,
              SUM(CASE WHEN seo_score >= ? THEN 1 ELSE 0 END)                 AS high_opportunity,
              SUM(CASE WHEN spam_risk_level IN ('High','Very High') THEN 1 ELSE 0 END) AS high_spam,
              SUM(CASE WHEN watchlisted = 1 THEN 1 ELSE 0 END)                AS watchlisted,
              SUM(CASE WHEN seo_score IS NOT NULL THEN 1 ELSE 0 END)          AS scored,
              SUM(CASE WHEN referring_domains IS NOT NULL THEN 1 ELSE 0 END)  AS with_backlinks,
              SUM(CASE WHEN snapshot_count IS NOT NULL THEN 1 ELSE 0 END)     AS with_history,
              MAX(last_rdap_checked)                                          AS last_rdap,
              MAX(last_backlink_checked)                                      AS last_backlink,
              MAX(last_history_checked)                                       AS last_history
            FROM domains
            """,
            (cfg_labels["high_opportunity_min"],),
        ).fetchone()
        topics_rows = conn.execute(
            "SELECT primary_topic AS topic, COUNT(*) AS n FROM domains "
            "WHERE primary_topic IS NOT NULL GROUP BY primary_topic ORDER BY n DESC, topic ASC"
        ).fetchall()

    data = dict(row) if row else {}
    return {
        "high_opportunity": data.get("high_opportunity") or 0,
        "high_spam_risk": data.get("high_spam") or 0,
        "watchlisted": data.get("watchlisted") or 0,
        "scored": data.get("scored") or 0,
        "with_backlink_data": data.get("with_backlinks") or 0,
        "with_history_data": data.get("with_history") or 0,
        "high_opportunity_min": cfg_labels["high_opportunity_min"],
        "topics": [{"topic": r["topic"], "count": r["n"]} for r in topics_rows],
        "refreshed": {
            "rdap": data.get("last_rdap"),
            "backlinks": data.get("last_backlink"),
            "history": data.get("last_history"),
        },
    }


def top_opportunities(limit: int = 8) -> list[dict[str, Any]]:
    """Highest scoring domains. Only scored rows qualify."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM domains WHERE seo_score IS NOT NULL "
            "ORDER BY seo_score DESC, referring_domains DESC, domain ASC LIMIT ?",
            (int(limit),),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def domains_needing_enrichment(
    backlink_ttl_hours: int,
    history_ttl_days: int,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Rows whose SEO data is missing or older than its own TTL.

    Backlinks and archive history age at different rates, so each is checked
    against its own stamp rather than a single shared one.
    """
    sql = (
        "SELECT domain, registration_date, last_backlink_checked, last_history_checked "
        "FROM domains WHERE "
        "  last_backlink_checked IS NULL "
        "  OR last_history_checked IS NULL "
        "  OR julianday('now') - julianday(last_backlink_checked) > ? / 24.0 "
        "  OR julianday('now') - julianday(last_history_checked) > ? "
        "ORDER BY last_history_checked IS NOT NULL, priority_rank ASC, domain ASC"
    )
    params: list[Any] = [float(backlink_ttl_hours), float(history_ttl_days)]
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


# ---------------------------------------------------------------------------
# Discovery source attribution
# ---------------------------------------------------------------------------

# Lifecycle states worth spending external SEO API calls on. A Safe domain is
# not an acquisition candidate, so it is not enriched by default.
INTERESTING_CATEGORIES = (
    "Pending Delete",
    "Redemption",
    "Expired",
    "Expiring <=30 Days",
    "Expiring 31-60 Days",
)

# Lower rank is processed first, so scarce API budget goes to the most urgent
# lifecycle states before anything else.
LIFECYCLE_RANK = {
    "Pending Delete": 0,
    "Redemption": 1,
    "Expired": 2,
    "Expiring <=30 Days": 3,
    "Expiring 31-60 Days": 4,
    "Unknown": 5,
    "Safe": 6,
}


def link_sources(origins: dict[str, str], kinds: Optional[dict[str, str]] = None) -> int:
    """Record which source discovered which domain.

    Upserts, so re-discovery bumps `last_seen_source` and `seen_count` rather
    than creating a duplicate candidate.
    """
    if not origins:
        return 0

    stamp = now_iso()
    kinds = kinds or {}
    rows = [
        (domain, source, kinds.get(source), stamp, stamp)
        for domain, source in origins.items()
    ]

    with _lock, connect() as conn:
        conn.executemany(
            """
            INSERT INTO domain_source_links
                (domain, source_name, source_kind, discovered_at, last_seen_source)
            VALUES (?,?,?,?,?)
            ON CONFLICT(domain, source_name) DO UPDATE SET
                last_seen_source = excluded.last_seen_source,
                source_kind      = COALESCE(excluded.source_kind, domain_source_links.source_kind),
                seen_count       = domain_source_links.seen_count + 1
            """,
            rows,
        )
    return len(rows)


def sources_for_domain(domain: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT source_name, source_kind, discovered_at, last_seen_source, seen_count "
            "FROM domain_source_links WHERE domain = ? ORDER BY discovered_at ASC",
            (domain,),
        ).fetchall()
    return [dict(r) for r in rows]


def source_candidate_counts() -> dict[str, dict[str, Any]]:
    """Stored candidate count and last sync per source, for the status panel."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT source_name, COUNT(*) AS candidates, MAX(last_seen_source) AS last_sync "
            "FROM domain_source_links GROUP BY source_name"
        ).fetchall()
    return {
        row["source_name"]: {"candidates": row["candidates"], "last_sync": row["last_sync"]}
        for row in rows
    }


def watchlisted_domains() -> list[dict[str, Any]]:
    with connect() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT domain FROM domains WHERE watchlisted = 1 ORDER BY domain"
            ).fetchall()
        ]


def domains_needing_rdap(ttl_hours: int, limit: Optional[int] = None) -> list[dict[str, Any]]:
    """Candidates never checked, or checked longer ago than the RDAP TTL.

    Ordered by lifecycle urgency so a truncated run still covers the domains
    that matter most.
    """
    rank_case = " ".join(
        f"WHEN '{category}' THEN {rank}" for category, rank in LIFECYCLE_RANK.items()
    )
    sql = f"""
        SELECT domain, source, first_seen, registration_date
        FROM domains
        WHERE last_rdap_checked IS NULL
           OR julianday('now') - julianday(last_rdap_checked) > ? / 24.0
        ORDER BY
          last_rdap_checked IS NOT NULL,
          CASE category {rank_case} ELSE 7 END ASC,
          domain ASC
    """
    params: list[Any] = [float(ttl_hours)]
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def domains_needing_enrichment_scoped(
    backlink_ttl_hours: int,
    history_ttl_days: int,
    limit: Optional[int] = None,
    categories: Optional[Iterable[str]] = None,
) -> list[dict[str, Any]]:
    """Enrichment queue, restricted to lifecycle states worth paying for.

    Passing categories=() means "no restriction". By default only the
    interesting lifecycle states are enriched, which keeps backlink API credit
    off domains that are years from expiring.
    """
    wanted = list(INTERESTING_CATEGORIES if categories is None else categories)

    clauses = [
        "(last_backlink_checked IS NULL"
        " OR last_history_checked IS NULL"
        " OR julianday('now') - julianday(last_backlink_checked) > ? / 24.0"
        " OR julianday('now') - julianday(last_history_checked) > ?)"
    ]
    params: list[Any] = [float(backlink_ttl_hours), float(history_ttl_days)]

    if wanted:
        placeholders = ",".join("?" for _ in wanted)
        clauses.append(f"(category IN ({placeholders}) OR watchlisted = 1)")
        params.extend(wanted)

    rank_case = " ".join(
        f"WHEN '{category}' THEN {rank}" for category, rank in LIFECYCLE_RANK.items()
    )
    sql = (
        "SELECT * FROM domains WHERE "
        + " AND ".join(clauses)
        + f" ORDER BY CASE category {rank_case} ELSE 7 END ASC,"
        "  last_history_checked IS NOT NULL, domain ASC"
    )
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))

    with connect() as conn:
        return [_row_to_dict(r) for r in conn.execute(sql, params).fetchall()]
