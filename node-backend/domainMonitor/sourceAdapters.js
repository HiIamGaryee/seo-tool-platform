"use strict";

// Faithful Node port of backend/domain_monitor/source_adapters.py
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const axios = require("axios");

const sourceConfig = require("./sourceConfig");

const USER_AGENT = "SEO-Tool-Platform-DomainRadar/1.0";

const STATUS_ACTIVE = "Active";
const STATUS_CONFIGURED = "Configured";
const STATUS_NOT_CONFIGURED = "Not Configured";
const STATUS_DISABLED = "Disabled";
const STATUS_FAILED = "Failed";

/** What one adapter did on this run. Surfaced verbatim in the UI. */
class SourceReport {
  constructor({
    kind,
    name,
    label,
    status,
    configured,
    enabled,
    raw_count = 0,
    detail = "",
    error = null,
  }) {
    this.kind = kind;
    this.name = name;
    this.label = label;
    this.status = status;
    this.configured = configured;
    this.enabled = enabled;
    this.raw_count = raw_count;
    this.detail = detail;
    this.error = error;
  }
}

/**
 * A candidate-domain provider.
 *
 * `fetchDomains` yields raw strings; normalisation, validation and
 * deduplication all happen downstream in the collector, so an adapter never
 * has to care about domain syntax.
 */
class DomainSource {
  constructor(settings) {
    this.settings = settings;
  }

  isConfigured() {
    return true;
  }

  describe() {
    return "";
  }

  fetchDomains() {
    return [];
  }
}
DomainSource.prototype.kind = "base";
DomainSource.prototype.name = "base";
DomainSource.prototype.label = "Base";

/**
 * Yield the candidate cell from one TXT or CSV line, skipping comments.
 * @returns {IterableIterator<string>}
 */
function* cells(line, column) {
  const text = line.trim();
  if (!text || text.startsWith("#") || text.startsWith(";")) {
    return;
  }
  if (!text.includes(",") && !text.includes("\t") && !text.includes(";")) {
    yield text;
    return;
  }
  const parts = text
    .replace(/\t/g, ",")
    .replace(/;/g, ",")
    .split(",")
    .map((p) => p.trim().replace(/^"+|"+$/g, ""));
  if (column < parts.length && parts[column]) {
    yield parts[column];
  } else if (parts.length && parts[0]) {
    yield parts[0];
  }
}

/** First column of a TXT or CSV line. */
function* cellsFirst(line) {
  yield* cells(line, 0);
}

/** Read a text file line by line as an iterator, matching Python's line iteration. */
function* readLines(text) {
  // Python iterates a file yielding lines including trailing newline; cells()
  // strips whitespace anyway, so splitting on newlines is equivalent.
  for (const line of text.split(/\r?\n/)) {
    yield line;
  }
}

class ManualFileSource extends DomainSource {
  get path() {
    const root = path.resolve(this.settings.manual_dir);
    // Basename only, so a configured filename can never escape the folder.
    return path.resolve(root, path.basename(this.settings.manual_file));
  }

