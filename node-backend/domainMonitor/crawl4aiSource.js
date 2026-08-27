"use strict";

// Faithful Node port of backend/domain_monitor/crawl4ai_source.py
//
// The Python module drives a headless-browser LLM crawler (crawl4ai) with a
// Gemini extraction fallback. There is no crawl4ai for Node, so the crawling
// path is reimplemented with axios (fetch page HTML) + cheerio (parse links /
// apply css_selector / next_page_selector). The Gemini fallback is
// reimplemented by calling the Gemini REST API with axios. The browser is
// reported as "not installed" (we have no headless browser); raw HTTP crawling
// stays available.

const { URL } = require("url");
const cheerio = require("cheerio");
const axios = require("axios");

const storage = require("./storage");
const { normalizeDomain } = require("./models");
const net = require("./net");

const CRAWL_KIND = "crawl4ai";
const CRAWL_LABEL = "Crawl4AI";

const USER_AGENT = "Mozilla/5.0 (compatible; DomainMonitor/1.0; +crawl4ai-node)";
const _GEMINI_MAX_HTML = 200000; // cap payload sent to the LLM

// Matches Python's _DOMAIN_TEXT_RE (case-insensitive), including the
// non-word/@/hyphen lookaround guards so emails and hostnames-in-words don't
// leak through. Node 20 supports lookbehind.
const _DOMAIN_TEXT_RE =
  /(?<![@\w-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![@\w-])/gi;
const _EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// --- env helpers ------------------------------------------------------------
function _env(name, def = "") {
  return (process.env[name] || def).trim();
}

function _envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return def;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? def : parsed;
}

