from __future__ import annotations

from fastapi import FastAPI, File, UploadFile, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from typing import Any, List
from pathlib import Path
import sys
import requests

# Ensure the ../python folder is on sys.path so we can import seo_scraper
ROOT_DIR = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT_DIR / "python"
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from seo_scraper import analyze_sitemap_bytes, rows_to_excel_bytes  # type: ignore

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/analyze-sitemap")
async def analyze_sitemap(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    rows = analyze_sitemap_bytes(data)
    return {"rows": rows}


@app.post("/export-excel")
async def export_excel(rows: List[dict[str, Any]]) -> StreamingResponse:
    excel_bytes = rows_to_excel_bytes(rows)
    return StreamingResponse(
        iter([excel_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="seo-analysis-report.xlsx"'
        },
    )


@app.get("/fetch-html")
async def fetch_html(url: str = Query(...)) -> Response:
    """
    Simple HTML fetch proxy for the Download page.
    This avoids browser CORS by fetching server-side.
    """
    resp = requests.get(
        url,
        timeout=10,
        headers={"User-Agent": "SEO-Sitemap-Analyzer/1.0"},
    )
    # try to decode with correct encoding
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding or "utf-8"
    return Response(content=resp.text, media_type="text/html; charset=utf-8")

