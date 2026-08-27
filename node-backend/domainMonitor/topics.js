"use strict";

// Faithful Node port of backend/domain_monitor/topics.py
const configLoader = require("./configLoader");

// Rule match strength bands. Deliberately not called "confidence" — there is no
// model here, only counted keyword hits.
const STRENGTH_HIGH = "High";
const STRENGTH_MEDIUM = "Medium";
const STRENGTH_LOW = "Low";
const STRENGTH_NONE = "None";

const RELEVANCE_HIGH = "High";
const RELEVANCE_MEDIUM = "Medium";
const RELEVANCE_LOW = "Low";
const RELEVANCE_NONE = "None";

const _WORD_SPLIT = /[^a-z0-9]+/;
const _patternCache = new Map();

function _escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary matcher for one keyword or phrase. */
function _pattern(keyword) {
  let cached = _patternCache.get(keyword);
  if (cached === undefined) {
    cached = new RegExp(
      `(?<![a-z0-9])${_escapeRegex(keyword.toLowerCase())}(?![a-z0-9])`,
      "g"
    );
    _patternCache.set(keyword, cached);
  }
  return cached;
}

/** Lowercase and flatten separators so URLs and titles match the same way. */
function normalizeText(value) {
  if (!value) return "";
  return String(value).toLowerCase().split(_WORD_SPLIT).join(" ").trim();
}

/** Total keyword occurrences in one text field. */
function countHits(text, keywords) {
  const haystack = normalizeText(text);
  if (!haystack) return 0;
  let total = 0;
  for (const kw of keywords) {
    const re = _pattern(kw);
    re.lastIndex = 0;
    const matches = haystack.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

/** Which text fields produced hits for one topic, and how many. */
class TopicSignal {
  constructor(topic) {
    this.topic = topic;
    this.title_hits = 0;
    this.meta_hits = 0;
    this.anchor_hits = 0;
    this.url_hits = 0;
  }

  get total() {
    return this.title_hits + this.meta_hits + this.anchor_hits + this.url_hits;
  }
}

/** Everything the topic and spam rules are allowed to read. */
class TextEvidence {
  constructor({ titles = [], metas = [], urls = [], anchors = [] } = {}) {
    this.titles = titles;
    this.metas = metas;
    this.urls = urls;
    this.anchors = anchors;
  }

  get is_empty() {
    return !(
      this.titles.length ||
      this.metas.length ||
      this.urls.length ||
      this.anchors.length
    );
  }

  joined() {
    return [...this.titles, ...this.metas, ...this.urls, ...this.anchors].join(
      " "
    );
  }
}

/**
 * Editorial topics, optionally widened with the spam categories.
 *
 * Spam categories count as topics for timeline and switch detection: a site
 * that turned into a casino really did change topic.
 */
function _topicVocabulary(includeSpam) {
  const vocabulary = { ...configLoader.topics() };
  if (includeSpam) {
    const cats = configLoader.spamCategories();
    for (const [name, spec] of Object.entries(cats)) {
      if (!Object.prototype.hasOwnProperty.call(vocabulary, name)) {
        vocabulary[name] = (spec && spec.keywords) || [];
      }
    }
  }
  return vocabulary;
}

/** Score every configured topic against the collected text evidence. */
function classify(evidence, includeSpam = true) {
  const result = {
    primary_topic: null,
    secondary_topics: [],
    topic_match_count: 0,
    match_strength: STRENGTH_NONE,
    per_topic: {},
    signals: {},
    has_data: false,
  };
  if (evidence.is_empty) return result;

  const configured = _topicVocabulary(includeSpam);
  const signals = {};

  for (const [topic, keywords] of Object.entries(configured)) {
    const signal = new TopicSignal(topic);
    for (const title of evidence.titles) signal.title_hits += countHits(title, keywords);
    for (const meta of evidence.metas) signal.meta_hits += countHits(meta, keywords);
    for (const anchor of evidence.anchors) signal.anchor_hits += countHits(anchor, keywords);
    for (const url of evidence.urls) signal.url_hits += countHits(url, keywords);
    if (signal.total > 0) signals[topic] = signal;
  }

  const signalList = Object.values(signals);
  if (signalList.length === 0) return result;

  const ranked = signalList.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;
  });

  result.signals = signals;
  result.per_topic = {};
  for (const s of ranked) result.per_topic[s.topic] = s.total;
  result.primary_topic = ranked[0].topic;
  result.secondary_topics = ranked.slice(1, 4).map((s) => s.topic);
  result.topic_match_count = ranked[0].total;
  result.has_data = Object.keys(result.per_topic).length > 0;

  const top = ranked[0].total;
  const fieldsHit = [
    ranked[0].title_hits,
    ranked[0].meta_hits,
    ranked[0].anchor_hits,
    ranked[0].url_hits,
  ].filter((v) => v).length;

  // Strength rises with both volume and how many independent fields agree.
  if (top >= 8 && fieldsHit >= 2) result.match_strength = STRENGTH_HIGH;
  else if (top >= 4) result.match_strength = STRENGTH_MEDIUM;
  else result.match_strength = STRENGTH_LOW;

  return result;
}

