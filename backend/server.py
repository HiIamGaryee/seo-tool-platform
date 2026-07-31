from __future__ import annotations

import logging
import time
import traceback
import zipfile
from datetime import datetime
from fastapi import FastAPI, File, UploadFile, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, JSONResponse
from pydantic import BaseModel
from typing import Any, List, Optional
from pathlib import Path
import sys
import requests

from batch_zip import normalize_items, build_zip


class ZipItem(BaseModel):
    url: str
    name: Optional[str] = None


class ZipRequest(BaseModel):
    items: Optional[List[ZipItem]] = None
    urls: Optional[List[str]] = None
    zipName: Optional[str] = None

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

from seo_scraper import analyze_sitemap_bytes, rows_to_excel_bytes  # type: ignore

app = FastAPI()

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
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "python_version": sys.version,
        "api_version": "1.0.0"
    }

@app.post("/analyze-sitemap")
async def analyze_sitemap(file: UploadFile = File(...)) -> dict[str, Any]:
    request_id = f"analyze-{datetime.now().isoformat()}-{id(file)}"
    logger.info(f"[{request_id}] Starting analyze-sitemap request")
    
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
            
            response_data = {"rows": rows, "request_id": request_id, "processing_time": analyze_time}
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

# ── Batch endpoints — ONE call fetches many resources and returns one zip ──
# These replace the frontend's per-item loops over /fetch-html and /fetch-image.

@app.post("/fetch-images-zip")
async def fetch_images_zip(req: ZipRequest) -> Response:
    request_id = f"images-zip-{datetime.now().isoformat()}"
    items = normalize_items(
        [{"url": i.url, "name": i.name} for i in req.items] if req.items else None,
        req.urls,
        ".jpg",
    )
    logger.info(f"[{request_id}] images-zip request with {len(items)} item(s)")

    if not items:
        return JSONResponse(
            status_code=400,
            content={"error": "No image URLs provided", "request_id": request_id},
        )

    try:
        # Images are already compressed, so store (no re-compression).
        zip_bytes, packed, failed = build_zip(
            items,
            timeout=30,
            headers={"User-Agent": "Mozilla/5.0 (compatible; SEO-Sitemap-Analyzer/1.0)"},
            compression=zipfile.ZIP_STORED,
        )
        logger.info(f"[{request_id}] images-zip: {packed} packed, {failed} failed")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="images.zip"',
                "X-Request-ID": request_id,
            },
        )
    except Exception as e:
        logger.error(f"[{request_id}] images-zip failed: {e}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to build images zip", "detail": str(e), "request_id": request_id},
        )


@app.post("/fetch-html-zip")
async def fetch_html_zip(req: ZipRequest) -> Response:
    request_id = f"html-zip-{datetime.now().isoformat()}"
    items = normalize_items(
        [{"url": i.url, "name": i.name} for i in req.items] if req.items else None,
        req.urls,
        ".html",
    )
    logger.info(f"[{request_id}] html-zip request with {len(items)} item(s)")

    if not items:
        return JSONResponse(
            status_code=400,
            content={"error": "No URLs provided", "request_id": request_id},
        )

    filename = req.zipName or "pages.zip"

    try:
        # HTML compresses well — deflate it.
        zip_bytes, packed, failed = build_zip(
            items,
            timeout=15,
            headers={"User-Agent": "SEO-Sitemap-Analyzer/1.0"},
            compression=zipfile.ZIP_DEFLATED,
        )
        logger.info(f"[{request_id}] html-zip: {packed} packed, {failed} failed")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Request-ID": request_id,
            },
        )
    except Exception as e:
        logger.error(f"[{request_id}] html-zip failed: {e}")
        logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"error": "Failed to build pages zip", "detail": str(e), "request_id": request_id},
        )


# Add startup and shutdown events
@app.on_event("startup")
async def startup_event():
    logger.info("=" * 50)
    logger.info("SEO API Server Starting Up")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Root directory: {ROOT_DIR}")
    logger.info(f"Python directory: {PYTHON_DIR}")
    logger.info("=" * 50)

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("=" * 50)
    logger.info("SEO API Server Shutting Down")
    logger.info("=" * 50)