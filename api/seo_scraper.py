from http.server import BaseHTTPRequestHandler
import json
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT_DIR / "python"
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from seo_scraper import analyze_sitemap_bytes  # type: ignore


class handler(BaseHTTPRequestHandler):
    """
    Vercel Python Function:
    - POST /api/seo_scraper
    - Body: raw sitemap XML (Content-Type: text/xml)
    - Response: JSON { rows: [...] }
    """

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or 0)
        data = self.rfile.read(length) if length > 0 else b""

        rows = analyze_sitemap_bytes(data)
        body = json.dumps({"rows": rows}).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return

