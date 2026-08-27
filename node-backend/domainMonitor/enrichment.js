"use strict";

// Faithful Node port of backend/domain_monitor/enrichment.py
const anchors = require("./anchors");
const backlinks = require("./backlinks");
const configLoader = require("./configLoader");
const historyClient = require("./historyClient");
const scoring = require("./scoring");
const spam = require("./spam");
const storage = require("./storage");
const topics = require("./topics");
const { normalizeDomain } = require("./models");
const { runPool } = require("./pool");

function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isNaN(v) ? def : v;
}

// Each external SEO source keeps its own TTL rather than sharing RDAP's.
const BACKLINK_TTL_HOURS = _envInt("DOMAIN_MONITOR_BACKLINK_TTL_HOURS", 168);
const HISTORY_TTL_DAYS = _envInt("DOMAIN_MONITOR_HISTORY_TTL_DAYS", 14);
const ENRICH_WORKERS = Math.max(1, Math.min(_envInt("DOMAIN_MONITOR_ENRICH_CONCURRENCY", 6), 16));
const ENRICH_BATCH_SIZE = Math.max(1, _envInt("DOMAIN_MONITOR_ENRICH_BATCH", 20));

function _now() {
  return new Date();
}

function _iso() {
  return storage.nowIso();
}

function _ageYears(registrationDate) {
  if (!registrationDate) return null;
  const created = new Date(String(registrationDate).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(created.getTime())) return null;
  const days = (_now().getTime() - created.getTime()) / 86400000;
  return Math.max(0.0, days / 365.25);
}

function _stale(stamp, maxAgeDays) {
  if (!stamp) return true;
  let checked = new Date(stamp);
  if (Number.isNaN(checked.getTime())) return true;
  return (_now().getTime() - checked.getTime()) / 1000 > maxAgeDays * 86400;
}

class EnrichmentState {
  constructor() {
    this._state = EnrichmentState._idle();
  }

