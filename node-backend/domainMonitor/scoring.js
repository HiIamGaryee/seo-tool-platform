"use strict";

// Faithful Node port of backend/domain_monitor/scoring.py
const configLoader = require("./configLoader");
const { registrableName } = require("./models");

const LABEL_EXCELLENT = "Excellent";
const LABEL_STRONG = "Strong";
const LABEL_GOOD = "Good";
const LABEL_REVIEW = "Review";
const LABEL_WEAK = "Weak";

const CONFIDENCE_FULL = "Full";
const CONFIDENCE_PARTIAL = "Partial";
const CONFIDENCE_LIMITED = "Limited";

// --- number formatting mirrors Python f-string specs ---------------------
function _comma(n) {
  return Number(n).toLocaleString("en-US");
}
function _g(n) {
  return Number(n).toString();
}
function _fixed0(n) {
  return String(Math.round(n));
}
function _fixed1(n) {
  return Number(n).toFixed(1);
}

// Python round() uses banker's rounding (round-half-to-even).
function _pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
function _round1(x) {
  return Math.round(x * 10) / 10;
}

// --- metrics/history helpers (derive from snake_case fields defensively) --
function _metricsHasData(m) {
  if (typeof m.has_data === "boolean") return m.has_data;
  return Boolean(m.queried) && m.referring_domains !== null && m.referring_domains !== undefined;
}
function _followPercentage(m) {
  if (typeof m.follow_percentage === "number") return m.follow_percentage;
  if (m.follow_percentage === null) return null;
  if (m.follow_backlinks === null || m.follow_backlinks === undefined || !m.total_backlinks) {
    return null;
  }
  return _round1((m.follow_backlinks / m.total_backlinks) * 100);
}
function _historyHasData(h) {
  if (typeof h.has_data === "boolean") return h.has_data;
  return Boolean(h.queried) && Boolean(h.snapshot_count);
}

/** One weighted contributor to the SEO Opportunity Score. */
function _component({ key, label, weight, awarded = null, detail = "", available = true }) {
  return { key, label, weight, awarded, detail, available };
}

function _ratio(component) {
  if (component.awarded === null || component.awarded === undefined || !component.weight) {
    return null;
  }
  return component.awarded / component.weight;
}

/** Piecewise-linear lookup: bands are [threshold, ratio] pairs, ascending. */
function _bandRatio(value, bands) {
  if (value === null || value === undefined || !bands || bands.length === 0) return null;
  const ordered = bands
    .map(([t, r]) => [parseFloat(t), parseFloat(r)])
    .sort((a, b) => a[0] - b[0]);
  if (value <= ordered[0][0]) return ordered[0][1];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [lowT, lowR] = ordered[i];
    const [highT, highR] = ordered[i + 1];
    if (value <= highT) {
      const span = highT - lowT;
      if (span <= 0) return highR;
      return lowR + (highR - lowR) * ((value - lowT) / span);
    }
  }
  return ordered[ordered.length - 1][1];
}

function labelFor(score) {
  const labels = configLoader.scoring().seo_score_labels || {};
  if (score >= parseInt(labels.excellent_min ?? 90, 10)) return LABEL_EXCELLENT;
  if (score >= parseInt(labels.strong_min ?? 80, 10)) return LABEL_STRONG;
  if (score >= parseInt(labels.good_min ?? 70, 10)) return LABEL_GOOD;
  if (score >= parseInt(labels.review_min ?? 60, 10)) return LABEL_REVIEW;
  return LABEL_WEAK;
}

/** Structural readability of the name. Says nothing about resale value. */
function domainQualityRatio(domain) {
  const cfg = configLoader.scoring().domain_quality || {};
  const name = registrableName(domain);
  const tld = "." + domain.split(".").pop();
  const notes = [];
  let ratio = 1.0;

  const ideal = parseInt(cfg.length_ideal_max ?? 12, 10);
  const poor = parseInt(cfg.length_poor_min ?? 22, 10);
  if (name.length <= ideal) {
    notes.push(`short name (${name.length} characters)`);
  } else if (name.length >= poor) {
    ratio -= 0.35;
    notes.push(`long name (${name.length} characters)`);
  } else {
    ratio -= 0.15;
  }

  const hyphens = (name.match(/-/g) || []).length;
  if (hyphens) {
    ratio -= parseFloat(cfg.hyphen_penalty ?? 0.3) * Math.min(hyphens, 2);
    notes.push(`${hyphens} hyphen${hyphens > 1 ? "s" : ""}`);
  } else {
    notes.push("no hyphen");
  }

  const digits = (name.match(/[0-9]/g) || []).length;
  if (digits) {
    ratio -= parseFloat(cfg.digit_penalty ?? 0.25);
    notes.push(`${digits} digit${digits > 1 ? "s" : ""}`);
  } else {
    notes.push("no numbers");
  }

  const preferred = cfg.preferred_tlds || [];
  if (preferred.includes(tld)) {
    ratio += parseFloat(cfg.preferred_tld_bonus ?? 0.2);
    notes.push(`preferred TLD ${tld}`);
  }

  if ((domain.match(/\./g) || []).length > 1) {
    ratio -= parseFloat(cfg.subdomain_penalty ?? 0.15);
    notes.push("multi-label host");
  }

  return [Math.max(0.0, Math.min(1.0, ratio)), notes];
}

