from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

MODULE_DIR = Path(__file__).resolve().parent

# Kind identifiers used by DOMAIN_SOURCES and by the API.
KIND_MANUAL = "manual"
KIND_ZONE = "zone"
KIND_FEED = "feed"
KIND_CRAWL4AI = "crawl4ai"
KIND_WATCHLIST = "watchlist"
KIND_DEMO = "demo"

ALL_KINDS = (
    KIND_MANUAL,
    KIND_ZONE,
    KIND_FEED,
    KIND_CRAWL4AI,
    KIND_WATCHLIST,
    KIND_DEMO,
)

# Manual import is the only source enabled by default: it holds nothing until an
# admin actually uploads a list, so a fresh install discovers zero candidates
# rather than quietly seeding sample domains.
DEFAULT_SOURCES = (KIND_MANUAL, KIND_CRAWL4AI)


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


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


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass
class SourceSettings:
    """Everything the discovery layer reads from the environment.

    Nothing here carries a production URL, path or credential as a default: an
    unconfigured source reports itself unconfigured instead of falling back to
    sample data.
    """

    enabled_kinds: tuple[str, ...] = DEFAULT_SOURCES
    globally_enabled: bool = True

    manual_dir: Path = MODULE_DIR / "sources"
    manual_file: str = "imported.txt"

    zone_directory: Optional[Path] = None
    zone_max_files: int = 25

    feed_url: Optional[str] = None
    feed_api_key: Optional[str] = None
    feed_format: str = "auto"
    feed_column: int = 0
    feed_json_path: str = ""

    demo_enabled: bool = False
    demo_file: Path = MODULE_DIR / "fixtures" / "demo_domains.txt"

    timeout: float = 20.0
    max_candidates: int = 5000
    max_fetch_bytes: int = 64 * 1024 * 1024

    rdap_cache_hours: int = 24
    scan_batch_size: int = 100
    rdap_concurrency: int = 10
    rdap_timeout: float = 15.0
    rdap_max_retries: int = 3
    rdap_min_host_interval: float = 0.6

    warnings: list[str] = field(default_factory=list)

    def is_enabled(self, kind: str) -> bool:
        return self.globally_enabled and kind in self.enabled_kinds


def load_settings() -> SourceSettings:
    """Read source configuration from the environment on every call.

    Deliberately not cached, so an operator can change configuration and
    restart a scan without restarting the process.
    """
    settings = SourceSettings()
    settings.globally_enabled = _env_bool("DOMAIN_SOURCE_ENABLED", True)

    raw_kinds = _env("DOMAIN_SOURCES")
    if raw_kinds:
        requested = [k.strip().lower() for k in raw_kinds.split(",") if k.strip()]
        known = [k for k in requested if k in ALL_KINDS]
        unknown = [k for k in requested if k not in ALL_KINDS]
        if unknown:
            settings.warnings.append(
                f"Ignoring unknown DOMAIN_SOURCES entries: {', '.join(unknown)}"
            )
        settings.enabled_kinds = tuple(known) if known else ()
    else:
        settings.enabled_kinds = DEFAULT_SOURCES

    # Manual import
    manual_dir = _env("DOMAIN_MONITOR_SOURCES")
    settings.manual_dir = Path(manual_dir) if manual_dir else MODULE_DIR / "sources"
    settings.manual_file = _env("DOMAIN_MANUAL_FILE", "imported.txt") or "imported.txt"

    # Zone files
    zone_dir = _env("ZONE_FILE_DIRECTORY")
    settings.zone_directory = Path(zone_dir) if zone_dir else None
    settings.zone_max_files = _env_int("ZONE_FILE_MAX_FILES", 25)

    # External feed
    feed_url = _env("DOMAIN_FEED_URL")
    if feed_url and not feed_url.lower().startswith(("http://", "https://")):
        settings.warnings.append("DOMAIN_FEED_URL must be an http(s) URL; ignoring it")
        feed_url = ""
    settings.feed_url = feed_url or None
    settings.feed_api_key = _env("DOMAIN_FEED_API_KEY") or None
    settings.feed_format = (_env("DOMAIN_FEED_FORMAT", "auto") or "auto").lower()
    settings.feed_column = _env_int("DOMAIN_FEED_COLUMN", 0)
    settings.feed_json_path = _env("DOMAIN_FEED_JSON_PATH")

    # Demo fixtures, off unless explicitly requested.
    settings.demo_enabled = _env_bool("DOMAIN_USE_DEMO_DATA", False)

    # Limits and transport
    settings.timeout = _env_float("DOMAIN_SOURCE_TIMEOUT", 20.0)
    settings.max_candidates = max(1, _env_int("DOMAIN_SOURCE_MAX_CANDIDATES", 5000))
    settings.rdap_cache_hours = _env_int("RDAP_CACHE_HOURS", _env_int("DOMAIN_MONITOR_CACHE_TTL_HOURS", 24))
    settings.scan_batch_size = max(1, _env_int("DOMAIN_SCAN_BATCH_SIZE", 100))
    settings.rdap_concurrency = max(1, min(_env_int("DOMAIN_RDAP_CONCURRENCY", 10), 32))
    settings.rdap_timeout = _env_float("DOMAIN_RDAP_TIMEOUT", 15.0)
    settings.rdap_max_retries = max(1, _env_int("DOMAIN_RDAP_MAX_RETRIES", 3))
    # Minimum spacing between calls to one RDAP host. Lower it only if the
    # registry you are querying is documented as tolerating more.
    settings.rdap_min_host_interval = max(
        0.0, _env_float("DOMAIN_RDAP_MIN_HOST_INTERVAL", 0.6)
    )

    if settings.demo_enabled and KIND_DEMO not in settings.enabled_kinds:
        settings.enabled_kinds = (*settings.enabled_kinds, KIND_DEMO)

    for warning in settings.warnings:
        logger.warning("[source-config] %s", warning)

    return settings
