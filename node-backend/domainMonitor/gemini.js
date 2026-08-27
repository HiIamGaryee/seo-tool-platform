"use strict";

// Port of server.py validate_gemini_api_key — a single tiny generateContent
// call used to validate a key and report timing. Never returns a credential.
const axios = require("axios");

const DEFAULT_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini/gemini-3-flash-preview";

async function validateGeminiApiKey(apiKey, modelName = null) {
  const key = (apiKey || "").trim();
  if (!key) {
    return {
      status: "not_configured",
      provider: "Gemini",
      model: modelName || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      latency_ms: null,
      error: "gemini_not_configured",
      message: "GEMINI_API_KEY is not set",
    };
  }

  const resolvedModel = modelName || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const model = resolvedModel.split("/").pop() || "gemini-3-flash-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const started = Date.now();
  let response;
  try {
    response = await axios.post(
      url,
      { contents: [{ parts: [{ text: "ping" }] }] },
      {
        headers: { "x-goog-api-key": key },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
  } catch (exc) {
    return {
      status: "error",
      provider: "Gemini",
      model: resolvedModel,
      latency_ms: Date.now() - started,
      error: "gemini_transport_error",
      message: String(exc.message || exc).slice(0, 300),
    };
  }

  const latencyMs = Date.now() - started;
  if (response.status === 200) {
    return {
      status: "ok",
      provider: "Gemini",
      model: resolvedModel,
      latency_ms: latencyMs,
      error: null,
      message: null,
    };
  }

  const kind =
    {
      400: "gemini_bad_request",
      401: "gemini_unauthorized",
      403: "gemini_forbidden",
      429: "gemini_rate_limit",
    }[response.status] || "gemini_http_error";
  return {
    status: "error",
    provider: "Gemini",
    model: resolvedModel,
    latency_ms: latencyMs,
    http_status: response.status,
    error: kind,
    message: `Gemini returned HTTP ${response.status}`,
  };
}

module.exports = {
  DEFAULT_GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL,
  validateGeminiApiKey,
};
