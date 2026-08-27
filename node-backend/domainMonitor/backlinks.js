"use strict";

// Faithful Node port of backend/domain_monitor/backlinks.py
const { URL } = require("url");
const net = require("./net");

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? def : parsed;
}

function envFloat(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? def : parsed;
}

const BACKLINK_TIMEOUT = envFloat("BACKLINK_TIMEOUT", 25.0);
const BACKLINK_RETRIES = envInt("BACKLINK_RETRIES", 3);
const BACKLINK_MIN_INTERVAL = envFloat("BACKLINK_MIN_INTERVAL", 1.0);
const ANCHOR_LIMIT = envInt("BACKLINK_ANCHOR_LIMIT", 25);
const REFDOMAIN_LIMIT = envInt("BACKLINK_REFDOMAIN_LIMIT", 25);

const USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0";

/**
 * Provider-reported backlink data.
 *
 * Every numeric field is optional and stays null when the provider did not
 * return it. null means "unavailable" and must render as an em dash; 0 means
 * the provider genuinely reported zero. The two are never interchangeable.
 */
class BacklinkMetrics {
  constructor({
    provider,
    queried = false,
    referring_domains = null,
    total_backlinks = null,
    follow_backlinks = null,
    nofollow_backlinks = null,
    lost_backlinks = null,
    new_backlinks = null,
    top_referring_domains = [],
    top_referring_tlds = [],
    anchor_counts = null,
    error = null,
  } = {}) {
    this.provider = provider;
    this.queried = queried;
    this.referring_domains = referring_domains;
    this.total_backlinks = total_backlinks;
    this.follow_backlinks = follow_backlinks;
    this.nofollow_backlinks = nofollow_backlinks;
    this.lost_backlinks = lost_backlinks;
    this.new_backlinks = new_backlinks;
    this.top_referring_domains = top_referring_domains;
    this.top_referring_tlds = top_referring_tlds;
    this.anchor_counts = anchor_counts;
    this.error = error;
  }

  get has_data() {
    return this.queried && this.referring_domains !== null;
  }

  get follow_percentage() {
    if (this.follow_backlinks === null || !this.total_backlinks) return null;
    return Math.round((this.follow_backlinks / this.total_backlinks) * 100 * 10) / 10;
  }

  get nofollow_percentage() {
    const follow = this.follow_percentage;
    return follow === null ? null : Math.round((100 - follow) * 10) / 10;
  }
}

/**
 * Used when no provider is configured.
 *
 * Returns queried=false so the UI prints "Backlink data unavailable" instead
 * of inventing numbers. This is the default, on purpose.
 */
class NullBacklinkProvider {
  constructor() {
    this.name = "none";
  }

  async getDomainMetrics(domain) {
    return new BacklinkMetrics({
      provider: this.name,
      queried: false,
      error:
        "No backlink provider configured (set BACKLINK_PROVIDER and BACKLINK_API_KEY)",
    });
  }
}

/** Shared plumbing: pooled session, per-host rate limit, bounded retries. */
class HttpProvider {
  constructor(apiKey, baseUrl = null, poolSize = 8) {
    this.name = "http";
    this.base_url = baseUrl || this.constructor.baseUrl || "";
    this._apiKey = apiKey;
    this._session = net.buildSession(USER_AGENT, poolSize, "application/json, text/csv");
    this._limiter = new net.HostRateLimiter(BACKLINK_MIN_INTERVAL);
  }

  get _host() {
    try {
      return new URL(this.base_url).host;
    } catch (e) {
      return "";
    }
  }

  async _get(url, params, headers = null) {
    if (headers) {
      Object.assign(this._session.defaults.headers.common, headers);
    }
    return net.getWithRetries(
      this._session,
      url,
      this._limiter,
      this._host,
      BACKLINK_TIMEOUT,
      BACKLINK_RETRIES,
      params,
      `${this.name} backlinks`
    );
  }

  close() {
    // axios instances hold no persistent connection to close.
  }
}

class AhrefsProvider extends HttpProvider {
  constructor(apiKey, baseUrl = null, poolSize = 8) {
    super(apiKey, baseUrl, poolSize);
    this.name = "ahrefs";
    if (!baseUrl) this.base_url = AhrefsProvider.baseUrl;
  }

