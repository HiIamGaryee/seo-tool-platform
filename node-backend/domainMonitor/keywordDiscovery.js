"use strict";

// Faithful Node port of backend/domain_monitor/keyword_discovery.py
//
// Given a keyword, build a real candidate pool (deterministic name variations +
// configured source matches), verify every candidate over RDAP or WHOIS, keep
// only the interesting lifecycle states, score SEO opportunity and return the
// nearest N. Nothing is ever reported as a result until a registry lookup has
// confirmed it exists.

const crypto = require("crypto");
const { randomUUID } = require("crypto");

const similarDomains = require("./similarDomains");
const sourceConfig = require("./sourceConfig");
const storage = require("./storage");
const { runPool } = require("./pool");
const {
  CAT_30,
  CAT_60,
  CAT_EXPIRED,
  CAT_PENDING_DELETE,
  CAT_REDEMPTION,
  CAT_SAFE,
  CAT_UNKNOWN,
  LOOKUP_NOT_FOUND,
  LOOKUP_OK,
  LOOKUP_UNSUPPORTED_TLD,
  DomainRecord,
  normalizeDomain,
  registrableName,
  tldOf,
} = require("./models");

// Not-yet-loaded / cycle-prone modules are required lazily inside the functions
// that need them, so this module (and snapshot()) load cleanly on their own.
function _rdapClient() {
  return require("./rdapClient");
}
function _crawl4aiSource() {
  return require("./crawl4aiSource");
}
function _domainMonitor() {
  return require("./domainMonitor");
}
function _domainSources() {
  return require("./domainSources");
}
function _enrichment() {
  return require("./enrichment");
}
function _backlinks() {
  return require("./backlinks");
}
function _historyClient() {
  return require("./historyClient");
}

const SEARCH_MODES = ["similar", "exact", "contains"];
const DEFAULT_SEARCH_MODE = "similar";

// Kept for payloads written by the previous Keyword Discovery UI.
const LEGACY_MATCH_TYPES = { contains: "contains", starts_with: "similar", ends_with: "similar" };

const EXPIRY_WINDOWS = [30, 60];
const DEFAULT_EXPIRY_WINDOW = 60;
const DEFAULT_CACHE_HOURS = 12;

const INTERESTING_CATEGORIES = [CAT_PENDING_DELETE, CAT_REDEMPTION, CAT_EXPIRED, CAT_30, CAT_60];

const LIFECYCLE_FILTERS = {
  all: INTERESTING_CATEGORIES,
  pending_delete: [CAT_PENDING_DELETE],
  redemption: [CAT_REDEMPTION],
  expired: [CAT_EXPIRED],
  lte_30: [CAT_PENDING_DELETE, CAT_REDEMPTION, CAT_EXPIRED, CAT_30],
  lte_60: INTERESTING_CATEGORIES,
  low_spam: INTERESTING_CATEGORIES,
};

// Lifecycle urgency, 0-100. Feeds the ranking formula.
const LIFECYCLE_SCORE = {
  [CAT_PENDING_DELETE]: 100,
  [CAT_REDEMPTION]: 90,
  [CAT_EXPIRED]: 80,
  [CAT_30]: 70,
  [CAT_60]: 50,
  [CAT_SAFE]: 0,
  [CAT_UNKNOWN]: 0,
};

const LIFECYCLE_BUCKETS = {
  [CAT_PENDING_DELETE]: "pending_delete",
  [CAT_REDEMPTION]: "redemption",
  [CAT_EXPIRED]: "expired",
  [CAT_30]: "lte_30",
  [CAT_60]: "days_31_60",
  [CAT_SAFE]: "safe",
  [CAT_UNKNOWN]: "unknown",
};

const SOURCE_LABELS = {
  manual: "Manual Import",
  zone: "Zone File",
  feed: "External Feed",
  crawl4ai: "Crawl4AI",
  watchlist: "Watchlist",
  demo: "Demo Fixture",
  database: "Candidate Database",
  generated: "Name Variations",
};

const MAX_REJECTION_ROWS = 250;

function _envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return def;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return def;
  const value = parseInt(text, 10);
  return Number.isNaN(value) ? def : value;
}

const SEO_ENRICH_LIMIT = Math.max(1, _envInt("SIMILAR_DOMAIN_SEO_ENRICH_LIMIT", 60));
const CACHE_HOURS = Math.max(1, _envInt("KEYWORD_DISCOVERY_CACHE_HOURS", DEFAULT_CACHE_HOURS));
const MIN_SIMILARITY = Math.max(0, Math.min(100, _envInt("SIMILAR_DOMAIN_MIN_SIMILARITY", 55)));
// At or above this, and with the whole keyword present in the name, a candidate
// counts as a strict match. Anything else is a Broader Match.
const STRICT_MIN_SIMILARITY = Math.max(
  MIN_SIMILARITY,
  Math.min(100, _envInt("SIMILAR_DOMAIN_STRICT_MIN_SIMILARITY", 70))
);

const MATCH_LEVELS = ["exact", "strict", "broader"];
const MATCH_LEVEL_RANK = { exact: 0, strict: 1, broader: 2 };
const MATCH_LEVEL_LABELS = {
  exact: "Exact Match",
  strict: "Strict Match",
  broader: "Broader Match",
};

// Lifecycle buckets that represent a real, actionable opportunity.
const ACTIONABLE_BUCKETS = ["pending_delete", "redemption", "expired", "lte_30", "days_31_60"];

// Rejection reasons that describe a verification OUTCOME rather than a user
// filter choice. These become the Non-actionable Candidates group.
const NON_ACTIONABLE_REASONS = {
  safe_beyond_window: "Verified · Safe beyond the expiry window",
  outside_expiry_window: "Verified · Outside the selected expiry window",
  no_expiry_data: "Verified · No expiry date published",
  lookup_failed: "Lookup failed",
  unsupported_tld: "Unsupported TLD",
};

// Thousands-separated integer, matching Python's `{n:,}` formatting.
function _fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function _now() {
  return new Date();
}

function _iso() {
  return storage.nowIso();
}

