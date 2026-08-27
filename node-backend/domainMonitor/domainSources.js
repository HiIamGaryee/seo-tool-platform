"use strict";

// Faithful Node port of backend/domain_monitor/domain_sources.py
const fs = require("fs");
const path = require("path");

const sourceConfig = require("./sourceConfig");
const sourceAdapters = require("./sourceAdapters");
const { normalizeDomain } = require("./models");
const {
  STATUS_ACTIVE,
  STATUS_CONFIGURED,
  STATUS_DISABLED,
  STATUS_FAILED,
  STATUS_NOT_CONFIGURED,
  InlineListSource,
  SourceReport,
} = sourceAdapters;
const { loadSettings } = sourceConfig;

// crawl4aiSource is required lazily so this module loads even if that port
// has not been written yet.
function crawl4ai() {
  return require("./crawl4aiSource");
}

// Re-exported for callers that only need the manual folder.
const SOURCES_DIR = path.join(sourceConfig.MODULE_DIR, "sources");

/**
 * Outcome of one discovery pass.
 *
 * `discovered` counts every raw string an adapter produced, `valid` counts
 * those that survived normalisation and `unique` is what actually reaches
 * RDAP. The three are reported separately because the gaps between them are
 * the interesting part.
 */
class CollectionResult {
  constructor() {
    this.domains = [];
    this.origins = {};
    this.reports = [];
    this.discovered = 0;
    this.valid = 0;
    this.invalid = 0;
    this.duplicates = 0;
    this.truncated = false;
  }

  get unique() {
    return this.domains.length;
  }

  get any_source_configured() {
    return this.reports.some((report) => report.configured);
  }

  perSource() {
    const out = {};
    for (const report of this.reports) {
      out[report.name] = report.raw_count;
    }
    return out;
  }
}

/**
 * Instantiate the enabled adapters.
 *
 * `kinds` lets a scan request narrow the selection; anything not enabled by
 * configuration stays out regardless of what the request asks for.
 */
function buildSources(settings = null, kinds = null) {
  settings = settings || loadSettings();
  const requested = kinds
    ? new Set(Array.from(kinds).map((k) => k.toLowerCase()))
    : null;

  const sources = [];
  for (const kind of sourceConfig.ALL_KINDS) {
    if (!settings.isEnabled(kind)) {
      continue;
    }
    if (requested !== null && !requested.has(kind)) {
      continue;
    }
    sources.push(...sourceAdapters.buildAdapters(kind, settings));
  }
  return [sources, settings];
}

/**
 * Per-source status for the Data Sources panel.
 *
 * Reports configuration state only; it never fetches, so it is cheap enough
 * to call on every dashboard load.
 */
function sourceStatus(settings = null) {
  settings = settings || loadSettings();
  const rows = [];
  for (const adapter of sourceAdapters.allAdapters(settings)) {
    const enabled = settings.isEnabled(adapter.kind);
    const configured = adapter.isConfigured();
    let status;
    if (!enabled) {
      status = STATUS_DISABLED;
    } else if (!configured) {
      status = STATUS_NOT_CONFIGURED;
    } else {
      status = STATUS_CONFIGURED;
    }
    rows.push({
      kind: adapter.kind,
      name: adapter.name,
      label: adapter.label,
      status,
      enabled,
      configured,
      detail: adapter.describe(),
    });
  }
  if (settings.isEnabled(sourceConfig.KIND_CRAWL4AI) || crawl4ai().loadSourceConfigs().length) {
    rows.push(...crawl4ai().sourceStatusRows());
  }
  return rows;
}

/**
 * Pull every source, normalise, deduplicate and cap.
 *
 * Deduplication happens here, before any RDAP call, so www.example.com and
 * https://EXAMPLE.com/ cost exactly one lookup between them. A source that
 * raises is marked Failed and the remaining sources still run.
 */
async function collect(sources, settings = null) {
  settings = settings || loadSettings();
  const result = new CollectionResult();
  const seen = new Set();
  const cap = settings.max_candidates;

  for (const source of sources) {
    const kind = source.kind !== undefined ? source.kind : "inline";
    const enabled =
      settings.isEnabled(kind) || source instanceof InlineListSource;
    const configured = source.isConfigured();
    const report = new SourceReport({
      kind,
      name: source.name,
      label: source.label,
      status: STATUS_ACTIVE,
      configured,
      enabled,
      detail: source.describe(),
    });

    if (!configured) {
      report.status = STATUS_NOT_CONFIGURED;
      result.reports.push(report);
      console.info(`[source:${source.name}] not configured — ${report.detail}`);
      continue;
    }

    let raw = 0;
    let accepted = 0;
    let failed = false;
    try {
      for await (const candidate of source.fetchDomains()) {
        raw += 1;
        result.discovered += 1;

        const domain = normalizeDomain(candidate);
        if (!domain) {
          result.invalid += 1;
          continue;
        }
        result.valid += 1;

        if (seen.has(domain)) {
          result.duplicates += 1;
          continue;
        }

        if (result.domains.length >= cap) {
          result.truncated = true;
          break;
        }

        seen.add(domain);
        result.domains.push(domain);
        result.origins[domain] = source.name;
        accepted += 1;
      }
    } catch (exc) {
      // A broken source degrades to Failed; discovery continues.
      failed = true;
      report.status = STATUS_FAILED;
      report.error = String(exc && exc.message ? exc.message : exc);
      console.warn(`[source:${source.name}] FAILED: ${exc}`);
    }
    if (!failed) {
      console.info(
        `[source:${source.name}] ${raw} raw, ${accepted} new candidates${
          result.truncated ? " (candidate cap reached)" : ""
        }`
      );
    }

    report.raw_count = raw;
    result.reports.push(report);

    if (result.truncated) {
      console.warn(
        `[collect] candidate cap of ${cap} reached; remaining sources skipped`
      );
      break;
    }
  }

  console.info(
    `[normalize] ${result.valid} valid of ${result.discovered} discovered (${result.invalid} rejected)`
  );
  console.info(
    `[dedupe] ${result.unique} unique candidates (${result.duplicates} duplicates collapsed)`
  );
  return result;
}

/**
 * Yield raw candidate cells from a pasted or uploaded TXT/CSV blob.
 *
 * Shared by the import endpoint and the file-backed adapters so both accept
 * exactly the same formats.
 */
function* parseCandidateLines(text, column = 0) {
  for (const line of (text || "").split(/\r?\n/)) {
    yield* sourceAdapters._cells(line, column);
  }
}

/** Where dashboard imports are appended, so ManualFileSource can re-read them. */
function manualImportPath(settings = null) {
  settings = settings || loadSettings();
  const root = settings.manual_dir;
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, path.basename(settings.manual_file));
}

// --- Backwards-compatible helpers ------------------------------------------

function loadConfiguredSources() {
  const [sources] = buildSources();
  return sources;
}

/** Legacy shape: [domains, per-source counts]. Prefer `collect`. */
async function collectCandidates(sources) {
  const result = await collect(sources);
  collectCandidates.last_origin = result.origins;
  return [result.domains, result.perSource()];
}

module.exports = {
  SOURCES_DIR,
  CollectionResult,
  buildSources,
  sourceStatus,
  collect,
  parseCandidateLines,
  manualImportPath,
  loadConfiguredSources,
  collectCandidates,
};
