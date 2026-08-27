"use strict";

// Faithful Node port of backend/domain_monitor/similar_domains.py

const { normalizeDomain, registrableName, tldOf } = require("./models");

// RapidFuzz/Levenshtein are not available in Node; the plain-JS edit distance
// below is always used. The label is a readable stand-in for the Python
// backend name.
const FUZZY_BACKEND = "js-levenshtein";

// --- centralized configuration ---------------------------------------------
// Every TLD the generator is allowed to try lives here. Nothing downstream
// hardcodes a TLD list.
const DEFAULT_TLDS = [
  ".com",
  ".net",
  ".org",
  ".co",
  ".io",
  ".ai",
  ".tech",
  ".xyz",
  ".online",
  ".site",
  ".info",
];

// Deterministic affixes. Deliberately short lists: the point is a controlled
// pool of plausible names, not thousands of junk permutations.
const PREFIXES = ["my", "get", "go", "try", "the"];
const SUFFIXES = ["group", "hub", "online", "global", "asia", "us", "my", "sg", "tech", "media"];
const HYPHEN_PREFIXES = ["my", "go", "try", "the"];
const HYPHEN_SUFFIXES = ["us", "my", "sg", "online", "group", "global"];
const NUMERIC_SUFFIXES = ["88", "365"];

const VARIATION_KINDS = ["exact", "prefix", "suffix", "hyphen", "numeric"];

const _TLD_CHARS = new Set(".abcdefghijklmnopqrstuvwxyz0123456789-".split(""));

function _env(name, def = "") {
  const raw = process.env[name];
  return String(raw || def).trim();
}

function _envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return def;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return def;
  const value = parseInt(text, 10);
  return Number.isNaN(value) ? def : value;
}

function _envFloat(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return def;
  const text = String(raw).trim();
  if (text === "") return def;
  const value = Number(text);
  return Number.isFinite(value) ? value : def;
}

function _envBool(name, def) {
  const raw = _env(name).toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * Whether verbose discovery diagnostics are on.
 *
 * Read from the environment on every call so the flag can be flipped in a
 * dev .env without editing code paths.
 */
function debugEnabled() {
  return _envBool("DOMAIN_RADAR_DEBUG", false);
}

/** Backend-only switch for dumping full RDAP payloads. Never frontend. */
function rdapVerbose() {
  return _envBool("DOMAIN_RADAR_RDAP_VERBOSE", false);
}

/** Accept `com`, `.com`, `COM ` alike; reject anything that is not a TLD. */
function normalizeTld(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (!value.startsWith(".")) value = `.${value}`;
  if (value.length < 3) return null;
  for (const ch of value) {
    if (!_TLD_CHARS.has(ch)) return null;
  }
  const dotCount = (value.match(/\./g) || []).length;
  if (dotCount > 2 || value.includes("..") || value.endsWith(".")) return null;
  return value;
}

/** The TLD expansion list, from DOMAIN_DISCOVERY_TLDS or the default set. */
function configuredTlds() {
  const raw = _env("DOMAIN_DISCOVERY_TLDS");
  if (!raw) return DEFAULT_TLDS.slice();
  const out = [];
  for (const chunk of raw.split(",")) {
    const tld = normalizeTld(chunk);
    if (tld && !out.includes(tld)) out.push(tld);
  }
  if (out.length === 0) {
    // logger.warning: DOMAIN_DISCOVERY_TLDS held no valid TLDs; using defaults
    return DEFAULT_TLDS.slice();
  }
  return out;
}

class DiscoveryLimits {
  constructor(maxGenerated, maxVerified, resultLimit) {
    this.max_generated = maxGenerated;
    this.max_verified = maxVerified;
    this.result_limit = resultLimit;
  }
}

function limits() {
  return new DiscoveryLimits(
    Math.max(1, _envInt("SIMILAR_DOMAIN_MAX_GENERATED", 300)),
    Math.max(1, _envInt("SIMILAR_DOMAIN_MAX_VERIFIED", 200)),
    Math.max(1, _envInt("SIMILAR_DOMAIN_RESULT_LIMIT", 30))
  );
}

class RankWeights {
  constructor(similarity, lifecycle, seo) {
    this.similarity = similarity;
    this.lifecycle = lifecycle;
    this.seo = seo;
  }
}

/** Ranking weights, configurable and normalised so they always sum to 1. */
function rankWeights() {
  const similarity = Math.max(0.0, _envFloat("SIMILAR_RANK_WEIGHT_SIMILARITY", 0.45));
  const lifecycle = Math.max(0.0, _envFloat("SIMILAR_RANK_WEIGHT_LIFECYCLE", 0.3));
  const seo = Math.max(0.0, _envFloat("SIMILAR_RANK_WEIGHT_SEO", 0.25));
  const total = similarity + lifecycle + seo;
  if (total <= 0) return new RankWeights(0.45, 0.3, 0.25);
  return new RankWeights(similarity / total, lifecycle / total, seo / total);
}

// --- rounding ---------------------------------------------------------------
// Python's round() uses banker's rounding (round-half-to-even); replicate it
// so scores match the reference exactly at .5 boundaries.
function pyRound(value, ndigits = 0) {
  const factor = Math.pow(10, ndigits);
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  const eps = 1e-9;
  if (Math.abs(diff - 0.5) < eps) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

// --- similarity -------------------------------------------------------------

/** Edit distance via plain-JS dynamic programming. */
function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  let previous = [];
  for (let j = 0; j <= right.length; j++) previous.push(j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    const lchar = left[i - 1];
    for (let j = 1; j <= right.length; j++) {
      const rchar = right[j - 1];
      current.push(
        Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (lchar !== rchar ? 1 : 0)
        )
      );
    }
    previous = current;
  }
  return previous[previous.length - 1];
}

