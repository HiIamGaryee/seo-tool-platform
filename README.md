# SEO Sitemap Analyzer (Frontend-Only)

A small React + TypeScript tool to analyze a `sitemap.xml` file in the browser and export SEO data to Excel.  
Everything runs on the **frontend only**, so it can be deployed easily to Vercel or any static host.

## Features

- Upload a `sitemap.xml` file
- Parse up to **100 URLs** from `<loc>` entries
- For each page (fetched from the browser):
  - Page title
  - Meta description
  - Canonical URL
  - Meta robots tag
  - HTML `lang` attribute
  - JSON‑LD `@type` values
  - Total DOM element count
  - Number of `<style>` tags
  - Error column (HTTP errors / timeouts)
- Progress indicator while crawling
- Download results as `seo-analysis-report.xlsx`
- 4 color themes with a toggle button (inspired by the palette images)

## Tech Stack

- **React** + **TypeScript** (Vite)
- **XLSX** (generate Excel in the browser)

## Getting Started (Local)

From the `frontend` folder:

```bash
cd frontend
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:5173`).

## How to Use

1. Open the app.
2. Click **Upload sitemap.xml** and choose your sitemap file.
3. Click **Run SEO Analysis**.
4. Wait for the progress counter to reach 100%.
5. Review the table, then click **Download Excel** to get `seo-analysis-report.xlsx`.
6. Use the **Theme** pill button in the top-right to cycle between the 4 color themes.

## Deployment (Vercel)

1. Make sure this project is in a Git repo and pushed to GitHub.
2. In Vercel:
   - New Project → Import your repo.
   - Framework: **Vite**.
   - Build command: `npm run build`.
   - Output directory: `dist`.
3. Deploy. No environment variables or backend are required.