function _envBool(name, def) {
  const raw = _env(name).toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

function _now() {
  return new Date();
}

function _iso() {
  return storage.nowIso();
}

// ISO timestamp N hours from now, seconds precision (matches Python's
// isoformat(timespec="seconds")).
function _cacheExpires(hours) {
  const dt = new Date(_now().getTime() + hours * 3600 * 1000);
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- Gemini telemetry -------------------------------------------------------
// Counters only. The API key never enters this dict, is never logged and is
// never serialised to any response the frontend can read. (Single-threaded
// event loop — no lock required.)
const _GEMINI_STATS = {
  calls: 0,
  success: 0,
  failures: 0,
  domains: 0,
  last_status: null,
  last_error: null,
  last_duration_ms: null,
};

function _recordGemini({
  success,
  domains = 0,
  status = null,
  error = null,
  durationMs = null,
} = {}) {
  _GEMINI_STATS.calls += 1;
  if (success) {
    _GEMINI_STATS.success += 1;
    _GEMINI_STATS.domains += domains;
  } else {
    _GEMINI_STATS.failures += 1;
  }
  _GEMINI_STATS.last_status = status;
  _GEMINI_STATS.last_error = error;
  _GEMINI_STATS.last_duration_ms = durationMs;
}

function _httpStatusFrom(error) {
  const match = /\b(4\d\d|5\d\d)\b/.exec(error || "");
  return match ? match[1] : null;
}

function geminiStats() {
  const settings = loadSettings();
  const snapshot = { ..._GEMINI_STATS };
  const configured = Boolean(settings.use_gemini && settings.gemini_api_key);
  let reason;
  if (configured) {
    reason = null;
  } else if (!settings.use_gemini) {
    reason = "CRAWL4AI_USE_GEMINI is off";
  } else {
    reason = "GEMINI_API_KEY missing";
  }
  return {
    ...snapshot,
    configured,
    provider: "Gemini",
    model: configured ? settings.gemini_model : null,
    reason,
  };
}

// --- settings & config ------------------------------------------------------
function loadSettings() {
  return {
    enabled: _envBool("CRAWL4AI_ENABLED", true),
    max_pages: Math.max(1, _envInt("CRAWL4AI_MAX_PAGES", 10)),
    page_timeout_ms: Math.max(1000, _envInt("CRAWL4AI_PAGE_TIMEOUT", 30000)),
    concurrency: Math.max(1, Math.min(_envInt("CRAWL4AI_CONCURRENCY", 3), 5)),
    cache_hours: Math.max(1, _envInt("CRAWL4AI_CACHE_HOURS", 6)),
    use_gemini: _envBool("CRAWL4AI_USE_GEMINI", false),
    gemini_model: _env("GEMINI_MODEL", "gemini/gemini-3-flash-preview"),
    gemini_api_key: _env("GEMINI_API_KEY") || null,
  };
}

function _hexId(n = 12) {
  let out = "";
  while (out.length < n) out += Math.random().toString(16).slice(2);
  return out.slice(0, n);
}

// Dataclass-like config. Plain enumerable snake_case fields so {...cfg} /
// JSON.stringify behave like Python's asdict().
class CrawlSourceConfig {
  constructor({
    id,
    name,
    url,
    enabled,
    max_pages,
    css_selector = null,
    next_page_selector = null,
    use_gemini = false,
  }) {
    this.id = id;
    this.name = name;
    this.url = url;
    this.enabled = enabled;
    this.max_pages = max_pages;
    this.css_selector = css_selector;
    this.next_page_selector = next_page_selector;
    this.use_gemini = use_gemini;
  }
}

// Dataclass-like result. candidate_count is materialised as an own property
// (in Python it is a @property over domains) so the object is plain-asdict-able.
class CrawlSourceResult {
  constructor({
    source_id,
    source_name,
    source_url,
    status,
    pages_crawled,
    domains,
    sample,
    crawled_at,
    expires_at,
    error = null,
    blocked = false,
  }) {
    this.source_id = source_id;
    this.source_name = source_name;
    this.source_url = source_url;
    this.status = status;
    this.error = error;
    this.pages_crawled = pages_crawled;
    this.candidate_count = domains.length;
    this.domains = domains;
    this.sample = sample;
    this.crawled_at = crawled_at;
    this.expires_at = expires_at;
    this.blocked = blocked;
  }
}

function _resultFromCache(source, cached, settings) {
  const domains = (cached.domains || []).map((item) => String(item));
  const sample = (cached.sample || []).map((item) => String(item));
  const status = String(cached.status || "active");
  return new CrawlSourceResult({
    source_id: source.id,
    source_name: source.name,
    source_url: source.url,
    status,
    pages_crawled: parseInt(cached.pages_crawled || 0, 10) || 0,
    domains,
    sample,
    crawled_at: String(cached.crawled_at || _iso()),
    expires_at: String(cached.expires_at || _cacheExpires(settings.cache_hours)),
    error: cached.error ?? null,
    blocked: status === "blocked",
  });
}

function loadSourceConfigs() {
  const items = [];
  for (const entry of storage.crawl4aiSources()) {
    try {
      items.push(
        new CrawlSourceConfig({
          id: String(entry.id || _hexId()),
          name: String(entry.name || "").trim(),
          url: String(entry.url || "").trim(),
          enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
          max_pages: Math.max(
            1,
            parseInt(entry.max_pages || loadSettings().max_pages, 10)
          ),
          css_selector: String(entry.css_selector || "").trim() || null,
          next_page_selector: String(entry.next_page_selector || "").trim() || null,
          use_gemini: Boolean(entry.use_gemini),
        })
      );
    } catch (_e) {
      continue;
    }
  }
  return items.filter((item) => item.name && item.url);
}

function saveSourceConfig(payload) {
  const settings = loadSettings();
  const source = new CrawlSourceConfig({
    id: String(payload.id || _hexId()),
    name: String(payload.name || "").trim(),
    url: String(payload.url || "").trim(),
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
    max_pages: Math.max(1, parseInt(payload.max_pages || settings.max_pages, 10)),
    css_selector: String(payload.css_selector || "").trim() || null,
    next_page_selector: String(payload.next_page_selector || "").trim() || null,
    use_gemini: Boolean(payload.use_gemini),
  });
  if (!source.name) {
    throw new Error("Source name is required");
  }
  const lowered = source.url.toLowerCase();
  if (!(lowered.startsWith("http://") || lowered.startsWith("https://"))) {
    throw new Error("Source URL must be http(s)");
  }
  storage.upsertCrawl4aiSource({ ...source });
  return source;
}

// --- URL / host helpers -----------------------------------------------------
function _netloc(rawUrl) {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch (_e) {
    return "";
  }
}

function _sameHost(url, candidate) {
  return _netloc(url) === _netloc(candidate);
}

function _hostLabel(url) {
  return _netloc(url) || url;
}

function _resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (_e) {
    return href;
  }
}

function _blocked(statusCode, errorText) {
  const lowered = (errorText || "").toLowerCase();
  const tokens = ["cloudflare", "captcha", "forbidden", "unauthorized"];
  return (
    [401, 403, 429, 503].includes(statusCode) ||
    tokens.some((token) => lowered.includes(token))
  );
}

function _extractFromHref(value) {
  const text = (value || "").trim();
  const lower = text.toLowerCase();
  if (
    !text ||
    lower.startsWith("javascript:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("file:") ||
    lower.startsWith("data:")
  ) {
    return null;
  }
  let host = "";
  try {
    const parsed = new URL(text.includes("://") ? text : `https://${text}`);
    host = parsed.hostname || "";
  } catch (_e) {
    return null;
  }
  if (!host || host === "localhost") return null;
  if (_EMAIL_RE.test(host)) return null;
  return normalizeDomain(host);
}

function extractDomainsFromHtml(html, { pageUrl, cssSelector = null } = {}) {
  void pageUrl;
  const $ = cheerio.load(html || "");
  const buckets = new Set();

  // Scope selection mirrors soup.select(css_selector) or the whole document.
  let scope;
  if (cssSelector) {
    const matched = $(cssSelector).toArray();
    scope = matched.length ? matched : [null];
  } else {
    scope = [null];
  }

  for (const node of scope) {
    const $node = node ? $(node) : $.root();
    $node.find("a[href]").each((_i, el) => {
      const domain = _extractFromHref($(el).attr("href") || "");
      if (domain) buckets.add(domain);
    });
    const text = $node.text().replace(/\s+/g, " ").trim();
    for (const match of text.matchAll(_DOMAIN_TEXT_RE)) {
      const domain = normalizeDomain(match[1]);
      if (domain) buckets.add(domain);
    }
  }

  // Also scan the rendered markup, matching Python's soup.decode() sweep.
  const rendered = $.html();
  for (const match of rendered.matchAll(_DOMAIN_TEXT_RE)) {
    const domain = normalizeDomain(match[1]);
    if (domain) buckets.add(domain);
  }

  return [...buckets].sort();
}

function _nextPageUrl(html, { currentUrl, nextPageSelector = null } = {}) {
  const $ = cheerio.load(html || "");

  if (nextPageSelector) {
    const node = $(nextPageSelector).first();
    const href = node.attr("href");
    if (node.length && href) {
      return _resolveUrl(currentUrl, href);
    }
  }

  for (const selector of ["a[rel=next]", "link[rel=next]"]) {
    const node = $(selector).first();
    const href = node.attr("href");
    if (node.length && href) {
      return _resolveUrl(currentUrl, href);
    }
  }

  let found = null;
  $("a[href]").each((_i, el) => {
    if (found) return;
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, " ").trim().toLowerCase();
    const rel = ($el.attr("rel") || "").toLowerCase();
    const href = $el.attr("href") || "";
    if (
      ["next", "next page", "older", "more"].includes(text) ||
      rel.includes("next")
    ) {
      const target = _resolveUrl(currentUrl, href);
      if (_sameHost(currentUrl, target)) {
        found = target;
      }
    }
  });
  return found;
}

// --- page fetch (replaces the crawl4ai headless browser) --------------------
// Returns { success, status_code, html, error }.
async function _fetchPage(url, settings) {
  const timeoutSeconds = Math.max(1, Math.round(settings.page_timeout_ms / 1000));
  const session = net.buildSession(USER_AGENT, 16, "text/html,*/*");
  const limiter = new net.HostRateLimiter(0);
  const host = _netloc(url) || url;
  const response = await net.getWithRetries(
    session,
    url,
    limiter,
    host,
    timeoutSeconds,
    3,
    null,
    "crawl4ai"
  );
  if (!response) {
    return { success: false, status_code: null, html: "", error: "crawl failed" };
  }
  const code = response.status;
  if (code >= 200 && code < 300) {
    const data = response.data;
    const html = typeof data === "string" ? data : String(data ?? "");
    return { success: true, status_code: code, html, error: null };
  }
  return {
    success: false,
    status_code: code,
    html: "",
    error: `HTTP ${code}`,
  };
}

// --- Gemini extraction fallback (REST) --------------------------------------
function _geminiModelId(model) {
  // Strip a leading "provider/" prefix (split on the first "/"), matching
  // Python's split("/", 1)[-1].
  const idx = model.indexOf("/");
  const id = idx === -1 ? model : model.slice(idx + 1);
  return id || "gemini-3-flash-preview";
}

function _parseGeminiDomains(payload) {
  // Pull the model's text response, then parse a JSON array of {domain,...}.
  let text = "";
  try {
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    text = parts.map((p) => p.text || "").join("");
  } catch (_e) {
    text = "";
  }
  if (!text) return [];
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if present.
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let items;
  try {
    items = JSON.parse(cleaned.slice(start, end + 1));
  } catch (_e) {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const domains = [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const domain = normalizeDomain(String(item.domain || ""));
      if (domain) domains.push(domain);
    }
  }
  return domains;
}

async function _geminiExtract(html, source, settings) {
  if (!settings.use_gemini && !source.use_gemini) return [];
  if (!settings.gemini_api_key) {
    return [];
  }

  const modelId = _geminiModelId(settings.gemini_model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const instruction =
    "Extract only domain names explicitly present in this page. " +
    "Do not invent, infer, autocomplete, or generate domain names. " +
    "Return a JSON array of objects, each { \"domain\": string, " +
    "\"status_text\": string|null, \"expiry_text\": string|null }. " +
    "Return valid JSON only, no prose.";
  const body = {
    contents: [
      {
        parts: [
          {
            text: `${instruction}\n\nHTML:\n${(html || "").slice(0, _GEMINI_MAX_HTML)}`,
          },
        ],
      },
    ],
  };

  const started = Date.now();
  let response;
  try {
    response = await axios.post(url, body, {
      headers: { "x-goog-api-key": settings.gemini_api_key },
      timeout: 60000,
      validateStatus: () => true,
    });
  } catch (exc) {
    const durationMs = Date.now() - started;
    const message = String(exc && exc.message ? exc.message : exc);
    _recordGemini({
      success: false,
      status: _httpStatusFrom(message),
      error: message.slice(0, 300),
      durationMs,
    });
    return [];
  }

  const durationMs = Date.now() - started;
  if (response.status !== 200) {
    const message = `Gemini returned HTTP ${response.status}`;
    _recordGemini({
      success: false,
      status: String(response.status),
      error: message.slice(0, 300),
      durationMs,
    });
    return [];
  }

  const domains = _parseGeminiDomains(response.data);
  const unique = [...new Set(domains)].sort();
  _recordGemini({
    success: true,
    domains: unique.length,
    status: "ok",
    durationMs,
  });
  return unique;
}

function geminiTest() {
  const settings = loadSettings();
  if (!settings.gemini_api_key) {
    return {
      status: "not_configured",
      provider: "Gemini",
      model: null,
      latency_ms: null,
      error: "gemini_not_configured",
      message: "GEMINI_API_KEY is not set",
    };
  }

  const modelId = _geminiModelId(settings.gemini_model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const started = Date.now();

  return axios
    .post(
      url,
      { contents: [{ parts: [{ text: "ping" }] }] },
      {
        headers: { "x-goog-api-key": settings.gemini_api_key },
        timeout: 20000,
        validateStatus: () => true,
      }
    )
    .then((response) => {
      const latencyMs = Date.now() - started;
      if (response.status === 200) {
        _recordGemini({ success: true, status: "ok", durationMs: latencyMs });
        return {
          status: "ok",
          provider: "Gemini",
          model: settings.gemini_model,
          latency_ms: latencyMs,
          error: null,
          message: null,
        };
      }
      const kind =
        {
          401: "gemini_unauthorized",
          403: "gemini_forbidden",
          429: "gemini_rate_limit",
        }[response.status] || "gemini_http_error";
      _recordGemini({
        success: false,
        status: String(response.status),
        error: `Gemini returned HTTP ${response.status}`,
        durationMs: latencyMs,
      });
      return {
        status: "error",
        provider: "Gemini",
        model: settings.gemini_model,
        latency_ms: latencyMs,
        http_status: response.status,
        error: kind,
        message: `Gemini returned HTTP ${response.status}`,
      };
    })
    .catch((exc) => {
      const latencyMs = Date.now() - started;
      const message = String(exc && exc.message ? exc.message : exc);
      _recordGemini({
        success: false,
        status: _httpStatusFrom(message),
        error: message.slice(0, 300),
        durationMs: latencyMs,
      });
      return {
        status: "error",
        provider: "Gemini",
        model: settings.gemini_model,
        latency_ms: latencyMs,
        error: "gemini_transport_error",
        message: message.slice(0, 300),
      };
    });
}

// --- crawling ---------------------------------------------------------------
async function _crawlSourceAsync(source, settings) {
  const seenPages = new Set();
  const foundDomains = new Set();
  let currentUrl = source.url;
  let pagesCrawled = 0;

  try {
    while (currentUrl && pagesCrawled < source.max_pages) {
      if (seenPages.has(currentUrl)) break;
      seenPages.add(currentUrl);

      const page = await _fetchPage(currentUrl, settings);
      pagesCrawled += 1;

      if (!page.success) {
        const error = page.error || "crawl failed";
        const status = _blocked(page.status_code, error) ? "blocked" : "error";
        const domains = [...foundDomains].sort();
        return new CrawlSourceResult({
          source_id: source.id,
          source_name: source.name,
          source_url: source.url,
          status,
          pages_crawled: pagesCrawled,
          domains,
          sample: domains.slice(0, 10),
          crawled_at: _iso(),
          expires_at: _cacheExpires(settings.cache_hours),
          error,
          blocked: status === "blocked",
        });
      }

      const html = page.html || "";
      const pageDomains = new Set(
        extractDomainsFromHtml(html, {
          pageUrl: currentUrl,
          cssSelector: source.css_selector,
        })
      );
      if (pageDomains.size === 0 && (settings.use_gemini || source.use_gemini)) {
        for (const d of await _geminiExtract(html, source, settings)) {
          pageDomains.add(d);
        }
      }
      for (const d of pageDomains) foundDomains.add(d);

      const nextUrl = _nextPageUrl(html, {
        currentUrl,
        nextPageSelector: source.next_page_selector,
      });
      if (!nextUrl || !_sameHost(source.url, nextUrl)) break;
      currentUrl = nextUrl;
    }
  } catch (exc) {
    const error = String(exc && exc.message ? exc.message : exc);
    const status = _blocked(null, error) ? "blocked" : "error";
    const domains = [...foundDomains].sort();
    return new CrawlSourceResult({
      source_id: source.id,
      source_name: source.name,
      source_url: source.url,
      status,
      pages_crawled: pagesCrawled,
      domains,
      sample: domains.slice(0, 10),
      crawled_at: _iso(),
      expires_at: _cacheExpires(settings.cache_hours),
      error,
      blocked: status === "blocked",
    });
  }

  const domains = [...foundDomains].sort();
  return new CrawlSourceResult({
    source_id: source.id,
    source_name: source.name,
    source_url: source.url,
    status: "active",
    pages_crawled: pagesCrawled,
    domains,
    sample: domains.slice(0, 10),
    crawled_at: _iso(),
    expires_at: _cacheExpires(settings.cache_hours),
  });
}

async function acrawlSource(source, { force = false } = {}) {
  const settings = loadSettings();
  if (!source.enabled) {
    return new CrawlSourceResult({
      source_id: source.id,
      source_name: source.name,
      source_url: source.url,
      status: "disabled",
      pages_crawled: 0,
      domains: [],
      sample: [],
      crawled_at: _iso(),
      expires_at: _cacheExpires(settings.cache_hours),
    });
  }

  const cached = force ? null : storage.getCrawlSourceCache(source.id);
  if (cached) {
    return _resultFromCache(source, cached, settings);
  }

  const result = await _crawlSourceAsync(source, settings);
  storage.setCrawlSourceCache(
    result.source_id,
    result.source_name,
    result.source_url,
    result.status,
    result.error,
    result.pages_crawled,
    result.candidate_count,
    result.domains,
    result.sample,
    result.crawled_at,
    result.expires_at
  );
  return result;
}

async function crawlSource(source, { force = false } = {}) {
  return acrawlSource(source, { force });
}

async function acrawlAllSources({ force = false } = {}) {
  const settings = loadSettings();
  if (!settings.enabled) return [];

  const sources = loadSourceConfigs().filter((s) => s.enabled);
  // Bounded parallelism: one failure does not abort the batch.
  const results = new Array(sources.length);
  let cursor = 0;
  const workers = new Array(Math.min(settings.concurrency, sources.length || 1))
    .fill(null)
    .map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= sources.length) break;
        results[index] = await acrawlSource(sources[index], { force });
      }
    });
  await Promise.all(workers);
  return results.filter((r) => r !== undefined);
}