function _parseIso(stamp) {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

/** Stage logging, on only when DOMAIN_RADAR_DEBUG is set. Never secrets. */
function _debug(message, ...args) {
  if (similarDomains.debugEnabled()) {
    // eslint-disable-next-line no-console
    console.log("[domain-radar] " + message, ...args);
  }
}

/** Parse a keyword, full domain, or URL. Digits are never stripped. */
function parseQuery(raw) {
  return similarDomains.parseQuery(raw);
}

/** The second-level label to search on, with every character intact. */
function normalizeKeyword(raw) {
  return parseQuery(raw).keyword;
}

/**
 * exact / strict / broader for one candidate.
 *
 * A fuzzy match means characters of the keyword are missing or rearranged, so
 * it is always Broader no matter how well it scores.
 */
function matchLevelOf(domain, keyword, similarity, exactCandidate) {
  const breakdown = similarDomains.similarityBreakdown(domain, keyword);
  if (exactCandidate) {
    // A TLD was entered, so only that one domain is the exact hit.
    if (domain === exactCandidate) return "exact";
  } else if (breakdown.match_kind === "exact") {
    // Bare keyword: any TLD carrying exactly this name is an exact hit.
    return "exact";
  }
  if (breakdown.match_kind !== "fuzzy" && similarity >= STRICT_MIN_SIMILARITY) {
    return "strict";
  }
  return "broader";
}

// --- request ----------------------------------------------------------------

class SimilarDomainRequest {
  constructor(fields) {
    this.keyword = fields.keyword;
    this.search_mode = fields.search_mode !== undefined ? fields.search_mode : DEFAULT_SEARCH_MODE;
    this.expiry_window =
      fields.expiry_window !== undefined ? fields.expiry_window : DEFAULT_EXPIRY_WINDOW;
    this.tld = fields.tld !== undefined ? fields.tld : null;
    this.limit = fields.limit !== undefined ? fields.limit : 30;
    this.lifecycle_filter = fields.lifecycle_filter !== undefined ? fields.lifecycle_filter : "all";
    this.include_available =
      fields.include_available !== undefined ? fields.include_available : false;
    // The parsed input.
    this.query = fields.query !== undefined ? fields.query : null;
  }

  get raw_query() {
    return this.query ? this.query.raw_query : this.keyword;
  }

  get exact_candidate() {
    return this.query ? this.query.exact_candidate : null;
  }

  get entered_tld() {
    return this.query ? this.query.tld : null;
  }

  static fromPayload(payload) {
    const parsed = parseQuery(payload.keyword);
    const keyword = parsed.keyword;

    let rawMode = String(payload.search_mode || "").trim().toLowerCase();
    if (!rawMode) {
      const legacy = String(payload.match_type || "").trim().toLowerCase();
      rawMode = Object.prototype.hasOwnProperty.call(LEGACY_MATCH_TYPES, legacy)
        ? LEGACY_MATCH_TYPES[legacy]
        : DEFAULT_SEARCH_MODE;
    }
    if (!SEARCH_MODES.includes(rawMode)) {
      throw new Error("search_mode must be similar, exact, or contains");
    }

    let window = Number(payload.expiry_window || DEFAULT_EXPIRY_WINDOW);
    if (!Number.isFinite(window)) {
      throw new Error("expiry_window must be a number");
    }
    // A stored search from the old UI could carry 90/180/365; clamp rather than
    // reject so recent-search chips keep working.
    window = window <= 30 ? 30 : 60;

    let tld = null;
    const rawTld = String(payload.tld || "").trim().toLowerCase();
    if (rawTld && rawTld !== "any") {
      tld = similarDomains.normalizeTld(rawTld);
      if (!tld) throw new Error("tld must be a valid TLD like .com");
    }

    const resultLimit = similarDomains.limits().result_limit;
    let limit = Number(payload.limit || resultLimit);
    if (!Number.isFinite(limit)) {
      throw new Error("limit must be a number");
    }
    limit = Math.trunc(limit);
    limit = Math.max(1, Math.min(limit, resultLimit));

    const lifecycleFilter = String(payload.lifecycle_filter || "all").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(LIFECYCLE_FILTERS, lifecycleFilter)) {
      throw new Error("lifecycle_filter is not supported");
    }

    let includeRaw;
    if (Object.prototype.hasOwnProperty.call(payload, "include_available")) {
      includeRaw = payload.include_available;
    } else if (Object.prototype.hasOwnProperty.call(payload, "include_safe")) {
      includeRaw = payload.include_safe;
    } else {
      includeRaw = false;
    }
    const includeAvailable = Boolean(includeRaw);

    return new SimilarDomainRequest({
      keyword: keyword,
      search_mode: rawMode,
      expiry_window: window,
      tld: tld,
      limit: limit,
      lifecycle_filter: lifecycleFilter,
      include_available: includeAvailable,
      query: parsed,
    });
  }

  toPayload() {
    return {
      keyword: this.keyword,
      raw_query: this.raw_query,
      entered_tld: this.entered_tld,
      exact_candidate: this.exact_candidate,
      search_mode: this.search_mode,
      expiry_window: this.expiry_window,
      tld: this.tld,
      limit: this.limit,
      lifecycle_filter: this.lifecycle_filter,
      include_available: this.include_available,
    };
  }

  /** Expansion order: an explicit UI filter wins, then the entered TLD. */
  tldList() {
    if (this.tld) return [this.tld];
    return similarDomains.orderedTlds(similarDomains.configuredTlds(), this.entered_tld);
  }

  get generates() {
    return this.search_mode === "similar" || this.search_mode === "exact";
  }
}

// Back-compat alias: server and older callers import this name.
const KeywordDiscoveryRequest = SimilarDomainRequest;

// --- ranking ----------------------------------------------------------------

function lifecycleScore(category) {
  const key = category || CAT_UNKNOWN;
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_SCORE, key) ? LIFECYCLE_SCORE[key] : 0;
}

/** Transparent weighted score. Weights come from the environment. */
function finalRankScore(row) {
  const weights = similarDomains.rankWeights();
  const similarity = Number(row.similarity_score || 0);
  const lifecycle = Number(lifecycleScore(row.category));
  const seo = Number(row.seo_score || 0);
  const total =
    similarity * weights.similarity + lifecycle * weights.lifecycle + seo * weights.seo;
  return _pyRound(total, 2);
}

