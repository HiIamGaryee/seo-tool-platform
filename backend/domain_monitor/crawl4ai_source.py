from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

import storage
from models import normalize_domain

logger = logging.getLogger(__name__)

_DOMAIN_TEXT_RE = re.compile(
    r"(?<![@\w-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![@\w-])",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return storage.now_iso()


def _base_directory() -> Path:
    raw = _env(
        "CRAWL4_AI_BASE_DIRECTORY",
        str(Path(__file__).resolve().parent / "data"),
    )
    base = Path(raw)
    base.mkdir(parents=True, exist_ok=True)
    return base


CRAWL_KIND = "crawl4ai"
CRAWL_LABEL = "Crawl4AI"


@dataclass
class Crawl4AISettings:
    enabled: bool
    max_pages: int
    page_timeout_ms: int
    concurrency: int
    cache_hours: int
    use_gemini: bool
    gemini_model: str
    gemini_api_key: Optional[str]


# --- Gemini telemetry -------------------------------------------------------
# Counters only. The API key never enters this dict, is never logged and is
# never serialised to any response the frontend can read.
_GEMINI_STATS: dict[str, Any] = {
    "calls": 0,
    "success": 0,
    "failures": 0,
    "domains": 0,
    "last_status": None,
    "last_error": None,
    "last_duration_ms": None,
}
_GEMINI_LOCK = threading.Lock()


def gemini_stats() -> dict[str, Any]:
    """Safe, non-secret Gemini telemetry for the debug panel."""
    settings = load_settings()
    with _GEMINI_LOCK:
        snapshot = dict(_GEMINI_STATS)
    configured = bool(settings.use_gemini and settings.gemini_api_key)
    if configured:
        reason = None
    elif not settings.use_gemini:
        reason = "CRAWL4AI_USE_GEMINI is off"
    else:
        reason = "GEMINI_API_KEY missing"
    snapshot.update(
        configured=configured,
        provider="Gemini",
        model=settings.gemini_model if configured else None,
        reason=reason,
    )
    return snapshot


def _record_gemini(
    *,
    success: bool,
    domains: int = 0,
    status: Optional[str] = None,
    error: Optional[str] = None,
    duration_ms: Optional[int] = None,
) -> None:
    with _GEMINI_LOCK:
        _GEMINI_STATS["calls"] += 1
        if success:
            _GEMINI_STATS["success"] += 1
            _GEMINI_STATS["domains"] += domains
        else:
            _GEMINI_STATS["failures"] += 1
        _GEMINI_STATS["last_status"] = status
        _GEMINI_STATS["last_error"] = error
        _GEMINI_STATS["last_duration_ms"] = duration_ms


def _http_status_from(error: str) -> Optional[str]:
    """Pull an HTTP status out of a provider error string, if it carries one."""
    match = re.search(r"\b(4\d\d|5\d\d)\b", error or "")
    return match.group(1) if match else None


@dataclass
class CrawlSourceConfig:
    id: str
    name: str
    url: str
    enabled: bool
    max_pages: int
    css_selector: Optional[str] = None
    next_page_selector: Optional[str] = None
    use_gemini: bool = False


@dataclass
class CrawlSourceResult:
    source_id: str
    source_name: str
    source_url: str
    status: str
    pages_crawled: int
    domains: list[str]
    sample: list[str]
    crawled_at: str
    expires_at: str
    error: Optional[str] = None
    blocked: bool = False

    @property
    def candidate_count(self) -> int:
        return len(self.domains)


def _result_from_cache(
    source: CrawlSourceConfig,
    cached: dict[str, Any],
    settings: Crawl4AISettings,
) -> CrawlSourceResult:
    return CrawlSourceResult(
        source_id=source.id,
        source_name=source.name,
        source_url=source.url,
        status=str(cached.get("status") or "active"),
        pages_crawled=int(cached.get("pages_crawled") or 0),
        domains=[str(item) for item in cached.get("domains", [])],
        sample=[str(item) for item in cached.get("sample", [])],
        crawled_at=str(cached.get("crawled_at") or _iso()),
        expires_at=str(cached.get("expires_at") or _cache_expires(settings.cache_hours)),
        error=cached.get("error"),
        blocked=str(cached.get("status") or "") == "blocked",
    )


def load_settings() -> Crawl4AISettings:
    return Crawl4AISettings(
        enabled=_env_bool("CRAWL4AI_ENABLED", True),
        max_pages=max(1, _env_int("CRAWL4AI_MAX_PAGES", 10)),
        page_timeout_ms=max(1000, _env_int("CRAWL4AI_PAGE_TIMEOUT", 30000)),
        concurrency=max(1, min(_env_int("CRAWL4AI_CONCURRENCY", 3), 5)),
        cache_hours=max(1, _env_int("CRAWL4AI_CACHE_HOURS", 6)),
        use_gemini=_env_bool("CRAWL4AI_USE_GEMINI", False),
        gemini_model=_env("GEMINI_MODEL", "gemini/gemini-3-flash-preview"),
        gemini_api_key=_env("GEMINI_API_KEY") or None,
    )


def load_source_configs() -> list[CrawlSourceConfig]:
    items = []
    for entry in storage.crawl4ai_sources():
        try:
            items.append(
                CrawlSourceConfig(
                    id=str(entry.get("id") or uuid.uuid4().hex[:12]),
                    name=str(entry.get("name") or "").strip(),
                    url=str(entry.get("url") or "").strip(),
                    enabled=bool(entry.get("enabled", True)),
                    max_pages=max(1, int(entry.get("max_pages") or load_settings().max_pages)),
                    css_selector=str(entry.get("css_selector") or "").strip() or None,
                    next_page_selector=str(entry.get("next_page_selector") or "").strip() or None,
                    use_gemini=bool(entry.get("use_gemini", False)),
                )
            )
        except (TypeError, ValueError):
            continue
    return [item for item in items if item.name and item.url]


def save_source_config(payload: dict[str, Any]) -> CrawlSourceConfig:
    settings = load_settings()
    source = CrawlSourceConfig(
        id=str(payload.get("id") or uuid.uuid4().hex[:12]),
        name=str(payload.get("name") or "").strip(),
        url=str(payload.get("url") or "").strip(),
        enabled=bool(payload.get("enabled", True)),
        max_pages=max(1, int(payload.get("max_pages") or settings.max_pages)),
        css_selector=str(payload.get("css_selector") or "").strip() or None,
        next_page_selector=str(payload.get("next_page_selector") or "").strip() or None,
        use_gemini=bool(payload.get("use_gemini", False)),
    )
    if not source.name:
        raise ValueError("Source name is required")
    if not source.url.lower().startswith(("http://", "https://")):
        raise ValueError("Source URL must be http(s)")
    storage.upsert_crawl4ai_source(asdict(source))
    return source


def _cache_expires(hours: int) -> str:
    return (_now() + timedelta(hours=hours)).isoformat(timespec="seconds")


def _same_host(url: str, candidate: str) -> bool:
    return urlparse(url).netloc.lower() == urlparse(candidate).netloc.lower()


def _host_label(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc or url


def _blocked(status_code: Optional[int], error_text: str) -> bool:
    lowered = error_text.lower()
    return status_code in (401, 403, 429, 503) or any(
        token in lowered for token in ("cloudflare", "captcha", "forbidden", "unauthorized")
    )


def _extract_from_href(value: str) -> Optional[str]:
    text = (value or "").strip()
    if not text or text.lower().startswith(("javascript:", "mailto:", "tel:", "file:", "data:")):
        return None
    parsed = urlparse(text if "://" in text else f"https://{text}")
    host = parsed.hostname or ""
    if not host or host == "localhost":
        return None
    if _EMAIL_RE.match(host):
        return None
    return normalize_domain(host)


def extract_domains_from_html(
    html: str,
    *,
    page_url: str,
    css_selector: Optional[str] = None,
) -> list[str]:
    del page_url
    soup = BeautifulSoup(html or "", "html.parser")
    buckets: set[str] = set()

    scope = soup.select(css_selector) if css_selector else [soup]
    if not scope:
        scope = [soup]

    for node in scope:
        for anchor in node.select("a[href]"):
            domain = _extract_from_href(anchor.get("href", ""))
            if domain:
                buckets.add(domain)
        text = node.get_text(" ", strip=True)
        for match in _DOMAIN_TEXT_RE.finditer(text):
            domain = normalize_domain(match.group(1))
            if domain:
                buckets.add(domain)

    rendered = soup.decode()
    for match in _DOMAIN_TEXT_RE.finditer(rendered):
        domain = normalize_domain(match.group(1))
        if domain:
            buckets.add(domain)

    return sorted(buckets)


def _next_page_url(
    html: str,
    *,
    current_url: str,
    next_page_selector: Optional[str] = None,
) -> Optional[str]:
    soup = BeautifulSoup(html or "", "html.parser")
    if next_page_selector:
        node = soup.select_one(next_page_selector)
        if node and node.get("href"):
            return urljoin(current_url, node["href"])

    for selector in ("a[rel=next]", "link[rel=next]"):
        node = soup.select_one(selector)
        if node and node.get("href"):
            return urljoin(current_url, node["href"])

    for anchor in soup.select("a[href]"):
        text = anchor.get_text(" ", strip=True).lower()
        rel = " ".join(anchor.get("rel", [])).lower()
        href = anchor.get("href") or ""
        if text in ("next", "next page", "older", "more") or "next" in rel:
            target = urljoin(current_url, href)
            if _same_host(current_url, target):
                return target
    return None


async def _crawl_page(
    crawler: Any,
    url: str,
    settings: Crawl4AISettings,
) -> Any:
    from crawl4ai import CacheMode, CrawlerRunConfig

    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        page_timeout=settings.page_timeout_ms,
        word_count_threshold=1,
    )
    return await crawler.arun(url=url, config=config)


async def _gemini_extract(
    html: str,
    source: CrawlSourceConfig,
    settings: Crawl4AISettings,
) -> list[str]:
    if not settings.use_gemini and not source.use_gemini:
        return []
    if not settings.gemini_api_key:
        logger.warning("[gemini] not configured — reason=GEMINI_API_KEY missing")
        return []

    from crawl4ai import LLMConfig, LLMExtractionStrategy

    schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "domain": {"type": "string"},
                "status_text": {"type": ["string", "null"]},
                "expiry_text": {"type": ["string", "null"]},
            },
            "required": ["domain"],
        },
    }
    strategy = LLMExtractionStrategy(
        llm_config=LLMConfig(
            provider=settings.gemini_model,
            api_token=settings.gemini_api_key,
        ),
        schema=schema,
        extraction_type="schema",
        instruction=(
            "Extract only domain names explicitly present in this page. "
            "Do not invent, infer, autocomplete, or generate domain names. "
            "Return valid JSON only."
        ),
        input_format="html",
        apply_chunking=False,
    )
    logger.info(
        "[gemini] request started model=%s source=%s", settings.gemini_model, source.name
    )
    started = time.monotonic()
    try:
        result = await strategy.extract(url=source.url, html=html)
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        message = str(exc)
        status = _http_status_from(message)
        _record_gemini(
            success=False, status=status, error=message[:300], duration_ms=duration_ms
        )
        logger.warning(
            "[gemini] extraction failed status=%s source=%s duration=%.2fs — "
            "falling back to deterministic extraction",
            status or "unknown",
            source.name,
            duration_ms / 1000,
        )
        return []

    duration_ms = int((time.monotonic() - started) * 1000)
    domains: list[str] = []
    for item in result or []:
        if isinstance(item, dict):
            domain = normalize_domain(str(item.get("domain") or ""))
            if domain:
                domains.append(domain)
    unique = sorted(set(domains))
    _record_gemini(success=True, domains=len(unique), status="ok", duration_ms=duration_ms)
    logger.info(
        "[gemini] success domains=%d duration=%.2fs source=%s",
        len(unique),
        duration_ms / 1000,
        source.name,
    )
    return unique


