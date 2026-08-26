from __future__ import annotations

import logging
import time
import traceback
from dataclasses import asdict
from datetime import datetime
import os
from fastapi import Body, FastAPI, File, UploadFile, Query, Request, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, JSONResponse
from typing import Any, List, Optional
from pathlib import Path
import sys
import requests
from dotenv import load_dotenv

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/seo_api.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Ensure the ../python folder is on sys.path so we can import seo_scraper
ROOT_DIR = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT_DIR / "python"
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

# Load .env before importing anything that reads configuration at import time.
# A real environment variable always wins over the file, so container and CI
# overrides keep working; backend/.env layers on top of the root file for local
# tweaks. Neither file is ever served or echoed back to a client.
for _env_file in (ROOT_DIR / ".env", Path(__file__).resolve().parent / ".env"):
    if _env_file.exists():
        load_dotenv(_env_file, override=False)
        logger.info("Loaded environment from %s", _env_file)

DEFAULT_GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
DEFAULT_GEMINI_MODEL = os.getenv("GEMINI_MODEL") or "gemini/gemini-3-flash-preview"

from seo_scraper import analyze_sitemap_bytes, rows_to_excel_bytes  # type: ignore

# Domain Monitor lives in its own package next to this file
DOMAIN_MONITOR_DIR = Path(__file__).resolve().parent / "domain_monitor"
if str(DOMAIN_MONITOR_DIR) not in sys.path:
    sys.path.insert(0, str(DOMAIN_MONITOR_DIR))

import domain_monitor as dm  # type: ignore
import enrichment as dm_enrich  # type: ignore
import keyword_discovery as dm_keyword  # type: ignore
import storage as dm_storage  # type: ignore
import config_loader as dm_config  # type: ignore
import domain_sources as dm_sources  # type: ignore
import source_config as dm_source_config  # type: ignore
import crawl4ai_source as dm_crawl  # type: ignore
import similar_domains as dm_similar  # type: ignore
from models import CATEGORIES, PRIORITIES, normalize_domain  # type: ignore

app = FastAPI()


def validate_gemini_api_key(
    api_key: str | None,
    model_name: str | None = None,
) -> dict[str, Any]:
    key = (api_key or "").strip()
    if not key:
        return {
            "status": "not_configured",
            "provider": "Gemini",
            "model": model_name or os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL,
            "latency_ms": None,
            "error": "gemini_not_configured",
            "message": "GEMINI_API_KEY is not set",
        }

    resolved_model = model_name or os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL
    model = resolved_model.split("/", 1)[-1] or "gemini-3-flash-preview"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    started = time.monotonic()
    try:
        response = requests.post(
            url,
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": [{"text": "ping"}]}]},
            timeout=20,
        )
    except requests.RequestException as exc:
        return {
            "status": "error",
            "provider": "Gemini",
            "model": resolved_model,
            "latency_ms": int((time.monotonic() - started) * 1000),
            "error": "gemini_transport_error",
            "message": str(exc)[:300],
        }

    latency_ms = int((time.monotonic() - started) * 1000)
    if response.status_code == 200:
        return {
            "status": "ok",
            "provider": "Gemini",
            "model": resolved_model,
            "latency_ms": latency_ms,
            "error": None,
            "message": None,
        }

    kind = {
        400: "gemini_bad_request",
        401: "gemini_unauthorized",
        403: "gemini_forbidden",
        429: "gemini_rate_limit",
    }.get(response.status_code, "gemini_http_error")
    return {
        "status": "error",
        "provider": "Gemini",
        "model": resolved_model,
        "latency_ms": latency_ms,
        "http_status": response.status_code,
        "error": kind,
        "message": f"Gemini returned HTTP {response.status_code}",
    }