  async getDomainMetrics(domain) {
    const metrics = new BacklinkMetrics({ provider: this.name, queried: true });
    const headers = { Authorization: `Bearer ${this._apiKey}` };

    const overview = await this._get(
      `${this.base_url}/v3/site-explorer/backlinks-stats`,
      { target: domain, mode: "domain" },
      headers
    );
    if (overview === null || overview.status !== 200) {
      metrics.error = httpError(overview, "Ahrefs");
      return metrics;
    }

    const parsedOverview = parseJson(overview);
    if (!parsedOverview.ok) {
      metrics.error = "Ahrefs returned a non-JSON response";
      return metrics;
    }
    const payload =
      parsedOverview.data && parsedOverview.data.metrics !== undefined
        ? parsedOverview.data.metrics
        : parsedOverview.data;

    metrics.referring_domains = asInt(pick(payload, "live_refdomains", "refdomains"));
    metrics.total_backlinks = asInt(pick(payload, "live", "backlinks"));
    metrics.lost_backlinks = asInt(pick(payload, "all_time_lost", "lost"));

    const anchors = await this._get(
      `${this.base_url}/v3/site-explorer/anchors`,
      { target: domain, mode: "domain", limit: ANCHOR_LIMIT, order_by: "backlinks:desc" },
      headers
    );
    if (anchors !== null && anchors.status === 200) {
      const parsed = parseJson(anchors);
      const rows = parsed.ok && Array.isArray(parsed.data.anchors) ? parsed.data.anchors : [];
      metrics.anchor_counts = rows
        .filter((row) => row.anchor)
        .map((row) => ({ anchor: row.anchor, count: asInt(row.backlinks) || 0 }));
    }

    const refdomains = await this._get(
      `${this.base_url}/v3/site-explorer/refdomains`,
      { target: domain, mode: "domain", limit: REFDOMAIN_LIMIT, order_by: "domain_rating:desc" },
      headers
    );
    if (refdomains !== null && refdomains.status === 200) {
      const parsed = parseJson(refdomains);
      const rows = parsed.ok && Array.isArray(parsed.data.refdomains) ? parsed.data.refdomains : [];
      metrics.top_referring_domains = rows
        .filter((row) => row.refdomain)
        .map((row) => ({
          domain: row.refdomain,
          backlinks: asInt(row.backlinks),
          rating: row.domain_rating,
        }));
      metrics.top_referring_tlds = tldSpread(metrics.top_referring_domains);
    }

    return metrics;
  }
}
AhrefsProvider.baseUrl = "https://api.ahrefs.com";

class SemrushProvider extends HttpProvider {
  constructor(apiKey, baseUrl = null, poolSize = 8) {
    super(apiKey, baseUrl, poolSize);
    this.name = "semrush";
    if (!baseUrl) this.base_url = SemrushProvider.baseUrl;
  }

  async getDomainMetrics(domain) {
    const metrics = new BacklinkMetrics({ provider: this.name, queried: true });

    const overview = await this._get(`${this.base_url}/analytics/v1/`, {
      key: this._apiKey,
      type: "backlinks_overview",
      target: domain,
      target_type: "root_domain",
      export_columns: "domains_num,backlinks_num,follows_num,nofollows_num",
    });
    if (overview === null || overview.status !== 200) {
      metrics.error = httpError(overview, "Semrush");
      return metrics;
    }

    const row = firstCsvRow(responseText(overview));
    if (row === null) {
      metrics.error = "Semrush returned no rows for this domain";
      return metrics;
    }

    metrics.referring_domains = asInt(row.domains_num);
    metrics.total_backlinks = asInt(row.backlinks_num);
    metrics.follow_backlinks = asInt(row.follows_num);
    metrics.nofollow_backlinks = asInt(row.nofollows_num);

    const anchors = await this._get(`${this.base_url}/analytics/v1/`, {
      key: this._apiKey,
      type: "backlinks_anchors",
      target: domain,
      target_type: "root_domain",
      export_columns: "anchor,domains_num,backlinks_num",
      display_limit: ANCHOR_LIMIT,
    });
    if (anchors !== null && anchors.status === 200) {
      metrics.anchor_counts = csvRows(responseText(anchors))
        .filter((r) => r.anchor)
        .map((r) => ({ anchor: r.anchor, count: asInt(r.backlinks_num) || 0 }));
    }

    const refdomains = await this._get(`${this.base_url}/analytics/v1/`, {
      key: this._apiKey,
      type: "backlinks_refdomains",
      target: domain,
      target_type: "root_domain",
      export_columns: "domain,backlinks_num,domain_score",
      display_limit: REFDOMAIN_LIMIT,
    });
    if (refdomains !== null && refdomains.status === 200) {
      metrics.top_referring_domains = csvRows(responseText(refdomains))
        .filter((r) => r.domain)
        .map((r) => ({
          domain: r.domain,
          backlinks: asInt(r.backlinks_num),
          rating: r.domain_score,
        }));
      metrics.top_referring_tlds = tldSpread(metrics.top_referring_domains);
    }

    return metrics;
  }
}
SemrushProvider.baseUrl = "https://api.semrush.com";

class MajesticProvider extends HttpProvider {
  constructor(apiKey, baseUrl = null, poolSize = 8) {
    super(apiKey, baseUrl, poolSize);
    this.name = "majestic";
    if (!baseUrl) this.base_url = MajesticProvider.baseUrl;
  }

