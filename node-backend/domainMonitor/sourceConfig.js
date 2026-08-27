"use strict";

// Faithful Node port of backend/domain_monitor/source_config.py
const path = require("path");

const MODULE_DIR = __dirname;

// Kind identifiers used by domainSources and by the API.
const KIND_MANUAL = "manual";
const KIND_ZONE = "zone";
const KIND_FEED = "feed";
const KIND_CRAWL4AI = "crawl4ai";
const KIND_WATCHLIST = "watchlist";
const KIND_DEMO = "demo";

const ALL_KINDS = [
  KIND_MANUAL,
  KIND_ZONE,
  KIND_FEED,
  KIND_CRAWL4AI,
  KIND_WATCHLIST,
  KIND_DEMO,
];

// Manual import + crawl4ai are enabled by default.
const DEFAULT_SOURCES = [KIND_MANUAL, KIND_CRAWL4AI];

function _env(name, def = "") {
  return (process.env[name] || def).trim();
}
function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isNaN(v) ? def : v;
}
function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isNaN(v) ? def : v;
}
function _envBool(name, def) {
  const raw = _env(name).toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

class SourceSettings {
  constructor() {
    this.enabled_kinds = [...DEFAULT_SOURCES];
    this.globally_enabled = true;

    this.manual_dir = path.join(MODULE_DIR, "sources");
    this.manual_file = "imported.txt";

    this.zone_directory = null;
    this.zone_max_files = 25;

    this.feed_url = null;
    this.feed_api_key = null;
    this.feed_format = "auto";
    this.feed_column = 0;
    this.feed_json_path = "";

    this.demo_enabled = false;
    this.demo_file = path.join(MODULE_DIR, "fixtures", "demo_domains.txt");

    this.timeout = 20.0;
    this.max_candidates = 5000;
    this.max_fetch_bytes = 64 * 1024 * 1024;

    this.rdap_cache_hours = 24;
    this.scan_batch_size = 100;
    this.rdap_concurrency = 10;
    this.rdap_timeout = 15.0;
    this.rdap_max_retries = 3;
    this.rdap_min_host_interval = 0.6;

    this.warnings = [];
  }

  isEnabled(kind) {
    return this.globally_enabled && this.enabled_kinds.includes(kind);
  }
}

/** Read source configuration from the environment on every call. */
function loadSettings() {
  const settings = new SourceSettings();
  settings.globally_enabled = _envBool("DOMAIN_SOURCE_ENABLED", true);

  const rawKinds = _env("DOMAIN_SOURCES");
  if (rawKinds) {
    const requested = rawKinds
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k);
    const known = requested.filter((k) => ALL_KINDS.includes(k));
    const unknown = requested.filter((k) => !ALL_KINDS.includes(k));
    if (unknown.length) {
      settings.warnings.push(
        `Ignoring unknown DOMAIN_SOURCES entries: ${unknown.join(", ")}`
      );
    }
    settings.enabled_kinds = known.length ? known : [];
  } else {
    settings.enabled_kinds = [...DEFAULT_SOURCES];
  }

  const manualDir = _env("DOMAIN_MONITOR_SOURCES");
  settings.manual_dir = manualDir || path.join(MODULE_DIR, "sources");
  settings.manual_file = _env("DOMAIN_MANUAL_FILE", "imported.txt") || "imported.txt";

  const zoneDir = _env("ZONE_FILE_DIRECTORY");
  settings.zone_directory = zoneDir || null;
  settings.zone_max_files = _envInt("ZONE_FILE_MAX_FILES", 25);

  let feedUrl = _env("DOMAIN_FEED_URL");
  if (feedUrl && !/^https?:\/\//i.test(feedUrl)) {
    settings.warnings.push("DOMAIN_FEED_URL must be an http(s) URL; ignoring it");
    feedUrl = "";
  }
  settings.feed_url = feedUrl || null;
  settings.feed_api_key = _env("DOMAIN_FEED_API_KEY") || null;
  settings.feed_format = (_env("DOMAIN_FEED_FORMAT", "auto") || "auto").toLowerCase();
  settings.feed_column = _envInt("DOMAIN_FEED_COLUMN", 0);
  settings.feed_json_path = _env("DOMAIN_FEED_JSON_PATH");

  settings.demo_enabled = _envBool("DOMAIN_USE_DEMO_DATA", false);

  settings.timeout = _envFloat("DOMAIN_SOURCE_TIMEOUT", 20.0);
  settings.max_candidates = Math.max(1, _envInt("DOMAIN_SOURCE_MAX_CANDIDATES", 5000));
  settings.rdap_cache_hours = _envInt(
    "RDAP_CACHE_HOURS",
    _envInt("DOMAIN_MONITOR_CACHE_TTL_HOURS", 24)
  );
  settings.scan_batch_size = Math.max(1, _envInt("DOMAIN_SCAN_BATCH_SIZE", 100));
  settings.rdap_concurrency = Math.max(
    1,
    Math.min(_envInt("DOMAIN_RDAP_CONCURRENCY", 10), 32)
  );
  settings.rdap_timeout = _envFloat("DOMAIN_RDAP_TIMEOUT", 15.0);
  settings.rdap_max_retries = Math.max(1, _envInt("DOMAIN_RDAP_MAX_RETRIES", 3));
  settings.rdap_min_host_interval = Math.max(
    0.0,
    _envFloat("DOMAIN_RDAP_MIN_HOST_INTERVAL", 0.6)
  );

  if (settings.demo_enabled && !settings.enabled_kinds.includes(KIND_DEMO)) {
    settings.enabled_kinds = [...settings.enabled_kinds, KIND_DEMO];
  }

  for (const warning of settings.warnings) {
    console.warn(`[source-config] ${warning}`);
  }

  return settings;
}

module.exports = {
  MODULE_DIR,
  KIND_MANUAL,
  KIND_ZONE,
  KIND_FEED,
  KIND_CRAWL4AI,
  KIND_WATCHLIST,
  KIND_DEMO,
  ALL_KINDS,
  DEFAULT_SOURCES,
  SourceSettings,
  loadSettings,
};