function _referringDomainComponent(weight, metrics) {
  const cfg = configLoader.scoring().referring_domain_bands || [];
  if (!_metricsHasData(metrics)) {
    return _component({
      key: "referring_domains",
      label: "Referring Domains",
      weight,
      available: false,
      detail: metrics.error || "No backlink provider data",
    });
  }
  const count = metrics.referring_domains;
  const ratio = _bandRatio(count, cfg);
  if (ratio === null) {
    return _component({
      key: "referring_domains",
      label: "Referring Domains",
      weight,
      available: false,
      detail: "Scoring bands are misconfigured",
    });
  }
  return _component({
    key: "referring_domains",
    label: "Referring Domains",
    weight,
    awarded: _round1(ratio * weight),
    detail: `${_comma(count)} referring domains`,
  });
}

function _backlinkQualityComponent(weight, metrics) {
  const cfg = configLoader.scoring().backlink_quality || {};
  if (!_metricsHasData(metrics)) {
    return _component({
      key: "backlink_quality",
      label: "Backlink Quality",
      weight,
      available: false,
      detail: metrics.error || "No backlink provider data",
    });
  }

  const parts = []; // [subRatio, subWeight]
  const notes = [];

  const followPct = _followPercentage(metrics);
  const followWeight = parseFloat(cfg.follow_pct_weight ?? 0.35);
  if (followPct !== null && followPct !== undefined) {
    const low = parseFloat(cfg.follow_pct_ideal_min ?? 40);
    const high = parseFloat(cfg.follow_pct_ideal_max ?? 90);
    let sub;
    if (followPct >= low && followPct <= high) sub = 1.0;
    else if (followPct < low) sub = Math.max(0.0, followPct / low);
    else sub = Math.max(0.0, 1 - (followPct - high) / (100 - high));
    parts.push([sub, followWeight]);
    notes.push(`${_g(followPct)}% follow`);
  }

  const diversityWeight = parseFloat(cfg.diversity_weight ?? 0.35);
  if (metrics.referring_domains && metrics.total_backlinks) {
    const perDomain = metrics.total_backlinks / metrics.referring_domains;
    const ideal = parseFloat(cfg.diversity_ideal_links_per_domain ?? 25);
    // Fewer links per domain means broader, more natural distribution.
    const sub = perDomain <= ideal ? 1.0 : Math.max(0.0, ideal / perDomain);
    parts.push([sub, diversityWeight]);
    notes.push(`${_fixed1(perDomain)} links per domain`);
  }

  const tldWeight = parseFloat(cfg.tld_spread_weight ?? 0.3);
  if (metrics.top_referring_tlds && metrics.top_referring_tlds.length) {
    const target = parseFloat(cfg.tld_spread_target ?? 6);
    const spread = metrics.top_referring_tlds.length;
    parts.push([Math.min(1.0, spread / target), tldWeight]);
    notes.push(`${spread} referring TLDs`);
  }

  if (parts.length === 0) {
    return _component({
      key: "backlink_quality",
      label: "Backlink Quality",
      weight,
      available: false,
      detail: "Provider returned no quality signals",
    });
  }

  const totalSubWeight = parts.reduce((sum, [, w]) => sum + w, 0);
  const ratio = parts.reduce((sum, [sub, w]) => sum + sub * w, 0) / totalSubWeight;
  return _component({
    key: "backlink_quality",
    label: "Backlink Quality",
    weight,
    awarded: _round1(ratio * weight),
    detail: notes.join(", "),
  });
}

