"use strict";

// Faithful Node port of backend/domain_monitor/domain_monitor.py
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const classifier = require("./classifier");
const domainSources = require("./domainSources");
const sourceConfig = require("./sourceConfig");
const storage = require("./storage");
const { InlineListSource } = require("./sourceAdapters");
const {
  CAT_30,
  CAT_60,
  CAT_EXPIRED,
  CAT_PENDING_DELETE,
  CAT_REDEMPTION,
  CAT_UNKNOWN,
  LOOKUP_FAILED,
  LOOKUP_NOT_FOUND,
  LOOKUP_OK,
  LOOKUP_UNSUPPORTED_TLD,
  PRI_UNKNOWN,
  DomainRecord,
  normalizeDomain,
  tldOf,
} = require("./models");
const { RdapClient, RdapError } = require("./rdapClient");
const { runPool } = require("./pool");

const ALLOW_WHOIS_FALLBACK = process.env.DOMAIN_MONITOR_WHOIS_FALLBACK === "1";

const EXPORT_FIELDS = [
  ["domain", "Domain"],
  ["category", "Lifecycle Status"],
  ["expiration_date", "Expiry Date"],
  ["days_left", "Days Left"],
  ["registry_status", "Registry Status"],
  ["registrar", "Registrar"],
  ["priority", "Priority"],
  ["referring_domains", "Referring Domains"],
  ["total_backlinks", "Backlinks"],
  ["follow_percentage", "Follow %"],
  ["domain_age_years", "Domain Age (years)"],
  ["primary_topic", "Primary Topic"],
  ["relevance_band", "Topical Relevance"],
  ["spam_risk_level", "Spam Risk"],
  ["spam_risk_score", "Spam Score"],
  ["seo_score", "SEO Score"],
  ["seo_confidence", "Score Confidence"],
  ["seo_coverage_pct", "Model Coverage %"],
  ["historical_stability", "Historical Stability"],
  ["first_archive_seen", "First Seen"],
  ["snapshot_count", "Archive Captures"],
  ["last_rdap_checked", "Last RDAP Check"],
  ["last_backlink_checked", "Last Backlink Refresh"],
  ["last_history_checked", "Last Archive Refresh"],
  ["watchlisted", "Watchlist"],
  ["notes", "Notes"],
];

const _LOOKUP_ERROR_KINDS = {
  not_found: LOOKUP_NOT_FOUND,
  unsupported_tld: LOOKUP_UNSUPPORTED_TLD,
};

function randomId() {
  return crypto.randomBytes(6).toString("hex");
}

class ScanState {
  constructor() {
    this._state = ScanState._idle();
  }

  static _idle() {
    return {
      scan_id: null,
      status: "idle",
      phase: "idle",
      checked: 0,
      total: 0,
      collected: 0,
      discovered: 0,
      valid: 0,
      unique: 0,
      duplicates: 0,
      invalid: 0,
      truncated: false,
      skipped_cached: 0,
      expired: 0,
      expiring_30: 0,
      expiring_31_60: 0,
      redemption: 0,
      pending_delete: 0,
      unknown: 0,
      failed: 0,
      sources: {},
      source_reports: [],
      no_sources_configured: false,
      started_at: null,
      finished_at: null,
      error: null,
    };
  }

  snapshot() {
    return { ...this._state };
  }

  isRunning() {
    return this._state.status === "running";
  }

  begin(scanId) {
    this._state = ScanState._idle();
    Object.assign(this._state, {
      scan_id: scanId,
      status: "running",
      phase: "collecting",
      started_at: storage.nowIso(),
    });
  }

  update(fields) {
    Object.assign(this._state, fields);
  }

  bump(category) {
    const key = {
      [CAT_EXPIRED]: "expired",
      [CAT_30]: "expiring_30",
      [CAT_60]: "expiring_31_60",
      [CAT_REDEMPTION]: "redemption",
      [CAT_PENDING_DELETE]: "pending_delete",
      [CAT_UNKNOWN]: "unknown",
    }[category];
    this._state.checked += 1;
    if (key) this._state[key] += 1;
  }

  fail() {
    this._state.checked += 1;
    this._state.failed += 1;
  }

  finish(error = null) {
    Object.assign(this._state, {
      status: error ? "error" : "completed",
      phase: error ? "error" : "done",
      finished_at: storage.nowIso(),
      error,
    });
  }
}

