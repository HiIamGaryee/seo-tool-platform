# SEO Sitemap Analyzer

A React + TypeScript tool to analyze a `sitemap.xml` file and export SEO data to Excel.

This repo supports **two run modes**:

- **Local backend mode (recommended for accuracy)**: React UI + local Python FastAPI backend (no CORS issues, best results)
- **Frontend-only mode (limited)**: browser fetches pages directly (may fail due to CORS on many sites)

## Features

- Upload a `sitemap.xml` file
- Parse up to **100 URLs** from `<loc>` entries
- For each page:
  - Page title
  - Meta description
  - Meta keywords
  - Canonical URL
  - Meta robots tag
  - HTML `lang` attribute
  - JSON‑LD `@type` values
  - Open Graph: `og:title`, `og:description`, `og:image`, `og:type`
  - Total DOM element count
  - Number of `<style>` tags
  - Error column (HTTP errors / timeouts)
- Progress indicator while crawling
- Download results as `seo-analysis-report.xlsx`
- 4 color themes with a toggle button (inspired by the palette images)

## Tech Stack

- **React** + **TypeScript** (Vite)
- **XLSX** (generate Excel in the browser)
- **Python** (requests + BeautifulSoup + lxml + pandas) for server-side scraping

## Getting Started (Local - with backend)

### Backend (Python)

```bash
cd backend
python3 -m pip install fastapi uvicorn requests beautifulsoup4 pandas openpyxl lxml
python3 -m uvicorn server:app --reload --port 8000
```

Leave that running.

### Frontend (React)

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:5173`).

> If your React app needs to point to the local backend, set `VITE_API_BASE_URL=http://localhost:8000` in `frontend/.env`.

## How to Use

1. Open the app.
2. Click **Upload sitemap.xml** and choose your sitemap file.
3. Click **Run SEO Analysis**.
4. Wait for the progress counter to reach 100%.
5. Review the table, then click **Download Excel** to get `seo-analysis-report.xlsx`.
6. Use the **Theme** pill button in the top-right to cycle between the 4 color themes.

## SEO Domain Radar

A second tool in the same app: it verifies candidate domains against RDAP,
enriches them with archive history and backlink data, then scores them for SEO
opportunity using transparent rules.

Open the sidebar and click **Domain Radar**.

Everything is deterministic. There is no AI, no LLM, no embeddings and no
learned model anywhere in the pipeline — every number traces to a configured
threshold in `backend/domain_monitor/config/`.

### Lifecycle, not availability

A domain does not go straight from expired to available. It moves through
Active -> Expired -> Grace / Auto Renew -> Redemption Period -> Pending Delete
-> Dropped. Both the expiration date and the registry status are stored, and
registry status wins when the two disagree. The tool never claims a domain will
become available.

| Signal | Category | Priority |
| --- | --- | --- |
| `pendingDelete` | Pending Delete | Critical |
| `redemptionPeriod` | Redemption | Very High |
| `days_left < 0` | Expired | High |
| `0-30 days` | Expiring <=30 Days | Medium |
| `31-60 days` | Expiring 31-60 Days | Watch |
| `> 60 days` | Safe | Low |
| no expiry published | Unknown | Unknown |

### How a scan works

RDAP cannot answer "which domains expire in 30 days" — it only verifies domains
you already know. So the pipeline is:

candidate sources -> collect -> deduplicate -> RDAP verify -> classify -> store

1. **Import Domains** — upload a TXT or CSV list. Every line is validated as a
   hostname; invalid entries and duplicates are reported, never stored.
2. **Run Scan** — runs on a background thread, so the UI stays responsive and
   shows live counters. Domains checked inside the cache TTL are skipped.
3. **Export** — downloads the current filtered result set as CSV.

### Candidate discovery

Discovery is a pluggable adapter pipeline, configured entirely from the
environment. Nothing is enabled by default except Manual Import, and Manual
Import is empty until you import something — a fresh install discovers **zero**
candidates and says so rather than seeding samples.

```
configured sources -> normalise -> deduplicate -> store -> RDAP -> classify
```