  static _idle() {
    return {
      run_id: null,
      status: "idle",
      phase: "idle",
      checked: 0,
      total: 0,
      with_backlinks: 0,
      with_history: 0,
      scored: 0,
      unscored: 0,
      high_opportunity: 0,
      high_spam: 0,
      failed: 0,
      provider: null,
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

  begin(runId, provider) {
    this._state = EnrichmentState._idle();
    Object.assign(this._state, {
      run_id: runId,
      status: "running",
      phase: "enriching",
      provider,
      started_at: _iso(),
    });
  }

  update(fields) {
    Object.assign(this._state, fields);
  }

  bump(result) {
    const state = this._state;
    state.checked += 1;
    if (result.referring_domains !== null && result.referring_domains !== undefined)
      state.with_backlinks += 1;
    if (result.snapshot_count !== null && result.snapshot_count !== undefined)
      state.with_history += 1;
    if (result.seo_score !== null && result.seo_score !== undefined) {
      state.scored += 1;
      if (result.seo_score >= 80) state.high_opportunity += 1;
    } else {
      state.unscored += 1;
    }
    if (result.spam_risk_level === "High" || result.spam_risk_level === "Very High")
      state.high_spam += 1;
  }

  fail() {
    this._state.checked += 1;
    this._state.failed += 1;
  }

  finish(error = null) {
    Object.assign(this._state, {
      status: error ? "error" : "completed",
      phase: error ? "error" : "done",
      finished_at: _iso(),
      error,
    });
  }
}

const ENRICHMENT = new EnrichmentState();

function _nicheKeywordSet(niches) {
  const configured = configLoader.topics();
  const words = new Set();
  for (const niche of niches) {
    for (const keyword of configured[niche] || []) {
      for (const w of keyword.toLowerCase().split(/\s+/)) if (w) words.add(w);
    }
  }
  return words;
}

async function enrichDomain(domain, registrationDate, history, provider, niches, stamps, force) {
  stamps = stamps || {};
  const payload = {};
  let snapshotRows = [];

  // --- archive history ---
  let historyResult = new historyClient.HistoryResult({ queried: false });
  const reuseHistory = !force && !_stale(stamps.last_history_checked, HISTORY_TTL_DAYS);
  if (reuseHistory) {
    snapshotRows = storage.getSnapshots(domain);
    const stored = storage.getDomain(domain) || {};
    historyResult = new historyClient.HistoryResult({
      queried: stored.snapshot_count !== null && stored.snapshot_count !== undefined,
      snapshot_count: stored.snapshot_count,
      first_seen: stored.first_archive_seen,
      last_seen: stored.last_archive_seen,
    });
  } else {
    try {
      historyResult = await history.lookup(domain);
    } catch (exc) {
      historyResult = new historyClient.HistoryResult({ queried: true, error: String(exc) });
    }
    payload.first_archive_seen = historyResult.first_seen;
    payload.last_archive_seen = historyResult.last_seen;
    payload.snapshot_count = historyResult.snapshot_count;
    payload.snapshot_count_truncated = historyResult.snapshot_count_truncated ? 1 : 0;
    payload.archive_error = historyResult.error;
    payload.last_history_checked = _iso();
    snapshotRows = (historyResult.snapshots || []).map((s) => ({
      year: s.year,
      timestamp: s.timestamp,
      title: s.title,
      meta_description: s.meta_description,
      language: s.language,
      is_redirect: s.is_redirect,
    }));
  }

  const timeline = topics.topicTimeline(snapshotRows);
  snapshotRows.forEach((row, i) => {
    row.topic = timeline[i] ? timeline[i].topic : undefined;
  });
  const switchCount = snapshotRows.length ? topics.countTopicSwitches(timeline) : null;

  // --- backlink provider ---
  let metrics;
  const reuseBacklinks = !force && !_stale(stamps.last_backlink_checked, BACKLINK_TTL_HOURS / 24.0);
  if (reuseBacklinks) {
    const stored = storage.getDomain(domain) || {};
    const anchorCounts =
      (stored.top_anchors || []).map((a) => ({ anchor: a.text, count: a.count }));
    metrics = new backlinks.BacklinkMetrics({
      provider: stored.backlink_provider || "cache",
      queried: stored.referring_domains !== null && stored.referring_domains !== undefined,
      referring_domains: stored.referring_domains,
      total_backlinks: stored.total_backlinks,
      follow_backlinks: stored.follow_backlinks,
      nofollow_backlinks: stored.nofollow_backlinks,
      lost_backlinks: stored.lost_backlinks,
      new_backlinks: stored.new_backlinks,
      top_referring_domains: stored.top_referring_domains || [],
      top_referring_tlds: stored.top_referring_tlds || [],
      anchor_counts: anchorCounts.length ? anchorCounts : null,
      error: stored.backlink_error,
    });
  } else {
    try {
      metrics = await provider.getDomainMetrics(domain);
    } catch (exc) {
      metrics = new backlinks.BacklinkMetrics({
        provider: provider.name || "unknown",
        queried: true,
        error: String(exc),
      });
    }
    payload.backlink_provider = metrics.provider;
    payload.backlink_error = metrics.error;
    payload.referring_domains = metrics.referring_domains;
    payload.total_backlinks = metrics.total_backlinks;
    payload.follow_backlinks = metrics.follow_backlinks;
    payload.nofollow_backlinks = metrics.nofollow_backlinks;
    payload.lost_backlinks = metrics.lost_backlinks;
    payload.new_backlinks = metrics.new_backlinks;
    payload.top_referring_domains = metrics.top_referring_domains;
    payload.top_referring_tlds = metrics.top_referring_tlds;
    payload.last_backlink_checked = _iso();
  }

  // --- derived analysis ---
  const nicheWords = _nicheKeywordSet(niches);
  const spamWords = spam.spamKeywordSet();

  const anchorProfile = anchors.buildProfile(metrics.anchor_counts, domain, spamWords, nicheWords);

  const evidence = new topics.TextEvidence({
    titles: snapshotRows.filter((s) => s.title).map((s) => s.title),
    metas: snapshotRows.filter((s) => s.meta_description).map((s) => s.meta_description),
    urls: [domain],
    anchors: anchorProfile.top_anchors.map((a) => a.text),
  });

  const topicResult = topics.classify(evidence);
  const [relevanceScore, relevanceBand] = topics.relevance(evidence, niches);

  const spamAssessment = spam.assess({
    domain,
    evidence,
    anchor_profile: anchorProfile,
    topic_switch_count: switchCount,
    referring_domains: metrics.referring_domains,
    new_backlinks: metrics.new_backlinks,
    lost_backlinks: metrics.lost_backlinks,
    total_backlinks: metrics.total_backlinks,
  });

  const age = _ageYears(registrationDate);

  const score = scoring.compute({
    domain,
    metrics,
    history: historyResult,
    anchor_profile: anchorProfile,
    spam_assessment: spamAssessment,
    switch_count: switchCount,
    relevance_score: relevanceScore,
    relevance_band: relevanceBand,
    age_years: age,
    niches_configured: Boolean(niches && niches.length),
  });

  Object.assign(payload, {
    domain_age_years: age,
    anchor_total: anchorProfile.total,
    branded_pct: anchorProfile.branded_pct,
    generic_pct: anchorProfile.generic_pct,
    exact_match_pct: anchorProfile.exact_match_pct,
    suspicious_anchor_pct: anchorProfile.suspicious_pct,
    top_anchors: anchorProfile.top_anchors.map((a) => ({
      text: a.text,
      count: a.count,
      share_pct: a.share_pct,
      kind: a.kind,
    })),
    primary_topic: topicResult.primary_topic,
    secondary_topics: topicResult.secondary_topics,
    topic_match_count: topicResult.topic_match_count || null,
    topic_match_strength: topicResult.has_data ? topicResult.match_strength : null,
    historical_topic: topics.dominantTopic(timeline),
    topic_switch_count: switchCount,
    historical_stability:
      switchCount !== null && switchCount !== undefined ? topics.stabilityLabel(switchCount) : null,
    relevance_score: relevanceScore,
    relevance_band: relevanceScore !== null && relevanceScore !== undefined ? relevanceBand : null,
    spam_risk_score: spamAssessment.score,
    spam_risk_level: spamAssessment.level,
    spam_signals: spamAssessment.signals.map((s) => ({ ...s })),
    spam_categories: spamAssessment.detected_categories,
    seo_base_score: score.base_score,
    spam_penalty: score.spam_penalty,
    seo_score: score.final_score,
    seo_label: score.label,
    seo_confidence: score.confidence,
    seo_coverage_pct: score.completeness_pct,
    seo_unscored_reason: score.unscored_reason,
    score_components: score.components.map((c) => ({ ...c })),
    score_reasons: score.reasons,
    score_concerns: score.concerns,
  });

  payload._snapshots = snapshotRows;
  payload._refreshed_history = !reuseHistory;
  return payload;
}

function persist(domain, payload) {
  const snapshots = payload._snapshots || [];
  const refreshedHistory = payload._refreshed_history || false;
  delete payload._snapshots;
  delete payload._refreshed_history;

  storage.saveEnrichment(domain, payload);
  if (refreshedHistory) storage.replaceSnapshots(domain, snapshots);
  storage.recordMetricHistory(domain, {
    referring_domains: payload.referring_domains,
    total_backlinks: payload.total_backlinks,
    spam_risk_score: payload.spam_risk_score,
    seo_score: payload.seo_score,
  });
}

async function runEnrichment(opts = {}) {
  const { domains = null, force = false, limit = null, include_safe = false } = opts;
  let { run_id = null, state = ENRICHMENT } = opts;

  const provider = backlinks.buildProvider();
  const providerName = provider.name || "unknown";

  if (run_id === null) {
    run_id = randomId();
    state.begin(run_id, providerName);
  } else {
    state.update({ provider: providerName });
  }

  const history = new historyClient.HistoryClient({ pool_size: ENRICH_WORKERS });

  try {
    storage.migrate();
    const niches = storage.targetNiches();

    const explicit = new Set(
      (domains || []).map((x) => normalizeDomain(x)).filter((d) => d)
    );
    let pending;
    if (explicit.size) {
      pending = storage.allDomains().filter((row) => explicit.has(row.domain));
      pending = pending.map((row) => ({ ...row, ...(storage.getDomain(row.domain) || {}) }));
    } else {
      // undefined => interesting categories only; [] => no restriction.
      const categories = include_safe ? [] : undefined;
      pending = storage.domainsNeedingEnrichmentScoped(
        force ? 0 : BACKLINK_TTL_HOURS,
        force ? 0 : HISTORY_TTL_DAYS,
        limit,
        categories
      );
    }
    if (limit) pending = pending.slice(0, parseInt(limit, 10));

    state.update({ total: pending.length });
    if (!pending.length) {
      state.finish();
      return state.snapshot();
    }

    let batch = [];
    await runPool(
      pending,
      (row) =>
        enrichDomain(
          row.domain,
          row.registration_date,
          history,
          provider,
          niches,
          row,
          force
        ),
      ENRICH_WORKERS,
      async (payload, row) => {
        state.bump(payload);
        batch.push([row.domain, payload]);
        if (batch.length >= ENRICH_BATCH_SIZE) {
          for (const [name, data] of batch) persist(name, data);
          batch = [];
        }
      },
      (_err) => {
        state.fail();
      }
    );

    for (const [name, data] of batch) persist(name, data);

    state.finish();
  } catch (exc) {
    state.finish(String((exc && exc.message) || exc));
  } finally {
    history.close();
    if (typeof provider.close === "function") provider.close();
  }

  return state.snapshot();
}

function startEnrichmentAsync(kwargs = {}) {
  if (ENRICHMENT.isRunning()) {
    return {
      started: false,
      reason: "An enrichment pass is already running",
      ...ENRICHMENT.snapshot(),
    };
  }

  const runId = randomId();
  ENRICHMENT.begin(runId, backlinks.configuredProviderName() || "none");
  // Fire-and-forget background run (mirrors the Python daemon thread).
  runEnrichment({ ...kwargs, run_id: runId }).catch((exc) => {
    ENRICHMENT.finish(String((exc && exc.message) || exc));
  });
  return { started: true, ...ENRICHMENT.snapshot() };
}

function dataSources() {
  const provider = backlinks.providerStatus();
  return [
    {
      key: "rdap",
      label: "RDAP",
      status: "Connected",
      available: true,
      detail: "IANA bootstrap registry",
    },
    {
      key: "wayback",
      label: "Wayback Machine",
      status: historyClient.ENABLED ? "Available" : "Disabled",
      available: historyClient.ENABLED,
      detail: `CDX index, ${historyClient.SNAPSHOT_SAMPLE_SIZE} snapshots sampled per domain`,
    },
    {
      key: "backlinks",
      label: "Backlink Provider",
      status: provider.configured
        ? titleCase(provider.provider || "")
        : "Not Configured",
      available: provider.configured,
      detail: provider.reason || `Provider: ${provider.provider}`,
    },
  ];
}

function titleCase(s) {
  return String(s).replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function randomId() {
  // 12 hex chars, like uuid4().hex[:12]
  return require("crypto").randomBytes(6).toString("hex");
}

module.exports = {
  BACKLINK_TTL_HOURS,
  HISTORY_TTL_DAYS,
  ENRICH_WORKERS,
  ENRICH_BATCH_SIZE,
  EnrichmentState,
  ENRICHMENT,
  enrichDomain,
  persist,
  runEnrichment,
  startEnrichmentAsync,
  dataSources,
};
