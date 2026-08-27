"use strict";

// Faithful Node port of backend/domain_monitor/schema.py

const SCHEMA_VERSION = 5;

// Columns added to `domains` by version 2+. Applied with ALTER TABLE so an
// existing database upgrades in place rather than being rebuilt.
const SEO_COLUMNS = [
  ["domain_age_years", "REAL"],
  // Backlink provider metrics. NULL means "not measured", never zero.
  ["backlink_provider", "TEXT"],
  ["backlink_error", "TEXT"],
  ["referring_domains", "INTEGER"],
  ["total_backlinks", "INTEGER"],
  ["follow_backlinks", "INTEGER"],
  ["nofollow_backlinks", "INTEGER"],
  ["lost_backlinks", "INTEGER"],
  ["new_backlinks", "INTEGER"],
  ["top_referring_domains", "TEXT"],
  ["top_referring_tlds", "TEXT"],
  // Anchor profile
  ["anchor_total", "INTEGER"],
  ["branded_pct", "REAL"],
  ["generic_pct", "REAL"],
  ["exact_match_pct", "REAL"],
  ["suspicious_anchor_pct", "REAL"],
  ["top_anchors", "TEXT"],
  // Topic classification
  ["primary_topic", "TEXT"],
  ["secondary_topics", "TEXT"],
  ["topic_match_count", "INTEGER"],
  ["topic_match_strength", "TEXT"],
  ["historical_topic", "TEXT"],
  ["topic_switch_count", "INTEGER"],
  ["historical_stability", "TEXT"],
  ["relevance_score", "INTEGER"],
  ["relevance_band", "TEXT"],
  // Archive history
  ["first_archive_seen", "TEXT"],
  ["last_archive_seen", "TEXT"],
  ["snapshot_count", "INTEGER"],
  ["snapshot_count_truncated", "INTEGER"],
  ["archive_error", "TEXT"],
  // Spam risk
  ["spam_risk_score", "INTEGER"],
  ["spam_risk_level", "TEXT"],
  ["spam_signals", "TEXT"],
  ["spam_categories", "TEXT"],
  // SEO opportunity score
  ["seo_base_score", "INTEGER"],
  ["spam_penalty", "INTEGER"],
  ["seo_score", "INTEGER"],
  ["seo_label", "TEXT"],
  ["seo_confidence", "TEXT"],
  ["seo_coverage_pct", "INTEGER"],
  ["seo_unscored_reason", "TEXT"],
  ["score_components", "TEXT"],
  ["score_reasons", "TEXT"],
  ["score_concerns", "TEXT"],
  // Shortlist
  ["watchlisted", "INTEGER NOT NULL DEFAULT 0"],
  ["notes", "TEXT"],
  // Per-source refresh stamps.
  ["last_rdap_checked", "TEXT"],
  ["last_backlink_checked", "TEXT"],
  ["last_history_checked", "TEXT"],
];

// JSON-encoded columns, decoded on read.
const JSON_COLUMNS = [
  "registry_status",
  "nameservers",
  "top_referring_domains",
  "top_referring_tlds",
  "top_anchors",
  "secondary_topics",
  "spam_signals",
  "spam_categories",
  "score_components",
  "score_reasons",
  "score_concerns",
];

const HISTORY_TABLES = `
CREATE TABLE IF NOT EXISTS domain_status_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT NOT NULL,
    registry_status TEXT,
    expiration_date TEXT,
    category        TEXT,
    days_left       INTEGER,
    checked_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_hist_domain ON domain_status_history(domain, checked_at);

CREATE TABLE IF NOT EXISTS seo_metric_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    domain            TEXT NOT NULL,
    referring_domains INTEGER,
    total_backlinks   INTEGER,
    spam_risk_score   INTEGER,
    seo_score         INTEGER,
    captured_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_hist_domain ON seo_metric_history(domain, captured_at);

CREATE TABLE IF NOT EXISTS domain_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    domain           TEXT NOT NULL,
    year             INTEGER,
    timestamp        TEXT,
    title            TEXT,
    meta_description TEXT,
    language         TEXT,
    topic            TEXT,
    is_redirect      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshots_domain ON domain_snapshots(domain, year);

CREATE TABLE IF NOT EXISTS domain_source_links (
    domain           TEXT NOT NULL,
    source_name      TEXT NOT NULL,
    source_kind      TEXT,
    discovered_at    TEXT NOT NULL,
    last_seen_source TEXT NOT NULL,
    seen_count       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (domain, source_name)
);
CREATE INDEX IF NOT EXISTS idx_source_links_source ON domain_source_links(source_name);
CREATE INDEX IF NOT EXISTS idx_source_links_domain ON domain_source_links(domain);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keyword_search_cache (
    cache_key     TEXT PRIMARY KEY,
    request_json  TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyword_cache_expires ON keyword_search_cache(expires_at);

CREATE TABLE IF NOT EXISTS keyword_search_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword      TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    searched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyword_history_time ON keyword_search_history(searched_at DESC);

CREATE TABLE IF NOT EXISTS crawl_source_cache (
    source_id        TEXT PRIMARY KEY,
    source_name      TEXT NOT NULL,
    source_url       TEXT NOT NULL,
    status           TEXT NOT NULL,
    error            TEXT,
    pages_crawled    INTEGER NOT NULL DEFAULT 0,
    candidate_count  INTEGER NOT NULL DEFAULT 0,
    domains_json     TEXT NOT NULL DEFAULT '[]',
    sample_json      TEXT NOT NULL DEFAULT '[]',
    crawled_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawl_source_cache_expiry ON crawl_source_cache(expires_at);

CREATE INDEX IF NOT EXISTS idx_domains_seo_score ON domains(seo_score);
CREATE INDEX IF NOT EXISTS idx_domains_spam ON domains(spam_risk_score);
CREATE INDEX IF NOT EXISTS idx_domains_topic ON domains(primary_topic);
CREATE INDEX IF NOT EXISTS idx_domains_watchlist ON domains(watchlisted);
`;

module.exports = { SCHEMA_VERSION, SEO_COLUMNS, JSON_COLUMNS, HISTORY_TABLES };