  isConfigured() {
    try {
      const st = fs.statSync(this.path);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  describe() {
    if (!fs.existsSync(this.path)) {
      return "No imported list yet — upload a TXT or CSV from the dashboard";
    }
    const size = fs.statSync(this.path).size;
    return `${path.basename(this.path)} (${size.toLocaleString("en-US")} bytes)`;
  }

  *fetchDomains() {
    const p = this.path;
    if (!fs.existsSync(p)) {
      return;
    }
    const text = fs.readFileSync(p, "utf-8");
    for (const line of readLines(text)) {
      yield* cells(line, 0);
    }
  }
}
ManualFileSource.prototype.kind = sourceConfig.KIND_MANUAL;
ManualFileSource.prototype.name = "manual";
ManualFileSource.prototype.label = "Manual Import";

const ZONE_SUFFIXES = [".txt", ".zone", ".csv", ".gz"];

/** Extract the owner name from a zone record, or the whole line. */
function* zoneLine(line) {
  const text = line.trim();
  if (!text || text.startsWith(";") || text.startsWith("#") || text.startsWith("$")) {
    return;
  }
  const first = text.split(/\s+/)[0];
  if (first) {
    yield first.replace(/\.+$/, "");
  }
}

class ZoneFileSource extends DomainSource {
  isConfigured() {
    const directory = this.settings.zone_directory;
    return Boolean(directory && isDir(directory) && this._files().length);
  }

  _files() {
    const directory = this.settings.zone_directory;
    if (!directory || !isDir(directory)) {
      return [];
    }
    const found = fs
      .readdirSync(directory)
      .sort()
      .map((entry) => path.join(directory, entry))
      .filter((p) => {
        try {
          return (
            fs.statSync(p).isFile() &&
            ZONE_SUFFIXES.includes(path.extname(p).toLowerCase())
          );
        } catch {
          return false;
        }
      });
    return found.slice(0, this.settings.zone_max_files);
  }

  describe() {
    const directory = this.settings.zone_directory;
    if (!directory) {
      return "Zone source not configured (set ZONE_FILE_DIRECTORY)";
    }
    if (!isDir(directory)) {
      return `Zone directory not found: ${directory}`;
    }
    const files = this._files();
    if (!files.length) {
      return `No zone files in ${directory}`;
    }
    const total = files.reduce((sum, p) => sum + fs.statSync(p).size, 0);
    return `${files.length} zone file(s) in ${path.basename(directory)}, ${(
      total / 1048576
    ).toFixed(1)} MB`;
  }

  /** Effective format, looking through a .gz wrapper. */
  static _innerSuffix(p) {
    if (path.extname(p).toLowerCase() === ".gz") {
      return path.extname(path.basename(p, path.extname(p))).toLowerCase() || ".txt";
    }
    return path.extname(p).toLowerCase();
  }

  *fetchDomains() {
    for (const p of this._files()) {
      const parse =
        ZoneFileSource._innerSuffix(p) === ".zone" ? zoneLine : cellsFirst;
      let text;
      try {
        if (path.extname(p).toLowerCase() === ".gz") {
          text = zlib.gunzipSync(fs.readFileSync(p)).toString("utf-8");
        } else {
          text = fs.readFileSync(p, "utf-8");
        }
      } catch (exc) {
        // One unreadable file must not abort the remaining zone files.
        console.warn(`[source:zone] could not read ${path.basename(p)}: ${exc}`);
        continue;
      }
      for (const line of readLines(text)) {
        yield* parse(line);
      }
    }
  }
}
ZoneFileSource.prototype.kind = sourceConfig.KIND_ZONE;
ZoneFileSource.prototype.name = "zone";
ZoneFileSource.prototype.label = "Zone File";

class ExternalFeedSource extends DomainSource {
  isConfigured() {
    return Boolean(this.settings.feed_url);
  }

  describe() {
    if (!this.settings.feed_url) {
      return "Feed not configured (set DOMAIN_FEED_URL)";
    }
    const host = this.settings.feed_url.includes("//")
      ? this.settings.feed_url.split("/")[2]
      : this.settings.feed_url;
    const auth = this.settings.feed_api_key ? "with API key" : "no credential";
    return `${host} (${this.settings.feed_format}, ${auth})`;
  }

  async *fetchDomains() {
    const url = this.settings.feed_url;
    if (!url) {
      return;
    }

    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "text/plain, text/csv, application/json",
    };
    if (this.settings.feed_api_key) {
      headers.Authorization = `Bearer ${this.settings.feed_api_key}`;
    }

    let text;
    try {
      const response = await axios.get(url, {
        headers,
        timeout: this.settings.timeout * 1000,
        responseType: "arraybuffer",
        maxContentLength: this.settings.max_fetch_bytes,
        maxBodyLength: this.settings.max_fetch_bytes,
        // Match requests.raise_for_status(): non-2xx must raise.
      });
      let body = Buffer.from(response.data || "");
      if (body.length > this.settings.max_fetch_bytes) {
        body = body.subarray(0, this.settings.max_fetch_bytes);
      }
      text = body.toString("utf-8");
    } catch (exc) {
      // Raised so the collector can mark this source Failed and continue.
      throw new Error(`Feed request failed: ${exc.message || exc}`);
    }

    let fmt = this.settings.feed_format;
    if (fmt === "auto") {
      const stripped = text.replace(/^\s+/, "");
      const head = stripped.slice(0, 1);
      fmt =
        head === "{" || head === "["
          ? "json"
          : stripped.slice(0, 400).includes(",")
          ? "csv"
          : "text";
    }

    if (fmt === "json") {
      yield* this._fromJson(text);
    } else {
      for (const line of text.split(/\r?\n/)) {
        yield* cells(line, this.settings.feed_column);
      }
    }
  }

  /**
   * Pull domains out of a JSON body.
   *
   * DOMAIN_FEED_JSON_PATH names the list (dotted) and, after a colon, the
   * field holding the domain — e.g. `data.items:domain`.
   */
  *_fromJson(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (exc) {
      throw new Error(`Feed returned invalid JSON: ${exc.message || exc}`);
    }

    const spec = this.settings.feed_json_path || "";
    const colon = spec.indexOf(":");
    const listPath = colon === -1 ? spec : spec.slice(0, colon);
    const fieldName = colon === -1 ? "" : spec.slice(colon + 1);

    let node = payload;
    for (const part of listPath.split(".").filter((p) => p)) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        node = Object.prototype.hasOwnProperty.call(node, part) ? node[part] : undefined;
      } else {
        node = null;
        break;
      }
    }