const SCAN = new ScanState();

async function verifyDomain(client, domain, source, firstSeen) {
  const record = new DomainRecord({
    id: domain,
    domain,
    tld: tldOf(domain),
    source,
    first_seen: firstSeen,
    last_checked: storage.nowIso(),
    quality_score: classifier.qualityScore(domain),
  });

  let result;
  try {
    result = await client.lookup(domain);
  } catch (exc) {
    if (exc instanceof RdapError) {
      record.lookup_status = _LOOKUP_ERROR_KINDS[exc.kind] || LOOKUP_FAILED;
      record.lookup_error = String(exc.message || exc);
      record.category = CAT_UNKNOWN;
      record.priority = PRI_UNKNOWN;
      return record;
    }
    record.lookup_status = LOOKUP_FAILED;
    record.lookup_error = `Unexpected error: ${exc}`;
    return record;
  }

  record.expiration_date = result.expiration_date;
  record.registration_date = result.registration_date;
  record.registry_status = result.registry_status;
  record.registrar = result.registrar;
  record.nameservers = result.nameservers;
  record.rdap_source = result.rdap_source;
  record.days_left = classifier.daysLeftFrom(result.expiration_date);
  const [category, priority] = classifier.classify(result.registry_status, record.days_left);
  record.category = category;
  record.priority = priority;
  record.lookup_status = LOOKUP_OK;
  record.available = null;
  return record;
}

async function runScan(opts = {}) {
  const {
    domains = null,
    use_sources = true,
    force = false,
    limit = null,
    source_kinds = null,
    enrich = false,
  } = opts;
  let { state = SCAN, scan_id = null } = opts;

  let settings = sourceConfig.loadSettings();

  if (scan_id === null) {
    scan_id = randomId();
    state.begin(scan_id);
  }

  const client = new RdapClient({
    timeout: settings.rdap_timeout,
    max_retries: settings.rdap_max_retries,
    min_host_interval: settings.rdap_min_host_interval,
    allow_whois_fallback: ALLOW_WHOIS_FALLBACK,
    pool_size: settings.rdap_concurrency,
  });

  try {
    storage.migrate();

    // --- discovery ---
    const sources = [];
    if (domains && domains.length) sources.push(new InlineListSource(settings, [...domains]));
    if (use_sources) {
      const [configured, s2] = domainSources.buildSources(settings, source_kinds);
      settings = s2;
      sources.push(...configured);
    }

    const collection = await domainSources.collect(sources, settings);
    const origin = collection.origins;
    const kindByName = {};
    for (const report of collection.reports) kindByName[report.name] = report.kind;

    state.update({
      collected: collection.unique,
      discovered: collection.discovered,
      valid: collection.valid,
      unique: collection.unique,
      duplicates: collection.duplicates,
      invalid: collection.invalid,
      truncated: collection.truncated,
      sources: collection.perSource(),
      source_reports: collection.reports.map((r) => ({ ...r })),
      no_sources_configured:
        !collection.any_source_configured && !(domains && domains.length),
      phase: "verifying",
    });

    if (collection.domains.length) {
      storage.addCandidates(collection.domains, "discovery");
      storage.linkSources(origin, kindByName);
    }

    // --- decide what to verify ---
    const explicit = new Set(
      (domains || []).map((x) => normalizeDomain(x)).filter((d) => d)
    );
    let pending;
    if (explicit.size) {
      pending = storage.allDomains().filter((row) => explicit.has(row.domain));
    } else if (force) {
      pending = storage.allDomains();
    } else {
      pending = storage.domainsNeedingRdap(settings.rdap_cache_hours, limit);
    }
    if (limit) pending = pending.slice(0, parseInt(limit, 10));

    const storedTotal = storage.stats().total;
    state.update({
      total: pending.length,
      skipped_cached: Math.max(0, storedTotal - pending.length),
    });

    if (!pending.length) {
      state.finish();
      return state.snapshot();
    }

    // --- RDAP verification in bounded batches ---
    const batchSize = settings.scan_batch_size;
    for (let index = 0; index < pending.length; index += batchSize) {
      const chunk = pending.slice(index, index + batchSize);
      let written = [];

      await runPool(
        chunk,
        (row) =>
          verifyDomain(
            client,
            row.domain,
            origin[row.domain] || row.source,
            row.first_seen
          ),
        settings.rdap_concurrency,
        (record) => {
          if (record.lookup_status === LOOKUP_OK) state.bump(record.category);
          else state.fail();
          written.push(record);
          storage.recordStatusHistory(record.domain, {
            registry_status: record.registry_status,
            expiration_date: record.expiration_date,
            category: record.category,
            days_left: record.days_left,
            checked_at: record.last_checked,
          });
        },
        (_err) => {
          state.fail();
        }
      );

      if (written.length) {
        storage.upsertMany(written);
        written = [];
      }
    }

    state.finish();
  } catch (exc) {
    state.finish(String((exc && exc.message) || exc));
  } finally {
    client.close();
  }

  if (enrich) {
    try {
      require("./enrichment").startEnrichmentAsync();
    } catch (_e) {
      /* enrichment chaining is best-effort */
    }
  }

  return state.snapshot();
}