| Adapter | Enable with | Reads |
| --- | --- | --- |
| **Manual Import** | `manual` (default) | `sources/imported.txt`, written by the Import dialog |
| **Zone File** | `zone` + `ZONE_FILE_DIRECTORY` | `.zone`, `.txt`, `.csv`, `.gz` — streamed, never loaded whole |
| **External Feed** | `feed` + `DOMAIN_FEED_URL` | text, CSV or JSON over HTTPS |
| **Watchlist** | `watchlist` | domains you flagged in the dashboard |
| **Demo Fixture** | `DOMAIN_USE_DEMO_DATA=true` | `fixtures/demo_domains.txt`, development only |

```bash
export DOMAIN_SOURCES=manual,zone,feed
export ZONE_FILE_DIRECTORY=/srv/zones
export DOMAIN_FEED_URL=https://feed.example/expiring.csv
export DOMAIN_FEED_API_KEY=...          # sent as a Bearer token, never logged
```

Zone files list registered domains and carry **no expiry information**, so
every candidate still goes through RDAP for its lifecycle. The feed adapter
does one authenticated GET and parses text/CSV/JSON — there is no HTML
scraper, no login flow and no CAPTCHA or anti-bot circumvention anywhere.

A source that fails is marked `Failed` and the remaining sources still run.

**Normalisation and deduplication happen before any RDAP call**, so
`example.com`, `EXAMPLE.COM`, `www.example.com` and
`https://example.com/path` cost exactly one lookup between them. Shell
commands, file paths and malformed hostnames are rejected.

Provenance is recorded in `domain_source_links`: a domain found by several
sources keeps one candidate row and one link row per source.

### Discovery configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `DOMAIN_SOURCES` | `manual` | Enabled adapters, comma-separated |
| `DOMAIN_SOURCE_ENABLED` | `true` | Master switch |
| `DOMAIN_SOURCE_MAX_CANDIDATES` | `5000` | Candidate cap per run |
| `DOMAIN_SOURCE_TIMEOUT` | `20` | Feed request timeout (seconds) |
| `ZONE_FILE_DIRECTORY` | unset | Zone file directory |
| `ZONE_FILE_MAX_FILES` | `25` | Zone files read per run |
| `DOMAIN_FEED_URL` | unset | Feed endpoint |
| `DOMAIN_FEED_API_KEY` | unset | Feed bearer token |
| `DOMAIN_FEED_FORMAT` | `auto` | `text`, `csv` or `json` |
| `DOMAIN_FEED_JSON_PATH` | unset | e.g. `data.items:domain` |
| `DOMAIN_SCAN_BATCH_SIZE` | `100` | RDAP batch size |
| `DOMAIN_RDAP_CONCURRENCY` | `10` | Parallel RDAP lookups |
| `DOMAIN_RDAP_TIMEOUT` | `15` | RDAP timeout (seconds) |
| `DOMAIN_RDAP_MAX_RETRIES` | `3` | RDAP attempts per domain |
| `RDAP_CACHE_HOURS` | `24` | Skip domains checked more recently |
| `DOMAIN_USE_DEMO_DATA` | `false` | Load development fixtures |

### Incremental scanning

Scans are incremental, not exhaustive: a new candidate is looked up, a stale
one is refreshed, and one checked inside `RDAP_CACHE_HOURS` is skipped. The
queue is ordered by lifecycle urgency (pending delete, redemption, expired,
then expiring), so a capped run still covers what matters.

SEO enrichment is gated the same way — only expiring, expired, redemption,
pending-delete and watchlisted domains are enriched, so backlink and archive
credit is never spent on a domain that is years from expiring. Pass
`include_safe=true` to override.

### Storage

SQLite at `backend/domain_monitor/data/domain_monitor.db`, created on first
run. Do not commit it.

### Tests

```bash
cd backend && python3 -m pytest tests/ -q
```

84 tests covering normalisation, validation, deduplication, the source
adapters, RDAP parsing and classification, the day boundaries, source failure
handling, cache TTL behaviour and lifecycle gating. External services are
mocked and the suite blocks live network calls outright.

### Scheduled scans

No scheduler package is bundled. Point whatever cron you already run at:

```bash
cd backend && python3 domain_monitor/domain_monitor.py --force
```

Flags: `--force` re-checks every stored domain, `--limit N` caps the run,
`--no-sources` skips the configured sources.

