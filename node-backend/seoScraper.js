"use strict";

// Node.js port of python/seo_scraper.py
// Uses cheerio (BeautifulSoup equivalent) + axios (requests equivalent).

const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");

const MAX_URLS = 100;
const REQUEST_TIMEOUT = 30000; // 30s, mirrors REQUEST_TIMEOUT = 30 (seconds) in Python
const CONCURRENCY = 6; // small pool; output order is still preserved by index

// Accept self-signed / bad certs, mirroring requests(..., verify=False)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Ordered list of the columns we produce, matching the Python SeoRow dataclass.
const ROW_COLUMNS = [
  "url",
  "title",
  "description",
  "keywords",
  "og_title",
  "og_description",
  "og_image",
  "og_type",
  "og_url",
  "canonical",
  "robots",
  "language",
  "jsonld",
  "domElements",
  "styleTags",
  "error",
];

function emptyRow(url, error) {
  return {
    url,
    title: "",
    description: "",
    keywords: "",
    og_title: "",
    og_description: "",
    og_image: "",
    og_type: "",
    og_url: "",
    canonical: "",
    robots: "",
    language: "",
    jsonld: "",
    domElements: 0,
    styleTags: 0,
    error: error || "",
  };
}

/**
 * Parse sitemap XML bytes and return up to `limit` <loc> URLs.
 * Mirrors parse_sitemap_bytes().
 */
function parseSitemapBytes(data, limit = MAX_URLS) {
  const xml = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  const $ = cheerio.load(xml, { xmlMode: true });

  const urls = [];
  $("loc").each((_, el) => {
    const text = $(el).text().trim();
    if (text) urls.push(text);
  });

  return urls.slice(0, limit);
}

/** Recursively collect JSON-LD @type values. Mirrors _extract_jsonld_types(). */
function extractJsonLdTypes($) {
  const types = new Set();

  const collect = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach(collect);
    } else if (obj && typeof obj === "object") {
      const t = obj["@type"];
      if (typeof t === "string") {
        types.add(t);
      } else if (Array.isArray(t)) {
        t.forEach((v) => {
          if (typeof v === "string") types.add(v);
        });
      }
      for (const v of Object.values(obj)) collect(v);
    }
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const text = ($(el).contents().text() || "").trim();
    if (!text) return;
    try {
      collect(JSON.parse(text));
    } catch {
      // ignore malformed JSON-LD, same as the Python version
    }
  });

  return Array.from(types).sort().join(", ");
}

/** Decode a response body buffer, honouring the charset in Content-Type when present. */
function decodeBody(buffer, contentType) {
  let charset = "utf-8";
  if (contentType) {
    const m = /charset=([^;]+)/i.exec(contentType);
    if (m) charset = m[1].trim().toLowerCase();
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf-8");
  }
}

/** Analyze a single URL. Mirrors analyze_url(). Never throws — returns a row (with error set on failure). */
async function analyzeUrl(url) {
  let resp;
  try {
    resp = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      responseType: "arraybuffer",
      maxRedirects: 10,
      httpsAgent: insecureAgent,
      // Never throw on HTTP status here; we handle non-2xx below like raise_for_status.
      validateStatus: () => true,
      headers: {
        "User-Agent": "SEO-Sitemap-Analyzer/1.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });
  } catch (exc) {
    const msg =
      exc.code === "ECONNABORTED"
        ? `Timeout after ${REQUEST_TIMEOUT / 1000}s`
        : `Request error: ${exc.message}`;
    return emptyRow(url, msg);
  }

  if (resp.status >= 400) {
    return emptyRow(url, `Request error: HTTP ${resp.status}`);
  }

  try {
    const html = decodeBody(
      Buffer.from(resp.data),
      resp.headers["content-type"]
    );
    const $ = cheerio.load(html);

    const title = $("title").first().text().trim();

    // last matching <meta name="..."> content, mirroring last_meta()
    const lastMeta = (name) => {
      const tags = $(`meta[name="${name}"]`);
      if (tags.length === 0) return "";
      return (tags.last().attr("content") || "").trim();
    };

    const og = (name) => {
      const tags = $(`meta[property="og:${name}"]`);
      if (tags.length === 0) return "";
      return (tags.last().attr("content") || "").trim();
    };

    const canonicalTag = $('link[rel*="canonical" i]').first();
    const canonical = canonicalTag.length
      ? (canonicalTag.attr("href") || "").trim()
      : "";

    const robotsTag = $('meta[name="robots"]').first();
    const robots = robotsTag.length
      ? (robotsTag.attr("content") || "").trim()
      : "";

    const language = ($("html").first().attr("lang") || "").trim();

    return {
      url,
      title,
      description: lastMeta("description"),
      keywords: lastMeta("keywords"),
      og_title: og("title"),
      og_description: og("description"),
      og_image: og("image"),
      og_type: og("type"),
      og_url: og("url"),
      canonical,
      robots,
      language,
      jsonld: extractJsonLdTypes($),
      domElements: $("*").length,
      styleTags: $("style").length,
      error: "",
    };
  } catch (e) {
    return emptyRow(url, `Error parsing HTML: ${e.message}`);
  }
}

/** Run async mapper over items with bounded concurrency, preserving input order. */
async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await mapper(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

/** Main entry point: parse sitemap bytes and analyze each URL. Mirrors analyze_sitemap_bytes(). */
async function analyzeSitemapBytes(data) {
  const urls = parseSitemapBytes(data);
  return mapPool(urls, CONCURRENCY, (url) => analyzeUrl(url));
}

/** Convert rows to an .xlsx Buffer. Mirrors rows_to_excel_bytes(). */
async function rowsToExcelBytes(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(ROW_COLUMNS);
  for (const row of rows || []) {
    sheet.addRow(ROW_COLUMNS.map((c) => (row && row[c] != null ? row[c] : "")));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  MAX_URLS,
  ROW_COLUMNS,
  parseSitemapBytes,
  analyzeUrl,
  analyzeSitemapBytes,
  rowsToExcelBytes,
};
