"use strict";

// Faithful Node port of backend/domain_monitor/models.py

// Categories
const CAT_PENDING_DELETE = "Pending Delete";
const CAT_REDEMPTION = "Redemption";
const CAT_EXPIRED = "Expired";
const CAT_30 = "Expiring <=30 Days";
const CAT_60 = "Expiring 31-60 Days";
const CAT_SAFE = "Safe";
const CAT_UNKNOWN = "Unknown";

const CATEGORIES = [
  CAT_PENDING_DELETE,
  CAT_REDEMPTION,
  CAT_EXPIRED,
  CAT_30,
  CAT_60,
  CAT_SAFE,
  CAT_UNKNOWN,
];

// Priorities
const PRI_CRITICAL = "Critical";
const PRI_VERY_HIGH = "Very High";
const PRI_HIGH = "High";
const PRI_MEDIUM = "Medium";
const PRI_WATCH = "Watch";
const PRI_LOW = "Low";
const PRI_UNKNOWN = "Unknown";

const PRIORITIES = [
  PRI_CRITICAL,
  PRI_VERY_HIGH,
  PRI_HIGH,
  PRI_MEDIUM,
  PRI_WATCH,
  PRI_LOW,
  PRI_UNKNOWN,
];

// Lookup outcome for a record
const LOOKUP_OK = "ok";
const LOOKUP_FAILED = "lookup_failed";
const LOOKUP_NOT_FOUND = "not_found";
const LOOKUP_UNSUPPORTED_TLD = "unsupported_tld";

// RFC 1035 / 1123 label rules. Deliberately strict: anything that is not a
// plain hostname is rejected before it ever reaches the network or the DB.
const _LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?:${_LABEL}\\.)+[a-z]{2,63}$`);
const MAX_DOMAIN_LENGTH = 253;

/**
 * Return a safe, lowercase registrable hostname, or null if invalid.
 * Strips a scheme/path/port/leading dot wrapper if the admin pasted a URL,
 * then validates against DOMAIN_RE.
 */
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;

  let value = raw.trim().replace(/^["']+|["']+$/g, "").toLowerCase();
  if (!value) return null;

  if (value.includes("://")) value = value.split("://", 2)[1];
  for (const sep of ["/", "?", "#", "\\"]) {
    if (value.includes(sep)) value = value.split(sep)[0];
  }
  // userinfo@host: keep the last segment (the host), not the credentials.
  if (value.includes("@")) {
    const parts = value.split("@");
    value = parts[parts.length - 1];
  }
  if (value.includes(":")) value = value.split(":")[0];
  value = value.replace(/^\.+|\.+$/g, "");

  // Collapse the www host onto the registrable domain.
  while (value.startsWith("www.")) {
    const remainder = value.slice(4);
    if ((remainder.match(/\./g) || []).length < 1) break;
    value = remainder;
  }

  if (!value || value.length > MAX_DOMAIN_LENGTH) return null;

  // IDNA (punycode) encode, mirroring Python's str.encode("idna").
  try {
    value = idnaEncode(value);
  } catch (_e) {
    return null;
  }
  if (!DOMAIN_RE.test(value)) return null;
  return value;
}

function idnaEncode(value) {
  // Node's url module provides punycode conversion of the whole domain.
  // For pure-ASCII hostnames this is a no-op, matching the Python path.
  const { domainToASCII } = require("url");
  const ascii = domainToASCII(value);
  if (!ascii) throw new Error("idna failed");
  return ascii;
}

function tldOf(domain) {
  return domain.includes(".") ? "." + domain.split(".").pop() : "";
}

/**
 * The label that carries the brand, ignoring the TLD.
 * Picks the longest non-TLD label.
 */
function registrableName(domain) {
  const labels = domain.split(".").filter((l) => l);
  if (labels.length < 2) return labels[0] || "";
  const candidates = labels.slice(0, -1);
  return candidates.reduce((a, b) => (b.length > a.length ? b : a), candidates[0]);
}

/**
 * One monitored domain. Fields RDAP does not return stay null.
 * Mirrors the Python DomainRecord dataclass; `toDict()` yields the base
 * columns written by upsertMany (SEO fields are persisted separately).
 */
class DomainRecord {
  constructor(fields = {}) {
    this.id = fields.id;
    this.domain = fields.domain;
    this.tld = fields.tld;
    this.expiration_date = fields.expiration_date ?? null;
    this.days_left = fields.days_left ?? null;
    this.registry_status = fields.registry_status ?? [];
    this.registrar = fields.registrar ?? null;
    this.registration_date = fields.registration_date ?? null;
    this.nameservers = fields.nameservers ?? [];
    this.category = fields.category ?? CAT_UNKNOWN;
    this.priority = fields.priority ?? PRI_UNKNOWN;
    this.quality_score = fields.quality_score ?? null;
    this.available = fields.available ?? null;
    this.lookup_status = fields.lookup_status ?? LOOKUP_OK;
    this.lookup_error = fields.lookup_error ?? null;
    this.rdap_source = fields.rdap_source ?? null;
    this.source = fields.source ?? null;
    this.first_seen = fields.first_seen ?? null;
    this.last_checked = fields.last_checked ?? null;
  }

  toDict() {
    return { ...this };
  }
}

module.exports = {
  CAT_PENDING_DELETE,
  CAT_REDEMPTION,
  CAT_EXPIRED,
  CAT_30,
  CAT_60,
  CAT_SAFE,
  CAT_UNKNOWN,
  CATEGORIES,
  PRI_CRITICAL,
  PRI_VERY_HIGH,
  PRI_HIGH,
  PRI_MEDIUM,
  PRI_WATCH,
  PRI_LOW,
  PRI_UNKNOWN,
  PRIORITIES,
  LOOKUP_OK,
  LOOKUP_FAILED,
  LOOKUP_NOT_FOUND,
  LOOKUP_UNSUPPORTED_TLD,
  DOMAIN_RE,
  MAX_DOMAIN_LENGTH,
  normalizeDomain,
  tldOf,
  registrableName,
  DomainRecord,
};