    if ((node === null || node === undefined) && isPlainObject(payload)) {
      node = Object.values(payload).find((v) => Array.isArray(v));
      if (node === undefined) node = null;
    }
    if (node === null || node === undefined) {
      node = payload;
    }

    if (!Array.isArray(node)) {
      throw new Error("Feed JSON did not contain a list of domains");
    }

    for (const entry of node) {
      if (typeof entry === "string") {
        yield entry;
      } else if (isPlainObject(entry)) {
        if (fieldName && Object.prototype.hasOwnProperty.call(entry, fieldName)) {
          yield String(entry[fieldName]);
        } else {
          for (const key of ["domain", "name", "host", "hostname", "fqdn"]) {
            if (Object.prototype.hasOwnProperty.call(entry, key)) {
              yield String(entry[key]);
              break;
            }
          }
        }
      }
    }
  }
}
ExternalFeedSource.prototype.kind = sourceConfig.KIND_FEED;
ExternalFeedSource.prototype.name = "feed";
ExternalFeedSource.prototype.label = "External Feed";

class DatabaseWatchlistSource extends DomainSource {
  isConfigured() {
    return true;
  }

  describe() {
    return "Domains flagged in the dashboard";
  }

  *fetchDomains() {
    const storage = require("./storage");
    storage.migrate();
    for (const row of storage.watchlistedDomains()) {
      yield row.domain;
    }
  }
}
DatabaseWatchlistSource.prototype.kind = sourceConfig.KIND_WATCHLIST;
DatabaseWatchlistSource.prototype.name = "watchlist";
DatabaseWatchlistSource.prototype.label = "Watchlist";

class DemoFixtureSource extends DomainSource {
  isConfigured() {
    return this.settings.demo_enabled && fs.existsSync(this.settings.demo_file);
  }

  describe() {
    if (!this.settings.demo_enabled) {
      return "Disabled (set DOMAIN_USE_DEMO_DATA=true to load fixtures)";
    }
    if (!fs.existsSync(this.settings.demo_file)) {
      return `Fixture file missing: ${this.settings.demo_file}`;
    }
    return `Development fixtures from ${path.basename(this.settings.demo_file)}`;
  }

