import base64
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT_DIR / "python"
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from seo_scraper import analyze_sitemap_bytes  # type: ignore


def handler(request):
    """
    Vercel Python Function (handler(request) style)
    - GET  /api/analyze-sitemap  -> simple JSON health response
    - POST /api/analyze-sitemap  -> body: raw sitemap.xml (text/xml), returns { rows: [...] }
    """
    method = (request.get("method") or request.get("httpMethod") or "GET").upper()

    if method == "GET":
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"message": "API working"}),
        }

    body = request.get("body", "") or ""
    if request.get("isBase64Encoded"):
        data = base64.b64decode(body)
    else:
        data = body.encode("utf-8") if isinstance(body, str) else body

    if not data:
        return {
            "statusCode": 400,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Empty request body. Send sitemap XML in POST body."}),
        }

    rows = analyze_sitemap_bytes(data)
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"rows": rows}),
    }

