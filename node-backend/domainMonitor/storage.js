"use strict";

// Faithful Node port of backend/domain_monitor/storage.py (better-sqlite3).
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const schema = require("./schema");
const { tldOf } = require("./models");

const DB_PATH =
  process.env.DOMAIN_MONITOR_DB ||
  path.join(__dirname, "data", "domain_monitor.db");

const SCHEMA_VERSION = schema.SCHEMA_VERSION;

// Columns the API is allowed to sort by. Anything else falls back to priority.
const SORTABLE = {
  domain: "domain",
  tld: "tld",
  expiration_date: "expiration_date",
  days_left: "days_left",
  registrar: "registrar",
  category: "category",
  priority: "priority_rank",
  quality_score: "quality_score",
  last_checked: "last_checked",
  first_seen: "first_seen",
  seo_score: "seo_score",
  referring_domains: "referring_domains",
  total_backlinks: "total_backlinks",
  spam_risk_score: "spam_risk_score",
  domain_age_years: "domain_age_years",
  primary_topic: "primary_topic",
};

// Lower rank = more urgent.
const PRIORITY_RANK = {
  Critical: 0,
  "Very High": 1,
  High: 2,
  Medium: 3,
  Watch: 4,
  Low: 5,
  Unknown: 6,
};

const _CREATE = `
CREATE TABLE IF NOT EXISTS domains (
    id                TEXT PRIMARY KEY,
    domain            TEXT NOT NULL UNIQUE,
    tld               TEXT NOT NULL,
    expiration_date   TEXT,
    days_left         INTEGER,
    registry_status   TEXT NOT NULL DEFAULT '[]',
    registrar         TEXT,
    registration_date TEXT,
    nameservers       TEXT NOT NULL DEFAULT '[]',
    category          TEXT NOT NULL,
    priority          TEXT NOT NULL,
    priority_rank     INTEGER NOT NULL DEFAULT 6,
    quality_score     INTEGER,
    available         INTEGER,
    lookup_status     TEXT NOT NULL DEFAULT 'ok',
    lookup_error      TEXT,
    rdap_source       TEXT,
    source            TEXT,
    first_seen        TEXT NOT NULL,
    last_checked      TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_category ON domains(category);
CREATE INDEX IF NOT EXISTS idx_domains_priority ON domains(priority_rank);
CREATE INDEX IF NOT EXISTS idx_domains_tld ON domains(tld);
CREATE INDEX IF NOT EXISTS idx_domains_checked ON domains(last_checked);

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { timeout: 30000 });
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

function nowIso() {
  // ISO with seconds precision + explicit UTC offset, like Python's
  // datetime.now(timezone.utc).isoformat(timespec="seconds").
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

let _migrated = false;

function migrate() {
  if (_migrated) return;
  const conn = db();
  conn.exec(_CREATE);

  const existing = new Set(
    conn.prepare("PRAGMA table_info(domains)").all().map((r) => r.name)
  );
  let added = 0;
  for (const [column, ddl] of schema.SEO_COLUMNS) {
    if (!existing.has(column)) {
      conn.exec(`ALTER TABLE domains ADD COLUMN ${column} ${ddl}`);
      added += 1;
    }
  }

  conn.exec(schema.HISTORY_TABLES);

  conn.exec(
    "UPDATE domains SET last_rdap_checked = last_checked " +
      "WHERE last_rdap_checked IS NULL AND last_checked IS NOT NULL"
  );

  conn
    .prepare(
      "INSERT INTO schema_meta(key, value) VALUES('version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run(String(SCHEMA_VERSION));

  _migrated = true;
  if (added) console.log(`Domain radar schema upgraded: ${added} new columns`);
  console.log(`Domain radar schema ready at ${DB_PATH} (v${SCHEMA_VERSION})`);
}

function _rowToDict(row) {
  if (!row) return null;
  const data = { ...row };
  delete data.priority_rank;
  for (const key of schema.JSON_COLUMNS) {
    if (key in data) {
      try {
        data[key] = JSON.parse(data[key] || "[]");
      } catch (_e) {
        data[key] = [];
      }
    }
  }
  for (const flag of ["available", "watchlisted", "snapshot_count_truncated"]) {
    if (flag in data) {
      const value = data[flag];
      data[flag] = value === null || value === undefined ? null : Boolean(value);
    }
  }
  return data;
}

/** Batch-write records. Existing rows keep their original first_seen. */
function upsertMany(records) {
  const rows = records.map((r) => [
    r.id,
    r.domain,
    r.tld || tldOf(r.domain),
    r.expiration_date ?? null,
    r.days_left ?? null,
    JSON.stringify(r.registry_status || []),
    r.registrar ?? null,
    r.registration_date ?? null,
    JSON.stringify(r.nameservers || []),
    r.category,
    r.priority,
    PRIORITY_RANK[r.priority] ?? 6,
    r.quality_score ?? null,
    r.available === null || r.available === undefined ? null : r.available ? 1 : 0,
    r.lookup_status,
    r.lookup_error ?? null,
    r.rdap_source ?? null,
    r.source ?? null,
    r.first_seen || nowIso(),
    r.last_checked ?? null,
  ]);
  if (!rows.length) return 0;

  const stmt = db().prepare(
    `INSERT INTO domains (
        id, domain, tld, expiration_date, days_left, registry_status,
        registrar, registration_date, nameservers, category, priority,
        priority_rank, quality_score, available, lookup_status,
        lookup_error, rdap_source, source, first_seen, last_checked
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(domain) DO UPDATE SET
        expiration_date   = excluded.expiration_date,
        days_left         = excluded.days_left,
        registry_status   = excluded.registry_status,
        registrar         = excluded.registrar,
        registration_date = excluded.registration_date,
        nameservers       = excluded.nameservers,
        category          = excluded.category,
        priority          = excluded.priority,
        priority_rank     = excluded.priority_rank,
        quality_score     = excluded.quality_score,
        available         = excluded.available,
        lookup_status     = excluded.lookup_status,
        lookup_error      = excluded.lookup_error,
        rdap_source       = excluded.rdap_source,
        source            = COALESCE(excluded.source, domains.source),
        last_checked      = excluded.last_checked`
  );
  const tx = db().transaction((batch) => {
    for (const row of batch) stmt.run(row);
  });
  tx(rows);
  return rows.length;
}

/** Register unverified candidates. Returns [inserted, alreadyPresent]. */
function addCandidates(domains, source) {
  const { qualityScore } = require("./classifier");
  const { CAT_UNKNOWN, PRI_UNKNOWN } = require("./models");

  const unique = [...new Set(domains)];
  if (!unique.length) return [0, 0];

  const stamp = nowIso();
  const rows = unique.map((d) => [
    d,
    d,
    tldOf(d),
    CAT_UNKNOWN,
    PRI_UNKNOWN,
    PRIORITY_RANK[PRI_UNKNOWN],
    qualityScore(d),
    source,
    stamp,
  ]);

  const conn = db();
  const before = conn.prepare("SELECT COUNT(*) AS n FROM domains").get().n;
  const stmt = conn.prepare(
    `INSERT INTO domains (
        id, domain, tld, category, priority, priority_rank,
        quality_score, source, first_seen
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(domain) DO NOTHING`
  );
  const tx = conn.transaction((batch) => {
    for (const row of batch) stmt.run(row);
  });
  tx(rows);
  const after = conn.prepare("SELECT COUNT(*) AS n FROM domains").get().n;

  const inserted = after - before;
  return [inserted, unique.length - inserted];
}

function getDomain(domain) {
  const row = db().prepare("SELECT * FROM domains WHERE domain = ?").get(domain);
  return row ? _rowToDict(row) : null;
}

const RD_WINDOWS = {
  "0-10": "referring_domains IS NOT NULL AND referring_domains <= 10",
  "11-50": "referring_domains BETWEEN 11 AND 50",
  "51-100": "referring_domains BETWEEN 51 AND 100",
  "100+": "referring_domains > 100",
};

const AGE_WINDOWS = {
  "<1": "domain_age_years IS NOT NULL AND domain_age_years < 1",
  "1-3": "domain_age_years >= 1 AND domain_age_years < 3",
  "3-5": "domain_age_years >= 3 AND domain_age_years < 5",
  "5-10": "domain_age_years >= 5 AND domain_age_years < 10",
  "10+": "domain_age_years >= 10",
};

const EXPIRY_WINDOWS = {
  expired: "days_left IS NOT NULL AND days_left < 0",
  "0-30": "days_left BETWEEN 0 AND 30",
  "31-60": "days_left BETWEEN 31 AND 60",
  "60+": "days_left > 60",
};

function _buildFilters(f) {
  const clauses = [];
  const params = [];

  if (f.search) {
    clauses.push("domain LIKE ?");
    params.push(`%${String(f.search).trim().toLowerCase()}%`);
  }
  if (f.category) {
    clauses.push("category = ?");
    params.push(f.category);
  }
  if (f.priority) {
    clauses.push("priority = ?");
    params.push(f.priority);
  }
  if (f.tld) {
    clauses.push("tld = ?");
    params.push(f.tld.startsWith(".") ? f.tld : `.${f.tld}`);
  }
  if (f.status) {
    clauses.push(
      "LOWER(REPLACE(REPLACE(registry_status,' ',''),'\"','')) LIKE ?"
    );
    params.push(`%${String(f.status).replace(/ /g, "").toLowerCase()}%`);
  }
  if (f.days && f.days in EXPIRY_WINDOWS) clauses.push(EXPIRY_WINDOWS[f.days]);

  if (f.seo_min !== null && f.seo_min !== undefined) {
    clauses.push("seo_score IS NOT NULL AND seo_score >= ?");
    params.push(parseInt(f.seo_min, 10));
  }
  if (f.spam_level) {
    clauses.push("spam_risk_level = ?");
    params.push(f.spam_level);
  }
  if (f.relevance) {
    clauses.push("relevance_band = ?");
    params.push(f.relevance);
  }
  if (f.topic) {
    clauses.push("primary_topic = ?");
    params.push(f.topic);
  }
  if (f.referring && f.referring in RD_WINDOWS) clauses.push(RD_WINDOWS[f.referring]);
  if (f.age && f.age in AGE_WINDOWS) clauses.push(AGE_WINDOWS[f.age]);
  if (f.watchlisted) clauses.push("watchlisted = 1");

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return [where, params];
}

function listDomains(opts = {}) {
  const [where, params] = _buildFilters(opts);
  const column = SORTABLE[opts.sort] || "priority_rank";
  const direction = String(opts.order).toLowerCase() === "desc" ? "DESC" : "ASC";
  const page = Math.max(1, parseInt(opts.page || 1, 10));
  const limit = Math.max(1, Math.min(parseInt(opts.limit || 20, 10), 200));
  const offset = (page - 1) * limit;

  const conn = db();
  const total = conn
    .prepare(`SELECT COUNT(*) AS n FROM domains${where}`)
    .get(...params).n;
  const rows = conn
    .prepare(
      `SELECT * FROM domains${where} ` +
        `ORDER BY ${column} IS NULL, ${column} ${direction}, domain ASC ` +
        `LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return {
    items: rows.map(_rowToDict),
    total,
    page,
    limit,
    pages: total ? Math.floor((total + limit - 1) / limit) : 0,
  };
}

function iterFiltered(filters = {}) {
  const [where, params] = _buildFilters(filters);
  const column = SORTABLE[filters.sort || "priority"] || "priority_rank";
  const direction =
    String(filters.order ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const rows = db()
    .prepare(
      `SELECT * FROM domains${where} ORDER BY ${column} IS NULL, ${column} ${direction}, domain ASC`
    )
    .all(...params);
  return rows.map(_rowToDict);
}

function stats() {
  const {
    CAT_30,
    CAT_60,
    CAT_EXPIRED,
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_SAFE,
    CAT_UNKNOWN,
  } = require("./models");

  const conn = db();
  const total = conn.prepare("SELECT COUNT(*) AS n FROM domains").get().n;
  const byCategory = {};
  for (const row of conn
    .prepare("SELECT category, COUNT(*) AS n FROM domains GROUP BY category")
    .all())
    byCategory[row.category] = row.n;
  const byPriority = {};
  for (const row of conn
    .prepare("SELECT priority, COUNT(*) AS n FROM domains GROUP BY priority")
    .all())
    byPriority[row.priority] = row.n;
  const tlds = conn
    .prepare(
      "SELECT tld, COUNT(*) AS n FROM domains GROUP BY tld ORDER BY n DESC, tld ASC LIMIT 25"
    )
    .all()
    .map((row) => ({ tld: row.tld, count: row.n }));
  const never = conn
    .prepare("SELECT COUNT(*) AS n FROM domains WHERE last_checked IS NULL")
    .get().n;
  const failed = conn
    .prepare("SELECT COUNT(*) AS n FROM domains WHERE lookup_status != 'ok'")
    .get().n;
  const lastChecked = conn
    .prepare("SELECT MAX(last_checked) AS m FROM domains")
    .get().m;

  return {
    total,
    expired: byCategory[CAT_EXPIRED] || 0,
    expiring_30: byCategory[CAT_30] || 0,
    expiring_31_60: byCategory[CAT_60] || 0,
    redemption: byCategory[CAT_REDEMPTION] || 0,
    pending_delete: byCategory[CAT_PENDING_DELETE] || 0,
    safe: byCategory[CAT_SAFE] || 0,
    unknown: byCategory[CAT_UNKNOWN] || 0,
    never_checked: never,
    lookup_failed: failed,
    by_category: byCategory,
    by_priority: byPriority,
    tlds,
    last_checked: lastChecked,
  };
}

function domainsNeedingCheck(ttlHours, limit = null) {
  let sql =
    "SELECT domain, source, first_seen FROM domains " +
    "WHERE last_checked IS NULL " +
    "   OR julianday('now') - julianday(last_checked) > ? / 24.0 " +
    "ORDER BY last_checked IS NOT NULL, priority_rank ASC, domain ASC";
  const params = [Number(ttlHours)];
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }
  return db().prepare(sql).all(...params);
}

function allDomains() {
  return db().prepare("SELECT domain, source, first_seen FROM domains").all();
}

// ---------------------------------------------------------------------------
// SEO enrichment persistence
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_NICHES = [];
const DEFAULT_CRAWL4AI_SOURCES = [];

function saveEnrichment(domain, payload) {
  const writable = new Set(schema.SEO_COLUMNS.map(([name]) => name));
  const updates = {};
  for (const [k, v] of Object.entries(payload)) {
    if (writable.has(k)) updates[k] = v;
  }
  const jsonCols = new Set(schema.JSON_COLUMNS);
  for (const key of Object.keys(updates)) {
    if (jsonCols.has(key) && !(typeof updates[key] === "string" || updates[key] === null)) {
      updates[key] = JSON.stringify(updates[key]);
    }
  }
  const keys = Object.keys(updates);
  if (!keys.length) return;

  const assignments = keys.map((k) => `${k} = ?`).join(", ");
  db()
    .prepare(`UPDATE domains SET ${assignments} WHERE domain = ?`)
    .run(...keys.map((k) => updates[k]), domain);
}

function recordStatusHistory(domain, record) {
  db()
    .prepare(
      "INSERT INTO domain_status_history " +
        "(domain, registry_status, expiration_date, category, days_left, checked_at) " +
        "VALUES (?,?,?,?,?,?)"
    )
    .run(
      domain,
      JSON.stringify(record.registry_status || []),
      record.expiration_date ?? null,
      record.category ?? null,
      record.days_left ?? null,
      record.checked_at || nowIso()
    );
}

function recordMetricHistory(domain, record) {
  const values = [
    record.referring_domains ?? null,
    record.total_backlinks ?? null,
    record.spam_risk_score ?? null,
    record.seo_score ?? null,
  ];
  if (values.every((v) => v === null)) return;

  db()
    .prepare(
      "INSERT INTO seo_metric_history " +
        "(domain, referring_domains, total_backlinks, spam_risk_score, seo_score, captured_at) " +
        "VALUES (?,?,?,?,?,?)"
    )
    .run(domain, ...values, record.captured_at || nowIso());
}

function replaceSnapshots(domain, snapshots) {
  const conn = db();
  const tx = conn.transaction(() => {
    conn.prepare("DELETE FROM domain_snapshots WHERE domain = ?").run(domain);
    if (snapshots && snapshots.length) {
      const stmt = conn.prepare(
        "INSERT INTO domain_snapshots " +
          "(domain, year, timestamp, title, meta_description, language, topic, is_redirect) " +
          "VALUES (?,?,?,?,?,?,?,?)"
      );
      for (const snap of snapshots) {
        stmt.run(
          domain,
          snap.year ?? null,
          snap.timestamp ?? null,
          snap.title ?? null,
          snap.meta_description ?? null,
          snap.language ?? null,
          snap.topic ?? null,
          snap.is_redirect ? 1 : 0
        );
      }
    }
  });
  tx();
}

function getSnapshots(domain) {
  const rows = db()
    .prepare(
      "SELECT year, timestamp, title, meta_description, language, topic, is_redirect " +
        "FROM domain_snapshots WHERE domain = ? ORDER BY year ASC, timestamp ASC"
    )
    .all(domain);
  return rows.map((r) => ({ ...r, is_redirect: Boolean(r.is_redirect) }));
}

function getMetricHistory(domain, limit = 60) {
  const rows = db()
    .prepare(
      "SELECT referring_domains, total_backlinks, spam_risk_score, seo_score, captured_at " +
        "FROM seo_metric_history WHERE domain = ? ORDER BY captured_at DESC LIMIT ?"
    )
    .all(domain, parseInt(limit, 10));
  return rows.reverse();
}

function getStatusHistory(domain, limit = 60) {
  const rows = db()
    .prepare(
      "SELECT registry_status, expiration_date, category, days_left, checked_at " +
        "FROM domain_status_history WHERE domain = ? ORDER BY checked_at DESC LIMIT ?"
    )
    .all(domain, parseInt(limit, 10));
  return rows.reverse().map((row) => {
    const data = { ...row };
    try {
      data.registry_status = JSON.parse(data.registry_status || "[]");
    } catch (_e) {
      data.registry_status = [];
    }
    return data;
  });
}

function setWatchlist(domain, watchlisted, notes = null) {
  const conn = db();
  let info;
  if (notes === null || notes === undefined) {
    info = conn
      .prepare("UPDATE domains SET watchlisted = ? WHERE domain = ?")
      .run(watchlisted ? 1 : 0, domain);
  } else {
    info = conn
      .prepare("UPDATE domains SET watchlisted = ?, notes = ? WHERE domain = ?")
      .run(watchlisted ? 1 : 0, notes, domain);
  }
  return info.changes > 0;
}

function getSetting(key, def = null) {
  const row = db().prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  if (!row) return def;
  try {
    return JSON.parse(row.value);
  } catch (_e) {
    return def;
  }
}

function setSetting(key, value) {
  db()
    .prepare(
      "INSERT INTO app_settings(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, JSON.stringify(value));
}

function pruneKeywordCache() {
  return db()
    .prepare(
      "DELETE FROM keyword_search_cache WHERE julianday(expires_at) <= julianday('now')"
    )
    .run().changes;
}

function getKeywordCache(cacheKey) {
  pruneKeywordCache();
  const row = db()
    .prepare(
      "SELECT cache_key, request_json, response_json, created_at, expires_at " +
        "FROM keyword_search_cache WHERE cache_key = ?"
    )
    .get(cacheKey);
  if (!row) return null;
  const data = { ...row };
  try {
    data.request = JSON.parse(data.request_json || "{}");
  } catch (_e) {
    data.request = {};
  }
  try {
    data.response = JSON.parse(data.response_json || "{}");
  } catch (_e) {
    data.response = {};
  }
  delete data.request_json;
  delete data.response_json;
  return data;
}

function setKeywordCache(cacheKey, requestPayload, responsePayload, createdAt, expiresAt) {
  db()
    .prepare(
      `INSERT INTO keyword_search_cache
        (cache_key, request_json, response_json, created_at, expires_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET
        request_json  = excluded.request_json,
        response_json = excluded.response_json,
        created_at    = excluded.created_at,
        expires_at    = excluded.expires_at`
    )
    .run(
      cacheKey,
      JSON.stringify(requestPayload),
      JSON.stringify(responsePayload),
      createdAt,
      expiresAt
    );
}

function addKeywordHistory(keyword, filters, resultCount, searchedAt = null) {
  const info = db()
    .prepare(
      `INSERT INTO keyword_search_history
        (keyword, filters_json, result_count, searched_at)
      VALUES (?,?,?,?)`
    )
    .run(keyword, JSON.stringify(filters), parseInt(resultCount, 10), searchedAt || nowIso());
  return Number(info.lastInsertRowid);
}

function clearKeywordHistory() {
  return db().prepare("DELETE FROM keyword_search_history").run().changes;
}

function listKeywordHistory(limit = 8) {
  limit = Math.max(1, Math.min(parseInt(limit, 10), 50));
  const rows = db()
    .prepare(
      `SELECT keyword, filters_json, result_count, searched_at
       FROM keyword_search_history
       ORDER BY searched_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row) => {
    const data = { ...row };
    try {
      data.filters = JSON.parse(data.filters_json || "{}");
    } catch (_e) {
      data.filters = {};
    }
    delete data.filters_json;
    return data;
  });
}

function targetNiches() {
  const value = getSetting("target_niches", DEFAULT_TARGET_NICHES);
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function crawl4aiSources() {
  const value = getSetting("crawl4ai_sources", DEFAULT_CRAWL4AI_SOURCES);
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item) => ({ ...item }));
}

function saveCrawl4aiSources(items) {
  setSetting("crawl4ai_sources", items);
}

function upsertCrawl4aiSource(item) {
  const current = crawl4aiSources();
  let updated = false;
  for (let i = 0; i < current.length; i++) {
    if (current[i].id === item.id) {
      current[i] = item;
      updated = true;
      break;
    }
  }
  if (!updated) current.push(item);
  saveCrawl4aiSources(current);
  return item;
}

function pruneCrawlSourceCache() {
  return db()
    .prepare(
      "DELETE FROM crawl_source_cache WHERE julianday(expires_at) <= julianday('now')"
    )
    .run().changes;
}

function _decodeCrawlRow(row) {
  const data = { ...row };
  for (const key of ["domains_json", "sample_json"]) {
    const target = key.slice(0, -5);
    try {
      data[target] = JSON.parse(data[key] || "[]");
    } catch (_e) {
      data[target] = [];
    }
    delete data[key];
  }
  return data;
}

function getCrawlSourceCache(sourceId) {
  pruneCrawlSourceCache();
  const row = db()
    .prepare(
      `SELECT source_id, source_name, source_url, status, error, pages_crawled,
              candidate_count, domains_json, sample_json, crawled_at, expires_at
       FROM crawl_source_cache WHERE source_id = ?`
    )
    .get(sourceId);
  if (!row) return null;
  return _decodeCrawlRow(row);
}

function setCrawlSourceCache(
  sourceId,
  sourceName,
  sourceUrl,
  status,
  error,
  pagesCrawled,
  candidateCount,
  domains,
  sample,
  crawledAt,
  expiresAt
) {
  db()
    .prepare(
      `INSERT INTO crawl_source_cache
        (source_id, source_name, source_url, status, error, pages_crawled,
         candidate_count, domains_json, sample_json, crawled_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_name     = excluded.source_name,
        source_url      = excluded.source_url,
        status          = excluded.status,
        error           = excluded.error,
        pages_crawled   = excluded.pages_crawled,
        candidate_count = excluded.candidate_count,
        domains_json    = excluded.domains_json,
        sample_json     = excluded.sample_json,
        crawled_at      = excluded.crawled_at,
        expires_at      = excluded.expires_at`
    )
    .run(
      sourceId,
      sourceName,
      sourceUrl,
      status,
      error ?? null,
      parseInt(pagesCrawled, 10),
      parseInt(candidateCount, 10),
      JSON.stringify(domains),
      JSON.stringify(sample),
      crawledAt,
      expiresAt
    );
}

function clearCrawlSourceCache(sourceId = null) {
  if (sourceId) {
    return db()
      .prepare("DELETE FROM crawl_source_cache WHERE source_id = ?")
      .run(sourceId).changes;
  }
  return db().prepare("DELETE FROM crawl_source_cache").run().changes;
}

function crawlSourceCacheRows() {
  pruneCrawlSourceCache();
  const rows = db()
    .prepare(
      `SELECT source_id, source_name, source_url, status, error, pages_crawled,
              candidate_count, domains_json, sample_json, crawled_at, expires_at
       FROM crawl_source_cache
       ORDER BY crawled_at DESC, source_name ASC`
    )
    .all();
  return rows.map(_decodeCrawlRow);
}

function seoStats() {
  const highOpportunityMin = 80;
  const conn = db();
  const row = conn
    .prepare(
      `SELECT
        COUNT(*)                                                        AS total,
        SUM(CASE WHEN seo_score >= ? THEN 1 ELSE 0 END)                 AS high_opportunity,
        SUM(CASE WHEN spam_risk_level IN ('High','Very High') THEN 1 ELSE 0 END) AS high_spam,
        SUM(CASE WHEN watchlisted = 1 THEN 1 ELSE 0 END)                AS watchlisted,
        SUM(CASE WHEN seo_score IS NOT NULL THEN 1 ELSE 0 END)          AS scored,
        SUM(CASE WHEN referring_domains IS NOT NULL THEN 1 ELSE 0 END)  AS with_backlinks,
        SUM(CASE WHEN snapshot_count IS NOT NULL THEN 1 ELSE 0 END)     AS with_history,
        MAX(last_rdap_checked)                                          AS last_rdap,
        MAX(last_backlink_checked)                                      AS last_backlink,
        MAX(last_history_checked)                                       AS last_history
      FROM domains`
    )
    .get(highOpportunityMin);
  const topicsRows = conn
    .prepare(
      "SELECT primary_topic AS topic, COUNT(*) AS n FROM domains " +
        "WHERE primary_topic IS NOT NULL GROUP BY primary_topic ORDER BY n DESC, topic ASC"
    )
    .all();

  const data = row || {};
  return {
    high_opportunity: data.high_opportunity || 0,
    high_spam_risk: data.high_spam || 0,
    watchlisted: data.watchlisted || 0,
    scored: data.scored || 0,
    with_backlink_data: data.with_backlinks || 0,
    with_history_data: data.with_history || 0,
    high_opportunity_min: highOpportunityMin,
    topics: topicsRows.map((r) => ({ topic: r.topic, count: r.n })),
    refreshed: {
      rdap: data.last_rdap ?? null,
      backlinks: data.last_backlink ?? null,
      history: data.last_history ?? null,
    },
  };
}

function topOpportunities(limit = 8) {
  const rows = db()
    .prepare(
      "SELECT * FROM domains WHERE seo_score IS NOT NULL " +
        "ORDER BY seo_score DESC, referring_domains DESC, domain ASC LIMIT ?"
    )
    .all(parseInt(limit, 10));
  return rows.map(_rowToDict);
}

function domainsNeedingEnrichment(backlinkTtlHours, historyTtlDays, limit = null) {
  let sql =
    "SELECT domain, registration_date, last_backlink_checked, last_history_checked " +
    "FROM domains WHERE " +
    "  last_backlink_checked IS NULL " +
    "  OR last_history_checked IS NULL " +
    "  OR julianday('now') - julianday(last_backlink_checked) > ? / 24.0 " +
    "  OR julianday('now') - julianday(last_history_checked) > ? " +
    "ORDER BY last_history_checked IS NOT NULL, priority_rank ASC, domain ASC";
  const params = [Number(backlinkTtlHours), Number(historyTtlDays)];
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }
  return db().prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// Discovery source attribution
// ---------------------------------------------------------------------------

const INTERESTING_CATEGORIES = [
  "Pending Delete",
  "Redemption",
  "Expired",
  "Expiring <=30 Days",
  "Expiring 31-60 Days",
];

const LIFECYCLE_RANK = {
  "Pending Delete": 0,
  Redemption: 1,
  Expired: 2,
  "Expiring <=30 Days": 3,
  "Expiring 31-60 Days": 4,
  Unknown: 5,
  Safe: 6,
};

function linkSources(origins, kinds = null) {
  const entries = Object.entries(origins || {});
  if (!entries.length) return 0;

  const stamp = nowIso();
  kinds = kinds || {};
  const stmt = db().prepare(
    `INSERT INTO domain_source_links
        (domain, source_name, source_kind, discovered_at, last_seen_source)
    VALUES (?,?,?,?,?)
    ON CONFLICT(domain, source_name) DO UPDATE SET
        last_seen_source = excluded.last_seen_source,
        source_kind      = COALESCE(excluded.source_kind, domain_source_links.source_kind),
        seen_count       = domain_source_links.seen_count + 1`
  );
  const tx = db().transaction(() => {
    for (const [domain, source] of entries) {
      stmt.run(domain, source, kinds[source] ?? null, stamp, stamp);
    }
  });
  tx();
  return entries.length;
}

function sourcesForDomain(domain) {
  return db()
    .prepare(
      "SELECT source_name, source_kind, discovered_at, last_seen_source, seen_count " +
        "FROM domain_source_links WHERE domain = ? ORDER BY discovered_at ASC"
    )
    .all(domain);
}

function sourceCandidateCounts() {
  const rows = db()
    .prepare(
      "SELECT source_name, COUNT(*) AS candidates, MAX(last_seen_source) AS last_sync " +
        "FROM domain_source_links GROUP BY source_name"
    )
    .all();
  const out = {};
  for (const row of rows) {
    out[row.source_name] = { candidates: row.candidates, last_sync: row.last_sync };
  }
  return out;
}

function watchlistedDomains() {
  return db()
    .prepare("SELECT domain FROM domains WHERE watchlisted = 1 ORDER BY domain")
    .all();
}

function domainsNeedingRdap(ttlHours, limit = null) {
  const rankCase = Object.entries(LIFECYCLE_RANK)
    .map(([category, rank]) => `WHEN '${category}' THEN ${rank}`)
    .join(" ");
  let sql = `
    SELECT domain, source, first_seen, registration_date
    FROM domains
    WHERE last_rdap_checked IS NULL
       OR julianday('now') - julianday(last_rdap_checked) > ? / 24.0
    ORDER BY
      last_rdap_checked IS NOT NULL,
      CASE category ${rankCase} ELSE 7 END ASC,
      domain ASC
  `;
  const params = [Number(ttlHours)];
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }
  return db().prepare(sql).all(...params);
}

function domainsNeedingEnrichmentScoped(
  backlinkTtlHours,
  historyTtlDays,
  limit = null,
  categories = undefined
) {
  const wanted =
    categories === undefined ? [...INTERESTING_CATEGORIES] : [...categories];

  const clauses = [
    "(last_backlink_checked IS NULL" +
      " OR last_history_checked IS NULL" +
      " OR julianday('now') - julianday(last_backlink_checked) > ? / 24.0" +
      " OR julianday('now') - julianday(last_history_checked) > ?)",
  ];
  const params = [Number(backlinkTtlHours), Number(historyTtlDays)];

  if (wanted.length) {
    const placeholders = wanted.map(() => "?").join(",");
    clauses.push(`(category IN (${placeholders}) OR watchlisted = 1)`);
    params.push(...wanted);
  }

  const rankCase = Object.entries(LIFECYCLE_RANK)
    .map(([category, rank]) => `WHEN '${category}' THEN ${rank}`)
    .join(" ");
  let sql =
    "SELECT * FROM domains WHERE " +
    clauses.join(" AND ") +
    ` ORDER BY CASE category ${rankCase} ELSE 7 END ASC,` +
    "  last_history_checked IS NOT NULL, domain ASC";
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }
  return db().prepare(sql).all(...params).map(_rowToDict);
}

module.exports = {
  DB_PATH,
  SCHEMA_VERSION,
  SORTABLE,
  PRIORITY_RANK,
  INTERESTING_CATEGORIES,
  LIFECYCLE_RANK,
  db,
  nowIso,
  migrate,
  upsertMany,
  addCandidates,
  getDomain,
  listDomains,
  iterFiltered,
  stats,
  domainsNeedingCheck,
  allDomains,
  saveEnrichment,
  recordStatusHistory,
  recordMetricHistory,
  replaceSnapshots,
  getSnapshots,
  getMetricHistory,
  getStatusHistory,
  setWatchlist,
  getSetting,
  setSetting,
  pruneKeywordCache,
  getKeywordCache,
  setKeywordCache,
  addKeywordHistory,
  clearKeywordHistory,
  listKeywordHistory,
  targetNiches,
  crawl4aiSources,
  saveCrawl4aiSources,
  upsertCrawl4aiSource,
  pruneCrawlSourceCache,
  getCrawlSourceCache,
  setCrawlSourceCache,
  clearCrawlSourceCache,
  crawlSourceCacheRows,
  seoStats,
  topOpportunities,
  domainsNeedingEnrichment,
  linkSources,
  sourcesForDomain,
  sourceCandidateCounts,
  watchlistedDomains,
  domainsNeedingRdap,
  domainsNeedingEnrichmentScoped,
};