function _historyComponent(weight, history, switchCount) {
  const cfg = configLoader.scoring().historical_stability || {};
  if (!_historyHasData(history)) {
    return _component({
      key: "historical_stability",
      label: "History",
      weight,
      available: false,
      detail: history.error || "No archive history found",
    });
  }

  let ratio = _bandRatio(history.snapshot_count, cfg.snapshot_bands || []);
  if (ratio === null) {
    return _component({
      key: "historical_stability",
      label: "History",
      weight,
      available: false,
      detail: "Scoring bands are misconfigured",
    });
  }
  const notes = [`${_comma(history.snapshot_count)} archive captures`];

  if (switchCount) {
    const penalty = parseFloat(cfg.switch_penalty_per_change ?? 0.25) * switchCount;
    ratio = Math.max(0.0, ratio - penalty);
    notes.push(`${switchCount} topic change${switchCount > 1 ? "s" : ""}`);
  } else {
    notes.push("no topic change detected");
  }

  return _component({
    key: "historical_stability",
    label: "History",
    weight,
    awarded: _round1(ratio * weight),
    detail: notes.join(", "),
  });
}

function _relevanceComponent(weight, relevanceScore, relevanceBand, nichesConfigured) {
  if (!nichesConfigured) {
    return _component({
      key: "topical_relevance",
      label: "Topical Relevance",
      weight,
      available: false,
      detail: "No target niches configured",
    });
  }
  if (relevanceScore === null || relevanceScore === undefined) {
    return _component({
      key: "topical_relevance",
      label: "Topical Relevance",
      weight,
      available: false,
      detail: "No historical text to match against",
    });
  }

  const cap = parseInt((configLoader.scoring().topical_relevance || {}).score_cap ?? 40, 10);
  const ratio = cap ? Math.min(1.0, relevanceScore / cap) : 0.0;
  return _component({
    key: "topical_relevance",
    label: "Topical Relevance",
    weight,
    awarded: _round1(ratio * weight),
    detail: `${relevanceBand} relevance (${relevanceScore}/${cap} keyword points)`,
  });
}

function _ageComponent(weight, ageYears) {
  if (ageYears === null || ageYears === undefined) {
    return _component({
      key: "domain_age",
      label: "Domain Age",
      weight,
      available: false,
      detail: "No registry creation date published",
    });
  }
  const ratio = _bandRatio(ageYears, (configLoader.scoring().domain_age || {}).bands || []);
  if (ratio === null) {
    return _component({
      key: "domain_age",
      label: "Domain Age",
      weight,
      available: false,
      detail: "Scoring bands are misconfigured",
    });
  }
  return _component({
    key: "domain_age",
    label: "Domain Age",
    weight,
    awarded: _round1(ratio * weight),
    detail: `${_fixed0(ageYears)} year${ageYears >= 2 ? "s" : ""} old`,
  });
}

function _anchorComponent(weight, profile) {
  const cfg = configLoader.scoring().anchor_profile || {};
  if (!profile.has_data) {
    return _component({
      key: "anchor_profile",
      label: "Anchor Profile",
      weight,
      available: false,
      detail: "No anchor data from provider",
    });
  }

  let ratio = 1.0;
  const notes = [];

  const suspiciousZeroAt = parseFloat(cfg.suspicious_pct_zero_at ?? 45);
  if (profile.suspicious_pct !== null && profile.suspicious_pct !== undefined) {
    ratio -= Math.min(1.0, profile.suspicious_pct / suspiciousZeroAt);
    notes.push(`${_g(profile.suspicious_pct)}% suspicious`);
  }

  const genericStart = parseFloat(cfg.generic_pct_penalty_start ?? 35);
  if (
    profile.generic_pct !== null &&
    profile.generic_pct !== undefined &&
    profile.generic_pct > genericStart
  ) {
    ratio -= Math.min(0.3, (profile.generic_pct - genericStart) / 100);
    notes.push(`${_g(profile.generic_pct)}% generic`);
  }

  const exactStart = parseFloat(cfg.exact_match_concentration_penalty_start ?? 30);
  if (
    profile.exact_match_pct !== null &&
    profile.exact_match_pct !== undefined &&
    profile.exact_match_pct > exactStart
  ) {
    ratio -= Math.min(0.3, (profile.exact_match_pct - exactStart) / 100);
    notes.push(`${_g(profile.exact_match_pct)}% exact-match`);
  }

  return _component({
    key: "anchor_profile",
    label: "Anchor Profile",
    weight,
    awarded: _round1(Math.max(0.0, ratio) * weight),
    detail: notes.length ? notes.join(", ") : "clean anchor distribution",
  });
}

function _qualityComponent(weight, domain) {
  const [ratio, notes] = domainQualityRatio(domain);
  return _component({
    key: "domain_quality",
    label: "Domain Quality",
    weight,
    awarded: _round1(ratio * weight),
    detail: notes.join(", "),
  });
}