# CORS middleware with detailed configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for debugging
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Add request logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    request_id = f"{datetime.now().isoformat()}-{id(request)}"
    
    # Log request details
    logger.info(f"[{request_id}] Request started: {request.method} {request.url}")
    logger.info(f"[{request_id}] Headers: {dict(request.headers)}")
    logger.info(f"[{request_id}] Client: {request.client}")
    
    try:
        response = await call_next(request)
        process_time = time.time() - start_time
        logger.info(f"[{request_id}] Request completed in {process_time:.3f}s with status {response.status_code}")
        response.headers["X-Process-Time"] = str(process_time)
        response.headers["X-Request-ID"] = request_id
        return response
    except Exception as e:
        process_time = time.time() - start_time
        logger.error(f"[{request_id}] Request failed after {process_time:.3f}s: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "detail": str(e),
                "request_id": request_id
            }
        )

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    crawl = dm_crawl.health_status()
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "python_version": sys.version,
        "api_version": "1.0.0",
        "rdap": "available",
        "crawl4ai": crawl["crawl4ai"],
        "crawl4ai_browser": crawl["crawl4ai_browser"],
        "gemini": crawl["gemini"],
    }

@app.post("/analyze-sitemap")
async def analyze_sitemap(
    file: UploadFile = File(...),
    use_default_key: bool = Form(True),
    gemini_api_key: str = Form(""),
) -> dict[str, Any]:
    request_id = f"analyze-{datetime.now().isoformat()}-{id(file)}"
    logger.info(f"[{request_id}] Starting analyze-sitemap request")
    previous_gemini_key = os.getenv("GEMINI_API_KEY")
    
    try:
        # Log file details
        logger.info(f"[{request_id}] File name: {file.filename}")
        logger.info(f"[{request_id}] Content type: {file.content_type}")
        
        # Read file data
        logger.info(f"[{request_id}] Reading file data...")
        start_read = time.time()
        data = await file.read()
        read_time = time.time() - start_read
        logger.info(f"[{request_id}] File read completed in {read_time:.3f}s, size: {len(data)} bytes")
        
        # Validate file is not empty
        if not data:
            logger.error(f"[{request_id}] Empty file received")
            return JSONResponse(
                status_code=400,
                content={"error": "Empty file received", "request_id": request_id}
            )
        
        # Parse and analyze sitemap
        logger.info(f"[{request_id}] Starting sitemap analysis...")
        start_analyze = time.time()
        
        try:
            selected_gemini_key = (
                (os.getenv("GEMINI_API_KEY") or "").strip()
                if use_default_key
                else gemini_api_key.strip()
            )
            if selected_gemini_key:
                os.environ["GEMINI_API_KEY"] = selected_gemini_key
            elif not use_default_key:
                os.environ.pop("GEMINI_API_KEY", None)

            # Log the first 500 characters of the file for debugging
            file_preview = data[:500].decode('utf-8', errors='ignore')
            logger.debug(f"[{request_id}] File preview: {file_preview}")
            
            rows = analyze_sitemap_bytes(data)
            analyze_time = time.time() - start_analyze
            logger.info(f"[{request_id}] Analysis completed in {analyze_time:.3f}s, found {len(rows)} URLs")
            
            # Log summary of results
            if rows:
                logger.info(f"[{request_id}] First URL analyzed: {rows[0].get('url', 'N/A')}")
                errors = [r for r in rows if r.get('error')]
                if errors:
                    logger.warning(f"[{request_id}] Found {len(errors)} URLs with errors")
                    for err in errors[:5]:  # Log first 5 errors
                        logger.warning(f"[{request_id}] Error for {err.get('url')}: {err.get('error')}")
            
            response_data = {
                "rows": rows,
                "request_id": request_id,
                "processing_time": analyze_time,
                "gemini_key_source": "default" if use_default_key else "custom",
                "gemini_key_configured": bool(selected_gemini_key),
            }
            logger.info(f"[{request_id}] Returning {len(rows)} rows to client")
            return JSONResponse(
                content=response_data,
                headers={
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            )
            
        except Exception as e:
            logger.error(f"[{request_id}] Error during sitemap analysis: {str(e)}")
            logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
            return JSONResponse(
                status_code=500,
                content={
                    "error": "Failed to analyze sitemap",
                    "detail": str(e),
                    "request_id": request_id
                }
            )
        finally:
            if previous_gemini_key is None:
                os.environ.pop("GEMINI_API_KEY", None)
            else:
                os.environ["GEMINI_API_KEY"] = previous_gemini_key
            
    except Exception as e:
        logger.error(f"[{request_id}] Unexpected error: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Unexpected server error",
                "detail": str(e),
                "request_id": request_id
            }
        )