async function atestSource(payload) {
  const settings = loadSettings();
  const source = new CrawlSourceConfig({
    id: String(payload.id || "test-source"),
    name: String(payload.name || "Test Source").trim(),
    url: String(payload.url || "").trim(),
    enabled: true,
    max_pages: 1,
    css_selector: String(payload.css_selector || "").trim() || null,
    next_page_selector: String(payload.next_page_selector || "").trim() || null,
    use_gemini: Boolean(payload.use_gemini),
  });
  const lowered = source.url.toLowerCase();
  if (!(lowered.startsWith("http://") || lowered.startsWith("https://"))) {
    throw new Error("Source URL must be http(s)");
  }
  const result = await _crawlSourceAsync(source, settings);
  return {
    status: result.status,
    pages: result.pages_crawled,
    candidate_domains: result.candidate_count,
    sample: result.sample.slice(0, 10),
    error: result.error,
  };
}

// --- status / health --------------------------------------------------------
function sourceStatusRows() {
  const settings = loadSettings();
  const configs = loadSourceConfigs();
  const cacheRows = {};
  for (const row of storage.crawlSourceCacheRows()) {
    cacheRows[row.source_id] = row;
  }

  if (configs.length === 0) {
    return [
      {
        kind: CRAWL_KIND,
        name: CRAWL_KIND,
        label: CRAWL_LABEL,
        status: settings.enabled ? "Not Configured" : "Disabled",
        enabled: settings.enabled,
        configured: false,
        detail: "Raw HTTP crawling available. No crawler sources configured.",
        candidates: null,
        last_sync: null,
      },
    ];
  }

  const rows = [];
  for (const config of configs) {
    const cache = cacheRows[config.id];
    let status = "Configured";
    let detail = _hostLabel(config.url);
    let candidates = null;
    let lastSync = null;
    const geminiOn = Boolean(
      settings.use_gemini && settings.gemini_api_key && config.use_gemini
    );
    if (!settings.enabled || !config.enabled) {
      status = "Disabled";
    } else if (cache) {
      candidates = parseInt(cache.candidate_count || 0, 10) || 0;
      lastSync = cache.crawled_at;
      if (cache.status === "blocked") {
        status = "Failed";
        detail = `Blocked: ${cache.error || "access blocked"}`;
      } else if (cache.status === "error") {
        status = "Failed";
        detail = cache.error || "crawl failed";
      } else {
        status = "Active";
        detail = `${config.max_pages} page cap · Gemini fallback ${
          geminiOn ? "enabled" : "disabled"
        }`;
      }
    }
    rows.push({
      id: config.id,
      kind: CRAWL_KIND,
      name: config.name,
      label: `${CRAWL_LABEL} · ${config.name}`,
      status,
      enabled: settings.enabled && config.enabled,
      configured: true,
      source_url: _hostLabel(config.url),
      max_pages: config.max_pages,
      gemini_fallback: geminiOn,
      detail,
      candidates,
      last_sync: lastSync,
    });
  }
  return rows;
}

