"use strict";

// Faithful Node port of backend/domain_monitor/rdap_client.py
const tcp = require("net"); // Node core TCP (NOT the local ./net helper module)
const url = require("url");

const net = require("./net");

// IANA's published RDAP bootstrap registry (RFC 7484). A documented public
// data file, not a scrape target.
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_SECONDS = 24 * 60 * 60;

const USER_AGENT = "SEO-Tool-Platform-DomainMonitor/1.0";
const RDAP_ACCEPT = "application/rdap+json, application/json";

const DEFAULT_TIMEOUT = 12.0;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_HOST_INTERVAL = 0.6; // seconds between calls to one RDAP host

const _WHOIS_EXPIRY_RE = new RegExp(
  "(?:registry expiry date|expiry date|expiration date|paid-till|renewal date)\\s*:\\s*(\\S+)",
  "i"
);
const _WHOIS_STATUS_RE = new RegExp(
  "^\\s*(?:domain )?status\\s*:\\s*([^\\s]+)",
  "gim"
);
const _WHOIS_REFERRAL_RE = new RegExp("^\\s*whois\\s*:\\s*(\\S+)", "im");

// IANA publishes the authoritative WHOIS server for every TLD over port 43,
// so a referral lookup replaces guessing at a third-party redirect host.
const IANA_WHOIS_HOST = "whois.iana.org";
const _WHOIS_REFERRAL_CACHE = new Map();

function verificationSourceOf(rdapSource) {
  // Which protocol actually produced a record: rdap, whois or unknown.
  if (!rdapSource) return "unknown";
  return String(rdapSource).startsWith("whois://") ? "whois" : "rdap";
}

class RdapError extends Error {
  // Recoverable RDAP problem. Carries a machine-readable kind.
  constructor(kind, message) {
    super(message);
    this.name = "RdapError";
    this.kind = kind;
  }
}

class RdapResult {
  constructor(domain) {
    this.domain = domain;
    this.expiration_date = null;
    this.registration_date = null;
    this.registry_status = [];
    this.registrar = null;
    this.nameservers = [];
    this.rdap_source = null;
  }
}

const _MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function _pad(n) {
  return String(n).padStart(2, "0");
}

function _isoFromYmd(y, m, d) {
  // Validate and format a naive y/m/d as an ISO date string (no tz shift).
  const yi = Number(y);
  const mi = Number(m);
  const di = Number(d);
  if (!Number.isInteger(yi) || !Number.isInteger(mi) || !Number.isInteger(di)) {
    return null;
  }
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  return `${String(yi).padStart(4, "0")}-${_pad(mi)}-${_pad(di)}`;
}

function _strptimeDate(value, fmt) {
  // Minimal strptime for the handful of formats the Python uses. Returns an
  // ISO date string or null. Mirrors datetime.strptime(...).date().isoformat().
  const s = value.trim().slice(0, 19);
  switch (fmt) {
    case "%Y-%m-%d": {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
      return m ? _isoFromYmd(m[1], m[2], m[3]) : null;
    }
    case "%d-%b-%Y": {
      const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
      if (!m) return null;
      const mon = _MONTHS[m[2].toLowerCase()];
      return mon ? _isoFromYmd(m[3], mon, m[1]) : null;
    }
    case "%Y.%m.%d": {
      const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s);
      return m ? _isoFromYmd(m[1], m[2], m[3]) : null;
    }
    case "%d.%m.%Y": {
      const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
      return m ? _isoFromYmd(m[3], m[2], m[1]) : null;
    }
    case "%Y/%m/%d": {
      const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
      return m ? _isoFromYmd(m[1], m[2], m[3]) : null;
    }
    default:
      return null;
  }
}

