from __future__ import annotations

import csv
import gzip
import io
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional, Protocol

import requests

import source_config
from source_config import SourceSettings

logger = logging.getLogger(__name__)

USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0"

STATUS_ACTIVE = "Active"
STATUS_CONFIGURED = "Configured"
STATUS_NOT_CONFIGURED = "Not Configured"
STATUS_DISABLED = "Disabled"
STATUS_FAILED = "Failed"


@dataclass
class SourceReport:
    """What one adapter did on this run. Surfaced verbatim in the UI."""

    kind: str
    name: str
    label: str
    status: str
    configured: bool
    enabled: bool
    raw_count: int = 0
    detail: str = ""
    error: Optional[str] = None


class DomainSource(Protocol):
    """A candidate-domain provider.

    `fetch_domains` yields raw strings; normalisation, validation and
    deduplication all happen downstream in the collector, so an adapter never
    has to care about domain syntax.
    """

    kind: str
    name: str
    label: str

    def is_configured(self) -> bool: ...

    def describe(self) -> str: ...

    def fetch_domains(self) -> Iterable[str]: ...


class _BaseSource:
    kind = "base"
    name = "base"
    label = "Base"

    def __init__(self, settings: SourceSettings) -> None:
        self.settings = settings

    def is_configured(self) -> bool:
        return True

    def describe(self) -> str:
        return ""

    def fetch_domains(self) -> Iterable[str]:
        return []


def _cells(line: str, column: int) -> Iterator[str]:
    """Yield the candidate cell from one TXT or CSV line, skipping comments."""
    text = line.strip()
    if not text or text.startswith("#") or text.startswith(";"):
        return
    if "," not in text and "\t" not in text and ";" not in text:
        yield text
        return
    parts = [p.strip().strip('"') for p in text.replace("\t", ",").replace(";", ",").split(",")]
    if column < len(parts) and parts[column]:
        yield parts[column]
    elif parts and parts[0]:
        yield parts[0]


def _cells_first(line: str) -> Iterator[str]:
    """First column of a TXT or CSV line."""
    return _cells(line, 0)


class ManualFileSource(_BaseSource):
    """Domains an admin uploaded or pasted from the dashboard.

    Reads a TXT/CSV file inside the configured manual directory. This is a
    first-class source, but it is empty until someone imports something.
    """

    kind = source_config.KIND_MANUAL
    name = "manual"
    label = "Manual Import"

    @property
    def path(self) -> Path:
        root = self.settings.manual_dir.resolve()
        # Basename only, so a configured filename can never escape the folder.
        return (root / Path(self.settings.manual_file).name).resolve()

    def is_configured(self) -> bool:
        return self.path.exists() and self.path.stat().st_size > 0

    def describe(self) -> str:
        if not self.path.exists():
            return "No imported list yet — upload a TXT or CSV from the dashboard"
        return f"{self.path.name} ({self.path.stat().st_size:,} bytes)"

    def fetch_domains(self) -> Iterator[str]:
        path = self.path
        if not path.exists():
            return
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                yield from _cells(line, 0)


class ZoneFileSource(_BaseSource):
    """Registry zone files as a candidate source.

    Zone files list registered domains; they carry no expiry information, so
    every candidate still goes through RDAP for its lifecycle. Supports .txt,
    .zone, .csv and .gz.
    """

    kind = source_config.KIND_ZONE
    name = "zone"
    label = "Zone File"

    SUFFIXES = (".txt", ".zone", ".csv", ".gz")

    def is_configured(self) -> bool:
        directory = self.settings.zone_directory
        return bool(directory and directory.is_dir() and self._files())

    def _files(self) -> list[Path]:
        directory = self.settings.zone_directory
        if not directory or not directory.is_dir():
            return []
        found = [
            path
            for path in sorted(directory.iterdir())
            if path.is_file() and path.suffix.lower() in self.SUFFIXES
        ]
        return found[: self.settings.zone_max_files]

    def describe(self) -> str:
        directory = self.settings.zone_directory
        if not directory:
            return "Zone source not configured (set ZONE_FILE_DIRECTORY)"
        if not directory.is_dir():
            return f"Zone directory not found: {directory}"
        files = self._files()
        if not files:
            return f"No zone files in {directory}"
        total = sum(path.stat().st_size for path in files)
        return f"{len(files)} zone file(s) in {directory.name}, {total / 1_048_576:.1f} MB"

    @staticmethod
    def _inner_suffix(path: Path) -> str:
        """Effective format, looking through a .gz wrapper."""
        if path.suffix.lower() == ".gz":
            return Path(path.stem).suffix.lower() or ".txt"
        return path.suffix.lower()

    def fetch_domains(self) -> Iterator[str]:
        """Stream candidates line by line; a zone file never lands in memory whole."""
        for path in self._files():
            # Zone syntax and delimited lists need different parsers, so pick by
            # the effective extension rather than guessing per line.
            parse = self._zone_line if self._inner_suffix(path) == ".zone" else _cells_first
            try:
                if path.suffix.lower() == ".gz":
                    handle: Any = gzip.open(path, "rt", encoding="utf-8", errors="ignore")
                else:
                    handle = path.open("r", encoding="utf-8", errors="ignore")
                with handle:
                    for line in handle:
                        yield from parse(line)
            except OSError as exc:
                # One unreadable file must not abort the remaining zone files.
                logger.warning("[source:zone] could not read %s: %s", path.name, exc)

    @staticmethod
    def _zone_line(line: str) -> Iterator[str]:
        """Extract the owner name from a zone record, or the whole line.

        Handles both a bare domain list and real zone syntax such as
        `example.com. 172800 IN NS ns1.example.com.`
        """
        text = line.strip()
        if not text or text.startswith((";", "#", "$")):
            return
        first = text.split()[0]
        if first:
            yield first.rstrip(".")


