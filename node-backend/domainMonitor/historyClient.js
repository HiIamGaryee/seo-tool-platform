"use strict";

// Faithful Node port of backend/domain_monitor/history_client.py
const cheerio = require("cheerio");
const net = require("./net");

// Wayback's documented public CDX index. Not a scrape target.
const CDX_URL = "https://web.archive.org/cdx/search/cdx";
const SNAPSHOT_URL = "https://web.archive.org/web/{timestamp}id_/{original}";
const CDX_HOST = "web.archive.org";

const USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0";

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

// Deliberately small: we sample a domain's history, we do not mirror the archive.
const SNAPSHOT_SAMPLE_SIZE = Math.max(
  1,
  Math.min(envInt("DOMAIN_MONITOR_HISTORY_SAMPLES", 5), 12)
);
const CDX_ROW_LIMIT = envInt("DOMAIN_MONITOR_HISTORY_CDX_LIMIT", 4000);
const HISTORY_TIMEOUT = envFloat("DOMAIN_MONITOR_HISTORY_TIMEOUT", 20.0);
const HISTORY_RETRIES = envInt("DOMAIN_MONITOR_HISTORY_RETRIES", 3);
const HISTORY_MIN_INTERVAL = envFloat("DOMAIN_MONITOR_HISTORY_MIN_INTERVAL", 1.2);
const MAX_SNAPSHOT_BYTES = envInt("DOMAIN_MONITOR_HISTORY_MAX_BYTES", 600000);

const ENABLED = process.env.DOMAIN_MONITOR_HISTORY_ENABLED !== "0";

class Snapshot {
  constructor({
    timestamp,
    year = null,
    original,
    status_code = null,
    title = null,
    meta_description = null,
    language = null,
    is_redirect = false,
  } = {}) {
    this.timestamp = timestamp;
    this.year = year;
    this.original = original;
    this.status_code = status_code;
    this.title = title;
    this.meta_description = meta_description;
    this.language = language;
    this.is_redirect = is_redirect;
  }
}

/**
 * Archive findings for one domain.
 *
 * `queried` distinguishes "we asked and the archive has nothing" from "we
 * never asked", which the UI must not conflate.
 */
class HistoryResult {
  constructor({
    queried = false,
    first_seen = null,
    last_seen = null,
    snapshot_count = null,
    snapshot_count_truncated = false,
    snapshots = [],
    redirect_count = 0,
    error = null,
  } = {}) {
    this.queried = queried;
    this.first_seen = first_seen;
    this.last_seen = last_seen;
    this.snapshot_count = snapshot_count;
    this.snapshot_count_truncated = snapshot_count_truncated;
    this.snapshots = snapshots;
    this.redirect_count = redirect_count;
    this.error = error;
  }

  get has_data() {
    return this.queried && Boolean(this.snapshot_count);
  }
}