function _iso(value) {
  // Normalize an RDAP/WHOIS date to an ISO date string, or null.
  if (!value || typeof value !== "string") return null;
  const text = value.trim().replace("Z", "+00:00");
  // Fast path: an ISO 8601 datetime/date (RDAP eventDate carries an offset).
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(text)) {
    return parsed.toISOString().slice(0, 10);
  }
  for (const fmt of ["%Y-%m-%d", "%d-%b-%Y", "%Y.%m.%d", "%d.%m.%Y", "%Y/%m/%d"]) {
    const out = _strptimeDate(value, fmt);
    if (out) return out;
  }
  return null;
}

function _registrarFromEntities(entities) {
  // Pull the registrar's display name out of the jCard vcardArray.
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) continue;
    const roles = (entity.roles || []).map((r) => String(r).toLowerCase());
    if (!roles.includes("registrar")) continue;
    const vcard = entity.vcardArray;
    if (Array.isArray(vcard) && vcard.length > 1 && Array.isArray(vcard[1])) {
      for (const prop of vcard[1]) {
        if (Array.isArray(prop) && prop.length >= 4 && prop[0] === "fn") {
          const name = prop[3];
          if (typeof name === "string" && name.trim()) return name.trim();
        }
      }
    }
    const handle = entity.handle;
    if (typeof handle === "string" && handle.trim()) return handle.trim();
  }
  return null;
}

function parseRdapPayload(domain, payload, source) {
  // Map an RDAP domain object onto RdapResult. Absent fields stay null.
  const result = new RdapResult(domain);
  result.rdap_source = source;

  for (const event of payload.events || []) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const action = String(event.eventAction || "").toLowerCase();
    const when = _iso(event.eventDate);
    if (action === "expiration") {
      result.expiration_date = when;
    } else if (action === "registration") {
      result.registration_date = when;
    }
  }

  const statuses = payload.status;
  if (Array.isArray(statuses)) {
    result.registry_status = statuses.filter((s) => s).map((s) => String(s));
  }

  result.registrar = _registrarFromEntities(payload.entities);

  const nameservers = [];
  for (const ns of payload.nameservers || []) {
    if (ns && typeof ns === "object" && !Array.isArray(ns)) {
      const name = ns.ldhName || ns.unicodeName;
      if (typeof name === "string" && name.trim()) {
        nameservers.push(name.trim().toLowerCase());
      }
    }
  }
  result.nameservers = Array.from(new Set(nameservers)).sort();

  return result;
}

class RdapClient {
  // Bootstrap-aware RDAP lookup client.
  //
  // Handles per-host rate limiting, bounded retries with exponential backoff
  // and jitter, and an optional port-43 WHOIS fallback for TLDs that publish
  // no RDAP endpoint.
  constructor({
    timeout = DEFAULT_TIMEOUT,
    max_retries = DEFAULT_MAX_RETRIES,
    min_host_interval = DEFAULT_MIN_HOST_INTERVAL,
    allow_whois_fallback = false,
    pool_size = 16,
  } = {}) {
    this.timeout = timeout;
    this.max_retries = max_retries;
    this.allow_whois_fallback = allow_whois_fallback;
    this._limiter = new net.HostRateLimiter(min_host_interval);
    this._bootstrap = {};
    this._bootstrapAt = 0.0;
    this._bootstrapInFlight = null; // serialises concurrent bootstrap fetches
    // Size the pool to the worker count so parallel lookups reuse
    // connections instead of discarding them.
    this._session = net.buildSession(USER_AGENT, pool_size, RDAP_ACCEPT);
  }

  // -- bootstrap ---------------------------------------------------------

  async _loadBootstrap() {
    const fresh = Date.now() / 1000 - this._bootstrapAt < BOOTSTRAP_TTL_SECONDS;
    if (Object.keys(this._bootstrap).length && fresh) {
      return this._bootstrap;
    }
    // Coalesce concurrent callers onto one in-flight fetch (Python used a lock).
    if (this._bootstrapInFlight) {
      return this._bootstrapInFlight;
    }
    this._bootstrapInFlight = this._fetchBootstrap().finally(() => {
      this._bootstrapInFlight = null;
    });
    return this._bootstrapInFlight;
  }

