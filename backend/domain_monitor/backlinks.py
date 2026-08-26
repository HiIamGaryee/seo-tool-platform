from __future__ import annotations

import csv
import io
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol
from urllib.parse import urlsplit

import net

logger = logging.getLogger(__name__)


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


BACKLINK_TIMEOUT = _env_float("BACKLINK_TIMEOUT", 25.0)
BACKLINK_RETRIES = _env_int("BACKLINK_RETRIES", 3)
BACKLINK_MIN_INTERVAL = _env_float("BACKLINK_MIN_INTERVAL", 1.0)
ANCHOR_LIMIT = _env_int("BACKLINK_ANCHOR_LIMIT", 25)
REFDOMAIN_LIMIT = _env_int("BACKLINK_REFDOMAIN_LIMIT", 25)

USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0"


@dataclass
class BacklinkMetrics:
    """Provider-reported backlink data.

    Every numeric field is Optional and stays None when the provider did not
    return it. None means "unavailable" and must render as an em dash; 0 means
    the provider genuinely reported zero. The two are never interchangeable.
    """

    provider: str
    queried: bool = False
    referring_domains: Optional[int] = None
    total_backlinks: Optional[int] = None
    follow_backlinks: Optional[int] = None
    nofollow_backlinks: Optional[int] = None
    lost_backlinks: Optional[int] = None
    new_backlinks: Optional[int] = None
    top_referring_domains: list[dict[str, Any]] = field(default_factory=list)
    top_referring_tlds: list[dict[str, Any]] = field(default_factory=list)
    anchor_counts: Optional[list[dict[str, Any]]] = None
    error: Optional[str] = None

    @property
    def has_data(self) -> bool:
        return self.queried and self.referring_domains is not None

    @property
    def follow_percentage(self) -> Optional[float]:
        if self.follow_backlinks is None or not self.total_backlinks:
            return None
        return round(self.follow_backlinks / self.total_backlinks * 100, 1)

    @property
    def nofollow_percentage(self) -> Optional[float]:
        follow = self.follow_percentage
        return None if follow is None else round(100 - follow, 1)


class BacklinkProvider(Protocol):
    """Adapter contract. One method, so a new vendor is one small class."""

    name: str

    def get_domain_metrics(self, domain: str) -> BacklinkMetrics: ...


class NullBacklinkProvider:
    """Used when no provider is configured.

    Returns queried=False so the UI prints "Backlink data unavailable" instead
    of inventing numbers. This is the default, on purpose.
    """

    name = "none"

    def get_domain_metrics(self, domain: str) -> BacklinkMetrics:
        return BacklinkMetrics(
            provider=self.name,
            queried=False,
            error="No backlink provider configured (set BACKLINK_PROVIDER and BACKLINK_API_KEY)",
        )


class _HttpProvider:
    """Shared plumbing: pooled session, per-host rate limit, bounded retries."""

    name = "http"
    base_url = ""

    def __init__(self, api_key: str, base_url: Optional[str] = None, pool_size: int = 8) -> None:
        self._api_key = api_key
        if base_url:
            self.base_url = base_url
        self._session = net.build_session(USER_AGENT, pool_size=pool_size, accept="application/json, text/csv")
        self._limiter = net.HostRateLimiter(BACKLINK_MIN_INTERVAL)

    @property
    def _host(self) -> str:
        return urlsplit(self.base_url).netloc

    def _get(self, url: str, params: dict, headers: Optional[dict] = None):
        if headers:
            self._session.headers.update(headers)
        return net.get_with_retries(
            self._session,
            url,
            self._limiter,
            self._host,
            BACKLINK_TIMEOUT,
            BACKLINK_RETRIES,
            params=params,
            label=f"{self.name} backlinks",
        )

    def close(self) -> None:
        self._session.close()