class ExternalFeedSource(_BaseSource):
    """A configured HTTP domain feed.

    Only for feeds whose operator permits automated retrieval. There is no HTML
    parsing, no login flow and no anti-bot circumvention here: the adapter does
    one authenticated GET and reads text, CSV or JSON.
    """

    kind = source_config.KIND_FEED
    name = "feed"
    label = "External Feed"

    def is_configured(self) -> bool:
        return bool(self.settings.feed_url)

    def describe(self) -> str:
        if not self.settings.feed_url:
            return "Feed not configured (set DOMAIN_FEED_URL)"
        host = self.settings.feed_url.split("/")[2] if "//" in self.settings.feed_url else self.settings.feed_url
        auth = "with API key" if self.settings.feed_api_key else "no credential"
        return f"{host} ({self.settings.feed_format}, {auth})"

    def fetch_domains(self) -> Iterator[str]:
        url = self.settings.feed_url
        if not url:
            return

        headers = {"User-Agent": USER_AGENT, "Accept": "text/plain, text/csv, application/json"}
        if self.settings.feed_api_key:
            headers["Authorization"] = f"Bearer {self.settings.feed_api_key}"

        try:
            response = requests.get(
                url, headers=headers, timeout=self.settings.timeout, stream=True
            )
            response.raise_for_status()
            body = response.raw.read(self.settings.max_fetch_bytes, decode_content=True) or b""
        except requests.RequestException as exc:
            # Raised so the collector can mark this source Failed and continue.
            raise RuntimeError(f"Feed request failed: {exc}") from exc

        text = body.decode("utf-8", errors="ignore")
        fmt = self.settings.feed_format
        if fmt == "auto":
            stripped = text.lstrip()
            fmt = "json" if stripped[:1] in ("{", "[") else "csv" if "," in stripped[:400] else "text"

        if fmt == "json":
            yield from self._from_json(text)
        else:
            for line in text.splitlines():
                yield from _cells(line, self.settings.feed_column)

    def _from_json(self, text: str) -> Iterator[str]:
        """Pull domains out of a JSON body.

        DOMAIN_FEED_JSON_PATH names the list (dotted) and, after a colon, the
        field holding the domain — e.g. `data.items:domain`.
        """
        try:
            payload = json.loads(text)
        except ValueError as exc:
            raise RuntimeError(f"Feed returned invalid JSON: {exc}") from exc

        spec = self.settings.feed_json_path
        list_path, _, field_name = spec.partition(":")

        node: Any = payload
        for part in [p for p in list_path.split(".") if p]:
            if isinstance(node, dict):
                node = node.get(part)
            else:
                node = None
                break

        if node is None and isinstance(payload, dict):
            node = next((v for v in payload.values() if isinstance(v, list)), None)
        if node is None:
            node = payload

        if not isinstance(node, list):
            raise RuntimeError("Feed JSON did not contain a list of domains")

        for entry in node:
            if isinstance(entry, str):
                yield entry
            elif isinstance(entry, dict):
                if field_name and field_name in entry:
                    yield str(entry[field_name])
                else:
                    for key in ("domain", "name", "host", "hostname", "fqdn"):
                        if key in entry:
                            yield str(entry[key])
                            break