### Tuning

| Env var | Default | Purpose |
| --- | --- | --- |
| `DOMAIN_MONITOR_CONCURRENCY` | `12` | Parallel RDAP lookups (capped at 32) |
| `DOMAIN_MONITOR_CACHE_TTL_HOURS` | `24` | Skip domains checked more recently |
| `DOMAIN_MONITOR_BATCH_SIZE` | `50` | Records per database write |
| `DOMAIN_MONITOR_DB` | `backend/domain_monitor/data/domain_monitor.db` | Database path |
| `DOMAIN_MONITOR_SOURCES` | `backend/domain_monitor/sources` | Source config folder |
| `DOMAIN_MONITOR_WHOIS_FALLBACK` | `0` | Set to `1` to allow port-43 WHOIS for TLDs with no RDAP |

### API

| Method | Path |
| --- | --- |
| `GET` | `/api/domain-monitor` (`search`, `category`, `priority`, `tld`, `status`, `days`, `page`, `limit`, `sort`, `order`) |
| `GET` | `/api/domain-monitor/stats` |
| `GET` | `/api/domain-monitor/scan` (poll progress) |
| `POST` | `/api/domain-monitor/scan` (`force`, `limit`, `use_sources`) |
| `POST` | `/api/domain-monitor/import` (TXT/CSV upload) |
| `GET` | `/api/domain-monitor/export` (CSV, same filters) |
| `GET` | `/api/domain-monitor/{domain}` |

### Pipeline

```
candidate sources -> RDAP verification -> lifecycle classification
  -> archive history (Wayback CDX) -> backlink provider -> anchor analysis
  -> spam rules -> topic matching -> SEO Opportunity Score -> dashboard
```

Two passes, on independent schedules:

- **Run Scan** — RDAP lifecycle only. Fast, 24h cache.
- **Refresh SEO Data** — archive, backlinks, topics, spam, scoring. Slow and
  rate-limited, so it caches for far longer.

### SEO Opportunity Score

Weighted, rule-based, 0–100. Weights live in `config/scoring.json`.

| Component | Weight |
| --- | --- |
| Referring Domains | 25 |
| Backlink Quality | 20 |
| Historical Stability | 15 |
| Topical Relevance | 15 |
| Domain Age | 10 |
| Anchor Profile | 10 |
| Domain Name Quality | 5 |

Then `final = base − spam_penalty`.

**Missing data is never scored as zero.** A component with no data is excluded
and the remaining weight is renormalised. Below
`minimum_available_weight_pct` (default 35%) no score is published at all —
the UI shows why instead. Every score carries a confidence label (Full /
Partial / Limited) and the exact model coverage, so a score built without
backlink data is visibly marked as such.

This is an internal rule-based measure. It is not a Google metric and it does
not predict resale value.

### Spam risk

Deterministic signals, each printed with the number that triggered it:
historical spam categories, suspicious anchor ratio, exact-match anchor
concentration, unrelated topic changes, backlink concentration and heavy
backlink loss. Keyword lists live in `config/spam_keywords.json`.

Bands: Low ≤20, Moderate ≤45, High ≤70, Very High >70. Called *rule-based spam
risk* — never a Google penalty score.

### Topic matching

Keyword dictionaries in `config/seo_topics.json`, matched on word boundaries
against archived titles, meta descriptions, URLs and anchor text. Spam
categories double as topics for timeline purposes, so a site that became a
casino registers as a topic change rather than as "no topic".

Reported as **Rule Match Strength**, not confidence. Select **Target Niches**
in the UI to drive the topical relevance component.

### Data sources

| Source | Status | Notes |
| --- | --- | --- |
| RDAP | always on | IANA bootstrap registry |
| Wayback Machine | on by default | public CDX API, 5 sampled snapshots per domain |
| Backlink provider | **opt-in** | Ahrefs / Semrush / Majestic |

Backlink data requires credentials. Without them the UI says *Backlink data
unavailable* and the affected score components are excluded — no numbers are
invented.

```bash
export BACKLINK_PROVIDER=ahrefs        # ahrefs | semrush | majestic
export BACKLINK_API_KEY=...            # never hardcoded
```

