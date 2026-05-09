'use strict';

const fs = require('fs');
const { getObserverPaths } = require('./paths');
const { readJsonSafe } = require('./jsonl');
const { getSafetyState } = require('./safety');

function getStatus() {
  const paths = getObserverPaths();
  const cycle = readJsonSafe(paths.cycleProgressPath, null);
  const solidify = readJsonSafe(paths.solidifyStatePath, null);
  const evolution = readJsonSafe(paths.evolutionStatePath, null);
  const proxy = getProxySettings();
  return {
    mode: inferMode(cycle, solidify, proxy),
    heartbeat: cycle,
    lastRun: solidify && solidify.last_run ? solidify.last_run : null,
    evolutionState: evolution,
    proxy,
    filesPresent: filesPresent(paths),
    safety: getSafetyState(),
  };
}

function inferMode(cycle, solidify, proxy) {
  if (cycle && isFresh(cycle.updated_at, 120_000)) return 'running';
  if (solidify && solidify.pending) return 'review_pending';
  if (proxy && proxy.running) return 'proxy_only';
  return 'idle';
}

function isFresh(timestamp, maxAgeMs) {
  const t = Number(timestamp);
  return Number.isFinite(t) && Date.now() - t < maxAgeMs;
}

function getProxySettings() {
  try {
    const { readSettings, isStaleProxy } = require('../../proxy/server/settings');
    const settings = readSettings();
    const proxy = settings.proxy || null;
    if (!proxy) return { running: false, url: null };
    return {
      running: !isStaleProxy(),
      url: proxy.url || null,
      pid: proxy.pid || null,
      started_at: proxy.started_at || null,
    };
  } catch {
    return { running: false, url: null };
  }
}

function filesPresent(paths) {
  return {
    cycleProgress: fs.existsSync(paths.cycleProgressPath),
    solidifyState: fs.existsSync(paths.solidifyStatePath),
    events: fs.existsSync(paths.eventsPath),
    assetCallLog: fs.existsSync(paths.assetCallLogPath),
    pipelineEvents: fs.existsSync(paths.pipelineEventsPath),
  };
}

module.exports = { getStatus, getProxySettings };
