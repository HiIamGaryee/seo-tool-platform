"use strict";

// Faithful Node port of backend/domain_monitor/spam.py
const configLoader = require("./configLoader");
const { countHits } = require("./topics");

const LEVEL_LOW = "Low";
const LEVEL_MODERATE = "Moderate";
const LEVEL_HIGH = "High";
const LEVEL_VERY_HIGH = "Very High";

// --- number formatting mirrors Python f-string specs ---------------------
function _comma(n) {
  return Number(n).toLocaleString("en-US");
}
// ":g" — general format, strips trailing zeros (25.0 -> "25").
function _g(n) {
  return Number(n).toString();
}
// str(float) after round(_, 1): always one decimal place (25.0 -> "25.0").
function _pct1(n) {
  return Number(n).toFixed(1);
}
// ":.0f"
function _fixed0(n) {
  return String(Math.round(n));
}

function levelFor(score) {
  const levels = (configLoader.scoring().spam_risk || {}).levels || {};
  if (score <= parseInt(levels.low_max ?? 20, 10)) return LEVEL_LOW;
  if (score <= parseInt(levels.moderate_max ?? 45, 10)) return LEVEL_MODERATE;
  if (score <= parseInt(levels.high_max ?? 70, 10)) return LEVEL_HIGH;
  return LEVEL_VERY_HIGH;
}

/** Flat set of every configured spam keyword token, for anchor matching. */
function spamKeywordSet() {
  const words = new Set();
  for (const spec of Object.values(configLoader.spamCategories())) {
    for (const keyword of (spec && spec.keywords) || []) {
      for (const token of keyword.toLowerCase().split(/\s+/)) {
        if (token) words.add(token);
      }
    }
  }
  return words;
}

/**
 * Spam categories present in the domain's history.
 * Returns [category, hitCount, configuredPoints] triples.
 */
function detectCategories(evidence) {
  if (evidence.is_empty) return [];

  const haystack = evidence.joined();
  const found = [];
  for (const [name, spec] of Object.entries(configLoader.spamCategories())) {
    const hits = countHits(haystack, (spec && spec.keywords) || []);
    if (hits > 0) found.push([name, hits, parseInt((spec && spec.points) ?? 10, 10)]);
  }
  found.sort((a, b) => b[2] - a[2]);
  return found;
}

/**
 * Deterministic spam risk. Every point is traceable to one printed rule.
 *
 * Returns an assessment with score null when no input signal was available at
 * all — an unknown history is not a clean history.
 */
function assess({
  domain,
  evidence,
  anchor_profile,
  topic_switch_count,
  referring_domains,
  new_backlinks,
  lost_backlinks,
  total_backlinks,
} = {}) {
  const cfg = configLoader.scoring().spam_risk || {};
  const signals = [];
  const evaluated = [];

  // --- historical spam content -------------------------------------------
  const categories = [];
  if (!evidence.is_empty) {
    evaluated.push("historical_content");
    for (const [name, hits, points] of detectCategories(evidence)) {
      categories.push(name);
      signals.push({
        code: `history_${name.toLowerCase().replace(/ /g, "_")}`,
        label: `Historical ${name} content`,
        detail: `${hits} ${name.toLowerCase()} keyword hit${hits !== 1 ? "s" : ""} in archived titles, meta or anchors`,
        points,
      });
    }
  }

  // --- anchor profile -----------------------------------------------------
  if (anchor_profile.has_data) {
    evaluated.push("anchor_profile");

    const threshold = parseFloat(cfg.suspicious_anchor_pct_threshold ?? 25);
    if (anchor_profile.suspicious_pct !== null && anchor_profile.suspicious_pct >= threshold) {
      signals.push({
        code: "suspicious_anchors",
        label: "Suspicious anchor concentration",
        detail: `${_pct1(anchor_profile.suspicious_pct)}% of anchors contain spam keywords (threshold ${_g(threshold)}%)`,
        points: parseInt(cfg.suspicious_anchor_points ?? 20, 10),
      });
    }

    const exactThreshold = parseFloat(cfg.exact_match_concentration_threshold ?? 35);
    if (anchor_profile.exact_match_pct !== null && anchor_profile.exact_match_pct >= exactThreshold) {
      signals.push({
        code: "exact_match_anchors",
        label: "High exact-match anchor ratio",
        detail: `${_pct1(anchor_profile.exact_match_pct)}% exact-match anchors (threshold ${_g(exactThreshold)}%)`,
        points: parseInt(cfg.exact_match_points ?? 12, 10),
      });
    }
  }

  // --- topic volatility ---------------------------------------------------
  if (topic_switch_count !== null && topic_switch_count !== undefined) {
    evaluated.push("topic_switching");
    const switchThreshold = parseInt(cfg.topic_switch_threshold ?? 3, 10);
    if (topic_switch_count >= switchThreshold) {
      const points = Math.min(
        topic_switch_count * parseInt(cfg.topic_switch_points_each ?? 6, 10),
        parseInt(cfg.topic_switch_points_cap ?? 24, 10)
      );
      signals.push({
        code: "topic_switching",
        label: "Unrelated topic changes",
        detail: `${topic_switch_count} topic changes across the archive (threshold ${switchThreshold})`,
        points,
      });
    }
  }

  // --- backlink shape ----------------------------------------------------
  if (total_backlinks !== null && total_backlinks !== undefined && referring_domains) {
    evaluated.push("backlink_shape");
    const ratio = total_backlinks / referring_domains;
    const spikeRatio = parseFloat(cfg.backlink_spike_ratio ?? 3.0);
    // Many links from very few domains is the classic footprint of a
    // sitewide or network link blast.
    if (ratio >= spikeRatio * 25) {
      signals.push({
        code: "backlink_concentration",
        label: "Abnormal backlink concentration",
        detail: `${_fixed0(ratio)} backlinks per referring domain — links come from very few sources`,
        points: parseInt(cfg.backlink_spike_points ?? 14, 10),
      });
    }
  }

  if (lost_backlinks !== null && lost_backlinks !== undefined && total_backlinks) {
    evaluated.push("backlink_decay");
    const lostRatio = lost_backlinks / Math.max(total_backlinks, 1);
    if (lostRatio >= parseFloat(cfg.lost_backlink_ratio ?? 0.6)) {
      signals.push({
        code: "backlink_decay",
        label: "Heavy backlink loss",
        detail: `${_comma(lost_backlinks)} lost vs ${_comma(total_backlinks)} live backlinks (${_fixed0(lostRatio * 100)}%)`,
        points: parseInt(cfg.lost_backlink_points ?? 8, 10),
      });
    }
  }

  if (evaluated.length === 0) {
    // No history, no anchors, no backlinks: we genuinely cannot say.
    return {
      score: null,
      level: null,
      signals: [],
      detected_categories: [],
      evaluated_rules: [],
      has_data: false,
    };
  }

  const score = Math.min(
    100,
    signals.reduce((sum, s) => sum + s.points, 0)
  );
  return {
    score,
    level: levelFor(score),
    signals,
    detected_categories: categories,
    evaluated_rules: evaluated,
    has_data: true,
  };
}

module.exports = {
  LEVEL_LOW,
  LEVEL_MODERATE,
  LEVEL_HIGH,
  LEVEL_VERY_HIGH,
  levelFor,
  spamKeywordSet,
  detectCategories,
  assess,
};