class AhrefsProvider(_HttpProvider):
    """Ahrefs API v3 site-explorer endpoints."""

    name = "ahrefs"
    base_url = "https://api.ahrefs.com"

    def get_domain_metrics(self, domain: str) -> BacklinkMetrics:
        metrics = BacklinkMetrics(provider=self.name, queried=True)
        headers = {"Authorization": f"Bearer {self._api_key}"}

        overview = self._get(
            f"{self.base_url}/v3/site-explorer/backlinks-stats",
            {"target": domain, "mode": "domain"},
            headers,
        )
        if overview is None or overview.status_code != 200:
            metrics.error = _http_error(overview, "Ahrefs")
            return metrics

        try:
            payload = overview.json().get("metrics", overview.json())
        except ValueError:
            metrics.error = "Ahrefs returned a non-JSON response"
            return metrics

        metrics.referring_domains = _as_int(payload.get("live_refdomains", payload.get("refdomains")))
        metrics.total_backlinks = _as_int(payload.get("live", payload.get("backlinks")))
        metrics.lost_backlinks = _as_int(payload.get("all_time_lost", payload.get("lost")))

        anchors = self._get(
            f"{self.base_url}/v3/site-explorer/anchors",
            {"target": domain, "mode": "domain", "limit": ANCHOR_LIMIT, "order_by": "backlinks:desc"},
            headers,
        )
        if anchors is not None and anchors.status_code == 200:
            try:
                rows = anchors.json().get("anchors", [])
            except ValueError:
                rows = []
            metrics.anchor_counts = [
                {"anchor": row.get("anchor"), "count": _as_int(row.get("backlinks")) or 0}
                for row in rows
                if row.get("anchor")
            ]

        refdomains = self._get(
            f"{self.base_url}/v3/site-explorer/refdomains",
            {"target": domain, "mode": "domain", "limit": REFDOMAIN_LIMIT, "order_by": "domain_rating:desc"},
            headers,
        )
        if refdomains is not None and refdomains.status_code == 200:
            try:
                rows = refdomains.json().get("refdomains", [])
            except ValueError:
                rows = []
            metrics.top_referring_domains = [
                {
                    "domain": row.get("refdomain"),
                    "backlinks": _as_int(row.get("backlinks")),
                    "rating": row.get("domain_rating"),
                }
                for row in rows
                if row.get("refdomain")
            ]
            metrics.top_referring_tlds = _tld_spread(metrics.top_referring_domains)

        return metrics


class SemrushProvider(_HttpProvider):
    """Semrush Analytics API v1. Returns semicolon-delimited CSV."""

    name = "semrush"
    base_url = "https://api.semrush.com"

    def get_domain_metrics(self, domain: str) -> BacklinkMetrics:
        metrics = BacklinkMetrics(provider=self.name, queried=True)

        overview = self._get(
            f"{self.base_url}/analytics/v1/",
            {
                "key": self._api_key,
                "type": "backlinks_overview",
                "target": domain,
                "target_type": "root_domain",
                "export_columns": "domains_num,backlinks_num,follows_num,nofollows_num",
            },
        )
        if overview is None or overview.status_code != 200:
            metrics.error = _http_error(overview, "Semrush")
            return metrics

        row = _first_csv_row(overview.text)
        if row is None:
            metrics.error = "Semrush returned no rows for this domain"
            return metrics

        metrics.referring_domains = _as_int(row.get("domains_num"))
        metrics.total_backlinks = _as_int(row.get("backlinks_num"))
        metrics.follow_backlinks = _as_int(row.get("follows_num"))
        metrics.nofollow_backlinks = _as_int(row.get("nofollows_num"))

        anchors = self._get(
            f"{self.base_url}/analytics/v1/",
            {
                "key": self._api_key,
                "type": "backlinks_anchors",
                "target": domain,
                "target_type": "root_domain",
                "export_columns": "anchor,domains_num,backlinks_num",
                "display_limit": ANCHOR_LIMIT,
            },
        )
        if anchors is not None and anchors.status_code == 200:
            metrics.anchor_counts = [
                {"anchor": row.get("anchor"), "count": _as_int(row.get("backlinks_num")) or 0}
                for row in _csv_rows(anchors.text)
                if row.get("anchor")
            ]

        refdomains = self._get(
            f"{self.base_url}/analytics/v1/",
            {
                "key": self._api_key,
                "type": "backlinks_refdomains",
                "target": domain,
                "target_type": "root_domain",
                "export_columns": "domain,backlinks_num,domain_score",
                "display_limit": REFDOMAIN_LIMIT,
            },
        )
        if refdomains is not None and refdomains.status_code == 200:
            metrics.top_referring_domains = [
                {
                    "domain": row.get("domain"),
                    "backlinks": _as_int(row.get("backlinks_num")),
                    "rating": row.get("domain_score"),
                }
                for row in _csv_rows(refdomains.text)
                if row.get("domain")
            ]
            metrics.top_referring_tlds = _tld_spread(metrics.top_referring_domains)

        return metrics