/**
 * The SEO Opportunity Score. Entirely rule-based and reproducible.
 *
 * Weight from unavailable components is redistributed across the rest, and the
 * result reports how much of the model it was able to use.
 */
function compute({
  domain,
  metrics,
  history,
  anchor_profile,
  spam_assessment,
  switch_count,
  relevance_score,
  relevance_band,
  age_years,
  niches_configured,
} = {}) {
  const weights = configLoader.scoring().weights || {};

  const components = [
    _referringDomainComponent(parseInt(weights.referring_domains ?? 25, 10), metrics),
    _backlinkQualityComponent(parseInt(weights.backlink_quality ?? 20, 10), metrics),
    _historyComponent(parseInt(weights.historical_stability ?? 15, 10), history, switch_count),
    _relevanceComponent(
      parseInt(weights.topical_relevance ?? 15, 10),
      relevance_score,
      relevance_band,
      niches_configured
    ),
    _ageComponent(parseInt(weights.domain_age ?? 10, 10), age_years),
    _anchorComponent(parseInt(weights.anchor_profile ?? 10, 10), anchor_profile),
    _qualityComponent(parseInt(weights.domain_quality ?? 5, 10), domain),
  ];

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const available = components.filter((c) => c.available && c.awarded !== null && c.awarded !== undefined);
  const availableWeight = available.reduce((sum, c) => sum + c.weight, 0);

  const result = {
    base_score: null,
    spam_penalty: 0,
    final_score: null,
    label: null,
    components,
    reasons: [],
    concerns: [],
    available_weight: availableWeight,
    total_weight: totalWeight,
    confidence: null,
    unscored_reason: null,
    completeness_pct: totalWeight ? _pyRound((availableWeight / totalWeight) * 100) : null,
  };

  const cfg = configLoader.scoring();
  const floorPct = parseFloat(cfg.minimum_available_weight_pct ?? 35);
  const coveragePct = totalWeight ? (availableWeight / totalWeight) * 100 : 0.0;

  const [reasons, concerns] = _explain(components, spam_assessment);
  result.reasons = reasons;
  result.concerns = concerns;

  if (coveragePct < floorPct) {
    // Renormalising over a sliver of the model would publish a confident
    // number built on almost nothing, so we publish no number at all.
    const missing = components.filter((c) => !c.available).map((c) => c.label);
    result.unscored_reason =
      `Only ${_fixed0(coveragePct)}% of the scoring model had data ` +
      `(minimum ${_fixed0(floorPct)}%). Missing: ${missing.join(", ")}.`;
    return result;
  }

  const earned = available.reduce((sum, c) => sum + (c.awarded || 0), 0);
  result.base_score = _pyRound((earned / availableWeight) * 100);

  const penaltyFactor = parseFloat(cfg.spam_penalty_factor ?? 0.5);
  result.spam_penalty = _pyRound(((spam_assessment.score || 0) * penaltyFactor));
  result.final_score = Math.max(0, result.base_score - result.spam_penalty);
  result.label = labelFor(result.final_score);

  const labels = cfg.completeness_labels || {};
  if (coveragePct >= parseFloat(labels.full_min ?? 95)) result.confidence = CONFIDENCE_FULL;
  else if (coveragePct >= parseFloat(labels.partial_min ?? 60)) result.confidence = CONFIDENCE_PARTIAL;
  else result.confidence = CONFIDENCE_LIMITED;

  return result;
}

/** Deterministic bullet points. Templated from the component details. */
function _explain(components, spamAssessment) {
  const reasons = [];
  const concerns = [];

  for (const component of components) {
    const ratio = _ratio(component);
    if (!component.available || ratio === null) {
      concerns.push(`${component.label}: ${component.detail}`);
      continue;
    }
    if (ratio >= 0.75) reasons.push(`${component.label}: ${component.detail}`);
    else if (ratio <= 0.4) concerns.push(`${component.label}: ${component.detail}`);
  }

  for (const signal of spamAssessment.signals || []) {
    concerns.push(`${signal.label}: ${signal.detail}`);
  }

  return [reasons, concerns];
}

module.exports = {
  LABEL_EXCELLENT,
  LABEL_STRONG,
  LABEL_GOOD,
  LABEL_REVIEW,
  LABEL_WEAK,
  CONFIDENCE_FULL,
  CONFIDENCE_PARTIAL,
  CONFIDENCE_LIMITED,
  labelFor,
  domainQualityRatio,
  compute,
};