/**
 * Weighted keyword score for the admin's target niches.
 *
 * Returns [score, band]. Score is null when no niches are configured.
 */
function relevance(evidence, targetNiches) {
  const niches = (targetNiches || []).filter((n) => n);
  if (niches.length === 0) return [null, RELEVANCE_NONE];
  if (evidence.is_empty) return [null, RELEVANCE_NONE];

  const cfg = configLoader.scoring().topical_relevance || {};
  const points = cfg.points || {};
  const cap = parseInt(cfg.score_cap ?? 40, 10);
  const bands = cfg.bands || {};
  const configured = configLoader.topics();

  let score = 0;
  for (const niche of niches) {
    const keywords = configured[niche];
    if (!keywords) continue;
    for (const title of evidence.titles)
      score += countHits(title, keywords) * parseInt(points.title_match ?? 5, 10);
    for (const meta of evidence.metas)
      score += countHits(meta, keywords) * parseInt(points.meta_match ?? 3, 10);
    for (const anchor of evidence.anchors)
      score += countHits(anchor, keywords) * parseInt(points.anchor_match ?? 3, 10);
    for (const url of evidence.urls)
      score += countHits(url, keywords) * parseInt(points.url_match ?? 2, 10);
  }

  score = Math.min(score, cap);

  if (score >= parseInt(bands.high_min ?? 20, 10)) return [score, RELEVANCE_HIGH];
  if (score >= parseInt(bands.medium_min ?? 10, 10)) return [score, RELEVANCE_MEDIUM];
  if (score >= parseInt(bands.low_min ?? 1, 10)) return [score, RELEVANCE_LOW];
  return [score, RELEVANCE_NONE];
}

/** Per-snapshot primary topic, oldest first. Drives the history timeline. */
function topicTimeline(snapshots) {
  const timeline = [];
  const sorted = [...snapshots].sort(
    (a, b) => (a.year || 0) - (b.year || 0)
  );
  for (const snap of sorted) {
    const evidence = new TextEvidence({
      titles: [snap.title || ""],
      metas: [snap.meta_description || ""],
      urls: [snap.url || ""],
    });
    const result = classify(evidence, true);
    timeline.push({
      year: snap.year ?? null,
      timestamp: snap.timestamp ?? null,
      title: snap.title ?? null,
      topic: result.primary_topic,
    });
  }
  return timeline;
}

/**
 * Distinct consecutive topic changes across the timeline.
 *
 * Snapshots with no detectable topic are skipped rather than counted.
 */
function countTopicSwitches(timeline) {
  const seen = timeline.filter((e) => e.topic).map((e) => e.topic);
  if (seen.length < 2) return 0;
  let switches = 0;
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] !== seen[i - 1]) switches += 1;
  }
  return switches;
}

function stabilityLabel(switchCount) {
  const labels =
    (configLoader.scoring().historical_stability || {}).stability_labels || {};
  if (switchCount <= parseInt(labels.stable_max_switches ?? 1, 10)) return "Stable";
  if (switchCount <= parseInt(labels.some_changes_max_switches ?? 3, 10))
    return "Some Changes";
  return "High Topic Volatility";
}

/** Most frequent topic across the archive, used as the historical topic. */
function dominantTopic(timeline) {
  const counts = new Map();
  for (const entry of timeline) {
    if (entry.topic) counts.set(entry.topic, (counts.get(entry.topic) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = -Infinity;
  for (const [topic, count] of counts) {
    if (count > bestCount) {
      best = topic;
      bestCount = count;
    }
  }
  return best;
}

module.exports = {
  STRENGTH_HIGH,
  STRENGTH_MEDIUM,
  STRENGTH_LOW,
  STRENGTH_NONE,
  RELEVANCE_HIGH,
  RELEVANCE_MEDIUM,
  RELEVANCE_LOW,
  RELEVANCE_NONE,
  normalizeText,
  countHits,
  TopicSignal,
  TextEvidence,
  classify,
  relevance,
  topicTimeline,
  countTopicSwitches,
  stabilityLabel,
  dominantTopic,
};
