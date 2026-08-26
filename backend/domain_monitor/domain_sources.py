from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Optional

import crawl4ai_source
import source_adapters
import source_config
from models import normalize_domain
from source_adapters import (
    STATUS_ACTIVE,
    STATUS_CONFIGURED,
    STATUS_DISABLED,
    STATUS_FAILED,
    STATUS_NOT_CONFIGURED,
    DomainSource,
    InlineListSource,
    SourceReport,
)
from source_config import SourceSettings, load_settings

logger = logging.getLogger(__name__)

# Re-exported for callers that only need the manual folder.
SOURCES_DIR = source_config.MODULE_DIR / "sources"


@dataclass
class CollectionResult:
    """Outcome of one discovery pass.

    `discovered` counts every raw string an adapter produced, `valid` counts
    those that survived normalisation and `unique` is what actually reaches
    RDAP. The three are reported separately because the gaps between them are
    the interesting part.
    """

    domains: list[str] = field(default_factory=list)
    origins: dict[str, str] = field(default_factory=dict)
    reports: list[SourceReport] = field(default_factory=list)
    discovered: int = 0
    valid: int = 0
    invalid: int = 0
    duplicates: int = 0
    truncated: bool = False

    @property
    def unique(self) -> int:
        return len(self.domains)

    @property
    def any_source_configured(self) -> bool:
        return any(report.configured for report in self.reports)

    def per_source(self) -> dict[str, int]:
        return {report.name: report.raw_count for report in self.reports}


def build_sources(
    settings: Optional[SourceSettings] = None,
    kinds: Optional[Iterable[str]] = None,
) -> tuple[list[DomainSource], SourceSettings]:
    """Instantiate the enabled adapters.

    `kinds` lets a scan request narrow the selection; anything not enabled by
    configuration stays out regardless of what the request asks for.
    """
    settings = settings or load_settings()
    requested = {k.lower() for k in kinds} if kinds else None

    sources: list[DomainSource] = []
    for kind in source_config.ALL_KINDS:
        if not settings.is_enabled(kind):
            continue
        if requested is not None and kind not in requested:
            continue
        sources.extend(source_adapters.build_adapters(kind, settings))
    return sources, settings


def source_status(settings: Optional[SourceSettings] = None) -> list[dict]:
    """Per-source status for the Data Sources panel.

    Reports configuration state only; it never fetches, so it is cheap enough
    to call on every dashboard load.
    """
    settings = settings or load_settings()
    rows = []
    for adapter in source_adapters.all_adapters(settings):
        enabled = settings.is_enabled(adapter.kind)
        configured = adapter.is_configured()
        if not enabled:
            status = STATUS_DISABLED
        elif not configured:
            status = STATUS_NOT_CONFIGURED
        else:
            status = STATUS_CONFIGURED
        rows.append(
            {
                "kind": adapter.kind,
                "name": adapter.name,
                "label": adapter.label,
                "status": status,
                "enabled": enabled,
                "configured": configured,
                "detail": adapter.describe(),
            }
        )
    if settings.is_enabled(source_config.KIND_CRAWL4AI) or crawl4ai_source.load_source_configs():
        rows.extend(crawl4ai_source.source_status_rows())
    return rows


def collect(
    sources: Iterable[DomainSource],
    settings: Optional[SourceSettings] = None,
) -> CollectionResult:
    """Pull every source, normalise, deduplicate and cap.

    Deduplication happens here, before any RDAP call, so www.example.com and
    https://EXAMPLE.com/ cost exactly one lookup between them. A source that
    raises is marked Failed and the remaining sources still run.
    """
    settings = settings or load_settings()
    result = CollectionResult()
    seen: set[str] = set()
    cap = settings.max_candidates

    for source in sources:
        enabled = settings.is_enabled(getattr(source, "kind", "inline")) or isinstance(
            source, InlineListSource
        )
        configured = source.is_configured()
        report = SourceReport(
            kind=getattr(source, "kind", "inline"),
            name=source.name,
            label=source.label,
            status=STATUS_ACTIVE,
            configured=configured,
            enabled=enabled,
            detail=source.describe(),
        )

        if not configured:
            report.status = STATUS_NOT_CONFIGURED
            result.reports.append(report)
            logger.info("[source:%s] not configured — %s", source.name, report.detail)
            continue

        raw = 0
        accepted = 0
        try:
            for candidate in source.fetch_domains():
                raw += 1
                result.discovered += 1

                domain = normalize_domain(candidate)
                if not domain:
                    result.invalid += 1
                    continue
                result.valid += 1

                if domain in seen:
                    result.duplicates += 1
                    continue

                if len(result.domains) >= cap:
                    result.truncated = True
                    break

                seen.add(domain)
                result.domains.append(domain)
                result.origins[domain] = source.name
                accepted += 1
        except Exception as exc:
            # A broken source degrades to Failed; discovery continues.
            report.status = STATUS_FAILED
            report.error = str(exc)
            logger.warning("[source:%s] FAILED: %s", source.name, exc)
        else:
            logger.info(
                "[source:%s] %d raw, %d new candidates%s",
                source.name,
                raw,
                accepted,
                " (candidate cap reached)" if result.truncated else "",
            )

        report.raw_count = raw
        result.reports.append(report)

        if result.truncated:
            logger.warning(
                "[collect] candidate cap of %d reached; remaining sources skipped", cap
            )
            break

    logger.info(
        "[normalize] %d valid of %d discovered (%d rejected)",
        result.valid,
        result.discovered,
        result.invalid,
    )
    logger.info(
        "[dedupe] %d unique candidates (%d duplicates collapsed)",
        result.unique,
        result.duplicates,
    )
    return result


def parse_candidate_lines(text: str, column: int = 0) -> Iterator[str]:
    """Yield raw candidate cells from a pasted or uploaded TXT/CSV blob.

    Shared by the import endpoint and the file-backed adapters so both accept
    exactly the same formats.
    """
    for line in (text or "").splitlines():
        yield from source_adapters._cells(line, column)


def manual_import_path(settings: Optional[SourceSettings] = None) -> Path:
    """Where dashboard imports are appended, so ManualFileSource can re-read them."""
    settings = settings or load_settings()
    root = settings.manual_dir
    root.mkdir(parents=True, exist_ok=True)
    return root / Path(settings.manual_file).name


# --- Backwards-compatible helpers ------------------------------------------

def load_configured_sources() -> list[DomainSource]:
    sources, _ = build_sources()
    return sources


def collect_candidates(
    sources: Iterable[DomainSource],
) -> tuple[list[str], dict[str, int]]:
    """Legacy shape: (domains, per-source counts). Prefer `collect`."""
    result = collect(sources)
    collect_candidates.last_origin = result.origins  # type: ignore[attr-defined]
    return result.domains, result.per_source()
