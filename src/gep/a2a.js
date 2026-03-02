const fs = require('fs');
const { readAllEvents } = require('./assetStore');
const { computeAssetId, SCHEMA_VERSION } = require('./contentHash');
const { unwrapAssetFromMessage } = require('./a2aProtocol');

function nowIso() { return new Date().toISOString(); }

function isAllowedA2AAsset(obj) {
  if (!obj || typeof obj !== 'object') return false;
  var t = obj.type;
  return t === 'Gene' || t === 'Capsule' || t === 'EvolutionEvent';
}

function safeNumber(x, fallback) {
  if (fallback === undefined) fallback = null;
  var n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function getBlastRadiusLimits() {
  var maxFiles = safeNumber(process.env.A2A_MAX_FILES, 5);
  var maxLines = safeNumber(process.env.A2A_MAX_LINES, 200);
  return {
    maxFiles: Number.isFinite(maxFiles) ? maxFiles : 5,
    maxLines: Number.isFinite(maxLines) ? maxLines : 200,
  };
}

function isBlastRadiusSafe(blastRadius) {
  var lim = getBlastRadiusLimits();
  var files = blastRadius && Number.isFinite(Number(blastRadius.files)) ? Math.max(0, Number(blastRadius.files)) : 0;
  var lines = blastRadius && Number.isFinite(Number(blastRadius.lines)) ? Math.max(0, Number(blastRadius.lines)) : 0;
  return files <= lim.maxFiles && lines <= lim.maxLines;
}

function clamp01(n) {
  var x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function lowerConfidence(asset, opts) {
  if (!opts) opts = {};
  var factor = Number.isFinite(Number(opts.factor)) ? Number(opts.factor) : 0.6;
  var receivedFrom = opts.source || 'external';
  var receivedAt = opts.received_at || nowIso();
  var cloned = JSON.parse(JSON.stringify(asset || {}));
  if (!isAllowedA2AAsset(cloned)) return null;
  if (cloned.type === 'Capsule') {
    if (typeof cloned.confidence === 'number') cloned.confidence = clamp01(cloned.confidence * factor);
    else if (cloned.confidence != null) cloned.confidence = clamp01(Number(cloned.confidence) * factor);
  }
  if (!cloned.a2a || typeof cloned.a2a !== 'object') cloned.a2a = {};
  cloned.a2a.status = 'external_candidate';
  cloned.a2a.source = receivedFrom;
  cloned.a2a.received_at = receivedAt;
  cloned.a2a.confidence_factor = factor;
  if (!cloned.schema_version) cloned.schema_version = SCHEMA_VERSION;
  if (!cloned.asset_id) { try { cloned.asset_id = computeAssetId(cloned); } catch (e) {} }
  return cloned;
}

function readEvolutionEvents() {
  var events = readAllEvents();
  return Array.isArray(events) ? events.filter(function (e) { return e && e.type === 'EvolutionEvent'; }) : [];
}

function normalizeEventsList(events) {
  return Array.isArray(events) ? events : [];
}

function computeCapsuleSuccessStreak(params) {
  var capsuleId = params.capsuleId;
  var events = params.events;
  var id = capsuleId ? String(capsuleId) : '';
  if (!id) return 0;
  var list = normalizeEventsList(events || readEvolutionEvents());
  var streak = 0;
  for (var i = list.length - 1; i >= 0; i--) {
    var ev = list[i];
    if (!ev || ev.type !== 'EvolutionEvent') continue;
    if (!ev.capsule_id || String(ev.capsule_id) !== id) continue;
    var st = ev.outcome && ev.outcome.status ? String(ev.outcome.status) : 'unknown';
    if (st === 'success') streak += 1; else break;
  }
  return streak;
}

function isCapsuleBroadcastEligible(capsule, opts) {
  if (!opts) opts = {};
  if (!capsule || capsule.type !== 'Capsule') return false;
  var score = capsule.outcome && capsule.outcome.score != null ? safeNumber(capsule.outcome.score, null) : null;
  if (score == null || score < 0.7) return false;
  var blast = capsule.blast_radius || (capsule.outcome && capsule.outcome.blast_radius) || null;
  if (!isBlastRadiusSafe(blast)) return false;
  var events = Array.isArray(opts.events) ? opts.events : readEvolutionEvents();
  var streak = computeCapsuleSuccessStreak({ capsuleId: capsule.id, events: events });
  if (streak < 2) return false;
  return true;
}

function exportEligibleCapsules(params) {
  if (!params) params = {};
  var list = Array.isArray(params.capsules) ? params.capsules : [];
  var evs = Array.isArray(params.events) ? params.events : readEvolutionEvents();
  var eligible = list.filter(function (c) { return isCapsuleBroadcastEligible(c, { events: evs }); });
  for (var i = 0; i < eligible.length; i++) {
    var c = eligible[i];
    if (!c.schema_version) c.schema_version = SCHEMA_VERSION;
    if (!c.asset_id) { try { c.asset_id = computeAssetId(c); } catch (e) {} }
  }
  return eligible;
}

function isGeneBroadcastEligible(gene) {
  if (!gene || gene.type !== 'Gene') return false;
  if (!gene.id || typeof gene.id !== 'string') return false;
  if (!Array.isArray(gene.strategy) || gene.strategy.length === 0) return false;
  if (!Array.isArray(gene.validation) || gene.validation.length === 0) return false;
  return true;
}

function exportEligibleGenes(params) {
  if (!params) params = {};
  var list = Array.isArray(params.genes) ? params.genes : [];
  var eligible = list.filter(function (g) { return isGeneBroadcastEligible(g); });
  for (var i = 0; i < eligible.length; i++) {
    var g = eligible[i];
    if (!g.schema_version) g.schema_version = SCHEMA_VERSION;
    if (!g.asset_id) { try { g.asset_id = computeAssetId(g); } catch (e) {} }
  }
  return eligible;
}

function parseA2AInput(text) {
  var raw = String(text || '').trim();
  if (!raw) return [];
  try {
    var maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) {
      return maybe.map(function (item) { return unwrapAssetFromMessage(item) || item; }).filter(Boolean);
    }
    if (maybe && typeof maybe === 'object') {
      var unwrapped = unwrapAssetFromMessage(maybe);
      return unwrapped ? [unwrapped] : [maybe];
    }
  } catch (e) {}
  var lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var items = [];
  for (var i = 0; i < lines.length; i++) {
    try {
      var obj = JSON.parse(lines[i]);
      var uw = unwrapAssetFromMessage(obj);
      items.push(uw || obj);
    } catch (e) { continue; }
  }
  return items;
}

function readTextIfExists(filePath) {
  try {
    if (!filePath) return '';
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch { return ''; }
}

module.exports = {
  isAllowedA2AAsset, lowerConfidence, isBlastRadiusSafe,
  computeCapsuleSuccessStreak, isCapsuleBroadcastEligible,
  exportEligibleCapsules, isGeneBroadcastEligible,
  exportEligibleGenes, parseA2AInput, readTextIfExists,
};