function yearOf(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;
  const parsed = parseInt(String(timestamp).slice(0, 4), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Evenly spread picks across the archive: oldest, quartiles, latest. */
function sampleIndices(count, wanted) {
  if (count <= wanted) {
    return Array.from({ length: count }, (_, i) => i);
  }
  if (wanted === 1) {
    return [count - 1];
  }
  const step = (count - 1) / (wanted - 1);
  const picks = new Set();
  for (let i = 0; i < wanted; i++) {
    picks.add(Math.round(i * step));
  }
  return Array.from(picks).sort((a, b) => a - b);
}

/** Wayback CDX index reader plus a bounded snapshot sampler. */
class HistoryClient {
  constructor({ pool_size = 8 } = {}) {
    this._session = net.buildSession(USER_AGENT, pool_size);
    this._limiter = new net.HostRateLimiter(HISTORY_MIN_INTERVAL);
  }

  async _cdx(params) {
    const response = await net.getWithRetries(
      this._session,
      CDX_URL,
      this._limiter,
      CDX_HOST,
      HISTORY_TIMEOUT,
      HISTORY_RETRIES,
      params,
      "wayback cdx"
    );
    if (response === null || response.status !== 200) return null;
    let rows = response.data;
    if (typeof rows === "string") {
      try {
        rows = JSON.parse(rows);
      } catch (e) {
        return null;
      }
    }
    if (!Array.isArray(rows) || rows.length < 2) return [];
    return rows.slice(1); // first row is the header
  }

  /** Index the domain's archive, then read a handful of snapshots. */
  async lookup(domain) {
    const result = new HistoryResult({ queried: true });
    if (!ENABLED) {
      return new HistoryResult({ queried: false });
    }

    // One index call, collapsed to a single capture per day, HTML 200s only.
    const rows = await this._cdx({
      url: domain,
      matchType: "domain",
      output: "json",
      fl: "timestamp,original,statuscode,mimetype",
      filter: ["statuscode:200", "mimetype:text/html"],
      collapse: "timestamp:8",
      limit: CDX_ROW_LIMIT,
    });
    if (rows === null) {
      result.error = "Wayback CDX index unavailable";
      return result;
    }
    if (!rows.length) {
      result.snapshot_count = 0;
      return result;
    }

    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    result.snapshot_count = rows.length;
    result.snapshot_count_truncated = rows.length >= CDX_ROW_LIMIT;
    result.first_seen = rows[0][0];
    result.last_seen = rows[rows.length - 1][0];

    for (const index of sampleIndices(rows.length, SNAPSHOT_SAMPLE_SIZE)) {
      const row = rows[index];
      const snapshot = new Snapshot({
        timestamp: row[0],
        year: yearOf(row[0]),
        original: row[1],
        status_code: row.length > 2 ? row[2] : null,
      });
      await this._readSnapshot(snapshot);
      result.snapshots.push(snapshot);
    }

    result.redirect_count = result.snapshots.filter((s) => s.is_redirect).length;
    return result;
  }

  /** Fetch one archived page and pull only the SEO-relevant head fields. */
  async _readSnapshot(snapshot) {
    const url = SNAPSHOT_URL.replace("{timestamp}", snapshot.timestamp).replace(
      "{original}",
      snapshot.original
    );
    const response = await net.getWithRetries(
      this._session,
      url,
      this._limiter,
      CDX_HOST,
      HISTORY_TIMEOUT,
      HISTORY_RETRIES,
      null,
      "wayback snapshot"
    );
    if (response === null || response.status !== 200) return;

    if (wasRedirected(response)) {
      snapshot.is_redirect = true;
    }

    let content = responseText(response);
    if (content.length > MAX_SNAPSHOT_BYTES) {
      content = content.slice(0, MAX_SNAPSHOT_BYTES);
    }

    let $;
    try {
      $ = cheerio.load(content);
    } catch (exc) {
      // a malformed archived page must not stop a scan
      return;
    }

    const titleText = $("title").first().text();
    if (titleText) {
      snapshot.title = titleText.split(/\s+/).filter(Boolean).join(" ").slice(0, 300);
    }

    const description = $('meta[name="description"]').first();
    const descContent = description.attr("content");
    if (description.length && descContent) {
      snapshot.meta_description = String(descContent)
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
    }

    const htmlLang = $("html").first().attr("lang");
    if (htmlLang) {
      snapshot.language = String(htmlLang).slice(0, 16);
    }

    let hasRefresh = false;
    $("meta").each((_, el) => {
      const httpEquiv = $(el).attr("http-equiv");
      if (httpEquiv && httpEquiv.toLowerCase() === "refresh") {
        hasRefresh = true;
      }
    });
    if (hasRefresh) {
      snapshot.is_redirect = true;
    }
  }

  close() {
    // axios instances hold no persistent connection to close.
  }
}

// Detect whether axios followed one or more redirects to reach this response.
function wasRedirected(response) {
  const req = response.request;
  if (!req) return false;
  const redirectable = req._redirectable;
  if (redirectable && typeof redirectable._redirectCount === "number") {
    return redirectable._redirectCount > 0;
  }
  return false;
}

function responseText(response) {
  const data = response.data;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data === null || data === undefined) return "";
  return typeof data === "object" ? JSON.stringify(data) : String(data);
}

module.exports = {
  HistoryClient,
  HistoryResult,
  Snapshot,
  ENABLED,
  SNAPSHOT_SAMPLE_SIZE,
};