@app.post("/gemini/validate-key")
async def gemini_validate_key(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    use_default_key = bool(payload.get("use_default_key", True))
    custom_key = str(payload.get("gemini_api_key", "") or "").strip()
    selected_key = (os.getenv("GEMINI_API_KEY") or "").strip() if use_default_key else custom_key
    result = validate_gemini_api_key(selected_key)
    result["key_source"] = "default" if use_default_key else "custom"
    result["configured"] = bool(selected_key)
    return result


@app.post("/api/domain-monitor/gemini/key")
async def domain_monitor_set_gemini_key(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    use_default_key = bool(payload.get("use_default_key", True))
    custom_key = str(payload.get("gemini_api_key", "") or "").strip()

    if use_default_key:
        if DEFAULT_GEMINI_API_KEY:
            os.environ["GEMINI_API_KEY"] = DEFAULT_GEMINI_API_KEY
        else:
            os.environ.pop("GEMINI_API_KEY", None)
    else:
        if custom_key:
            os.environ["GEMINI_API_KEY"] = custom_key
        else:
            os.environ.pop("GEMINI_API_KEY", None)

    result = validate_gemini_api_key(os.getenv("GEMINI_API_KEY"))
    result["key_source"] = "default" if use_default_key else "custom"
    result["configured"] = bool(os.getenv("GEMINI_API_KEY"))
    return result

@app.post("/export-excel")
async def export_excel(rows: List[dict[str, Any]]) -> StreamingResponse:
    request_id = f"export-{datetime.now().isoformat()}"
    logger.info(f"[{request_id}] Starting export-excel request with {len(rows)} rows")
    
    try:
        start_time = time.time()
        excel_bytes = rows_to_excel_bytes(rows)
        process_time = time.time() - start_time
        
        logger.info(f"[{request_id}] Excel file generated in {process_time:.3f}s, size: {len(excel_bytes)} bytes")
        
        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": 'attachment; filename="seo-analysis-report.xlsx"',
                "X-Request-ID": request_id,
                "X-Process-Time": str(process_time)
            },
        )
    except Exception as e:
        logger.error(f"[{request_id}] Error during Excel export: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "error": "Failed to export Excel",
                "detail": str(e),
                "request_id": request_id
            }
        )

@app.get("/fetch-html")
async def fetch_html(url: str = Query(...)) -> Response:
    request_id = f"fetch-html-{datetime.now().isoformat()}"
    logger.info(f"[{request_id}] Fetching HTML for URL: {url}")
    
    try:
        start_time = time.time()
        resp = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": "SEO-Sitemap-Analyzer/1.0"},
        )
        fetch_time = time.time() - start_time
        
        logger.info(f"[{request_id}] HTML fetched in {fetch_time:.3f}s, status: {resp.status_code}, size: {len(resp.content)} bytes")
        
        # try to decode with correct encoding
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding or "utf-8"
        
        return Response(
            content=resp.text, 
            media_type="text/html; charset=utf-8",
            headers={
                "X-Request-ID": request_id,
                "X-Process-Time": str(fetch_time)
            }
        )
    except Exception as e:
        logger.error(f"[{request_id}] Error fetching HTML: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return Response(
            content=f"Error fetching URL: {str(e)}",
            status_code=500,
            headers={"X-Request-ID": request_id}
        )

@app.get("/fetch-image")
async def fetch_image(url: str = Query(...)) -> Response:
    request_id = f"fetch-image-{datetime.now().isoformat()}"
    logger.info(f"[{request_id}] Fetching image from URL: {url}")
    
    try:
        start_time = time.time()
        resp = requests.get(
            url,
            timeout=20,
            headers={"User-Agent": "Mozilla/5.0 (compatible; SEO-Sitemap-Analyzer/1.0)"},
            stream=False,
        )
        fetch_time = time.time() - start_time
        
        logger.info(f"[{request_id}] Image fetched in {fetch_time:.3f}s, status: {resp.status_code}, size: {len(resp.content)} bytes")
        
        content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        return Response(
            content=resp.content, 
            media_type=content_type,
            headers={
                "X-Request-ID": request_id,
                "X-Process-Time": str(fetch_time)
            }
        )
    except Exception as e:
        logger.error(f"[{request_id}] Error fetching image: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return Response(
            content=f"Error fetching image: {str(e)}",
            status_code=500,
            headers={"X-Request-ID": request_id}
        )