def gemini_test() -> dict[str, Any]:
    """Backend-side Gemini connectivity probe.

    Runs entirely on the server: the key is used to sign one tiny request and
    never appears in the returned payload.
    """
    settings = load_settings()
    if not settings.gemini_api_key:
        return {
            "status": "not_configured",
            "provider": "Gemini",
            "model": None,
            "latency_ms": None,
            "error": "gemini_not_configured",
            "message": "GEMINI_API_KEY is not set",
        }

    model = settings.gemini_model.split("/", 1)[-1] or "gemini-3-flash-preview"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    started = time.monotonic()
    try:
        response = requests.post(
            url,
            headers={"x-goog-api-key": settings.gemini_api_key},
            json={"contents": [{"parts": [{"text": "ping"}]}]},
            timeout=20,
        )
    except requests.RequestException as exc:
        return {
            "status": "error",
            "provider": "Gemini",
            "model": settings.gemini_model,
            "latency_ms": int((time.monotonic() - started) * 1000),
            "error": "gemini_transport_error",
            "message": str(exc)[:300],
        }

    latency_ms = int((time.monotonic() - started) * 1000)
    if response.status_code == 200:
        logger.info("[gemini] test ok model=%s latency=%dms", model, latency_ms)
        return {
            "status": "ok",
            "provider": "Gemini",
            "model": settings.gemini_model,
            "latency_ms": latency_ms,
            "error": None,
            "message": None,
        }

    kind = {
        401: "gemini_unauthorized",
        403: "gemini_forbidden",
        429: "gemini_rate_limit",
    }.get(response.status_code, "gemini_http_error")
    logger.warning(
        "[gemini] test failed status=%s latency=%dms", response.status_code, latency_ms
    )
    return {
        "status": "error",
        "provider": "Gemini",
        "model": settings.gemini_model,
        "latency_ms": latency_ms,
        "http_status": response.status_code,
        "error": kind,
        "message": f"Gemini returned HTTP {response.status_code}",
    }