Google SERPs are never scraped and index status is never fabricated.

### Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BACKLINK_PROVIDER` | unset | Backlink vendor |
| `BACKLINK_API_KEY` | unset | Vendor credential |
| `DOMAIN_MONITOR_BACKLINK_TTL_HOURS` | `168` | Backlink cache |
| `DOMAIN_MONITOR_HISTORY_TTL_DAYS` | `14` | Archive cache |
| `DOMAIN_MONITOR_HISTORY_SAMPLES` | `5` | Snapshots read per domain |
| `DOMAIN_MONITOR_ENRICH_CONCURRENCY` | `6` | Parallel enrichment workers |
| `DOMAIN_MONITOR_HISTORY_MIN_INTERVAL` | `1.2` | Seconds between Wayback calls |
| `DOMAIN_MONITOR_HISTORY_ENABLED` | `1` | Set `0` to skip the archive |

### Database

Schema v2 upgrades v1 in place via `ALTER TABLE` — no data loss. Adds the SEO
columns plus `domain_status_history`, `seo_metric_history`, `domain_snapshots`
and `app_settings`. Lifecycle and metric observations are appended, never
overwritten, so trends stay available.

### API

| Method | Path |
| --- | --- |
| `GET` | `/api/domain-monitor` (adds `seo_min`, `spam_level`, `relevance`, `topic`, `referring`, `age`, `watchlisted`) |
| `GET` | `/api/domain-monitor/stats` |
| `GET` `POST` | `/api/domain-monitor/scan` |
| `GET` `POST` | `/api/domain-monitor/enrich` |
| `GET` | `/api/domain-monitor/opportunities` |
| `GET` | `/api/domain-monitor/data-sources` |
| `GET` `PUT` | `/api/domain-monitor/settings` (target niches) |
| `POST` | `/api/domain-monitor/watchlist` |
| `GET` | `/api/domain-monitor/compare?domains=a,b,c` |
| `POST` | `/api/domain-monitor/import` |
| `GET` | `/api/domain-monitor/export?fmt=csv\|xlsx` |
| `GET` | `/api/domain-monitor/{domain}` |

## UI / Design System

The frontend uses [shadcn/ui](https://ui.shadcn.com/) on top of the existing
React + TypeScript + Vite + Tailwind v4 stack. No UI framework was added or
replaced.

- **Config**: `frontend/components.json` — `new-york` style, `zinc` base,
  CSS variables, `lucide` icons, Tailwind v4 (empty `tailwind.config`).
- **Primitives**: `frontend/src/components/ui/` — CLI-generated, not
  hand-edited. Regenerate with `npx shadcn@latest add <component>`.
- **Shell**: `frontend/src/components/layout/` — `AppShell`, `AppSidebar`,
  `AppHeader`. Nav items live in `frontend/src/lib/nav.ts`.
- **Tokens**: `frontend/src/index.css`. Semantic variables only — components
  never name a colour. The lifecycle severity ramp is
  `--critical` / `--severe` / `--caution` / `--info` / `--success`, mapped to
  badge classes in `frontend/src/domain-monitor/domainVisuals.ts`.
- **Radius**: `--radius: 0.625rem` drives `rounded-sm` 6px (small controls),
  `rounded-md` 8px (inputs, buttons, badges), `rounded-lg` 10px (cards),
  `rounded-xl` 14px (dialogs). `rounded-full` is reserved for status dots and
  the progress track.
- **Dark mode**: the header toggle writes a `.dark` class on `<html>` and
  persists to `localStorage`. State lives in
  `frontend/src/hooks/use-color-scheme.ts`.
- **Toasts**: Sonner, mounted in `main.tsx`. No `alert()`.

Tailwind note: before this integration `src/index.css` never imported
Tailwind, so the configured v4 pipeline emitted nothing. `@import "tailwindcss"`
is now in place; the `@tailwindcss/postcss` setup was kept as-is.

## Deployment (Vercel)

### Frontend-only deploy

If you deploy only the `frontend` app to Vercel, the Python backend will not run there, and scraping may be limited by CORS.

### Full deploy (Frontend + Python Functions)

This repo also includes Python functions under `api/`, but they will only work if your Vercel project root is the **repo root** (not `frontend`).