# ---------------------------------------------------------------------------
# Domain Monitor
# ---------------------------------------------------------------------------

@app.get("/api/domain-monitor")
async def domain_monitor_list(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    tld: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    days: Optional[str] = Query(None),
    seo_min: Optional[int] = Query(None, ge=0, le=100),
    spam_level: Optional[str] = Query(None),
    relevance: Optional[str] = Query(None),
    topic: Optional[str] = Query(None),
    referring: Optional[str] = Query(None),
    age: Optional[str] = Query(None),
    watchlisted: bool = Query(False),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=200),
    sort: str = Query("priority"),
    order: str = Query("asc"),
) -> dict[str, Any]:
    request_id = f"dm-list-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        result = dm_storage.list_domains(
            search=search,
            category=category,
            priority=priority,
            tld=tld,
            status=status,
            days=days,
            seo_min=seo_min,
            spam_level=spam_level,
            relevance=relevance,
            topic=topic,
            referring=referring,
            age=age,
            watchlisted=watchlisted or None,
            page=page,
            limit=limit,
            sort=sort,
            order=order,
        )
        logger.info(f"[{request_id}] Returning {len(result['items'])} of {result['total']} domains")
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Domain list failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to list domains", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/stats")
async def domain_monitor_stats() -> dict[str, Any]:
    request_id = f"dm-stats-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        return {
            **dm_storage.stats(),
            **dm_storage.seo_stats(),
            "categories": CATEGORIES,
            "priorities": PRIORITIES,
            "available_topics": sorted(dm_config.topics().keys()),
            "target_niches": dm_storage.target_niches(),
            "data_sources": dm_enrich.data_sources(),
            "discovery_sources": dm_sources.source_status(),
            "source_candidates": dm_storage.source_candidate_counts(),
            "scan": dm.SCAN.snapshot(),
            "enrichment": dm_enrich.ENRICHMENT.snapshot(),
        }
    except Exception as e:
        logger.error(f"[{request_id}] Domain stats failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to load stats", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/scan")
async def domain_monitor_scan_status() -> dict[str, Any]:
    """Poll the running scan. Cheap enough for a 1s interval."""
    return dm.SCAN.snapshot()


@app.get("/api/domain-monitor/provider-status")
async def domain_monitor_provider_status() -> dict[str, Any]:
    """Health of every verification and extraction provider.

    Gemini connectivity is only ever tested from here, on the backend. No
    credential of any kind is included in this response.
    """
    crawl = dm_crawl.health_status()
    gemini = dm_crawl.gemini_stats()
    whois_enabled = dm.ALLOW_WHOIS_FALLBACK
    return {
        "rdap": {"status": "available", "detail": "IANA RDAP bootstrap"},
        "whois": {
            "status": "available" if whois_enabled else "not_configured",
            "detail": (
                "Port-43 fallback via IANA referral"
                if whois_enabled
                else "Set DOMAIN_MONITOR_WHOIS_FALLBACK=1 to enable"
            ),
        },
        "crawl4ai": {
            "status": crawl["crawl4ai"],
            "detail": f"browser: {crawl['crawl4ai_browser']}",
        },
        "gemini": {
            "status": "connected" if gemini["configured"] else "not_configured",
            "provider": gemini["provider"],
            "model": gemini["model"],
            "detail": gemini["reason"] or "Extraction fallback ready",
            "calls": gemini["calls"],
            "success": gemini["success"],
            "failures": gemini["failures"],
            "last_status": gemini["last_status"],
            "last_error": gemini["last_error"],
        },
        "debug": dm_similar.debug_enabled(),
        "tlds": list(dm_similar.configured_tlds()),
        "limits": {
            "max_generated": dm_similar.limits().max_generated,
            "max_verified": dm_similar.limits().max_verified,
            "result_limit": dm_similar.limits().result_limit,
        },
        "fuzzy_backend": dm_similar.FUZZY_BACKEND,
    }


@app.post("/api/domain-monitor/gemini/test")
async def domain_monitor_gemini_test() -> dict[str, Any]:
    """Run one tiny Gemini request server-side and report timing only."""
    request_id = f"dm-gemini-test-{datetime.now().isoformat()}"
    try:
        result = dm_crawl.gemini_test()
        logger.info(f"[{request_id}] Gemini test -> {result['status']}")
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Gemini test failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "provider": "Gemini",
                "error": "gemini_test_failed",
                "message": str(e),
                "request_id": request_id,
            },
        )