async def _crawl_source_async(
    source: CrawlSourceConfig,
    settings: Crawl4AISettings,
) -> CrawlSourceResult:
    from crawl4ai import AsyncWebCrawler, BrowserConfig

    base_dir = _base_directory()
    os.environ.setdefault("CRAWL4_AI_BASE_DIRECTORY", str(base_dir))

    browser_config = BrowserConfig(headless=True)
    seen_pages: set[str] = set()
    found_domains: set[str] = set()
    current_url = source.url
    pages_crawled = 0

    try:
        async with AsyncWebCrawler(config=browser_config, base_directory=str(base_dir)) as crawler:
            while current_url and pages_crawled < source.max_pages:
                if current_url in seen_pages:
                    break
                seen_pages.add(current_url)
                logger.info("[crawl4ai] crawling %s (%s)", source.name, current_url)
                result = await _crawl_page(crawler, current_url, settings)
                pages_crawled += 1

                if not getattr(result, "success", False):
                    error = str(getattr(result, "error_message", "") or "crawl failed")
                    status_code = getattr(result, "status_code", None)
                    status = "blocked" if _blocked(status_code, error) else "error"
                    return CrawlSourceResult(
                        source_id=source.id,
                        source_name=source.name,
                        source_url=source.url,
                        status=status,
                        pages_crawled=pages_crawled,
                        domains=sorted(found_domains),
                        sample=sorted(found_domains)[:10],
                        crawled_at=_iso(),
                        expires_at=_cache_expires(settings.cache_hours),
                        error=error,
                        blocked=status == "blocked",
                    )

                html = getattr(result, "html", "") or ""
                markdown = getattr(result, "markdown", "") or ""
                page_domains = set(
                    extract_domains_from_html(
                        html or markdown,
                        page_url=current_url,
                        css_selector=source.css_selector,
                    )
                )
                if not page_domains and (settings.use_gemini or source.use_gemini):
                    page_domains.update(await _gemini_extract(html or markdown, source, settings))
                found_domains.update(page_domains)
                logger.info(
                    "[crawl4ai] page %d -> %d candidate domains",
                    pages_crawled,
                    len(page_domains),
                )

                next_url = _next_page_url(
                    html,
                    current_url=current_url,
                    next_page_selector=source.next_page_selector,
                )
                if not next_url or not _same_host(source.url, next_url):
                    break
                current_url = next_url
    except Exception as exc:
        error = str(exc)
        status = "blocked" if _blocked(None, error) else "error"
        return CrawlSourceResult(
            source_id=source.id,
            source_name=source.name,
            source_url=source.url,
            status=status,
            pages_crawled=pages_crawled,
            domains=sorted(found_domains),
            sample=sorted(found_domains)[:10],
            crawled_at=_iso(),
            expires_at=_cache_expires(settings.cache_hours),
            error=error,
            blocked=status == "blocked",
        )

    return CrawlSourceResult(
        source_id=source.id,
        source_name=source.name,
        source_url=source.url,
        status="active",
        pages_crawled=pages_crawled,
        domains=sorted(found_domains),
        sample=sorted(found_domains)[:10],
        crawled_at=_iso(),
        expires_at=_cache_expires(settings.cache_hours),
    )