// Faithful reimplementation of the ratio produced by Python's
// difflib.SequenceMatcher (2*M / T, where M is the total size of the matching
// blocks found by the recursive longest-match algorithm). Our inputs are short
// domain labels, so difflib's autojunk heuristic (only >200 elements) and junk
// handling never apply.
function _matchingBlocksSize(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    const ch = b[j];
    if (!b2j.has(ch)) b2j.set(ch, []);
    b2j.get(ch).push(j);
  }

  function findLongestMatch(alo, ahi, blo, bhi) {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      const indices = b2j.get(a[i]) || [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // No junk in our alphabet, so only plain extension applies.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  }

  let matches = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k > 0) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return matches;
}

function sequenceRatio(a, b) {
  const length = a.length + b.length;
  if (!length) return 1.0;
  const matches = _matchingBlocksSize(a, b);
  return (2.0 * matches) / length;
}

/** Split one word at letter/digit boundaries: saibo898 -> [saibo, 898]. */
function _digitSplit(word) {
  const out = [];
  let buffer = "";
  let previousDigit = null;
  for (const char of word) {
    const isDigit = /[0-9]/.test(char);
    if (previousDigit !== null && isDigit !== previousDigit && buffer) {
      out.push(buffer);
      buffer = "";
    }
    buffer += char;
    previousDigit = isDigit;
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * Tokens of a second-level domain, at both granularities.
 *
 * Hyphen-separated words come first and are kept whole, so a keyword that
 * contains digits (saibo898) still matches as one token. The letter/digit
 * splits are added as well, so a purely alphabetic keyword (saibo) can still
 * match inside saibo898.
 */
function _tokens(name) {
  const words = name.split("-").filter((word) => word);
  const out = words.slice();
  for (const word of words) {
    const parts = _digitSplit(word);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

class SimilarityBreakdown {
  constructor(fields) {
    this.score = fields.score;
    this.match_kind = fields.match_kind;
    this.second_level = fields.second_level;
    this.tld = fields.tld;
    this.tld_score = fields.tld_score;
    this.length_delta = fields.length_delta;
    this.edit_distance = fields.edit_distance;
    this.ratio = fields.ratio;
    this.token_match = fields.token_match;
  }
}

// Positional base scores. Exact match on the second-level domain is the only
// route to 100.
const _BASE_BY_KIND = {
  exact: 100,
  starts_with: 97,
  ends_with: 92,
  contains: 90,
  fuzzy: 0,
};

// Used only to break ties between equally similar names, never folded into the
// similarity score itself (the TLD is scored separately by design).
const _TLD_SCORE = {
  ".com": 100,
  ".net": 88,
  ".org": 84,
  ".co": 80,
  ".io": 76,
  ".ai": 72,
  ".me": 66,
  ".tech": 62,
  ".online": 58,
  ".site": 54,
  ".info": 52,
  ".xyz": 50,
};

function tldScore(domain) {
  const tld = tldOf(domain);
  return Object.prototype.hasOwnProperty.call(_TLD_SCORE, tld) ? _TLD_SCORE[tld] : 45;
}

function _countDigits(text) {
  let count = 0;
  for (const ch of text) if (ch >= "0" && ch <= "9") count += 1;
  return count;
}

/**
 * Deterministic 0-100 similarity of a domain to a keyword.
 *
 * Scored on the second-level domain only; the TLD is reported separately.
 */
function similarityBreakdown(domain, keyword) {
  keyword = String(keyword || "").trim().toLowerCase();
  const name = registrableName(domain).toLowerCase();
  const squashed = name.replace(/-/g, "");
  const tld = tldOf(domain);
  const tokens = _tokens(name);
  const tokenMatch = tokens.includes(keyword);
  const ratio = sequenceRatio(squashed, keyword);
  const distance = levenshtein(squashed, keyword);
  const lengthDelta = name.length - keyword.length;

  let kind;
  if (squashed === keyword) kind = "exact";
  else if (squashed.startsWith(keyword)) kind = "starts_with";
  else if (squashed.endsWith(keyword)) kind = "ends_with";
  else if (squashed.includes(keyword)) kind = "contains";
  else kind = "fuzzy";

  // Digits that the keyword itself carries are meaningful, not noise: only
  // digits ADDED beyond the keyword's own are treated as padding.
  const keywordDigits = _countDigits(keyword);
  const extraDigits = Math.max(0, _countDigits(name) - keywordDigits);

  let score;
  if (kind === "exact") {
    score = 100;
  } else if (kind === "fuzzy") {
    // No positional anchor. Characters MISSING from the candidate mean the
    // query's own content was dropped, which is a far worse match than
    // characters added, so it is penalised much harder.
    const missing = Math.max(0, keyword.length - squashed.length);
    const extra = Math.max(0, squashed.length - keyword.length);
    score =
      40 +
      50 * ratio -
      Math.min(35, missing * 7) -
      Math.min(20, extra) -
      Math.min(20, distance);
  } else {
    // The whole keyword is present, so nothing is missing by definition.
    const extra = Math.max(0, lengthDelta);
    // Padding hurts, and it hurts faster past four characters.
    score = _BASE_BY_KIND[kind] - extra - Math.max(0, extra - 4);
    score -= extraDigits * 3;
    if (tokenMatch) {
      // A clean word boundary means the keyword survived intact, so floor the
      // score — but the floor still decays with padding.
      score = Math.max(score, 88 - Math.max(0, extra - 4) * 2);
    }
  }

  return new SimilarityBreakdown({
    score: Math.trunc(Math.max(0, Math.min(100, pyRound(score)))),
    match_kind: kind,
    second_level: name,
    tld: tld,
    tld_score: tldScore(domain),
    length_delta: lengthDelta,
    edit_distance: distance,
    ratio: pyRound(ratio, 4),
    token_match: tokenMatch,
  });
}

function similarityScore(domain, keyword) {
  return similarityBreakdown(domain, keyword).score;
}

// --- query parsing ----------------------------------------------------------

const _KEYWORD_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789-".split(""));
const _UNSAFE = ["<", ">", "{", "}", "(", ")", ";", "|", "$", "`", "&", "*", "'", '"', " "];

class ParsedQuery {
  constructor(fields) {
    this.raw_query = fields.raw_query;
    this.keyword = fields.keyword;
    this.second_level = fields.second_level;
    this.tld = fields.tld;
    this.normalized_domain = fields.normalized_domain;
    this.is_full_domain = fields.is_full_domain;
    this.exact_candidate = fields.exact_candidate;
  }

  toDebug() {
    return {
      raw_query: this.raw_query,
      normalized_domain: this.normalized_domain,
      second_level_domain: this.second_level,
      tld: this.tld ? this.tld.replace(/^\.+/, "") : null,
      is_full_domain: this.is_full_domain,
      exact_candidate: this.exact_candidate,
    };
  }
}

/**
 * Accept a keyword, a full domain, or a URL and parse it losslessly.
 *
 * Throws Error with a human-readable reason for anything that is not one of
 * those three shapes (mirrors Python's ValueError).
 */
function parseQuery(raw) {
  let text = String(raw == null ? "" : raw).trim();
  // Python: .strip('"').strip("'") — strip leading/trailing quote chars.
  text = text.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  if (!text) throw new Error("Enter a keyword or domain");
  if (text.length > 253) throw new Error("Search term is too long");
  for (const token of _UNSAFE) {
    if (text.includes(token)) {
      throw new Error("Search term must be a plain keyword, domain, or URL");
    }
  }

  const looksLikeDomain = text.includes(".") || text.includes("://") || text.includes("/");

  if (looksLikeDomain) {
    const domain = normalizeDomain(text);
    if (!domain) throw new Error("That does not look like a valid domain or URL");
    const secondLevel = registrableName(domain);
    if (!secondLevel) throw new Error("Could not read a domain name from that input");
    return new ParsedQuery({
      raw_query: text,
      keyword: secondLevel,
      second_level: secondLevel,
      tld: tldOf(domain),
      normalized_domain: domain,
      is_full_domain: true,
      exact_candidate: domain,
    });
  }

  const keyword = text.toLowerCase();
  if (keyword.length < 2) throw new Error("Keyword must be at least 2 characters");
  if (keyword.length > 63) throw new Error("Keyword must be 63 characters or fewer");
  for (const char of keyword) {
    if (!_KEYWORD_CHARS.has(char)) {
      throw new Error("Keyword may contain only letters, numbers, and hyphens");
    }
  }
  if (keyword.startsWith("-") || keyword.endsWith("-") || keyword.includes("--")) {
    throw new Error("Keyword hyphens must be used sensibly");
  }

  return new ParsedQuery({
    raw_query: text,
    keyword: keyword,
    second_level: keyword,
    tld: null,
    normalized_domain: null,
    is_full_domain: false,
    exact_candidate: null,
  });
}

/**
 * TLD expansion order, with an explicitly entered TLD promoted first.
 *
 * A TLD the user typed is always included even when it is not in
 * DOMAIN_DISCOVERY_TLDS: they asked for it by name.
 */
function orderedTlds(configured, preferred = null) {
  const out = [];
  if (preferred) {
    const normalized = normalizeTld(preferred);
    if (normalized) out.push(normalized);
  }
  for (const raw of configured) {
    const tld = normalizeTld(raw);
    if (tld && !out.includes(tld)) out.push(tld);
  }
  return out;
}

// --- generation -------------------------------------------------------------

class GeneratedCandidate {
  constructor(fields) {
    this.domain = fields.domain;
    this.name = fields.name;
    this.kind = fields.kind;
    this.similarity = fields.similarity;
    this.tld = fields.tld;
    this.exact_match = fields.exact_match || false;
  }
}

/**
 * (second-level name, variation kind) pairs for one keyword.
 *
 * Deterministic and bounded: the same keyword always produces the same list.
 */
function variationNames(keyword) {
  const pairs = [[keyword, "exact"]];
  for (const prefix of PREFIXES) pairs.push([`${prefix}${keyword}`, "prefix"]);
  for (const suffix of SUFFIXES) pairs.push([`${keyword}${suffix}`, "suffix"]);
  for (const suffix of HYPHEN_SUFFIXES) pairs.push([`${keyword}-${suffix}`, "hyphen"]);
  for (const prefix of HYPHEN_PREFIXES) pairs.push([`${prefix}-${keyword}`, "hyphen"]);
  for (const number of NUMERIC_SUFFIXES) pairs.push([`${keyword}${number}`, "numeric"]);

  const seen = new Set();
  const unique = [];
  for (const [name, kind] of pairs) {
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push([name, kind]);
  }
  return unique;
}

/**
 * Expand a query into a ranked, capped pool of candidate domains.
 *
 * The exact domain the user typed, if any, is always first and is never
 * dropped by the cap. These are candidates only.
 */
function generateCandidates(query, { tlds = null, maxGenerated = null, exactOnly = false } = {}) {
  const parsed = typeof query === "string" ? parseQuery(query) : query;
  const keyword = parsed.keyword;
  if (!keyword) return [];

  // An explicitly entered TLD leads the expansion order.
  const sourceTlds = tlds !== null ? Array.from(tlds) : configuredTlds();
  let tldList = orderedTlds(sourceTlds, parsed.tld);
  if (tldList.length === 0) tldList = DEFAULT_TLDS.slice();
  const tldRank = new Map();
  tldList.forEach((tld, index) => tldRank.set(tld, index));

  const cap = maxGenerated !== null ? maxGenerated : limits().max_generated;

  const out = [];
  const seen = new Set();

  function add(domain, name, kind, exact) {
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    out.push(
      new GeneratedCandidate({
        domain: domain,
        name: name,
        kind: kind,
        similarity: similarityScore(domain, keyword),
        tld: tldOf(domain),
        exact_match: exact,
      })
    );
  }

  // Candidate #1 is always the exact domain the user typed.
  let exactDomain = null;
  if (parsed.exact_candidate) {
    exactDomain = parsed.exact_candidate;
    add(exactDomain, parsed.second_level, "exact", true);
  }

  const names = exactOnly ? [[keyword, "exact"]] : variationNames(keyword);
  for (const [name, kind] of names) {
    for (const tld of tldList) {
      add(normalizeDomain(`${name}${tld}`), name, kind, false);
    }
  }

  // Rank before truncating so the cap always keeps the closest names.
  const rankFor = (tld) => (tldRank.has(tld) ? tldRank.get(tld) : tldRank.size);
  out.sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    const ra = rankFor(a.tld);
    const rb = rankFor(b.tld);
    if (ra !== rb) return ra - rb;
    const ta = tldScore(a.domain);
    const tb = tldScore(b.domain);
    if (ta !== tb) return tb - ta;
    if (a.domain.length !== b.domain.length) return a.domain.length - b.domain.length;
    if (a.domain < b.domain) return -1;
    if (a.domain > b.domain) return 1;
    return 0;
  });

  let result = out;
  if (out.length > cap) {
    // logger.info: generated pool capped at cap of out.length
    let kept = out.slice(0, cap);
    if (exactDomain && kept.every((c) => c.domain !== exactDomain)) {
      const pinned = out.filter((c) => c.domain === exactDomain);
      kept = pinned.concat(kept.slice(0, kept.length - 1));
    }
    result = kept;
  }

  // Stable sort re-pins the exact candidate to the front.
  result.sort((a, b) => (a.exact_match ? 0 : 1) - (b.exact_match ? 0 : 1));
  return result;
}

module.exports = {
  FUZZY_BACKEND,
  DEFAULT_TLDS,
  PREFIXES,
  SUFFIXES,
  HYPHEN_PREFIXES,
  HYPHEN_SUFFIXES,
  NUMERIC_SUFFIXES,
  VARIATION_KINDS,
  debugEnabled,
  rdapVerbose,
  normalizeTld,
  configuredTlds,
  DiscoveryLimits,
  limits,
  RankWeights,
  rankWeights,
  levenshtein,
  sequenceRatio,
  SimilarityBreakdown,
  tldScore,
  similarityBreakdown,
  similarityScore,
  ParsedQuery,
  parseQuery,
  orderedTlds,
  GeneratedCandidate,
  variationNames,
  generateCandidates,
};