function healthStatus() {
  // Raw HTTP (axios+cheerio) crawling is always available; there is no
  // headless browser in Node, so the browser is reported as "not installed".
  let crawl4aiState = "available";
  const browserState = "not installed";
  let geminiState = "not_configured";

  const settings = loadSettings();
  const configs = loadSourceConfigs();
  if (settings.use_gemini && settings.gemini_api_key) {
    geminiState = "available";
  } else if (settings.use_gemini) {
    geminiState = "missing_api_key";
  }
  if (!settings.enabled) {
    crawl4aiState = "disabled";
  } else if (configs.length === 0) {
    crawl4aiState = "available";
  }
  return {
    crawl4ai: crawl4aiState,
    crawl4ai_browser: browserState,
    gemini: geminiState,
  };
}

function providerStatus() {
  const settings = loadSettings();
  const configs = loadSourceConfigs();
  const cached = storage.crawlSourceCacheRows();
  const total = cached.reduce(
    (acc, row) => acc + (parseInt(row.candidate_count || 0, 10) || 0),
    0
  );
  const geminiOn = Boolean(settings.use_gemini && settings.gemini_api_key);
  return {
    key: CRAWL_KIND,
    label: CRAWL_LABEL,
    status: settings.enabled ? "Active" : "Disabled",
    available: true,
    detail:
      `${configs.length} configured source(s), ` +
      `${total.toLocaleString("en-US")} domains found, ` +
      `Gemini fallback ${geminiOn ? "enabled" : "disabled"}`,
  };
}

module.exports = {
  CRAWL_KIND,
  CRAWL_LABEL,
  CrawlSourceConfig,
  CrawlSourceResult,
  loadSettings,
  loadSourceConfigs,
  // faithful alias of Python load_source_configs
  load_source_configs: loadSourceConfigs,
  saveSourceConfig,
  // faithful alias — callers may reference saveSource
  saveSource: saveSourceConfig,
  extractDomainsFromHtml,
  geminiStats,
  geminiTest,
  acrawlSource,
  crawlSource,
  acrawlAllSources,
  atestSource,
  sourceStatusRows,
  healthStatus,
  providerStatus,
};