function _pyRound(value, ndigits = 0) {
  const factor = Math.pow(10, ndigits);
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let rounded;
  if (Math.abs(diff - 0.5) < eps) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

function _scoreParts(row) {
  const weights = similarDomains.rankWeights();
  return {
    similarity: {
      value: Math.trunc(Number(row.similarity_score || 0)),
      weight: _pyRound(weights.similarity, 4),
    },
    lifecycle: {
      value: lifecycleScore(row.category),
      weight: _pyRound(weights.lifecycle, 4),
    },
    seo: {
      value: Math.trunc(Number(row.seo_score || 0)),
      weight: _pyRound(weights.seo, 4),
    },
  };
}

// --- state ------------------------------------------------------------------

function _emptyDiagnostics() {
  return {
    generated: 0,
    source_matches: 0,
    unique_candidates: 0,
    skipped_over_cap: 0,
    verify_attempted: 0,
    rdap_verified: 0,
    whois_verified: 0,
    verified: 0,
    cache_reused: 0,
    lookup_failed: 0,
    unsupported_tld: 0,
    available_unregistered: 0,
    no_expiry_data: 0,
    safe_beyond_window: 0,
    outside_expiry_window: 0,
    below_similarity_floor: 0,
    filtered_by_lifecycle: 0,
    filtered_by_spam: 0,
    eligible: 0,
    seo_analyzed: 0,
    level_exact: 0,
    level_strict: 0,
    level_broader: 0,
    actionable: 0,
    available: 0,
    non_actionable: 0,
    results: 0,
  };
}

/** Live progress for one discovery run, polled by the dashboard. */
class SimilarDomainState {
  constructor() {
    // Node is single-threaded; no lock is needed to guard mutations.
    this._state = SimilarDomainState._idle();
  }

  static _idle() {
    return {
      run_id: null,
      status: "idle",
      phase: "idle",
      keyword: null,
      filters: {},
      message: null,
      stage_label: null,
      sources_total: 0,
      sources_completed: 0,
      generated: 0,
      source_matches: 0,
      unique_candidates: 0,
      verify_total: 0,
      verified: 0,
      eligible: 0,
      enriched: 0,
      seo_total: 0,
      result_count: 0,
      // Legacy field names the previous UI polled.
      candidates_found: 0,
      candidate_matches: 0,
      results: [],
      available_results: [],
      available_count: 0,
      non_actionable: [],
      non_actionable_count: 0,
      query: {},
      strict_min_similarity: STRICT_MIN_SIMILARITY,
      min_similarity: MIN_SIMILARITY,
      history: [],
      source_counts: {},
      source_details: [],
      diagnostics: _emptyDiagnostics(),
      rejections: [],
      gemini: {},
      weights: {},
      tlds: [],
      debug: false,
      no_sources_configured: false,
      cache_hit: false,
      cache_key: null,
      cache_expires_at: null,
      duration_ms: null,
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

  begin(runId, request) {
    this._state = SimilarDomainState._idle();
    Object.assign(this._state, {
      run_id: runId,
      status: "running",
      phase: "generating",
      keyword: request.keyword,
      filters: request.toPayload(),
      started_at: _iso(),
      debug: similarDomains.debugEnabled(),
      tlds: request.tldList(),
      query: request.query ? request.query.toDebug() : {},
    });
  }

  update(fields) {
    Object.assign(this._state, fields);
  }

  stage(phase, message, fields = {}) {
    Object.assign(this._state, { phase, message, stage_label: message }, fields);
    _debug("%s — %s", phase, message);
  }

  increment(key, amount = 1) {
    const value = Math.trunc(Number(this._state[key] || 0)) + amount;
    this._state[key] = value;
    return value;
  }

  finish(error = null) {
    Object.assign(this._state, {
      status: error ? "error" : "completed",
      phase: error ? "error" : "done",
      finished_at: _iso(),
      error: error,
    });
  }
}

const STATE = new SimilarDomainState();
const KeywordDiscoveryState = SimilarDomainState;

/** Bounded per-domain accept/reject log, surfaced in the debug panel. */
class Rejections {
  constructor() {
    this._rows = [];
  }

  add(domain, opts) {
    if (this._rows.length >= MAX_REJECTION_ROWS) return;
    this._rows.push({
      domain: domain,
      accepted: opts.accepted,
      reason: opts.reason,
      detail: opts.detail,
      similarity_score: opts.similarity,
      category: opts.category !== undefined ? opts.category : null,
      verification_source:
        opts.verification_source !== undefined ? opts.verification_source : "unknown",
    });
  }

  rows() {
    return this._rows.slice().sort((a, b) => {
      // (not accepted, -similarity, domain): rejected rows first.
      const aRej = a.accepted ? 1 : 0;
      const bRej = b.accepted ? 1 : 0;
      if (aRej !== bRej) return aRej - bRej;
      const sa = Math.trunc(Number(a.similarity_score || 0));
      const sb = Math.trunc(Number(b.similarity_score || 0));
      if (sa !== sb) return sb - sa;
      if (a.domain < b.domain) return -1;
      if (a.domain > b.domain) return 1;
      return 0;
    });
  }
}

// --- candidate collection ---------------------------------------------------

/**
 * Does a source domain qualify, and how similar is it? Returns [ok, score].
 * Cheap gates first so a large zone file is not scored character by character.
 */
function _matchesMode(domain, request) {
  if (request.tld && tldOf(domain) !== request.tld) return [false, 0];
  const name = registrableName(domain).toLowerCase();
  const squashed = name.replace(/-/g, "");
  const keyword = request.keyword;

  if (request.search_mode === "exact") {
    if (squashed !== keyword) return [false, 0];
    return [true, similarDomains.similarityScore(domain, keyword)];
  }

  if (request.search_mode === "contains") {
    if (!name.includes(keyword) && !squashed.includes(keyword)) return [false, 0];
    return [true, similarDomains.similarityScore(domain, keyword)];
  }

  // similar: containment, or a close-enough fuzzy neighbour.
  if (!squashed.includes(keyword)) {
    if (Math.abs(squashed.length - keyword.length) > 6) return [false, 0];
    if (squashed.slice(0, 1) !== keyword.slice(0, 1) && squashed.slice(-1) !== keyword.slice(-1)) {
      return [false, 0];
    }
  }
  const score = similarDomains.similarityScore(domain, keyword);
  return [score >= MIN_SIMILARITY, score];
}

/** Stage 1: deterministic name variations. Candidates only, never results. */
function _generatePool(request, state) {
  if (!request.generates) {
    state.stage("generating", "Skipping name generation for this search mode", { generated: 0 });
    return {};
  }

  const caps = similarDomains.limits();
  const pool = similarDomains.generateCandidates(
    request.query || similarDomains.parseQuery(request.keyword),
    {
      tlds: request.tldList(),
      maxGenerated: caps.max_generated,
      exactOnly: request.search_mode === "exact",
    }
  );

  const generated = {};
  for (const candidate of pool) generated[candidate.domain] = candidate.similarity;
  state.stage(
    "generating",
    `Generating candidate names... ${_fmt(Object.keys(generated).length)} candidates`,
    { generated: Object.keys(generated).length }
  );
  _debug(
    "candidate generation: %d names across %d TLDs, exact_candidate=%s, first=%s",
    Object.keys(generated).length,
    request.tldList().length,
    request.exact_candidate || "-",
    pool.slice(0, 5).map((c) => c.domain).join(", ")
  );
  return generated;
}

/** Stage 2: match the keyword against every configured real source. */
async function _searchSources(request, settings, state) {
  const domainSources = _domainSources();
  const matched = {}; // domain -> best score
  const origins = new Map(); // domain -> Set of source names
  const originKinds = {}; // source name -> kind
  const sourceDetails = [];
  let anyConfigured = false;

  const [adapters] = domainSources.buildSources(settings);
  const total = adapters.length + 1; // +1 for the stored candidate database
  state.stage("searching_sources", "Searching configured sources...", {
    sources_total: total,
    sources_completed: 0,
    source_matches: 0,
  });

  function record(domain, score, sourceName, kind) {
    if (!origins.has(domain)) origins.set(domain, new Set());
    origins.get(domain).add(sourceName);
    originKinds[sourceName] = kind;
    const previous = matched[domain];
    if (previous === undefined || score > previous) matched[domain] = score;
  }

  let completed = 0;
  for (const adapter of adapters) {
    const started = Date.now();
    let searched = 0;
    let hits = 0;
    let status = "success";
    let error = null;
    const configured = adapter.isConfigured();
    if (configured) {
      anyConfigured = true;
      try {
        let iterable = adapter.fetchDomains();
        if (iterable && typeof iterable.then === "function") iterable = await iterable;
        for await (const raw of iterable) {
          searched += 1;
          const domain = normalizeDomain(raw);
          if (!domain) continue;
          const [ok, score] = _matchesMode(domain, request);
          if (!ok) continue;
          hits += 1;
          record(domain, score, adapter.name, adapter.kind);
        }
      } catch (exc) {
        // One broken source must never take the run down.
        status = "error";
        error = String(exc && exc.message ? exc.message : exc);
        console.warn(`[domain-radar] source ${adapter.name} failed: ${error}`);
      }
    } else {
      status = "not_configured";
    }

    sourceDetails.push({
      name: adapter.name,
      kind: adapter.kind,
      label: adapter.label,
      status: status,
      configured: configured,
      searched: searched,
      matched: hits,
      duration_ms: Math.trunc(Date.now() - started),
      error: error,
      detail: adapter.describe(),
    });
    completed += 1;
    state.update({
      sources_completed: completed,
      source_matches: Object.keys(matched).length,
      source_details: sourceDetails,
      message: `Searching configured sources... ${completed} / ${total}`,
    });
    _debug("source %s: status=%s searched=%d matched=%d", adapter.name, status, searched, hits);
  }

  // The stored candidate database is always searched: it is the accumulated
  // result of every previous scan and import.
  const startedDb = Date.now();
  const stored = storage.allDomains();
  let hits = 0;
  for (const row of stored) {
    const domain = row.domain;
    if (!domain) continue;
    const [ok, score] = _matchesMode(domain, request);
    if (!ok) continue;
    hits += 1;
    record(domain, score, "database", "database");
  }
  if (stored.length) anyConfigured = true;
  sourceDetails.push({
    name: "database",
    kind: "database",
    label: SOURCE_LABELS.database,
    status: "success",
    configured: true,
    searched: stored.length,
    matched: hits,
    duration_ms: Math.trunc(Date.now() - startedDb),
    error: null,
    detail: `Searching ${_fmt(stored.length)} stored candidates`,
  });
  completed += 1;
  state.update({
    sources_completed: completed,
    source_matches: Object.keys(matched).length,
    source_details: sourceDetails,
    message: `Searching configured sources... ${_fmt(Object.keys(matched).length)} source matches`,
  });
  _debug("source pass complete: %d matches across %d sources", Object.keys(matched).length, completed);

  const configuredRows = domainSources.sourceStatus(settings);
  const noSourcesConfigured =
    !anyConfigured && !configuredRows.some((row) => row.configured);
  return { matched, origins, originKinds, sourceDetails, noSourcesConfigured };
}

// --- verification -----------------------------------------------------------

function _rdapStale(stamp, ttlHours) {
  const checked = _parseIso(stamp);
  if (!checked) return true;
  const deltaMs = _now().getTime() - checked.getTime();
  return deltaMs > Number(ttlHours) * 3600 * 1000;
}

class VerifiedRow {
  constructor(fields) {
    this.row = fields.row;
    this.similarity = fields.similarity;
    this.verification_source = fields.verification_source;
    this.from_cache = fields.from_cache;
  }
}

/** Stage 4: RDAP first, WHOIS second. Nothing is trusted until this runs. */
async function _verifyCandidates(request, candidates, origins, settings, state, diagnostics) {
  const { RdapClient, verificationSourceOf } = _rdapClient();
  const domainMonitor = _domainMonitor();

  const total = candidates.length;
  state.stage("verifying", `RDAP / WHOIS verification... 0 / ${total}`, {
    verify_total: total,
    verified: 0,
  });
  const client = new RdapClient({
    timeout: settings.rdap_timeout,
    max_retries: settings.rdap_max_retries,
    min_host_interval: settings.rdap_min_host_interval,
    allow_whois_fallback: domainMonitor.ALLOW_WHOIS_FALLBACK,
    pool_size: settings.rdap_concurrency,
  });
  const verified = [];
  let written = [];
  const similarityByDomain = new Map(candidates);

  try {
    const batchSize = Math.max(1, settings.scan_batch_size);
    const domains = candidates.map(([domain]) => domain);
    for (let index = 0; index < domains.length; index += batchSize) {
      const chunk = domains.slice(index, index + batchSize);

      const worker = async (domain) => {
        const stored = storage.getDomain(domain);
        if (stored && !_rdapStale(stored.last_rdap_checked, settings.rdap_cache_hours)) {
          return { domain, fromCache: true, result: stored };
        }
        const originSet = origins.get(domain);
        const firstSource =
          originSet && originSet.size ? originSet.values().next().value : "generated";
        const firstSeen = stored ? stored.first_seen : null;
        const result = await domainMonitor.verifyDomain(client, domain, firstSource, firstSeen);
        return { domain, fromCache: false, result };
      };

      const onResult = ({ domain, fromCache, result }) => {
        let row;
        if (result instanceof DomainRecord) {
          written.push(result);
          storage.recordStatusHistory(result.domain, {
            registry_status: result.registry_status,
            expiration_date: result.expiration_date,
            category: result.category,
            days_left: result.days_left,
            checked_at: result.last_checked,
          });
          row = result.toDict();
        } else {
          row = { ...result };
        }

        const source = verificationSourceOf(row.rdap_source);
        diagnostics.verify_attempted += 1;
        if (fromCache) diagnostics.cache_reused += 1;
        if (row.lookup_status === LOOKUP_OK) {
          diagnostics.verified += 1;
          if (source === "whois") diagnostics.whois_verified += 1;
          else if (source === "rdap") diagnostics.rdap_verified += 1;
        }
        verified.push(
          new VerifiedRow({
            row: row,
            similarity: similarityByDomain.get(domain) || 0,
            verification_source: source,
            from_cache: fromCache,
          })
        );

        const count = state.increment("verified");
        state.update({ message: `RDAP / WHOIS verification... ${count} / ${total}` });
        if (similarDomains.debugEnabled()) {
          const statuses = row.registry_status || [];
          _debug(
            "[rdap] %s status=%s expires=%s via=%s%s",
            domain,
            statuses.map((s) => String(s)).join(",") || row.lookup_status,
            row.expiration_date || "-",
            source,
            fromCache ? " (cached)" : ""
          );
        }
      };

      const onError = (exc, domain) => {
        const msg = exc && exc.message ? exc.message : String(exc);
        console.warn(`[domain-radar] verify worker failed on ${domain}: ${msg}`);
        diagnostics.lookup_failed += 1;
        state.increment("verified");
      };

      await runPool(chunk, worker, settings.rdap_concurrency, onResult, onError);

      if (written.length) {
        storage.upsertMany(written);
        written = [];
      }
    }
  } finally {
    if (client && typeof client.close === "function") {
      const maybe = client.close();
      if (maybe && typeof maybe.then === "function") await maybe;
    }
  }

  return verified;
}

// --- lifecycle filter -------------------------------------------------------

/**
 * Stage 5. Returns the enriched row when eligible, null when rejected.
 *
 * A 404 from the registry means unregistered, which is not the same thing as
 * expired: it lands in its own bucket and only reaches the results when
 * Include Available is on.
 */
function _classifyCandidate(item, request, diagnostics, rejections) {
  const row = item.row;
  const domain = row.domain;
  const status = row.lookup_status;
  const category = row.category;
  const daysLeft = row.days_left;

  let bucket;
  if (status === LOOKUP_NOT_FOUND) {
    diagnostics.available_unregistered += 1;
    if (!request.include_available) {
      rejections.add(domain, {
        accepted: false,
        reason: "available_unregistered",
        detail: "Not present in the registry — available, not expired",
        similarity: item.similarity,
        category: "Available",
        verification_source: item.verification_source,
      });
      return null;
    }
    bucket = "available";
  } else if (status === LOOKUP_UNSUPPORTED_TLD) {
    diagnostics.unsupported_tld += 1;
    rejections.add(domain, {
      accepted: false,
      reason: "unsupported_tld",
      detail: "No RDAP endpoint and no WHOIS fallback for this TLD",
      similarity: item.similarity,
      verification_source: item.verification_source,
    });
    return null;
  } else if (status !== LOOKUP_OK) {
    diagnostics.lookup_failed += 1;
    rejections.add(domain, {
      accepted: false,
      reason: "lookup_failed",
      detail: String(row.lookup_error || "Registry lookup failed"),
      similarity: item.similarity,
      verification_source: item.verification_source,
    });
    return null;
  } else {
    bucket = LIFECYCLE_BUCKETS[category || CAT_UNKNOWN] || "unknown";
  }

  if (item.similarity < MIN_SIMILARITY) {
    diagnostics.below_similarity_floor += 1;
    rejections.add(domain, {
      accepted: false,
      reason: "below_similarity_floor",
      detail: `Similarity ${item.similarity} is under the floor of ${MIN_SIMILARITY}`,
      similarity: item.similarity,
      category: category,
      verification_source: item.verification_source,
    });
    return null;
  }

  if (bucket !== "available") {
    if (category === CAT_SAFE) {
      diagnostics.safe_beyond_window += 1;
      const detail =
        daysLeft !== null && daysLeft !== undefined
          ? `Expires in ${daysLeft} days`
          : "Not expiring soon";
      rejections.add(domain, {
        accepted: false,
        reason: "safe_beyond_window",
        detail: detail,
        similarity: item.similarity,
        category: category,
        verification_source: item.verification_source,
      });
      return null;
    }
    if (category === CAT_UNKNOWN) {
      diagnostics.no_expiry_data += 1;
      rejections.add(domain, {
        accepted: false,
        reason: "no_expiry_data",
        detail: "Registered, but the registry published no expiry date",
        similarity: item.similarity,
        category: category,
        verification_source: item.verification_source,
      });
      return null;
    }
    if (category === CAT_60 && request.expiry_window < 60) {
      diagnostics.outside_expiry_window += 1;
      rejections.add(domain, {
        accepted: false,
        reason: "outside_expiry_window",
        detail: `Expires in ${daysLeft} days, outside the ${request.expiry_window}-day window`,
        similarity: item.similarity,
        category: category,
        verification_source: item.verification_source,
      });
      return null;
    }
    const wanted = LIFECYCLE_FILTERS[request.lifecycle_filter] || INTERESTING_CATEGORIES;
    if (!wanted.includes(category)) {
      diagnostics.filtered_by_lifecycle += 1;
      rejections.add(domain, {
        accepted: false,
        reason: "filtered_by_lifecycle",
        detail: `${category} is outside the selected lifecycle filter`,
        similarity: item.similarity,
        category: category,
        verification_source: item.verification_source,
      });
      return null;
    }
  }

  diagnostics.eligible += 1;
  const breakdown = similarDomains.similarityBreakdown(domain, request.keyword);
  const level = matchLevelOf(domain, request.keyword, item.similarity, request.exact_candidate);
  const levelKey = `level_${level}`;
  diagnostics[levelKey] = Math.trunc(Number(diagnostics[levelKey] || 0)) + 1;
  return {
    ...row,
    similarity_score: item.similarity,
    match_level: level,
    match_level_label: MATCH_LEVEL_LABELS[level],
    exact_match: level === "exact",
    similarity_match_kind: breakdown.match_kind,
    similarity_second_level: breakdown.second_level,
    similarity_tld_score: breakdown.tld_score,
    similarity_edit_distance: breakdown.edit_distance,
    lifecycle_bucket: bucket,
    lifecycle_score: lifecycleScore(category),
    verification_source: item.verification_source,
    verified_from_cache: item.from_cache,
  };
}

// --- SEO enrichment ---------------------------------------------------------

async function _enrichShortlist(domains, state) {
  if (!domains.length) return;
  const backlinks = _backlinks();
  const enrichment = _enrichment();
  const historyClient = _historyClient();

  const provider = backlinks.buildProvider();
  const history = new historyClient.HistoryClient({ pool_size: enrichment.ENRICH_WORKERS });
  const niches = storage.targetNiches();
  let enriched = 0;
  try {
    const targets = domains
      .map((domain) => ({ domain, row: storage.getDomain(domain) }))
      .filter((t) => t.row);

    const worker = async ({ domain, row }) => {
      return enrichment.enrichDomain(
        domain,
        row.registration_date,
        history,
        provider,
        niches,
        row,
        false
      );
    };
    const onResult = (payload, { domain }) => {
      enrichment.persist(domain, payload);
      enriched += 1;
      state.update({
        enriched: enriched,
        message: `SEO enrichment... ${enriched} / ${domains.length}`,
      });
    };
    const onError = (exc, { domain }) => {
      const msg = exc && exc.message ? exc.message : String(exc);
      console.warn(`[domain-radar] SEO enrichment failed for ${domain}: ${msg}`);
    };
    await runPool(targets, worker, enrichment.ENRICH_WORKERS, onResult, onError);
  } finally {
    if (history && typeof history.close === "function") {
      const maybe = history.close();
      if (maybe && typeof maybe.then === "function") await maybe;
    }
    if (provider && typeof provider.close === "function") {
      const maybe = provider.close();
      if (maybe && typeof maybe.then === "function") await maybe;
    }
  }
}

function _resultSources(domain, origins, generated) {
  const names = new Set(origins.get(domain) || []);
  for (const row of storage.sourcesForDomain(domain)) {
    names.add(String(row.source_name || ""));
  }
  if (generated && names.size === 0) names.add("generated");
  const cleaned = [...names].filter((name) => name);
  const sorted = cleaned.sort();
  const labels = sorted.map((name) =>
    Object.prototype.hasOwnProperty.call(SOURCE_LABELS, name) ? SOURCE_LABELS[name] : name
  );
  return [sorted, labels];
}

/**
 * Stage 7: rank the survivors and split them into groups.
 * Returns [actionable, available]. Never pads either list to reach the limit.
 */
function _decorate(request, rows, origins, generatedPool, diagnostics, rejections) {
  const decorated = [];
  for (const row of rows) {
    if (
      request.lifecycle_filter === "low_spam" &&
      row.spam_risk_level !== null &&
      row.spam_risk_level !== undefined &&
      row.spam_risk_level !== "Low"
    ) {
      diagnostics.filtered_by_spam += 1;
      rejections.add(row.domain, {
        accepted: false,
        reason: "filtered_by_spam",
        detail: `Spam risk ${row.spam_risk_level} excluded by Low Spam Only`,
        similarity: Math.trunc(Number(row.similarity_score || 0)),
        category: row.category,
        verification_source: String(row.verification_source || "unknown"),
      });
      continue;
    }
    const [sourceNames, sourceLabels] = _resultSources(
      row.domain,
      origins,
      Object.prototype.hasOwnProperty.call(generatedPool, row.domain)
    );
    decorated.push({
      ...row,
      final_rank_score: finalRankScore(row),
      score_parts: _scoreParts(row),
      source_names: sourceNames,
      source_labels: sourceLabels,
      // Legacy aliases so nothing downstream breaks on rename.
      keyword_match_score: Math.trunc(Number(row.similarity_score || 0)),
      keyword_match_type: row.similarity_match_kind,
    });
  }

  // Exact first, then strict, then broader.
  const lifecycleRankOf = (category) =>
    Object.prototype.hasOwnProperty.call(storage.LIFECYCLE_RANK, category)
      ? storage.LIFECYCLE_RANK[category]
      : 7;
  decorated.sort((a, b) => {
    const la = Object.prototype.hasOwnProperty.call(MATCH_LEVEL_RANK, a.match_level)
      ? MATCH_LEVEL_RANK[a.match_level]
      : 2;
    const lb = Object.prototype.hasOwnProperty.call(MATCH_LEVEL_RANK, b.match_level)
      ? MATCH_LEVEL_RANK[b.match_level]
      : 2;
    if (la !== lb) return la - lb;
    const fa = Number(a.final_rank_score || 0);
    const fb = Number(b.final_rank_score || 0);
    if (fa !== fb) return fb - fa;
    const sa = Math.trunc(Number(a.similarity_score || 0));
    const sb = Math.trunc(Number(b.similarity_score || 0));
    if (sa !== sb) return sb - sa;
    const ta = Math.trunc(Number(a.similarity_tld_score || 0));
    const tb = Math.trunc(Number(b.similarity_tld_score || 0));
    if (ta !== tb) return tb - ta;
    const ra = lifecycleRankOf(a.category);
    const rb = lifecycleRankOf(b.category);
    if (ra !== rb) return ra - rb;
    if (a.domain < b.domain) return -1;
    if (a.domain > b.domain) return 1;
    return 0;
  });

  const actionable = [];
  const available = [];
  for (const row of decorated) {
    if (ACTIONABLE_BUCKETS.includes(row.lifecycle_bucket)) actionable.push(row);
    else if (row.lifecycle_bucket === "available") available.push(row);
  }

  actionable.forEach((row, i) => {
    row.rank = i + 1;
  });
  available.forEach((row, i) => {
    row.rank = i + 1;
  });

  for (const row of decorated) {
    rejections.add(row.domain, {
      accepted: true,
      reason: "accepted",
      detail: `${row.category} · similarity ${row.similarity_score} · ${row.match_level_label}`,
      similarity: Math.trunc(Number(row.similarity_score || 0)),
      category: row.category,
      verification_source: String(row.verification_source || "unknown"),
    });
  }

  diagnostics.actionable = actionable.length;
  diagnostics.available = available.length;
  return [actionable.slice(0, request.limit), available.slice(0, request.limit)];
}

/**
 * Verified-but-unusable candidates, for the collapsed group in the UI.
 * Only verification outcomes appear here.
 */
function _nonActionableRows(rejections) {
  const out = [];
  for (const row of rejections.rows()) {
    if (row.accepted) continue;
    const reason = row.reason;
    if (!Object.prototype.hasOwnProperty.call(NON_ACTIONABLE_REASONS, reason)) continue;
    out.push({
      domain: row.domain,
      reason: NON_ACTIONABLE_REASONS[reason],
      reason_code: reason,
      detail: row.detail,
      similarity_score: row.similarity_score,
      category: row.category,
      verification_source: row.verification_source,
      verification_status: ["safe_beyond_window", "outside_expiry_window", "no_expiry_data"].includes(
        reason
      )
        ? "Verified"
        : "Unverified",
    });
  }
  return out;
}

// --- orchestration ----------------------------------------------------------

function _cacheKey(payload) {
  const wire = [
    "v3",
    payload.keyword,
    payload.raw_query || payload.keyword,
    payload.entered_tld || "-",
    payload.search_mode,
    String(payload.expiry_window),
    payload.tld || "*",
    String(payload.limit),
    payload.lifecycle_filter,
    payload.include_available ? "1" : "0",
  ].join("|");
  return crypto.createHash("sha256").update(wire, "utf-8").digest("hex");
}

function _cacheExpiry() {
  const d = new Date(_now().getTime() + CACHE_HOURS * 3600 * 1000);
  // isoformat(timespec="seconds") with UTC offset, e.g. 2026-08-27T12:00:00+00:00
  return d.toISOString().replace(/\.\d+Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function history(limit = 8) {
  storage.migrate();
  return { items: storage.listKeywordHistory(limit) };
}

function snapshot() {
  storage.migrate();
  const current = STATE.snapshot();
  current.history = storage.listKeywordHistory(8);
  current.debug = similarDomains.debugEnabled();
  return current;
}

async function runSimilarDomainDiscovery(request, { runId = null, state = STATE } = {}) {
  const started = Date.now();
  if (runId === null) {
    runId = crypto.randomBytes(6).toString("hex");
    state.begin(runId, request);
  }

  // Any escape from here would leave the state stuck at "running" and block
  // every later run, so the whole body is guarded.
  try {
    return await _execute(request, runId, state, started);
  } catch (exc) {
    console.error(`Similar domain discovery ${runId} failed during setup`, exc);
    state.finish(exc && exc.message ? exc.message : String(exc));
    return state.snapshot();
  }
}

async function _execute(request, runId, state, started) {
  storage.migrate();
  const settings = sourceConfig.loadSettings();
  const caps = similarDomains.limits();
  const weights = similarDomains.rankWeights();
  const cacheKey = _cacheKey(request.toPayload());

  _debug(
    "search started raw_query=%s normalized_domain=%s second_level_domain=%s " +
      "tld=%s exact_candidate=%s mode=%s window=%s tld_filter=%s",
    request.raw_query,
    (request.query ? request.query.normalized_domain : null) || "-",
    request.keyword,
    (request.entered_tld || "-").replace(/^\.+/, ""),
    request.exact_candidate || "-",
    request.search_mode,
    request.expiry_window,
    request.tld || "any"
  );

  const cached = storage.getKeywordCache(cacheKey);
  if (cached) {
    const response = { ...(cached.response || {}) };
    Object.assign(response, {
      run_id: runId,
      status: "completed",
      phase: "done",
      cache_hit: true,
      cache_key: cacheKey,
      cache_expires_at: cached.expires_at,
      finished_at: _iso(),
      history: storage.listKeywordHistory(8),
      debug: similarDomains.debugEnabled(),
    });
    state.update(response);
    _debug("cache hit for %s (%d results)", request.keyword, Math.trunc(Number(response.result_count || 0)));
    return state.snapshot();
  }

  const diagnostics = _emptyDiagnostics();
  const rejections = new Rejections();

  try {
    state.update({
      cache_key: cacheKey,
      weights: {
        similarity: _pyRound(weights.similarity, 4),
        lifecycle: _pyRound(weights.lifecycle, 4),
        seo: _pyRound(weights.seo, 4),
      },
      tlds: request.tldList(),
    });

    const crawl4aiSource = _crawl4aiSource();
    const geminiBefore = crawl4aiSource.geminiStats();

    // 1. deterministic name variations
    const generatedPool = _generatePool(request, state);
    diagnostics.generated = Object.keys(generatedPool).length;

    // 2. real configured sources
    const {
      matched: sourcePool,
      origins,
      originKinds,
      sourceDetails,
      noSourcesConfigured: noSources,
    } = await _searchSources(request, settings, state);
    diagnostics.source_matches = Object.keys(sourcePool).length;

    const geminiAfter = crawl4aiSource.geminiStats();
    const geminiDelta = {};
    for (const key of ["calls", "success", "failures", "domains"]) {
      geminiDelta[key] = (geminiAfter[key] || 0) - (geminiBefore[key] || 0);
    }
    Object.assign(geminiDelta, {
      configured: geminiAfter.configured,
      model: geminiAfter.model,
      provider: geminiAfter.provider,
      reason: geminiAfter.reason,
      last_status: geminiAfter.last_status,
      last_error: geminiAfter.last_error,
      last_duration_ms: geminiAfter.last_duration_ms,
    });
    state.update({ gemini: geminiDelta });

    if (noSources && Object.keys(generatedPool).length === 0) {
      state.update({
        status: "completed",
        phase: "done",
        no_sources_configured: true,
        message: "No discovery sources configured.",
        source_details: sourceDetails,
        diagnostics: diagnostics,
        history: storage.listKeywordHistory(8),
      });
      return state.snapshot();
    }

    // 3. merge + dedupe, keeping the best similarity per domain
    const merged = { ...generatedPool };
    for (const [domain, score] of Object.entries(sourcePool)) {
      merged[domain] = Math.max(score, merged[domain] === undefined ? 0 : merged[domain]);
    }
    let candidates = Object.entries(merged).sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      if (a[0].length !== b[0].length) return a[0].length - b[0].length;
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
    diagnostics.unique_candidates = candidates.length;
    state.stage("deduplicating", `Deduplicating... ${_fmt(candidates.length)} unique candidates`, {
      unique_candidates: candidates.length,
      candidates_found: candidates.length,
      candidate_matches: candidates.length,
    });

    if (candidates.length > caps.max_verified) {
      diagnostics.skipped_over_cap = candidates.length - caps.max_verified;
      candidates = candidates.slice(0, caps.max_verified);
    }

    // 4. RDAP / WHOIS
    const verified = await _verifyCandidates(
      request,
      candidates,
      origins,
      settings,
      state,
      diagnostics
    );

    for (const item of verified) {
      if (item.row.lookup_status === LOOKUP_OK) {
        const originSet = origins.get(item.row.domain) || new Set();
        for (const name of originSet) {
          storage.linkSources({ [item.row.domain]: name }, { [name]: originKinds[name] });
        }
      }
    }

    // 5. lifecycle filter
    state.stage("lifecycle_filter", "Lifecycle filtering...");
    const eligible = [];
    for (const item of verified) {
      const row = _classifyCandidate(item, request, diagnostics, rejections);
      if (row) eligible.push(row);
    }
    state.stage("lifecycle_filter", `Lifecycle filtering... ${_fmt(eligible.length)} eligible`, {
      eligible: eligible.length,
      diagnostics: diagnostics,
    });

    // 6. SEO enrichment on the closest eligible rows only
    const lifecycleRankOf = (category) =>
      Object.prototype.hasOwnProperty.call(storage.LIFECYCLE_RANK, category)
        ? storage.LIFECYCLE_RANK[category]
        : 7;
    eligible.sort((a, b) => {
      const sa = Math.trunc(Number(a.similarity_score || 0));
      const sb = Math.trunc(Number(b.similarity_score || 0));
      if (sa !== sb) return sb - sa;
      const ra = lifecycleRankOf(a.category);
      const rb = lifecycleRankOf(b.category);
      if (ra !== rb) return ra - rb;
      if (a.domain < b.domain) return -1;
      if (a.domain > b.domain) return 1;
      return 0;
    });
    const enrichTargets = eligible.slice(0, SEO_ENRICH_LIMIT).map((row) => row.domain);
    state.stage("seo_analysis", `SEO enrichment... 0 / ${enrichTargets.length}`, {
      enriched: 0,
      seo_total: enrichTargets.length,
    });
    await _enrichShortlist(enrichTargets, state);
    diagnostics.seo_analyzed = enrichTargets.length;

    // Re-read so the freshly persisted SEO metrics reach the ranking stage.
    const byDomain = new Map();
    for (const row of eligible) byDomain.set(row.domain, row);
    const finalRows = [];
    for (const [domain, row] of byDomain) {
      const stored = storage.getDomain(domain);
      const base = stored ? { ...row, ...stored } : row;
      finalRows.push(base);
      if (stored) {
        const keep = [
          "similarity_score",
          "match_level",
          "match_level_label",
          "exact_match",
          "similarity_match_kind",
          "similarity_second_level",
          "similarity_tld_score",
          "similarity_edit_distance",
          "lifecycle_bucket",
          "lifecycle_score",
          "verification_source",
          "verified_from_cache",
        ];
        for (const key of keep) base[key] = row[key];
      }
    }

    // 7. ranking
    state.stage("ranking", "Ranking...");
    const [results, availableResults] = _decorate(
      request,
      finalRows,
      origins,
      generatedPool,
      diagnostics,
      rejections
    );
    const nonActionable = _nonActionableRows(rejections);
    diagnostics.results = results.length;
    diagnostics.non_actionable = nonActionable.length;
    const durationMs = Math.trunc(Date.now() - started);

    const summary = results.length
      ? `${results.length} matching opportunit${results.length === 1 ? "y" : "ies"} found`
      : "0 lifecycle matches found";

    const sourceCounts = {};
    for (const detail of sourceDetails) sourceCounts[detail.label] = detail.matched;

    const response = {
      keyword: request.keyword,
      filters: request.toPayload(),
      sources_total: sourceDetails.length,
      sources_completed: sourceDetails.length,
      generated: diagnostics.generated,
      source_matches: diagnostics.source_matches,
      unique_candidates: diagnostics.unique_candidates,
      verify_total: candidates.length,
      verified: diagnostics.verify_attempted,
      eligible: eligible.length,
      enriched: enrichTargets.length,
      seo_total: enrichTargets.length,
      result_count: results.length,
      candidates_found: diagnostics.unique_candidates,
      candidate_matches: diagnostics.unique_candidates,
      results: results,
      available_results: availableResults,
      available_count: availableResults.length,
      non_actionable: nonActionable,
      non_actionable_count: nonActionable.length,
      query: request.query ? request.query.toDebug() : {},
      strict_min_similarity: STRICT_MIN_SIMILARITY,
      min_similarity: MIN_SIMILARITY,
      source_counts: sourceCounts,
      source_details: sourceDetails,
      diagnostics: diagnostics,
      rejections: rejections.rows(),
      gemini: geminiDelta,
      weights: {
        similarity: _pyRound(weights.similarity, 4),
        lifecycle: _pyRound(weights.lifecycle, 4),
        seo: _pyRound(weights.seo, 4),
      },
      tlds: request.tldList(),
      no_sources_configured: false,
      cache_hit: false,
      cache_key: cacheKey,
      cache_expires_at: _cacheExpiry(),
      duration_ms: durationMs,
      message: summary,
      stage_label: summary,
    };

    storage.setKeywordCache(
      cacheKey,
      request.toPayload(),
      response,
      _iso(),
      response.cache_expires_at
    );
    storage.addKeywordHistory(request.keyword, request.toPayload(), results.length);
    state.update({ ...response, phase: "done", history: storage.listKeywordHistory(8) });
    state.finish();
    _debug(
      "search completed keyword=%s results=%d duration=%.1fs",
      request.keyword,
      results.length,
      durationMs / 1000
    );
  } catch (exc) {
    console.error(`Similar domain discovery ${runId} failed`, exc);
    state.update({ diagnostics: diagnostics, rejections: rejections.rows() });
    state.finish(exc && exc.message ? exc.message : String(exc));
  }
  return state.snapshot();
}

// Back-compat alias.
const runKeywordDiscovery = runSimilarDomainDiscovery;

function startSimilarDomainDiscovery(payload) {
  if (STATE.isRunning()) {
    return { started: false, reason: "A discovery run is already running", ...snapshot() };
  }

  const request = SimilarDomainRequest.fromPayload(payload);
  const runId = crypto.randomBytes(6).toString("hex");
  STATE.begin(runId, request);
  // Kick off the background run without awaiting, mirroring the Python's
  // begin-before-thread pattern. A rejection is swallowed inside
  // runSimilarDomainDiscovery, which records the error onto STATE.
  runSimilarDomainDiscovery(request, { runId }).catch((exc) => {
    console.error("similar-domain-discovery run crashed", exc);
    STATE.finish(exc && exc.message ? exc.message : String(exc));
  });
  return { started: true, ...snapshot() };
}

const startKeywordDiscovery = startSimilarDomainDiscovery;

const EXPORT_FIELDS = [
  ["rank", "Rank"],
  ["domain", "Domain"],
  ["similarity_score", "Similarity"],
  ["match_level_label", "Match Level"],
  ["category", "Lifecycle"],
  ["expiration_date", "Expiry"],
  ["days_left", "Days Left"],
  ["referring_domains", "RD"],
  ["total_backlinks", "Backlinks"],
  ["spam_risk_level", "Spam Risk"],
  ["seo_score", "SEO Score"],
  ["verification_source", "Verified By"],
  ["final_rank_score", "Final Score"],
];

const KEYWORD_EXPORT_FIELDS = EXPORT_FIELDS;

function _csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function exportResults(cacheKey, fmt = "csv") {
  const cached = storage.getKeywordCache(cacheKey);
  if (!cached) throw new Error("Discovery cache not found");
  const results = [...((cached.response || {}).results || [])];
  const header = EXPORT_FIELDS.map(([, label]) => label);
  const body = results.map((row) =>
    EXPORT_FIELDS.map(([key]) => (row[key] === null || row[key] === undefined ? "" : row[key]))
  );

  if (fmt === "xlsx") {
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Similar Domains");
    sheet.addRow(header);
    for (const row of body) sheet.addRow(row);
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  }

  const lines = [];
  lines.push(header.map(_csvField).join(","));
  for (const row of body) lines.push(row.map(_csvField).join(","));
  return lines.map((line) => line + "\r\n").join("");
}

module.exports = {
  // Constants
  SEARCH_MODES,
  DEFAULT_SEARCH_MODE,
  LEGACY_MATCH_TYPES,
  EXPIRY_WINDOWS,
  DEFAULT_EXPIRY_WINDOW,
  DEFAULT_CACHE_HOURS,
  INTERESTING_CATEGORIES,
  LIFECYCLE_FILTERS,
  LIFECYCLE_SCORE,
  LIFECYCLE_BUCKETS,
  SOURCE_LABELS,
  MAX_REJECTION_ROWS,
  SEO_ENRICH_LIMIT,
  CACHE_HOURS,
  MIN_SIMILARITY,
  STRICT_MIN_SIMILARITY,
  MATCH_LEVELS,
  MATCH_LEVEL_RANK,
  MATCH_LEVEL_LABELS,
  ACTIONABLE_BUCKETS,
  NON_ACTIONABLE_REASONS,
  EXPORT_FIELDS,
  KEYWORD_EXPORT_FIELDS,
  // Helpers / classes
  parseQuery,
  normalizeKeyword,
  matchLevelOf,
  lifecycleScore,
  finalRankScore,
  SimilarDomainRequest,
  KeywordDiscoveryRequest,
  SimilarDomainState,
  KeywordDiscoveryState,
  STATE,
  // Public API (server-facing)
  snapshot,
  history,
  startSimilarDomainDiscovery,
  startKeywordDiscovery,
  runSimilarDomainDiscovery,
  runKeywordDiscovery,
  exportResults,
};