class DatabaseWatchlistSource(_BaseSource):
    """Re-queues domains already flagged by an admin.

    Keeps watchlisted candidates refreshed even if the source that originally
    discovered them has gone away.
    """

    kind = source_config.KIND_WATCHLIST
    name = "watchlist"
    label = "Watchlist"

    def is_configured(self) -> bool:
        return True

    def describe(self) -> str:
        return "Domains flagged in the dashboard"

    def fetch_domains(self) -> Iterator[str]:
        import storage

        storage.migrate()
        for row in storage.watchlisted_domains():
            yield row["domain"]


class DemoFixtureSource(_BaseSource):
    """Sample domains for local development only.

    Loads nothing unless DOMAIN_USE_DEMO_DATA is explicitly true, so production
    can never be seeded with fixtures by accident.
    """

    kind = source_config.KIND_DEMO
    name = "demo"
    label = "Demo Fixture"

    def is_configured(self) -> bool:
        return self.settings.demo_enabled and self.settings.demo_file.exists()

    def describe(self) -> str:
        if not self.settings.demo_enabled:
            return "Disabled (set DOMAIN_USE_DEMO_DATA=true to load fixtures)"
        if not self.settings.demo_file.exists():
            return f"Fixture file missing: {self.settings.demo_file}"
        return f"Development fixtures from {self.settings.demo_file.name}"

    def fetch_domains(self) -> Iterator[str]:
        if not self.settings.demo_enabled:
            return
        path = self.settings.demo_file
        if not path.exists():
            return
        logger.warning(
            "[source:demo] loading development fixtures from %s — not for production",
            path,
        )
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                yield from _cells(line, 0)


class InlineListSource(_BaseSource):
    """Domains supplied directly by a request, e.g. a single-domain recheck."""

    kind = "inline"
    name = "request"
    label = "Request"

    def __init__(self, settings: SourceSettings, domains: Iterable[str]) -> None:
        super().__init__(settings)
        self._domains = list(domains)

    def is_configured(self) -> bool:
        return bool(self._domains)

    def describe(self) -> str:
        return f"{len(self._domains)} domain(s) supplied by the request"

    def fetch_domains(self) -> Iterable[str]:
        return list(self._domains)


class Crawl4AIDomainSource(_BaseSource):
    """Configured Crawl4AI source.

    The discovery interface stays synchronous; Crawl4AI does its async work
    internally and returns cached candidates here.
    """

    kind = source_config.KIND_CRAWL4AI
    label = "Crawl4AI"

    def __init__(self, settings: SourceSettings, source_id: str) -> None:
        super().__init__(settings)
        import crawl4ai_source

        self._source_id = source_id
        self._config = next(
            (row for row in crawl4ai_source.load_source_configs() if row.id == source_id),
            None,
        )
        self.name = self._config.name if self._config else source_id

    def is_configured(self) -> bool:
        return bool(self._config and self._config.url)

    def describe(self) -> str:
        if not self._config:
            return "No crawler source configured"
        return f"{self._config.url} · {self._config.max_pages} page cap"

    def fetch_domains(self) -> Iterator[str]:
        if not self._config or not self._config.enabled:
            return
        import crawl4ai_source

        result = crawl4ai_source.crawl_source(self._config)
        for domain in result.domains:
            yield domain


ADAPTERS: dict[str, type[_BaseSource]] = {
    source_config.KIND_MANUAL: ManualFileSource,
    source_config.KIND_ZONE: ZoneFileSource,
    source_config.KIND_FEED: ExternalFeedSource,
    source_config.KIND_WATCHLIST: DatabaseWatchlistSource,
    source_config.KIND_DEMO: DemoFixtureSource,
}


def build_adapter(kind: str, settings: SourceSettings) -> Optional[_BaseSource]:
    builder = ADAPTERS.get(kind)
    return builder(settings) if builder else None


def build_adapters(kind: str, settings: SourceSettings) -> list[_BaseSource]:
    if kind == source_config.KIND_CRAWL4AI:
        import crawl4ai_source

        return [
            Crawl4AIDomainSource(settings, source.id)
            for source in crawl4ai_source.load_source_configs()
            if source.enabled
        ]
    adapter = build_adapter(kind, settings)
    return [adapter] if adapter else []


def all_adapters(settings: SourceSettings) -> list[_BaseSource]:
    """Every known adapter, configured or not, for the status panel."""
    return [builder(settings) for builder in ADAPTERS.values()]
