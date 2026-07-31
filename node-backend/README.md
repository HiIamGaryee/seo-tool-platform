# SEO Tool — Node.js backend

A drop-in Node.js (Express) replacement for the Python FastAPI backend
(`backend/server.py` + `python/seo_scraper.py`). Same routes, same JSON shapes,
same default port (**8000**) — the React frontend needs **no changes**.

## Run

```bash
cd node-backend
npm install
npm start        # or: npm run dev  (auto-restart on file changes)
```

Server listens on `http://localhost:8000`. The frontend already points here via
`VITE_API_BASE_URL` (default `http://localhost:8000`), so just run this instead
of uvicorn.

## Endpoints (identical to the Python backend)

| Method | Route              | Purpose                                             |
|--------|--------------------|-----------------------------------------------------|
| GET    | `/health`          | Health check                                        |
| POST   | `/analyze-sitemap` | Upload `sitemap.xml` (field `file`) → `{ rows }`     |
| POST   | `/export-excel`    | JSON rows → `.xlsx` (kept for parity; frontend builds Excel client-side) |
| GET    | `/fetch-html?url=` | Server-side HTML proxy (avoids browser CORS)        |
| GET    | `/fetch-image?url=`| Server-side image proxy                             |

## Python → Node mapping

| Python                    | Node                |
|---------------------------|---------------------|
| FastAPI + uvicorn         | express             |
| requests                  | axios               |
| BeautifulSoup + lxml      | cheerio             |
| lxml (sitemap XML)        | cheerio (xml mode)  |
| pandas → Excel            | exceljs             |
| UploadFile                | multer              |

## Notes / known small differences vs. Python

- **`domElements`** is `cheerio('*').length`. cheerio (parse5) and
  BeautifulSoup+lxml build the DOM slightly differently, so this count can differ
  by a small amount on the same page. It's the same *metric*, not a bug.
- Charset detection uses the `Content-Type` header charset (fallback UTF-8),
  vs. Python's `requests.apparent_encoding`. UTF-8 pages are identical; a few
  legacy-encoded pages may decode slightly differently.
- URL analysis runs with concurrency 6 (Python ran them one at a time). Output
  order is preserved by sitemap order, so results are unchanged — just faster.
- The `exceljs` audit warnings come from its transitive deps and are only
  reachable through `/export-excel`, which the current frontend does not call.
