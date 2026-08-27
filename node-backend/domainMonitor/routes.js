"use strict";

// Express port of the Domain Monitor endpoints from backend/server.py.
// Registered onto the existing Express app; route order matches the Python
// file (the catch-all /:domain is registered LAST).

const multer = require("multer");

const dm = require("./domainMonitor");
const dmEnrich = require("./enrichment");
const dmKeyword = require("./keywordDiscovery");
const dmStorage = require("./storage");
const dmConfig = require("./configLoader");
const dmSources = require("./domainSources");
const dmSourceConfig = require("./sourceConfig");
const dmCrawl = require("./crawl4aiSource");
const dmSimilar = require("./similarDomains");
const { CATEGORIES, PRIORITIES, normalizeDomain } = require("./models");
const { validateGeminiApiKey, DEFAULT_GEMINI_API_KEY } = require("./gemini");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

function reqId(prefix) {
  return `${prefix}-${new Date().toISOString()}`;
}

function parseBool(value, def = false) {
  if (value === undefined || value === null || value === "") return def;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function fail(res, status, body) {
  return res.status(status).json(body);
}

function registerDomainMonitorRoutes(app) {
  // GET /api/domain-monitor  (list)
  app.get("/api/domain-monitor", (req, res) => {
    const requestId = reqId("dm-list");
    try {
      dmStorage.migrate();
      const q = req.query;
      const result = dmStorage.listDomains({
        search: q.search ?? null,
        category: q.category ?? null,
        priority: q.priority ?? null,
        tld: q.tld ?? null,
        status: q.status ?? null,
        days: q.days ?? null,
        seo_min: parseIntOrNull(q.seo_min),
        spam_level: q.spam_level ?? null,
        relevance: q.relevance ?? null,
        topic: q.topic ?? null,
        referring: q.referring ?? null,
        age: q.age ?? null,
        watchlisted: parseBool(q.watchlisted) || null,
        page: parseIntOrNull(q.page) || 1,
        limit: parseIntOrNull(q.limit) || 20,
        sort: q.sort || "priority",
        order: q.order || "asc",
      });
      return res.json(result);
    } catch (e) {
      return fail(res, 500, { error: "Failed to list domains", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/stats
  app.get("/api/domain-monitor/stats", (req, res) => {
    const requestId = reqId("dm-stats");
    try {
      dmStorage.migrate();
      return res.json({
        ...dmStorage.stats(),
        ...dmStorage.seoStats(),
        categories: CATEGORIES,
        priorities: PRIORITIES,
        available_topics: Object.keys(dmConfig.topics()).sort(),
        target_niches: dmStorage.targetNiches(),
        data_sources: dmEnrich.dataSources(),
        discovery_sources: dmSources.sourceStatus(),
        source_candidates: dmStorage.sourceCandidateCounts(),
        scan: dm.SCAN.snapshot(),
        enrichment: dmEnrich.ENRICHMENT.snapshot(),
      });
    } catch (e) {
      return fail(res, 500, { error: "Failed to load stats", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/scan  (poll)
  app.get("/api/domain-monitor/scan", (req, res) => res.json(dm.SCAN.snapshot()));

  // GET /api/domain-monitor/provider-status
  app.get("/api/domain-monitor/provider-status", (req, res) => {
    const crawl = dmCrawl.healthStatus();
    const gemini = dmCrawl.geminiStats();
    const whoisEnabled = dm.ALLOW_WHOIS_FALLBACK;
    const lim = dmSimilar.limits();
    return res.json({
      rdap: { status: "available", detail: "IANA RDAP bootstrap" },
      whois: {
        status: whoisEnabled ? "available" : "not_configured",
        detail: whoisEnabled
          ? "Port-43 fallback via IANA referral"
          : "Set DOMAIN_MONITOR_WHOIS_FALLBACK=1 to enable",
      },
      crawl4ai: { status: crawl.crawl4ai, detail: `browser: ${crawl.crawl4ai_browser}` },
      gemini: {
        status: gemini.configured ? "connected" : "not_configured",
        provider: gemini.provider,
        model: gemini.model,
        detail: gemini.reason || "Extraction fallback ready",
        calls: gemini.calls,
        success: gemini.success,
        failures: gemini.failures,
        last_status: gemini.last_status,
        last_error: gemini.last_error,
      },
      debug: dmSimilar.debugEnabled(),
      tlds: [...dmSimilar.configuredTlds()],
      limits: {
        max_generated: lim.max_generated,
        max_verified: lim.max_verified,
        result_limit: lim.result_limit,
      },
      fuzzy_backend: dmSimilar.FUZZY_BACKEND,
    });
  });

  // POST /api/domain-monitor/gemini/test
  app.post("/api/domain-monitor/gemini/test", async (req, res) => {
    const requestId = reqId("dm-gemini-test");
    try {
      const result = await dmCrawl.geminiTest();
      return res.json(result);
    } catch (e) {
      return fail(res, 500, {
        status: "error",
        provider: "Gemini",
        error: "gemini_test_failed",
        message: String(e.message || e),
        request_id: requestId,
      });
    }
  });

  // POST /gemini/validate-key  (note: NOT under /api/domain-monitor)
  app.post("/gemini/validate-key", async (req, res) => {
    const payload = req.body || {};
    const useDefaultKey = payload.use_default_key === undefined ? true : Boolean(payload.use_default_key);
    const customKey = String(payload.gemini_api_key || "").trim();
    const selectedKey = useDefaultKey ? (process.env.GEMINI_API_KEY || "").trim() : customKey;
    const result = await validateGeminiApiKey(selectedKey);
    result.key_source = useDefaultKey ? "default" : "custom";
    result.configured = Boolean(selectedKey);
    return res.json(result);
  });

  // POST /api/domain-monitor/gemini/key
  app.post("/api/domain-monitor/gemini/key", async (req, res) => {
    const payload = req.body || {};
    const useDefaultKey = payload.use_default_key === undefined ? true : Boolean(payload.use_default_key);
    const customKey = String(payload.gemini_api_key || "").trim();

    if (useDefaultKey) {
      if (DEFAULT_GEMINI_API_KEY) process.env.GEMINI_API_KEY = DEFAULT_GEMINI_API_KEY;
      else delete process.env.GEMINI_API_KEY;
    } else if (customKey) {
      process.env.GEMINI_API_KEY = customKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }

    const result = await validateGeminiApiKey(process.env.GEMINI_API_KEY);
    result.key_source = useDefaultKey ? "default" : "custom";
    result.configured = Boolean(process.env.GEMINI_API_KEY);
    return res.json(result);
  });

  // GET /api/domain-monitor/discover-keyword  (poll)
  app.get("/api/domain-monitor/discover-keyword", (req, res) => res.json(dmKeyword.snapshot()));

  // GET /api/domain-monitor/discover-keyword/history
  app.get("/api/domain-monitor/discover-keyword/history", (req, res) => {
    const limit = Math.max(1, Math.min(parseIntOrNull(req.query.limit) || 8, 20));
    return res.json(dmKeyword.history(limit));
  });

  // DELETE /api/domain-monitor/discover-keyword/history
  app.delete("/api/domain-monitor/discover-keyword/history", (req, res) => {
    dmStorage.migrate();
    return res.json({ cleared: dmStorage.clearKeywordHistory() });
  });

  // POST /api/domain-monitor/discover-keyword
  app.post("/api/domain-monitor/discover-keyword", (req, res) => {
    const requestId = reqId("dm-keyword");
    try {
      dmStorage.migrate();
      const result = dmKeyword.startKeywordDiscovery(req.body || {});
      return res.json(result);
    } catch (e) {
      if (e && e.name === "ValueError") {
        return fail(res, 400, { error: String(e.message || e), request_id: requestId });
      }
      return fail(res, 500, { error: "Failed to start keyword discovery", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/discover-keyword/export
  app.get("/api/domain-monitor/discover-keyword/export", async (req, res) => {
    const requestId = reqId("dm-keyword-export");
    try {
      const kind = String(req.query.fmt || "csv").toLowerCase();
      if (!["csv", "xlsx"].includes(kind)) {
        return fail(res, 400, { error: "fmt must be csv or xlsx", request_id: requestId });
      }
      const cacheKey = req.query.cache_key;
      const payload = await dmKeyword.exportResults(cacheKey, kind);
      const mediaType =
        kind === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8";
      res.set({
        "Content-Type": mediaType,
        "Content-Disposition": `attachment; filename="seo-domain-radar-keyword.${kind}"`,
      });
      return res.send(Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf-8"));
    } catch (e) {
      if (e && e.name === "ValueError") {
        return fail(res, 404, { error: String(e.message || e), request_id: requestId });
      }
      return fail(res, 500, { error: "Failed to export keyword results", detail: String(e.message || e), request_id: requestId });
    }
  });

  // POST /api/domain-monitor/scan
  app.post("/api/domain-monitor/scan", (req, res) => {
    const requestId = reqId("dm-scan");
    try {
      dmStorage.migrate();
      const q = req.query;
      let requested = null;
      if (q.domains) {
        requested = String(q.domains)
          .split(",")
          .map((p) => normalizeDomain(p))
          .filter((d) => d);
        if (!requested.length) {
          return fail(res, 400, { error: "No valid domain names given", request_id: requestId });
        }
      }
      const sourceKinds = q.sources
        ? String(q.sources).split(",").map((k) => k.trim().toLowerCase()).filter((k) => k)
        : null;
      const result = dm.startScanAsync({
        domains: requested,
        force: parseBool(q.force),
        limit: parseIntOrNull(q.limit),
        use_sources: parseBool(q.use_sources, true),
        source_kinds: sourceKinds,
        enrich: parseBool(q.enrich),
      });
      return res.json(result);
    } catch (e) {
      return fail(res, 500, { error: "Failed to start scan", detail: String(e.message || e), request_id: requestId });
    }
  });

  // POST /api/domain-monitor/import
  app.post("/api/domain-monitor/import", upload.single("file"), (req, res) => {
    const requestId = reqId("dm-import");
    try {
      const data = req.file && req.file.buffer;
      if (!data || data.length === 0) {
        return fail(res, 400, { error: "Empty file received", request_id: requestId });
      }
      if (data.length > 5 * 1024 * 1024) {
        return fail(res, 413, { error: "File larger than 5 MB", request_id: requestId });
      }
      const text = data.toString("utf-8");
      const name = (req.file.originalname || "upload").split(/[\\/]/).pop();
      const result = dm.importDomains(text, `import:${name}`);
      return res.json(result);
    } catch (e) {
      return fail(res, 500, { error: "Failed to import domains", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/export
  app.get("/api/domain-monitor/export", async (req, res) => {
    const requestId = reqId("dm-export");
    try {
      dmStorage.migrate();
      const q = req.query;
      const filters = {
        search: q.search ?? null,
        category: q.category ?? null,
        priority: q.priority ?? null,
        tld: q.tld ?? null,
        status: q.status ?? null,
        days: q.days ?? null,
        seo_min: parseIntOrNull(q.seo_min),
        spam_level: q.spam_level ?? null,
        relevance: q.relevance ?? null,
        topic: q.topic ?? null,
        referring: q.referring ?? null,
        age: q.age ?? null,
        watchlisted: parseBool(q.watchlisted) || null,
        sort: q.sort || "priority",
        order: q.order || "asc",
      };
      const fmt = String(q.fmt || "csv").toLowerCase();
      if (fmt === "xlsx" || fmt === "excel") {
        const buf = await dm.exportXlsx(filters);
        res.set({
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="seo-domain-radar.xlsx"',
          "X-Request-ID": requestId,
        });
        return res.send(buf);
      }
      res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="seo-domain-radar.csv"',
        "X-Request-ID": requestId,
      });
      return res.send(dm.exportCsv(filters));
    } catch (e) {
      return fail(res, 500, { error: "Failed to export domains", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/enrich  (poll)
  app.get("/api/domain-monitor/enrich", (req, res) => res.json(dmEnrich.ENRICHMENT.snapshot()));

  // POST /api/domain-monitor/enrich
  app.post("/api/domain-monitor/enrich", (req, res) => {
    const requestId = reqId("dm-enrich");
    try {
      dmStorage.migrate();
      const q = req.query;
      let requested = null;
      if (q.domains) {
        requested = String(q.domains)
          .split(",")
          .map((p) => normalizeDomain(p))
          .filter((d) => d);
        if (!requested.length) {
          return fail(res, 400, { error: "No valid domain names given", request_id: requestId });
        }
      }
      const result = dmEnrich.startEnrichmentAsync({
        domains: requested,
        force: parseBool(q.force),
        limit: parseIntOrNull(q.limit),
        include_safe: parseBool(q.include_safe),
      });
      return res.json(result);
    } catch (e) {
      return fail(res, 500, { error: "Failed to start enrichment", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/opportunities
  app.get("/api/domain-monitor/opportunities", (req, res) => {
    const requestId = reqId("dm-opps");
    try {
      dmStorage.migrate();
      const limit = Math.max(1, Math.min(parseIntOrNull(req.query.limit) || 8, 50));
      return res.json({ items: dmStorage.topOpportunities(limit) });
    } catch (e) {
      return fail(res, 500, { error: "Failed to load opportunities", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/sources
  app.get("/api/domain-monitor/sources", (req, res) => {
    const requestId = reqId("dm-sources");
    try {
      dmStorage.migrate();
      const settings = dmSourceConfig.loadSettings();
      const counts = dmStorage.sourceCandidateCounts();
      const rows = [];
      for (const row of dmSources.sourceStatus(settings)) {
        const stored = counts[row.name] || {};
        rows.push({
          ...row,
          candidates: row.candidates ?? stored.candidates ?? null,
          last_sync: row.last_sync ?? stored.last_sync ?? null,
        });
      }
      return res.json({
        sources: rows,
        any_configured: rows.some((r) => r.configured && r.enabled),
        enabled_kinds: [...settings.enabled_kinds],
        max_candidates: settings.max_candidates,
        rdap_cache_hours: settings.rdap_cache_hours,
        scan_batch_size: settings.scan_batch_size,
        rdap_concurrency: settings.rdap_concurrency,
        warnings: settings.warnings,
      });
    } catch (e) {
      return fail(res, 500, { error: "Failed to load sources", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/data-sources
  app.get("/api/domain-monitor/data-sources", (req, res) => {
    return res.json({ sources: dmEnrich.dataSources() });
  });

  // POST /api/domain-monitor/sources/crawl4ai/test
  app.post("/api/domain-monitor/sources/crawl4ai/test", async (req, res) => {
    const requestId = reqId("dm-crawl4ai-test");
    try {
      dmStorage.migrate();
      return res.json(await dmCrawl.atestSource(req.body || {}));
    } catch (e) {
      if (e && e.name === "ValueError") {
        return fail(res, 400, { error: String(e.message || e), request_id: requestId });
      }
      return fail(res, 500, { error: "Failed to test crawl source", detail: String(e.message || e), request_id: requestId });
    }
  });

  // POST /api/domain-monitor/sources/crawl4ai
  app.post("/api/domain-monitor/sources/crawl4ai", (req, res) => {
    const requestId = reqId("dm-crawl4ai-save");
    try {
      dmStorage.migrate();
      const source = dmCrawl.saveSourceConfig(req.body || {});
      dmStorage.clearCrawlSourceCache(source.id);
      return res.json({ source: { ...source } });
    } catch (e) {
      if (e && e.name === "ValueError") {
        return fail(res, 400, { error: String(e.message || e), request_id: requestId });
      }
      return fail(res, 500, { error: "Failed to save crawl source", detail: String(e.message || e), request_id: requestId });
    }
  });

  // POST /api/domain-monitor/sources/crawl4ai/refresh
  app.post("/api/domain-monitor/sources/crawl4ai/refresh", async (req, res) => {
    const requestId = reqId("dm-crawl4ai-refresh");
    try {
      dmStorage.migrate();
      const sourceId = String((req.body || {}).source_id || "").trim() || null;
      const configs = dmCrawl.loadSourceConfigs();
      if (sourceId) {
        const config = configs.find((row) => row.id === sourceId);
        if (!config) {
          return fail(res, 404, { error: "Crawl source not found", request_id: requestId });
        }
        const result = await dmCrawl.acrawlSource(config, { force: true });
        return res.json({ results: [{ ...result }] });
      }
      const all = await dmCrawl.acrawlAllSources({ force: true });
      return res.json({ results: all.map((row) => ({ ...row })) });
    } catch (e) {
      return fail(res, 500, { error: "Failed to refresh crawl sources", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/settings
  app.get("/api/domain-monitor/settings", (req, res) => {
    dmStorage.migrate();
    return res.json({
      target_niches: dmStorage.targetNiches(),
      available_topics: Object.keys(dmConfig.topics()).sort(),
    });
  });

  // PUT /api/domain-monitor/settings
  app.put("/api/domain-monitor/settings", (req, res) => {
    const requestId = reqId("dm-settings");
    try {
      dmStorage.migrate();
      const available = new Set(Object.keys(dmConfig.topics()));
      const requested = (req.body || {}).target_niches;
      if (!Array.isArray(requested)) {
        return fail(res, 400, { error: "target_niches must be a list", request_id: requestId });
      }
      const cleaned = requested.map(String).filter((n) => available.has(n));
      dmStorage.setSetting("target_niches", cleaned);
      return res.json({ target_niches: cleaned, ignored: requested.filter((n) => !available.has(String(n))) });
    } catch (e) {
      return fail(res, 500, { error: "Failed to save settings", detail: String(e.message || e), request_id: requestId });
    }
  });

  // POST /api/domain-monitor/watchlist
  app.post("/api/domain-monitor/watchlist", (req, res) => {
    const requestId = reqId("dm-watchlist");
    const payload = req.body || {};
    const domain = normalizeDomain(String(payload.domain || ""));
    if (!domain) {
      return fail(res, 400, { error: "Invalid domain name", request_id: requestId });
    }
    try {
      dmStorage.migrate();
      const notes = payload.notes;
      const updated = dmStorage.setWatchlist(
        domain,
        payload.watchlisted === undefined ? true : Boolean(payload.watchlisted),
        notes === null || notes === undefined ? null : String(notes).slice(0, 2000)
      );
      if (!updated) {
        return fail(res, 404, { error: "Domain not monitored", domain, request_id: requestId });
      }
      return res.json(dmStorage.getDomain(domain) || {});
    } catch (e) {
      return fail(res, 500, { error: "Failed to update watchlist", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/compare
  app.get("/api/domain-monitor/compare", (req, res) => {
    const requestId = reqId("dm-compare");
    const names = String(req.query.domains || "")
      .split(",")
      .map((p) => normalizeDomain(p))
      .filter((d) => d)
      .slice(0, 3);
    if (!names.length) {
      return fail(res, 400, { error: "No valid domain names given", request_id: requestId });
    }
    try {
      dmStorage.migrate();
      const found = names.map((name) => dmStorage.getDomain(name));
      return res.json({
        items: found.filter((row) => row),
        missing: names.filter((name, i) => !found[i]),
      });
    } catch (e) {
      return fail(res, 500, { error: "Failed to compare domains", detail: String(e.message || e), request_id: requestId });
    }
  });

  // GET /api/domain-monitor/:domain  (catch-all — MUST be last)
  app.get("/api/domain-monitor/:domain", (req, res) => {
    const requestId = reqId("dm-detail");
    const normalized = normalizeDomain(req.params.domain);
    if (!normalized) {
      return fail(res, 400, { error: "Invalid domain name", request_id: requestId });
    }
    try {
      dmStorage.migrate();
      const record = dmStorage.getDomain(normalized);
      if (!record) {
        return fail(res, 404, { error: "Domain not monitored", domain: normalized, request_id: requestId });
      }
      return res.json({
        ...record,
        snapshots: dmStorage.getSnapshots(normalized),
        status_history: dmStorage.getStatusHistory(normalized),
        metric_history: dmStorage.getMetricHistory(normalized),
        discovery_sources: dmStorage.sourcesForDomain(normalized),
      });
    } catch (e) {
      return fail(res, 500, { error: "Failed to load domain", detail: String(e.message || e), request_id: requestId });
    }
  });
}

module.exports = { registerDomainMonitorRoutes };