function startScanAsync(kwargs = {}) {
  if (SCAN.isRunning()) {
    return { started: false, reason: "A scan is already running", ...SCAN.snapshot() };
  }
  const scanId = randomId();
  SCAN.begin(scanId);
  runScan({ ...kwargs, scan_id: scanId }).catch((exc) => {
    SCAN.finish(String((exc && exc.message) || exc));
  });
  return { started: true, ...SCAN.snapshot() };
}

function importDomains(text, source = "import") {
  storage.migrate();

  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicatesInFile = 0;

  for (const cell of domainSources.parseCandidateLines(text)) {
    const domain = normalizeDomain(cell);
    if (!domain) {
      if (invalid.length < 50) invalid.push(cell.slice(0, 100));
      continue;
    }
    if (seen.has(domain)) {
      duplicatesInFile += 1;
      continue;
    }
    seen.add(domain);
    valid.push(domain);
  }

  const [inserted, alreadyPresent] = storage.addCandidates(valid, source);
  _appendToImportSource(valid);

  return {
    imported: inserted,
    duplicates: alreadyPresent + duplicatesInFile,
    invalid: invalid.length,
    invalid_samples: invalid.slice(0, 10),
    total_lines_parsed: valid.length + invalid.length + duplicatesInFile,
  };
}

function _appendToImportSource(domains) {
  domains = [...domains];
  if (!domains.length) return;
  const p = domainSources.manualImportPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let existing = new Set();
    if (fs.existsSync(p)) {
      existing = new Set(
        fs
          .readFileSync(p, "utf-8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l)
      );
    }
    const fresh = domains.filter((d) => !existing.has(d));
    if (fresh.length) fs.appendFileSync(p, fresh.join("\n") + "\n");
  } catch (_e) {
    /* mirroring the import is best-effort */
  }
}

function _exportCell(row, key) {
  if (key === "registry_status") return (row.registry_status || []).join(", ");
  if (key === "follow_percentage") {
    const follow = row.follow_backlinks;
    const total = row.total_backlinks;
    if (follow === null || follow === undefined || !total) return "";
    return Math.round((follow / total) * 100 * 10) / 10;
  }
  if (key === "watchlisted") return row.watchlisted ? "yes" : "no";
  if (key === "domain_age_years") {
    const age = row.domain_age_years;
    return age === null || age === undefined ? "" : Math.round(parseFloat(age) * 10) / 10;
  }
  const value = row[key];
  return value === null || value === undefined ? "" : value;
}

function exportRows(filters = {}) {
  const rows = storage.iterFiltered(filters);
  const header = EXPORT_FIELDS.map(([, label]) => label);
  const body = rows.map((row) => EXPORT_FIELDS.map(([key]) => _exportCell(row, key)));
  return [header, body];
}

function exportCsv(filters = {}) {
  const [header, body] = exportRows(filters);
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(escape).join(",")];
  for (const row of body) lines.push(row.map(escape).join(","));
  return lines.join("\r\n") + "\r\n";
}

async function exportXlsx(filters = {}) {
  const ExcelJS = require("exceljs");
  const [header, body] = exportRows(filters);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("SEO Domain Radar");
  ws.addRow(header);
  for (const row of body) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  ALLOW_WHOIS_FALLBACK,
  EXPORT_FIELDS,
  ScanState,
  SCAN,
  verifyDomain,
  runScan,
  startScanAsync,
  importDomains,
  exportRows,
  exportCsv,
  exportXlsx,
};