@app.get("/api/domain-monitor/discover-keyword")
async def domain_monitor_keyword_status() -> dict[str, Any]:
    return dm_keyword.snapshot()


@app.get("/api/domain-monitor/discover-keyword/history")
async def domain_monitor_keyword_history(limit: int = Query(8, ge=1, le=20)) -> dict[str, Any]:
    return dm_keyword.history(limit)


@app.delete("/api/domain-monitor/discover-keyword/history")
async def domain_monitor_keyword_history_clear() -> dict[str, Any]:
    dm_storage.migrate()
    return {"cleared": dm_storage.clear_keyword_history()}


@app.post("/api/domain-monitor/discover-keyword")
async def domain_monitor_keyword_discovery(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    request_id = f"dm-keyword-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        result = dm_keyword.start_keyword_discovery(payload)
        logger.info(
            f"[{request_id}] Similar domain discovery requested for {payload.get('keyword')!r} "
            f"mode={payload.get('search_mode') or 'similar'} "
            f"window={payload.get('expiry_window')} tld={payload.get('tld') or 'any'} "
            f"(started={result.get('started')})"
        )
        return result
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": str(e), "request_id": request_id},
        )
    except Exception as e:
        logger.error(f"[{request_id}] Keyword discovery failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to start keyword discovery", "detail": str(e), "request_id": request_id},
        )


@app.post("/api/domain-monitor/scan")
async def domain_monitor_scan(
    force: bool = Query(False),
    limit: Optional[int] = Query(None, ge=1, le=5000),
    use_sources: bool = Query(True),
    domains: Optional[str] = Query(None),
    sources: Optional[str] = Query(None),
    enrich: bool = Query(False),
) -> dict[str, Any]:
    """Start a scan on a background thread and return immediately.

    `domains` takes a comma-separated list, which lets the UI re-check a single
    row without pulling in the configured sources. `sources` narrows discovery
    to the named source kinds, and `enrich` chains SEO enrichment afterwards.
    """
    request_id = f"dm-scan-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()

        requested: Optional[list[str]] = None
        if domains:
            requested = [d for d in (normalize_domain(p) for p in domains.split(",")) if d]
            if not requested:
                return JSONResponse(
                    status_code=400,
                    content={"error": "No valid domain names given", "request_id": request_id},
                )

        source_kinds = (
            [k.strip().lower() for k in sources.split(",") if k.strip()] if sources else None
        )
        result = dm.start_scan_async(
            domains=requested,
            force=force,
            limit=limit,
            use_sources=use_sources,
            source_kinds=source_kinds,
            enrich=enrich,
        )
        logger.info(f"[{request_id}] Scan start requested (started={result.get('started')})")
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Scan start failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to start scan", "detail": str(e), "request_id": request_id},
        )