  async _fetchBootstrap() {
    // Re-check freshness inside the critical section.
    const fresh = Date.now() / 1000 - this._bootstrapAt < BOOTSTRAP_TTL_SECONDS;
    if (Object.keys(this._bootstrap).length && fresh) {
      return this._bootstrap;
    }

    let services;
    try {
      const resp = await this._session.get(BOOTSTRAP_URL, {
        timeout: this.timeout * 1000,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`bootstrap HTTP ${resp.status}`);
      }
      services = (resp.data && resp.data.services) || [];
    } catch (exc) {
      console.warn(`RDAP bootstrap fetch failed: ${exc}`);
      return this._bootstrap; // keep any previously cached map
    }

    const mapping = {};
    for (const entry of services) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const tlds = entry[0];
      const urls = entry[1];
      let base = (urls || []).find((u) => String(u).startsWith("https://"));
      base = base || (urls && urls.length ? urls[0] : null);
      if (!base) continue;
      for (const tld of tlds) {
        mapping[String(tld).toLowerCase().replace(/^\.+/, "")] = String(base).replace(/\/+$/, "");
      }
    }

    if (Object.keys(mapping).length) {
      this._bootstrap = mapping;
      this._bootstrapAt = Date.now() / 1000;
      console.info(`RDAP bootstrap loaded: ${Object.keys(mapping).length} TLDs`);
    }
    return this._bootstrap;
  }

  async baseUrlFor(domain) {
    // Longest-suffix match against the bootstrap map (handles .co.uk).
    const mapping = await this._loadBootstrap();
    if (!mapping || !Object.keys(mapping).length) return null;
    const labels = domain.split(".");
    for (let i = 1; i < labels.length; i++) {
      const candidate = labels.slice(i).join(".");
      if (candidate in mapping) return mapping[candidate];
    }
    return null;
  }

  // -- lookup ------------------------------------------------------------

  async lookup(domain) {
    // Look up one domain. Throws RdapError on any unrecoverable outcome.
    const base = await this.baseUrlFor(domain);
    if (!base) {
      if (this.allow_whois_fallback) return this._whoisFallback(domain);
      throw new RdapError("unsupported_tld", `No RDAP endpoint published for ${domain}`);
    }

    const lookupUrl = `${base}/domain/${domain}`;
    const host = url.parse(base).host;
    let lastError = null;

    for (let attempt = 0; attempt < this.max_retries; attempt++) {
      await this._limiter.wait(host);
      let resp = null;
      let transportError = false;
      try {
        resp = await this._session.get(lookupUrl, { timeout: this.timeout * 1000 });
      } catch (exc) {
        transportError = true;
        if (exc && exc.code === "ECONNABORTED") {
          lastError = "RDAP request timed out";
        } else {
          lastError = `RDAP transport error: ${exc && exc.message ? exc.message : exc}`;
        }
      }

      if (!transportError && resp) {
        const code = resp.status;
        if (code === 200) {
          const payload = resp.data;
          if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            // requests.json() raises on non-JSON; axios leaves non-JSON as a
            // string, and an object check covers the "not an object" case.
            if (typeof payload === "string") {
              throw new RdapError("malformed_response", "RDAP returned non-JSON");
            }
            throw new RdapError("malformed_response", "RDAP payload was not an object");
          }
          return parseRdapPayload(domain, payload, base);
        }
        if (code === 404) {
          throw new RdapError("not_found", "Domain not present in the registry (404)");
        }
        if (code === 429) {
          lastError = "RDAP rate limited (429)";
          await this._sleepBackoff(attempt, resp.headers && resp.headers["retry-after"]);
          continue;
        }
        if (code >= 500 && code < 600) {
          lastError = `RDAP server error (${code})`;
        } else {
          throw new RdapError("http_error", `RDAP responded ${code}`);
        }
      }

      if (attempt < this.max_retries - 1) {
        await this._sleepBackoff(attempt, null);
      }
    }

    if (this.allow_whois_fallback) {
      try {
        return await this._whoisFallback(domain);
      } catch (exc) {
        if (exc instanceof RdapError) {
          lastError = `${lastError}; WHOIS fallback failed: ${exc.message}`;
        } else {
          throw exc;
        }
      }
    }
    throw new RdapError("lookup_failed", lastError || "RDAP lookup failed");
  }

  async _sleepBackoff(attempt, retryAfter) {
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (!Number.isNaN(parsed)) {
        await net.sleep(Math.min(parsed, 30.0) * 1000);
        return;
      }
    }
    const delay = Math.min(Math.pow(2, attempt), 8.0) + Math.random() * 0.4;
    await net.sleep(delay * 1000);
  }

  // -- WHOIS fallback ----------------------------------------------------

  async _whoisQuery(host, query) {
    // One raw port-43 exchange. Bounded read, no shell, no HTTP.
    await this._limiter.wait(host);
    // IDNA-encode the query the way Python's .encode("idna") would.
    let encodedQuery = url.domainToASCII(query);
    if (!encodedQuery) encodedQuery = query;

    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      const socket = new tcp.Socket();

      const fail = (exc) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) { /* ignore */ }
        reject(new RdapError("lookup_failed", `WHOIS unavailable via ${host}: ${exc}`));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) { /* ignore */ }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      };

      socket.setTimeout(this.timeout * 1000);
      socket.on("timeout", () => fail("timed out"));
      socket.on("error", (err) => fail(err && err.message ? err.message : err));
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total > 256000) done();
      });
      socket.on("end", done);
      socket.on("close", done);

      socket.connect(43, host, () => {
        socket.write(`${encodedQuery}\r\n`);
      });
    });
  }

  async whoisServerFor(domain) {
    // The registry's own WHOIS host, as published by IANA over port 43.
    // Cached per TLD for the life of the process. Falls back to the
    // whois-servers.net alias only when IANA publishes no referral.
    const parts = domain.split(".");
    const tld = parts[parts.length - 1].toLowerCase();
    if (_WHOIS_REFERRAL_CACHE.has(tld)) return _WHOIS_REFERRAL_CACHE.get(tld);

    let server = null;
    try {
      const referral = await this._whoisQuery(IANA_WHOIS_HOST, tld);
      const match = _WHOIS_REFERRAL_RE.exec(referral);
      if (match) server = match[1].trim().toLowerCase() || null;
    } catch (exc) {
      // IANA referral failed; fall through to the alias.
    }

    if (!server) server = `${tld}.whois-servers.net`;

    _WHOIS_REFERRAL_CACHE.set(tld, server);
    return server;
  }

  async _whoisFallback(domain) {
    // Minimal port-43 WHOIS read for TLDs with no RDAP service.
    // Only the expiry date and status lines are parsed; WHOIS text is far
    // too inconsistent to trust for anything richer.
    const server = await this.whoisServerFor(domain);
    if (!server) {
      throw new RdapError("lookup_failed", "No WHOIS server published for this TLD");
    }
    const text = await this._whoisQuery(server, domain);

    const result = new RdapResult(domain);
    result.rdap_source = `whois://${server}`;
    const expiry = _WHOIS_EXPIRY_RE.exec(text);
    if (expiry) result.expiration_date = _iso(expiry[1]);

    const statusSet = new Set();
    _WHOIS_STATUS_RE.lastIndex = 0;
    let m;
    while ((m = _WHOIS_STATUS_RE.exec(text)) !== null) {
      statusSet.add(m[1]);
    }
    result.registry_status = Array.from(statusSet).sort();

    if (!result.expiration_date && !result.registry_status.length) {
      throw new RdapError("lookup_failed", "WHOIS response carried no usable fields");
    }
    return result;
  }

  close() {
    // axios has no persistent session to tear down; nothing to close.
  }
}

module.exports = {
  RdapClient,
  RdapError,
  RdapResult,
  parseRdapPayload,
  verificationSourceOf,
  BOOTSTRAP_URL,
  USER_AGENT,
  RDAP_ACCEPT,
};
