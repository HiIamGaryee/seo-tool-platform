from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Optional

import warnings

from bs4 import BeautifulSoup

try:  # archived sitemaps and feeds are XML; the warning is noise, not a fault
    from bs4 import XMLParsedAsHTMLWarning

    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
except ImportError:  # older bs4 without the warning class
    pass

import net

logger = logging.getLogger(__name__)

# Wayback's documented public CDX index. Not a scrape target.
CDX_URL = "https://web.archive.org/cdx/search/cdx"
SNAPSHOT_URL = "https://web.archive.org/web/{timestamp}id_/{original}"
CDX_HOST = "web.archive.org"

USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Deliberately small: we sample a domain's history, we do not mirror the archive.
SNAPSHOT_SAMPLE_SIZE = max(1, min(_env_int("DOMAIN_MONITOR_HISTORY_SAMPLES", 5), 12))
CDX_ROW_LIMIT = _env_int("DOMAIN_MONITOR_HISTORY_CDX_LIMIT", 4000)
HISTORY_TIMEOUT = _env_float("DOMAIN_MONITOR_HISTORY_TIMEOUT", 20.0)
HISTORY_RETRIES = _env_int("DOMAIN_MONITOR_HISTORY_RETRIES", 3)
HISTORY_MIN_INTERVAL = _env_float("DOMAIN_MONITOR_HISTORY_MIN_INTERVAL", 1.2)
MAX_SNAPSHOT_BYTES = _env_int("DOMAIN_MONITOR_HISTORY_MAX_BYTES", 600_000)

ENABLED = os.environ.get("DOMAIN_MONITOR_HISTORY_ENABLED", "1") != "0"


@dataclass
class Snapshot:
    timestamp: str
    year: Optional[int]
    original: str
    status_code: Optional[str] = None
    title: Optional[str] = None
    meta_description: Optional[str] = None
    language: Optional[str] = None
    is_redirect: bool = False


@dataclass
class HistoryResult:
    """Archive findings for one domain.

    `queried` distinguishes "we asked and the archive has nothing" from "we
    never asked", which the UI must not conflate.
    """

    queried: bool = False
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    snapshot_count: Optional[int] = None
    snapshot_count_truncated: bool = False
    snapshots: list[Snapshot] = field(default_factory=list)
    redirect_count: int = 0
    error: Optional[str] = None

    @property
    def has_data(self) -> bool:
        return self.queried and bool(self.snapshot_count)


def _year(timestamp: str) -> Optional[int]:
    try:
        return int(timestamp[:4])
    except (TypeError, ValueError):
        return None


def _sample_indices(count: int, wanted: int) -> list[int]:
    """Evenly spread picks across the archive: oldest, quartiles, latest."""
    if count <= wanted:
        return list(range(count))
    if wanted == 1:
        return [count - 1]
    step = (count - 1) / (wanted - 1)
    return sorted({int(round(i * step)) for i in range(wanted)})


class HistoryClient:
    """Wayback CDX index reader plus a bounded snapshot sampler."""

    def __init__(self, pool_size: int = 8) -> None:
        self._session = net.build_session(USER_AGENT, pool_size=pool_size)
        self._limiter = net.HostRateLimiter(HISTORY_MIN_INTERVAL)

    def _cdx(self, params: dict) -> Optional[list[list[str]]]:
        response = net.get_with_retries(
            self._session,
            CDX_URL,
            self._limiter,
            CDX_HOST,
            HISTORY_TIMEOUT,
            HISTORY_RETRIES,
            params=params,
            label="wayback cdx",
        )
        if response is None or response.status_code != 200:
            return None
        try:
            rows = response.json()
        except ValueError:
            return None
        if not isinstance(rows, list) or len(rows) < 2:
            return []
        return rows[1:]  # first row is the header

    def lookup(self, domain: str) -> HistoryResult:
        """Index the domain's archive, then read a handful of snapshots."""
        result = HistoryResult(queried=True)
        if not ENABLED:
            return HistoryResult(queried=False)

        # One index call, collapsed to a single capture per day, HTML 200s only.
        rows = self._cdx(
            {
                "url": domain,
                "matchType": "domain",
                "output": "json",
                "fl": "timestamp,original,statuscode,mimetype",
                "filter": ["statuscode:200", "mimetype:text/html"],
                "collapse": "timestamp:8",
                "limit": CDX_ROW_LIMIT,
            }
        )
        if rows is None:
            result.error = "Wayback CDX index unavailable"
            return result
        if not rows:
            result.snapshot_count = 0
            return result

        rows.sort(key=lambda row: row[0])
        result.snapshot_count = len(rows)
        result.snapshot_count_truncated = len(rows) >= CDX_ROW_LIMIT
        result.first_seen = rows[0][0]
        result.last_seen = rows[-1][0]

        for index in _sample_indices(len(rows), SNAPSHOT_SAMPLE_SIZE):
            row = rows[index]
            snapshot = Snapshot(
                timestamp=row[0],
                year=_year(row[0]),
                original=row[1],
                status_code=row[2] if len(row) > 2 else None,
            )
            self._read_snapshot(snapshot)
            result.snapshots.append(snapshot)

        result.redirect_count = sum(1 for s in result.snapshots if s.is_redirect)
        return result

    def _read_snapshot(self, snapshot: Snapshot) -> None:
        """Fetch one archived page and pull only the SEO-relevant head fields."""
        url = SNAPSHOT_URL.format(timestamp=snapshot.timestamp, original=snapshot.original)
        response = net.get_with_retries(
            self._session,
            url,
            self._limiter,
            CDX_HOST,
            HISTORY_TIMEOUT,
            HISTORY_RETRIES,
            label="wayback snapshot",
        )
        if response is None or response.status_code != 200:
            return

        if response.history:
            snapshot.is_redirect = True

        content = response.content[:MAX_SNAPSHOT_BYTES]
        try:
            soup = BeautifulSoup(content, "lxml")
        except Exception as exc:  # a malformed archived page must not stop a scan
            logger.debug("Could not parse snapshot %s: %s", url, exc)
            return

        if soup.title and soup.title.string:
            snapshot.title = " ".join(soup.title.string.split())[:300]

        description = soup.find("meta", attrs={"name": "description"})
        if description and description.get("content"):
            snapshot.meta_description = " ".join(str(description["content"]).split())[:500]

        html_tag = soup.find("html")
        if html_tag and html_tag.get("lang"):
            snapshot.language = str(html_tag["lang"])[:16]

        refresh = soup.find("meta", attrs={"http-equiv": lambda v: v and v.lower() == "refresh"})
        if refresh:
            snapshot.is_redirect = True

    def close(self) -> None:
        self._session.close()