  *fetchDomains() {
    if (!this.settings.demo_enabled) {
      return;
    }
    const p = this.settings.demo_file;
    if (!fs.existsSync(p)) {
      return;
    }
    console.warn(
      `[source:demo] loading development fixtures from ${p} — not for production`
    );
    const text = fs.readFileSync(p, "utf-8");
    for (const line of readLines(text)) {
      yield* cells(line, 0);
    }
  }
}
DemoFixtureSource.prototype.kind = sourceConfig.KIND_DEMO;
DemoFixtureSource.prototype.name = "demo";
DemoFixtureSource.prototype.label = "Demo Fixture";

/** Domains supplied directly by a request, e.g. a single-domain recheck. */
class InlineListSource extends DomainSource {
  constructor(settings, domains) {
    super(settings);
    this._domains = Array.from(domains);
  }

  isConfigured() {
    return Boolean(this._domains.length);
  }

  describe() {
    return `${this._domains.length} domain(s) supplied by the request`;
  }

  fetchDomains() {
    return Array.from(this._domains);
  }
}
InlineListSource.prototype.kind = "inline";
InlineListSource.prototype.name = "request";
InlineListSource.prototype.label = "Request";

class Crawl4AIDomainSource extends DomainSource {
  constructor(settings, sourceId) {
    super(settings);
    const crawl4aiSource = require("./crawl4aiSource");
    this._sourceId = sourceId;
    this._config =
      crawl4aiSource.loadSourceConfigs().find((row) => row.id === sourceId) || null;
    this.name = this._config ? this._config.name : sourceId;
  }

  isConfigured() {
    return Boolean(this._config && this._config.url);
  }

  describe() {
    if (!this._config) {
      return "No crawler source configured";
    }
    return `${this._config.url} · ${this._config.max_pages} page cap`;
  }

  async *fetchDomains() {
    if (!this._config || !this._config.enabled) {
      return;
    }
    const crawl4aiSource = require("./crawl4aiSource");
    const result = await crawl4aiSource.crawlSource(this._config);
    for (const domain of result.domains) {
      yield domain;
    }
  }
}
Crawl4AIDomainSource.prototype.kind = sourceConfig.KIND_CRAWL4AI;
Crawl4AIDomainSource.prototype.label = "Crawl4AI";

const ADAPTERS = {
  [sourceConfig.KIND_MANUAL]: ManualFileSource,
  [sourceConfig.KIND_ZONE]: ZoneFileSource,
  [sourceConfig.KIND_FEED]: ExternalFeedSource,
  [sourceConfig.KIND_WATCHLIST]: DatabaseWatchlistSource,
  [sourceConfig.KIND_DEMO]: DemoFixtureSource,
};

function buildAdapter(kind, settings) {
  const Builder = ADAPTERS[kind];
  return Builder ? new Builder(settings) : null;
}

function buildAdapters(kind, settings) {
  if (kind === sourceConfig.KIND_CRAWL4AI) {
    const crawl4aiSource = require("./crawl4aiSource");
    return crawl4aiSource
      .loadSourceConfigs()
      .filter((source) => source.enabled)
      .map((source) => new Crawl4AIDomainSource(settings, source.id));
  }
  const adapter = buildAdapter(kind, settings);
  return adapter ? [adapter] : [];
}

/** Every known adapter, configured or not, for the status panel. */
function allAdapters(settings) {
  return Object.values(ADAPTERS).map((Builder) => new Builder(settings));
}

// --- Small internal helpers ------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

module.exports = {
  USER_AGENT,
  STATUS_ACTIVE,
  STATUS_CONFIGURED,
  STATUS_NOT_CONFIGURED,
  STATUS_DISABLED,
  STATUS_FAILED,
  SourceReport,
  DomainSource,
  ManualFileSource,
  ZoneFileSource,
  ExternalFeedSource,
  DatabaseWatchlistSource,
  DemoFixtureSource,
  InlineListSource,
  Crawl4AIDomainSource,
  ADAPTERS,
  buildAdapter,
  buildAdapters,
  allAdapters,
  cells,
  _cells: cells,
  cellsFirst,
};