async def acrawl_source(
    source: CrawlSourceConfig,
    *,
    force: bool = False,
) -> CrawlSourceResult:
    settings = load_settings()
    if not source.enabled:
        return CrawlSourceResult(
            source_id=source.id,
            source_name=source.name,
            source_url=source.url,
            status="disabled",
            pages_crawled=0,
            domains=[],
            sample=[],
            crawled_at=_iso(),
            expires_at=_cache_expires(settings.cache_hours),
        )

    cached = None if force else storage.get_crawl_source_cache(source.id)
    if cached:
        return _result_from_cache(source, cached, settings)

    result = await _crawl_source_async(source, settings)
    storage.set_crawl_source_cache(
        source_id=result.source_id,
        source_name=result.source_name,
        source_url=result.source_url,
        status=result.status,
        error=result.error,
        pages_crawled=result.pages_crawled,
        candidate_count=result.candidate_count,
        domains=result.domains,
        sample=result.sample,
        crawled_at=result.crawled_at,
        expires_at=result.expires_at,
    )
    return result


def crawl_source(
    source: CrawlSourceConfig,
    *,
    force: bool = False,
) -> CrawlSourceResult:
    return asyncio.run(acrawl_source(source, force=force))


async def acrawl_all_sources(*, force: bool = False) -> list[CrawlSourceResult]:
    settings = load_settings()
    if not settings.enabled:
        return []
    semaphore = asyncio.Semaphore(settings.concurrency)

    async def run_one(source: CrawlSourceConfig) -> CrawlSourceResult:
        async with semaphore:
            return await acrawl_source(source, force=force)

    tasks = [run_one(source) for source in load_source_configs() if source.enabled]
    results = await asyncio.gather(*tasks) if tasks else []
    for result in results:
        logger.info("[crawl4ai] total extracted -> %d (%s)", result.candidate_count, result.source_name)
    return results


