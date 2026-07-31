"use strict";

// Node.js port of backend/server.py (Express drop-in for the FastAPI backend).
// Same routes, same JSON shapes, same default port (8000) — the React frontend
// needs no changes.

const https = require("https");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");

const {
  analyzeSitemapBytes,
  rowsToExcelBytes,
} = require("./seoScraper");

const PORT = process.env.PORT || 8000;

const app = express();

// CORS: allow all origins, mirroring the FastAPI config.
app.use(cors());

// Parse JSON bodies (for /export-excel). Generous limit for large row sets.
app.use(express.json({ limit: "50mb" }));

// In-memory file upload for /analyze-sitemap (field name: "file").
const upload = multer({ storage: multer.memoryStorage() });

// Accept self-signed / bad certs for the proxy endpoints, mirroring verify=False.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Simple request logger, similar in spirit to the FastAPI middleware.
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `${new Date().toISOString()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  req.requestId = requestId;
  console.log(`[${requestId}] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[${requestId}] completed ${res.statusCode} in ${(ms / 1000).toFixed(3)}s`
    );
  });
  next();
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    node_version: process.version,
    api_version: "1.0.0",
  });
});

app.post("/analyze-sitemap", upload.single("file"), async (req, res) => {
  const requestId = req.requestId;
  try {
    const data = req.file && req.file.buffer;
    if (!data || data.length === 0) {
      return res
        .status(400)
        .json({ error: "Empty file received", request_id: requestId });
    }

    const start = Date.now();
    const rows = await analyzeSitemapBytes(data);
    const processingTime = (Date.now() - start) / 1000;
    console.log(
      `[${requestId}] analyzed ${rows.length} URLs in ${processingTime.toFixed(3)}s`
    );

    res.set({
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    return res.json({
      rows,
      request_id: requestId,
      processing_time: processingTime,
    });
  } catch (e) {
    console.error(`[${requestId}] analyze-sitemap failed: ${e.stack || e}`);
    return res.status(500).json({
      error: "Failed to analyze sitemap",
      detail: String(e.message || e),
      request_id: requestId,
    });
  }
});

// Kept for parity with the Python backend (the current frontend builds Excel
// client-side, so this route is optional but harmless to keep).
app.post("/export-excel", async (req, res) => {
  const requestId = req.requestId;
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    const excelBytes = await rowsToExcelBytes(rows);
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="seo-analysis-report.xlsx"',
      "X-Request-ID": requestId,
    });
    return res.send(excelBytes);
  } catch (e) {
    console.error(`[${requestId}] export-excel failed: ${e.stack || e}`);
    return res.status(500).json({
      error: "Failed to export Excel",
      detail: String(e.message || e),
      request_id: requestId,
    });
  }
});

app.get("/fetch-html", async (req, res) => {
  const requestId = req.requestId;
  const url = req.query.url;
  if (!url) {
    return res.status(422).send("Missing 'url' query parameter");
  }
  try {
    const resp = await axios.get(String(url), {
      timeout: 10000,
      responseType: "text",
      httpsAgent: insecureAgent,
      maxRedirects: 10,
      headers: { "User-Agent": "SEO-Sitemap-Analyzer/1.0" },
    });
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "X-Request-ID": requestId,
    });
    return res.send(resp.data);
  } catch (e) {
    console.error(`[${requestId}] fetch-html failed: ${e.message}`);
    return res
      .status(500)
      .set("X-Request-ID", requestId)
      .send(`Error fetching URL: ${e.message}`);
  }
});

app.get("/fetch-image", async (req, res) => {
  const requestId = req.requestId;
  const url = req.query.url;
  if (!url) {
    return res.status(422).send("Missing 'url' query parameter");
  }
  try {
    const resp = await axios.get(String(url), {
      timeout: 20000,
      responseType: "arraybuffer",
      httpsAgent: insecureAgent,
      maxRedirects: 10,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SEO-Sitemap-Analyzer/1.0)",
      },
    });
    const contentType = (resp.headers["content-type"] || "image/jpeg")
      .split(";")[0]
      .trim();
    res.set({ "Content-Type": contentType, "X-Request-ID": requestId });
    return res.send(Buffer.from(resp.data));
  } catch (e) {
    console.error(`[${requestId}] fetch-image failed: ${e.message}`);
    return res
      .status(500)
      .set("X-Request-ID", requestId)
      .send(`Error fetching image: ${e.message}`);
  }
});

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("SEO API Server (Node.js) listening on port " + PORT);
  console.log("Node version: " + process.version);
  console.log("=".repeat(50));
});