@app.post("/api/domain-monitor/import")
async def domain_monitor_import(file: UploadFile = File(...)) -> dict[str, Any]:
    """Import a TXT or CSV candidate list. Every line is validated as a hostname."""
    request_id = f"dm-import-{datetime.now().isoformat()}"
    logger.info(f"[{request_id}] Import received: {file.filename} ({file.content_type})")
    try:
        data = await file.read()
        if not data:
            return JSONResponse(
                status_code=400,
                content={"error": "Empty file received", "request_id": request_id},
            )
        if len(data) > 5 * 1024 * 1024:
            return JSONResponse(
                status_code=413,
                content={"error": "File larger than 5 MB", "request_id": request_id},
            )
        text = data.decode("utf-8", errors="ignore")
        result = dm.import_domains(text, source=f"import:{Path(file.filename or 'upload').name}")
        logger.info(
            f"[{request_id}] Imported {result['imported']}, "
            f"duplicates {result['duplicates']}, invalid {result['invalid']}"
        )
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Import failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to import domains", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/export")
async def domain_monitor_export(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    tld: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    days: Optional[str] = Query(None),
    seo_min: Optional[int] = Query(None, ge=0, le=100),
    spam_level: Optional[str] = Query(None),
    relevance: Optional[str] = Query(None),
    topic: Optional[str] = Query(None),
    referring: Optional[str] = Query(None),
    age: Optional[str] = Query(None),
    watchlisted: bool = Query(False),
    sort: str = Query("priority"),
    order: str = Query("asc"),
    fmt: str = Query("csv"),
) -> Response:
    """Export the current filtered result set as CSV or XLSX."""
    request_id = f"dm-export-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        filters = dict(
            search=search,
            category=category,
            priority=priority,
            tld=tld,
            status=status,
            days=days,
            seo_min=seo_min,
            spam_level=spam_level,
            relevance=relevance,
            topic=topic,
            referring=referring,
            age=age,
            watchlisted=watchlisted or None,
            sort=sort,
            order=order,
        )

        if fmt.lower() in ("xlsx", "excel"):
            return Response(
                content=dm.export_xlsx(**filters),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Content-Disposition": 'attachment; filename="seo-domain-radar.xlsx"',
                    "X-Request-ID": request_id,
                },
            )

        return Response(
            content=dm.export_csv(**filters),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="seo-domain-radar.csv"',
                "X-Request-ID": request_id,
            },
        )
    except Exception as e:
        logger.error(f"[{request_id}] Export failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to export domains", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/discover-keyword/export")
async def domain_monitor_keyword_export(
    cache_key: str = Query(...),
    fmt: str = Query("csv"),
):
    request_id = f"dm-keyword-export-{datetime.now().isoformat()}"
    try:
        kind = fmt.lower()
        if kind not in ("csv", "xlsx"):
            return JSONResponse(
                status_code=400,
                content={"error": "fmt must be csv or xlsx", "request_id": request_id},
            )
        payload = dm_keyword.export_results(cache_key, kind)
        media_type = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if kind == "xlsx"
            else "text/csv; charset=utf-8"
        )
        filename = f"seo-domain-radar-keyword.{kind}"
        return StreamingResponse(
            iter([payload.encode("utf-8") if isinstance(payload, str) else payload]),
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ValueError as e:
        return JSONResponse(
            status_code=404,
            content={"error": str(e), "request_id": request_id},
        )
    except Exception as e:
        logger.error(f"[{request_id}] Keyword export failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to export keyword results", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/enrich")
async def domain_monitor_enrich_status() -> dict[str, Any]:
    """Poll the running enrichment pass."""
    return dm_enrich.ENRICHMENT.snapshot()


@app.post("/api/domain-monitor/enrich")
async def domain_monitor_enrich(
    force: bool = Query(False),
    limit: Optional[int] = Query(None, ge=1, le=5000),
    domains: Optional[str] = Query(None),
    include_safe: bool = Query(False),
) -> dict[str, Any]:
    """Start the SEO enrichment pipeline on a background thread.

    Archive history, backlink metrics, topic matching, spam rules and the SEO
    Opportunity Score all run here. Each external source honours its own cache
    TTL unless `force` is set.
    """
    request_id = f"dm-enrich-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()

        requested: Optional[list[str]] = None
        if domains:
            requested = [d for d in (normalize_domain(p) for p in domains.split(",")) if d]
            if not requested:
                return JSONResponse(
                    status_code=400,
                    content={"error": "No valid domain names given", "request_id": request_id},
                )

        result = dm_enrich.start_enrichment_async(
            domains=requested, force=force, limit=limit, include_safe=include_safe
        )
        logger.info(f"[{request_id}] Enrichment start requested (started={result.get('started')})")
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Enrichment start failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to start enrichment", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/opportunities")
async def domain_monitor_opportunities(limit: int = Query(8, ge=1, le=50)) -> dict[str, Any]:
    """Highest scoring domains. Only rows that actually carry a score appear."""
    request_id = f"dm-opps-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        return {"items": dm_storage.top_opportunities(limit)}
    except Exception as e:
        logger.error(f"[{request_id}] Opportunities failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to load opportunities", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/sources")
async def domain_monitor_sources() -> dict[str, Any]:
    """Configured discovery sources, their status and stored candidate counts.

    Reports configuration state without fetching, and never echoes a credential.
    """
    request_id = f"dm-sources-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        settings = dm_source_config.load_settings()
        counts = dm_storage.source_candidate_counts()

        rows = []
        for row in dm_sources.source_status(settings):
            stored = counts.get(row["name"], {})
            rows.append(
                {
                    **row,
                    "candidates": row.get("candidates", stored.get("candidates")),
                    "last_sync": row.get("last_sync", stored.get("last_sync")),
                }
            )

        return {
            "sources": rows,
            "any_configured": any(r["configured"] and r["enabled"] for r in rows),
            "enabled_kinds": list(settings.enabled_kinds),
            "max_candidates": settings.max_candidates,
            "rdap_cache_hours": settings.rdap_cache_hours,
            "scan_batch_size": settings.scan_batch_size,
            "rdap_concurrency": settings.rdap_concurrency,
            "warnings": settings.warnings,
        }
    except Exception as e:
        logger.error(f"[{request_id}] Source status failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to load sources", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/data-sources")
async def domain_monitor_data_sources() -> dict[str, Any]:
    """Which external sources are configured, and why any are unavailable."""
    return {"sources": dm_enrich.data_sources()}


@app.post("/api/domain-monitor/sources/crawl4ai/test")
async def domain_monitor_crawl4ai_test(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    request_id = f"dm-crawl4ai-test-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        return await dm_crawl.atest_source(payload)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": str(e), "request_id": request_id},
        )
    except Exception as e:
        logger.error(f"[{request_id}] Crawl4AI test failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to test crawl source", "detail": str(e), "request_id": request_id},
        )


@app.post("/api/domain-monitor/sources/crawl4ai")
async def domain_monitor_crawl4ai_save(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    request_id = f"dm-crawl4ai-save-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        source = dm_crawl.save_source_config(payload)
        dm_storage.clear_crawl_source_cache(source.id)
        return {"source": asdict(source)}
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": str(e), "request_id": request_id},
        )
    except Exception as e:
        logger.error(f"[{request_id}] Crawl4AI save failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to save crawl source", "detail": str(e), "request_id": request_id},
        )