class MajesticProvider(_HttpProvider):
    """Majestic API GetIndexItemInfo."""

    name = "majestic"
    base_url = "https://api.majestic.com"

    def get_domain_metrics(self, domain: str) -> BacklinkMetrics:
        metrics = BacklinkMetrics(provider=self.name, queried=True)

        response = self._get(
            f"{self.base_url}/api/json",
            {
                "app_api_key": self._api_key,
                "cmd": "GetIndexItemInfo",
                "items": 1,
                "item0": domain,
                "datasource": "fresh",
            },
        )
        if response is None or response.status_code != 200:
            metrics.error = _http_error(response, "Majestic")
            return metrics

        try:
            payload = response.json()
        except ValueError:
            metrics.error = "Majestic returned a non-JSON response"
            return metrics

        if payload.get("Code") != "OK":
            metrics.error = f"Majestic error: {payload.get('ErrorMessage') or payload.get('Code')}"
            return metrics

        rows = payload.get("DataTables", {}).get("Results", {}).get("Data", [])
        if not rows:
            metrics.error = "Majestic returned no rows for this domain"
            return metrics

        row = rows[0]
        metrics.referring_domains = _as_int(row.get("RefDomains"))
        metrics.total_backlinks = _as_int(row.get("ExtBackLinks"))
        return metrics


_PROVIDERS = {
    "ahrefs": AhrefsProvider,
    "semrush": SemrushProvider,
    "majestic": MajesticProvider,
}


def _as_int(value: Any) -> Optional[int]:
    """Parse a provider number. Returns None rather than defaulting to zero."""
    if value is None or value == "":
        return None
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return None


def _http_error(response, vendor: str) -> str:
    if response is None:
        return f"{vendor} unreachable after retries"
    if response.status_code == 401 or response.status_code == 403:
        return f"{vendor} rejected the API key ({response.status_code})"
    if response.status_code == 404:
        return f"{vendor} has no data for this domain (404)"
    return f"{vendor} responded {response.status_code}"


def _csv_rows(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text.strip()), delimiter=";")
    return [row for row in reader if any(row.values())]


def _first_csv_row(text: str) -> Optional[dict[str, str]]:
    rows = _csv_rows(text)
    return rows[0] if rows else None


def _tld_spread(referring_domains: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Referring-domain counts grouped by TLD. Derived, not invented."""
    counts: dict[str, int] = {}
    for entry in referring_domains:
        host = str(entry.get("domain") or "")
        if "." not in host:
            continue
        tld = "." + host.rsplit(".", 1)[-1].lower()
        counts[tld] = counts.get(tld, 0) + 1
    return [
        {"tld": tld, "count": count}
        for tld, count in sorted(counts.items(), key=lambda kv: -kv[1])
    ]


def configured_provider_name() -> str:
    return (os.environ.get("BACKLINK_PROVIDER") or "").strip().lower()


def provider_status() -> dict[str, Any]:
    """What the Data Sources panel shows. Never leaks the key itself."""
    name = configured_provider_name()
    has_key = bool(os.environ.get("BACKLINK_API_KEY"))

    if not name:
        return {"provider": None, "configured": False, "reason": "BACKLINK_PROVIDER is not set"}
    if name not in _PROVIDERS:
        return {
            "provider": name,
            "configured": False,
            "reason": f"Unknown provider {name!r}; supported: {', '.join(sorted(_PROVIDERS))}",
        }
    if not has_key:
        return {"provider": name, "configured": False, "reason": "BACKLINK_API_KEY is not set"}
    return {"provider": name, "configured": True, "reason": None}


def build_provider() -> BacklinkProvider:
    """Resolve the configured provider, or the null provider.

    Credentials come from the environment only; nothing is ever hardcoded.
    """
    status = provider_status()
    if not status["configured"]:
        logger.info("Backlink provider not configured: %s", status["reason"])
        return NullBacklinkProvider()

    builder = _PROVIDERS[status["provider"]]
    return builder(
        api_key=os.environ["BACKLINK_API_KEY"],
        base_url=os.environ.get("BACKLINK_API_BASE") or None,
    )
