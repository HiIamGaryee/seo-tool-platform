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

## Domain Monitor (ported from `backend/domain_monitor/`)

The full **Domain Monitor / SEO Domain Radar** subsystem is ported to Node under
`domainMonitor/` and mounted by `server.js` at `/api/domain-monitor/*` (~30
endpoints, same routes and JSON shapes as the FastAPI backend, so the React
frontend needs no changes). Storage is SQLite via `better-sqlite3`; the schema,
scoring config and topic/spam keyword lists are byte-for-byte the same JSON.

Pipelines: **scan** (discovery sources → normalise → dedupe → RDAP verify →
classify → store) and **enrich** (Wayback archive history + backlink provider +
topic classification + spam rules + rule-based SEO Opportunity Score), plus
**discover-keyword** (fuzzy similar/expiring-domain discovery).

### Python → Node mapping (Domain Monitor)

| Python                         | Node                                             |
|--------------------------------|--------------------------------------------------|
| `sqlite3`                      | `better-sqlite3`                                 |
| `requests` clients             | `axios` (via `net.js`)                           |
| `BeautifulSoup`                | `cheerio`                                        |
| `ThreadPoolExecutor`           | bounded async Promise pool (`pool.js`)           |
| `pandas`/`openpyxl` export     | `exceljs`                                        |
| `rapidfuzz`/`difflib`          | in-repo Levenshtein + SequenceMatcher port       |
| **`crawl4ai`** (headless LLM crawler) | `axios` + `cheerio` raw-HTTP crawl, with the Gemini REST API as the extraction fallback |

**crawl4ai note:** Node has no `crawl4ai` package, so the headless-browser path
is replaced by raw-HTTP crawling (axios + cheerio) and a direct Gemini
`generateContent` call for the LLM-extraction fallback. `healthStatus()` reports
`crawl4ai_browser: "not installed"` accordingly; CSS-selector / pagination /
domain-extraction crawling all work.

### Domain Monitor config / env

Same env var names as the Python backend, e.g. `DOMAIN_MONITOR_DB`,
`DOMAIN_SOURCES`, `RDAP_CACHE_HOURS`, `DOMAIN_MONITOR_WHOIS_FALLBACK`,
`BACKLINK_PROVIDER` + `BACKLINK_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
`DOMAIN_MONITOR_BACKLINK_TTL_HOURS`, `DOMAIN_MONITOR_HISTORY_TTL_DAYS`. With no
extra config a fresh install discovers zero candidates (import a TXT/CSV list or
set `DOMAIN_SOURCES`) and the backlink provider is `none` (metrics render as
em dashes, never zero). The SQLite DB lives at `domainMonitor/data/` and is
gitignored.
