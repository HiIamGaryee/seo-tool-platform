"use strict";

// Faithful Node port of backend/domain_monitor/classifier.py
const {
  CAT_30,
  CAT_60,
  CAT_EXPIRED,
  CAT_PENDING_DELETE,
  CAT_REDEMPTION,
  CAT_SAFE,
  CAT_UNKNOWN,
  PRI_CRITICAL,
  PRI_HIGH,
  PRI_LOW,
  PRI_MEDIUM,
  PRI_UNKNOWN,
  PRI_VERY_HIGH,
  PRI_WATCH,
} = require("./models");

// Registry statuses that override any date-based verdict, most severe first.
const _STATUS_OVERRIDES = [
  ["pendingdelete", CAT_PENDING_DELETE],
  ["redemptionperiod", CAT_REDEMPTION],
];

const _CATEGORY_PRIORITY = {
  [CAT_PENDING_DELETE]: PRI_CRITICAL,
  [CAT_REDEMPTION]: PRI_VERY_HIGH,
  [CAT_EXPIRED]: PRI_HIGH,
  [CAT_30]: PRI_MEDIUM,
  [CAT_60]: PRI_WATCH,
  [CAT_SAFE]: PRI_LOW,
  [CAT_UNKNOWN]: PRI_UNKNOWN,
};

// Used by the quality score only. Not a resale-value signal.
const _PREFERRED_TLDS = new Set([
  ".com", ".net", ".org", ".io", ".co", ".ai", ".dev", ".tech",
]);

function _normalizeStatus(status) {
  return status.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whole days between today and the expiration date. null if unparseable. */
function daysLeftFrom(expirationDate, today = null) {
  if (!expirationDate) return null;
  const reference = today || new Date();
  const iso = String(expirationDate).slice(0, 10);
  const expiry = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(expiry.getTime())) return null;
  const ref = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate()
  );
  const exp = Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth(),
    expiry.getUTCDate()
  );
  return Math.round((exp - ref) / 86400000);
}

/**
 * Return [category, priority]. Registry status wins over the date maths.
 */
function classify(registryStatus, daysLeft) {
  const normalized = new Set(
    (registryStatus || []).filter((s) => s).map((s) => _normalizeStatus(s))
  );

  for (const [token, category] of _STATUS_OVERRIDES) {
    if (normalized.has(token)) return [category, _CATEGORY_PRIORITY[category]];
  }

  if (daysLeft === null || daysLeft === undefined)
    return [CAT_UNKNOWN, _CATEGORY_PRIORITY[CAT_UNKNOWN]];
  if (daysLeft < 0) return [CAT_EXPIRED, _CATEGORY_PRIORITY[CAT_EXPIRED]];
  if (daysLeft <= 30) return [CAT_30, _CATEGORY_PRIORITY[CAT_30]];
  if (daysLeft <= 60) return [CAT_60, _CATEGORY_PRIORITY[CAT_60]];
  return [CAT_SAFE, _CATEGORY_PRIORITY[CAT_SAFE]];
}

/** Structural readability score, 0-100. Purely mechanical. */
function qualityScore(domain) {
  if (!domain || !domain.includes(".")) return 0;

  const name = domain.split(".")[0];
  const tld = "." + domain.split(".").pop();
  let score = 100;

  if (name.length > 20) score -= 30;
  else if (name.length > 15) score -= 20;
  else if (name.length > 10) score -= 10;

  const hyphens = (name.match(/-/g) || []).length;
  score -= Math.min(hyphens * 15, 30);

  const digits = (name.match(/[0-9]/g) || []).length;
  score -= Math.min(digits * 8, 24);

  if (!_PREFERRED_TLDS.has(tld)) score -= 12;

  if (domain.split(".").length > 2) score -= 10;

  return Math.max(0, Math.min(100, score));
}

module.exports = { classify, daysLeftFrom, qualityScore, _CATEGORY_PRIORITY };