@app.post("/api/domain-monitor/sources/crawl4ai/refresh")
async def domain_monitor_crawl4ai_refresh(payload: Optional[dict[str, Any]] = Body(None)) -> dict[str, Any]:
    request_id = f"dm-crawl4ai-refresh-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        source_id = str((payload or {}).get("source_id") or "").strip() or None
        configs = dm_crawl.load_source_configs()
        if source_id:
            config = next((row for row in configs if row.id == source_id), None)
            if not config:
                return JSONResponse(
                    status_code=404,
                    content={"error": "Crawl source not found", "request_id": request_id},
                )
            result = await dm_crawl.acrawl_source(config, force=True)
            return {"results": [asdict(result)]}
        return {"results": [asdict(row) for row in await dm_crawl.acrawl_all_sources(force=True)]}
    except Exception as e:
        logger.error(f"[{request_id}] Crawl4AI refresh failed: {str(e)}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to refresh crawl sources", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/settings")
async def domain_monitor_get_settings() -> dict[str, Any]:
    dm_storage.migrate()
    return {
        "target_niches": dm_storage.target_niches(),
        "available_topics": sorted(dm_config.topics().keys()),
    }


@app.put("/api/domain-monitor/settings")
async def domain_monitor_put_settings(payload: dict[str, Any]) -> dict[str, Any]:
    """Persist the admin's target niches. Only known topics are accepted."""
    request_id = f"dm-settings-{datetime.now().isoformat()}"
    try:
        dm_storage.migrate()
        available = set(dm_config.topics().keys())
        requested = payload.get("target_niches")
        if not isinstance(requested, list):
            return JSONResponse(
                status_code=400,
                content={"error": "target_niches must be a list", "request_id": request_id},
            )
        cleaned = [str(n) for n in requested if str(n) in available]
        dm_storage.set_setting("target_niches", cleaned)
        return {"target_niches": cleaned, "ignored": [n for n in requested if str(n) not in available]}
    except Exception as e:
        logger.error(f"[{request_id}] Settings update failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to save settings", "detail": str(e), "request_id": request_id},
        )