  async getDomainMetrics(domain) {
    const metrics = new BacklinkMetrics({ provider: this.name, queried: true });

    const response = await this._get(`${this.base_url}/api/json`, {
      app_api_key: this._apiKey,
      cmd: "GetIndexItemInfo",
      items: 1,
      item0: domain,
      datasource: "fresh",
    });
    if (response === null || response.status !== 200) {
      metrics.error = httpError(response, "Majestic");
      return metrics;
    }

    const parsed = parseJson(response);
    if (!parsed.ok) {
      metrics.error = "Majestic returned a non-JSON response";
      return metrics;
    }
    const payload = parsed.data;

    if (payload.Code !== "OK") {
      metrics.error = `Majestic error: ${payload.ErrorMessage || payload.Code}`;
      return metrics;
    }

    const rows =
      (payload.DataTables &&
        payload.DataTables.Results &&
        payload.DataTables.Results.Data) ||
      [];
    if (!rows.length) {
      metrics.error = "Majestic returned no rows for this domain";
      return metrics;
    }

    const row = rows[0];
    metrics.referring_domains = asInt(row.RefDomains);
    metrics.total_backlinks = asInt(row.ExtBackLinks);
    return metrics;
  }
}
MajesticProvider.baseUrl = "https://api.majestic.com";

const PROVIDERS = {
  ahrefs: AhrefsProvider,
  semrush: SemrushProvider,
  majestic: MajesticProvider,
};

function pick(obj, primary, fallback) {
  if (obj && obj[primary] !== undefined) return obj[primary];
  return obj ? obj[fallback] : undefined;
}

/** Parse a provider number. Returns null rather than defaulting to zero. */
function asInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace(/,/g, "");
  const parsed = parseFloat(cleaned);
  if (Number.isNaN(parsed)) return null;
  return Math.trunc(parsed);
}

function parseJson(response) {
  const data = response.data;
  if (data !== null && typeof data === "object") return { ok: true, data };
  if (typeof data === "string") {
    try {
      return { ok: true, data: JSON.parse(data) };
    } catch (e) {
      return { ok: false, data: null };
    }
  }
  return { ok: false, data: null };
}

function responseText(response) {
  const data = response.data;
  if (typeof data === "string") return data;
  if (data === null || data === undefined) return "";
  return typeof data === "object" ? JSON.stringify(data) : String(data);
}

function httpError(response, vendor) {
  if (response === null) return `${vendor} unreachable after retries`;
  if (response.status === 401 || response.status === 403) {
    return `${vendor} rejected the API key (${response.status})`;
  }
  if (response.status === 404) return `${vendor} has no data for this domain (404)`;
  return `${vendor} responded ${response.status}`;
}

// Minimal semicolon-delimited CSV reader mirroring csv.DictReader.
function csvRows(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r\n|\r|\n/);
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = values[c] !== undefined ? values[c] : null;
    }
    if (Object.values(row).some((v) => v)) rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  return line.split(";").map((cell) => cell.trim());
}

function firstCsvRow(text) {
  const rows = csvRows(text);
  return rows.length ? rows[0] : null;
}

/** Referring-domain counts grouped by TLD. Derived, not invented. */
function tldSpread(referringDomains) {
  const counts = {};
  for (const entry of referringDomains) {
    const host = String((entry && entry.domain) || "");
    if (!host.includes(".")) continue;
    const tld = "." + host.split(".").pop().toLowerCase();
    counts[tld] = (counts[tld] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([tld, count]) => ({ tld, count }));
}

function configuredProviderName() {
  return (process.env.BACKLINK_PROVIDER || "").trim().toLowerCase();
}

/** What the Data Sources panel shows. Never leaks the key itself. */
function providerStatus() {
  const name = configuredProviderName();
  const hasKey = Boolean(process.env.BACKLINK_API_KEY);

  if (!name) {
    return { provider: null, configured: false, reason: "BACKLINK_PROVIDER is not set" };
  }
  if (!(name in PROVIDERS)) {
    const supported = Object.keys(PROVIDERS).sort().join(", ");
    return {
      provider: name,
      configured: false,
      reason: `Unknown provider '${name}'; supported: ${supported}`,
    };
  }
  if (!hasKey) {
    return { provider: name, configured: false, reason: "BACKLINK_API_KEY is not set" };
  }
  return { provider: name, configured: true, reason: null };
}

/**
 * Resolve the configured provider, or the null provider.
 *
 * Credentials come from the environment only; nothing is ever hardcoded.
 */
function buildProvider() {
  const status = providerStatus();
  if (!status.configured) {
    return new NullBacklinkProvider();
  }

  const Builder = PROVIDERS[status.provider];
  return new Builder(
    process.env.BACKLINK_API_KEY,
    process.env.BACKLINK_API_BASE || null
  );
}

module.exports = {
  BacklinkMetrics,
  NullBacklinkProvider,
  AhrefsProvider,
  SemrushProvider,
  MajesticProvider,
  buildProvider,
  configuredProviderName,
  providerStatus,
};