def crawl_all_sources(*, force: bool = False) -> list[CrawlSourceResult]:
    return asyncio.run(acrawl_all_sources(force=force))


async def atest_source(payload: dict[str, Any]) -> dict[str, Any]:
    settings = load_settings()
    source = CrawlSourceConfig(
        id=str(payload.get("id") or "test-source"),
        name=str(payload.get("name") or "Test Source").strip(),
        url=str(payload.get("url") or "").strip(),
        enabled=True,
        max_pages=1,
        css_selector=str(payload.get("css_selector") or "").strip() or None,
        next_page_selector=str(payload.get("next_page_selector") or "").strip() or None,
        use_gemini=bool(payload.get("use_gemini", False)),
    )
    if not source.url.lower().startswith(("http://", "https://")):
        raise ValueError("Source URL must be http(s)")
    result = await _crawl_source_async(source, settings)
    return {
        "status": result.status,
        "pages": result.pages_crawled,
        "candidate_domains": result.candidate_count,
        "sample": result.sample[:10],
        "error": result.error,
    }


def test_source(payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(atest_source(payload))


def source_status_rows() -> list[dict[str, Any]]:
    settings = load_settings()
    configs = load_source_configs()
    cache_rows = {row["source_id"]: row for row in storage.crawl_source_cache_rows()}
    if not configs:
        return [
            {
                "kind": CRAWL_KIND,
                "name": CRAWL_KIND,
                "label": CRAWL_LABEL,
                "status": "Not Configured" if settings.enabled else "Disabled",
                "enabled": settings.enabled,
                "configured": False,
                "detail": "Crawl4AI installed. No crawler sources configured.",
                "candidates": None,
                "last_sync": None,
            }
        ]

    rows = []
    for config in configs:
        cache = cache_rows.get(config.id)
        status = "Configured"
        detail = _host_label(config.url)
        candidates = None
        last_sync = None
        if not settings.enabled or not config.enabled:
            status = "Disabled"
        elif cache:
            candidates = int(cache.get("candidate_count") or 0)
            last_sync = cache.get("crawled_at")
            if cache.get("status") == "blocked":
                status = "Failed"
                detail = f"Blocked: {cache.get('error') or 'access blocked'}"
            elif cache.get("status") == "error":
                status = "Failed"
                detail = cache.get("error") or "crawl failed"
            else:
                status = "Active"
                detail = (
                    f"{config.max_pages} page cap · "
                    f"Gemini fallback {'enabled' if (settings.use_gemini and settings.gemini_api_key and config.use_gemini) else 'disabled'}"
                )
        rows.append(
            {
                "id": config.id,
                "kind": CRAWL_KIND,
                "name": config.name,
                "label": f"{CRAWL_LABEL} · {config.name}",
                "status": status,
                "enabled": settings.enabled and config.enabled,
                "configured": True,
                "source_url": _host_label(config.url),
                "max_pages": config.max_pages,
                "gemini_fallback": bool(
                    (settings.use_gemini and settings.gemini_api_key and config.use_gemini)
                ),
                "detail": detail,
                "candidates": candidates,
                "last_sync": last_sync,
            }
        )
    return rows


def health_status() -> dict[str, str]:
    crawl4ai_state = "available"
    browser_state = "available"
    gemini_state = "not_configured"
    try:
        from crawl4ai import AsyncWebCrawler

        if AsyncWebCrawler is None:
            crawl4ai_state = "unavailable"
    except Exception:
        crawl4ai_state = "unavailable"
        browser_state = "unavailable"
    settings = load_settings()
    configs = load_source_configs()
    if settings.use_gemini and settings.gemini_api_key:
        gemini_state = "available"
    elif settings.use_gemini:
        gemini_state = "missing_api_key"
    if not settings.enabled:
        crawl4ai_state = "disabled"
    elif not configs:
        crawl4ai_state = "available"
    return {
        "crawl4ai": crawl4ai_state,
        "crawl4ai_browser": browser_state,
        "gemini": gemini_state,
    }


def provider_status() -> dict[str, Any]:
    settings = load_settings()
    configs = load_source_configs()
    cached = storage.crawl_source_cache_rows()
    return {
        "key": CRAWL_KIND,
        "label": CRAWL_LABEL,
        "status": "Active" if settings.enabled else "Disabled",
        "available": True,
        "detail": (
            f"{len(configs)} configured source(s), "
            f"{sum(int(row.get('candidate_count') or 0) for row in cached):,} domains found, "
            f"Gemini fallback "
            f"{'enabled' if settings.use_gemini and settings.gemini_api_key else 'disabled'}"
        ),
    }
