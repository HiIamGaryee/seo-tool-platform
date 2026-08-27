"use strict";

// Faithful Node port of backend/domain_monitor/config_loader.py
const fs = require("fs");
const path = require("path");

const CONFIG_DIR =
  process.env.DOMAIN_MONITOR_CONFIG || path.join(__dirname, "config");

const _cache = {};

/**
 * Read a JSON config file once and memoise it. Config is data, not code.
 */
function load(name) {
  if (Object.prototype.hasOwnProperty.call(_cache, name)) return _cache[name];
  const p = path.join(CONFIG_DIR, name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (exc) {
    console.error(`Could not read config ${p}: ${exc}`);
    data = {};
  }
  _cache[name] = data;
  return data;
}

function topics() {
  return load("seo_topics.json").topics || {};
}

function spamCategories() {
  return load("spam_keywords.json").categories || {};
}

function genericAnchors() {
  return load("spam_keywords.json").generic_anchors || [];
}

function scoring() {
  return load("scoring.json");
}

function resetCache() {
  for (const k of Object.keys(_cache)) delete _cache[k];
}

module.exports = {
  CONFIG_DIR,
  load,
  topics,
  spamCategories,
  genericAnchors,
  scoring,
  resetCache,
};
