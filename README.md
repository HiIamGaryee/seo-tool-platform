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

## Deployment (Vercel)

### Frontend-only deploy

If you deploy only the `frontend` app to Vercel, the Python backend will not run there, and scraping may be limited by CORS.

### Full deploy (Frontend + Python Functions)

This repo also includes Python functions under `api/`, but they will only work if your Vercel project root is the **repo root** (not `frontend`).
