"use strict";

// Faithful Node port of backend/domain_monitor/anchors.py
const configLoader = require("./configLoader");
const { registrableName } = require("./models");
const { normalizeText } = require("./topics");

const _WORD = /[a-z0-9]+/g;

const BRANDED = "branded";
const GENERIC = "generic";
const EXACT_MATCH = "exact_match";
const OTHER = "other";

function _words(text) {
  return new Set(text.match(_WORD) || []);
}

function _round1(value) {
  return Math.round(value * 10) / 10;
}

/** Tokens that count as the domain's own brand name. */
function _brandTokens(domain) {
  const name = registrableName(domain);
  const tokens = new Set();
  for (const t of name.toLowerCase().match(_WORD) || []) {
    if (t.length > 2) tokens.add(t);
  }
  tokens.add(name.toLowerCase().replace(/-/g, ""));
  const out = new Set();
  for (const t of tokens) if (t) out.add(t);
  return out;
}

function _intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Bucket one anchor. Order matters: brand wins, then generic, then exact. */
function classifyAnchor(text, domain, nicheKeywords) {
  const normalized = normalizeText(text);
  if (!normalized) return OTHER;

  const brand = _brandTokens(domain);
  const words = _words(normalized);
  const squashed = normalized.replace(/ /g, "");
  const brandSquashed = registrableName(domain).toLowerCase().replace(/-/g, "");

  // "travel hub" is the brand of travelhub.com, so compare de-spaced forms too.
  if (
    _intersects(words, brand) ||
    squashed === brandSquashed ||
    squashed.includes(brandSquashed)
  ) {
    return BRANDED;
  }

  const generics = new Set(
    configLoader.genericAnchors().map((g) => normalizeText(g))
  );
  if (generics.has(normalized)) return GENERIC;

  // "Exact match" means a commercial keyword anchor with no brand token.
  if (nicheKeywords && nicheKeywords.size && _intersects(words, nicheKeywords)) {
    return EXACT_MATCH;
  }

  return OTHER;
}

/**
 * Turn provider anchor rows into a profile.
 *
 * `anchorCounts` is a list of {anchor, count} from the backlink provider.
 * null means the provider was not configured or returned nothing; that is
 * different from an empty anchor list.
 */
function buildProfile(anchorCounts, domain, spamKeywords = null, nicheKeywords = null, topN = 10) {
  if (anchorCounts === null || anchorCounts === undefined) {
    return _profile({});
  }

  let rows = anchorCounts
    .filter((row) => row && row.anchor)
    .map((row) => [
      String(row.anchor || "").trim(),
      Math.trunc(Number(row.count) || 0),
    ]);
  rows = rows.filter(([, count]) => count > 0);
  if (rows.length === 0) return _profile({ total: 0 });

  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const niche = nicheKeywords || new Set();
  const spam = spamKeywords || new Set();

  const buckets = { [BRANDED]: 0, [GENERIC]: 0, [EXACT_MATCH]: 0, [OTHER]: 0 };
  let suspicious = 0;
  const anchors = [];

  const ordered = [...rows].sort((a, b) => b[1] - a[1]);
  for (const [text, count] of ordered) {
    const kind = classifyAnchor(text, domain, niche);
    buckets[kind] += count;
    const words = _words(normalizeText(text));
    if (_intersects(words, spam)) suspicious += count;
    if (anchors.length < topN) {
      anchors.push({
        text,
        count,
        share_pct: _round1((count / total) * 100),
        kind,
      });
    }
  }

  const pct = (value) => _round1((value / total) * 100);

  return _profile({
    total,
    top_anchors: anchors,
    branded_pct: pct(buckets[BRANDED]),
    generic_pct: pct(buckets[GENERIC]),
    exact_match_pct: pct(buckets[EXACT_MATCH]),
    suspicious_pct: pct(suspicious),
    top_share_pct: anchors.length ? anchors[0].share_pct : null,
  });
}

/**
 * Build an AnchorProfile-shaped plain object. Every field stays null when the
 * provider gave us nothing, so the UI can print an em dash instead of a zero.
 */
function _profile(fields) {
  const total = fields.total ?? null;
  return {
    total,
    top_anchors: fields.top_anchors ?? [],
    branded_pct: fields.branded_pct ?? null,
    generic_pct: fields.generic_pct ?? null,
    exact_match_pct: fields.exact_match_pct ?? null,
    suspicious_pct: fields.suspicious_pct ?? null,
    top_share_pct: fields.top_share_pct ?? null,
    has_data: total !== null && total > 0,
  };
}

module.exports = {
  BRANDED,
  GENERIC,
  EXACT_MATCH,
  OTHER,
  classifyAnchor,
  buildProfile,
};
