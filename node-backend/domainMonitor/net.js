"use strict";

// Faithful Node port of backend/domain_monitor/net.py (async, axios-based).
const axios = require("axios");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimum spacing between requests to the same host. Shared by every external
 * client so one provider's limit cannot be bypassed by another code path.
 */
class HostRateLimiter {
  constructor(minInterval) {
    this._minInterval = minInterval; // seconds
    this._last = new Map();
    this._chain = Promise.resolve();
  }

  // Serialise waits so concurrent callers space out correctly.
  async wait(host) {
    const run = this._chain.then(async () => {
      const now = Date.now() / 1000;
      const readyAt = (this._last.get(host) || 0) + this._minInterval;
      if (now >= readyAt) {
        this._last.set(host, now);
        return;
      }
      const sleepFor = readyAt - now;
      await sleep(sleepFor * 1000);
      this._last.set(host, Date.now() / 1000);
    });
    this._chain = run.catch(() => {});
    return run;
  }
}

/** Exponential backoff with jitter, honouring Retry-After when present. */
async function sleepBackoff(attempt, retryAfter = null, cap = 8.0) {
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (!Number.isNaN(parsed)) {
      await sleep(Math.min(parsed, 30.0) * 1000);
      return;
    }
  }
  const delay = Math.min(Math.pow(2, attempt), cap) + Math.random() * 0.4;
  await sleep(delay * 1000);
}

function buildSession(userAgent, poolSize = 16, accept = "*/*") {
  return axios.create({
    headers: { "User-Agent": userAgent, Accept: accept },
    // axios throws on non-2xx by default; we validate status ourselves.
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

/**
 * Rate-limited GET with bounded retries. Returns an axios-like response
 * object ({status, headers, data}) or null when every attempt failed.
 */
async function getWithRetries(
  session,
  url,
  limiter,
  host,
  timeout,
  maxRetries,
  params = null,
  label = "request"
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await limiter.wait(host);
    let response = null;
    try {
      response = await session.get(url, { params, timeout: timeout * 1000 });
    } catch (exc) {
      // transport error / timeout
      response = null;
    }

    if (response) {
      const code = response.status;
      if (code === 200) return response;
      if (code === 404) return response;
      if (code === 429 || (code >= 500 && code < 600)) {
        if (attempt < maxRetries - 1) {
          await sleepBackoff(attempt, response.headers?.["retry-after"]);
        }
        continue;
      }
      return response;
    }

    if (attempt < maxRetries - 1) await sleepBackoff(attempt);
  }
  return null;
}

module.exports = {
  sleep,
  HostRateLimiter,
  sleepBackoff,
  buildSession,
  getWithRetries,
};