@app.post("/api/domain-monitor/watchlist")
async def domain_monitor_watchlist(payload: dict[str, Any]) -> dict[str, Any]:
    """Toggle the shortlist flag and optionally store a note."""
    request_id = f"dm-watchlist-{datetime.now().isoformat()}"
    domain = normalize_domain(str(payload.get("domain") or ""))
    if not domain:
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid domain name", "request_id": request_id},
        )
    try:
        dm_storage.migrate()
        notes = payload.get("notes")
        updated = dm_storage.set_watchlist(
            domain,
            bool(payload.get("watchlisted", True)),
            None if notes is None else str(notes)[:2000],
        )
        if not updated:
            return JSONResponse(
                status_code=404,
                content={"error": "Domain not monitored", "domain": domain, "request_id": request_id},
            )
        return dm_storage.get_domain(domain) or {}
    except Exception as e:
        logger.error(f"[{request_id}] Watchlist update failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to update watchlist", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/compare")
async def domain_monitor_compare(domains: str = Query(...)) -> dict[str, Any]:
    """Side-by-side rows for up to three domains."""
    request_id = f"dm-compare-{datetime.now().isoformat()}"
    names = [d for d in (normalize_domain(p) for p in domains.split(",")) if d][:3]
    if not names:
        return JSONResponse(
            status_code=400,
            content={"error": "No valid domain names given", "request_id": request_id},
        )
    try:
        dm_storage.migrate()
        found = [dm_storage.get_domain(name) for name in names]
        return {
            "items": [row for row in found if row],
            "missing": [name for name, row in zip(names, found) if not row],
        }
    except Exception as e:
        logger.error(f"[{request_id}] Compare failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to compare domains", "detail": str(e), "request_id": request_id},
        )


@app.get("/api/domain-monitor/{domain}")
async def domain_monitor_detail(domain: str) -> dict[str, Any]:
    request_id = f"dm-detail-{datetime.now().isoformat()}"
    normalized = normalize_domain(domain)
    if not normalized:
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid domain name", "request_id": request_id},
        )
    try:
        dm_storage.migrate()
        record = dm_storage.get_domain(normalized)
        if not record:
            return JSONResponse(
                status_code=404,
                content={"error": "Domain not monitored", "domain": normalized, "request_id": request_id},
            )
        return {
            **record,
            "snapshots": dm_storage.get_snapshots(normalized),
            "status_history": dm_storage.get_status_history(normalized),
            "metric_history": dm_storage.get_metric_history(normalized),
            "discovery_sources": dm_storage.sources_for_domain(normalized),
        }
    except Exception as e:
        logger.error(f"[{request_id}] Domain detail failed: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to load domain", "detail": str(e), "request_id": request_id},
        )


# Add startup and shutdown events
@app.on_event("startup")
async def startup_event():
    logger.info("=" * 50)
    logger.info("SEO API Server Starting Up")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Root directory: {ROOT_DIR}")
    logger.info(f"Python directory: {PYTHON_DIR}")
    try:
        dm_storage.migrate()
        logger.info(f"Domain Monitor DB ready: {dm_storage.DB_PATH}")
    except Exception as e:
        logger.error(f"Domain Monitor migration failed: {e}")
    logger.info("=" * 50)

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("=" * 50)
    logger.info("SEO API Server Shutting Down")
    logger.info("=" * 50)
