// GEP A2A Protocol - Standard message types and pluggable transport layer.
//
// Protocol messages:
//   hello    - capability advertisement and node discovery
//   publish  - broadcast an eligible asset (Capsule/Gene)
//   fetch    - request a specific asset by id or content hash
//   report   - send a ValidationReport for a received asset
//   decision - accept/reject/quarantine decision on a received asset
//   revoke   - withdraw a previously published asset
//
// Transport interface:
//   send(message, opts)    - send a protocol message
//   receive(opts)          - receive pending messages
//   list(opts)             - list available message files/streams
//
// Default transport: FileTransport (reads/writes JSONL to a2a/ directory).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getGepAssetsDir, getEvolverLogPath } = require('./paths');
const { computeAssetId } = require('./contentHash');
const { captureEnvFingerprint } = require('./envFingerprint');
const os = require('os');
const { getDeviceId } = require('./deviceId');

const PROTOCOL_NAME = 'gep-a2a';
const PROTOCOL_VERSION = '1.0.0';
const VALID_MESSAGE_TYPES = ['hello', 'publish', 'fetch', 'report', 'decision', 'revoke'];

const NODE_ID_RE = /^node_[a-f0-9]{12}$/;
const NODE_ID_DIR = path.join(os.homedir(), '.evomap');
const NODE_ID_FILE = path.join(NODE_ID_DIR, 'node_id');
const LOCAL_NODE_ID_FILE = path.resolve(__dirname, '..', '..', '.evomap_node_id');

let _cachedNodeId = null;

function _loadPersistedNodeId() {
  try {
    if (fs.existsSync(NODE_ID_FILE)) {
      const id = fs.readFileSync(NODE_ID_FILE, 'utf8').trim();
      if (id && NODE_ID_RE.test(id)) return id;
    }
  } catch {}
  try {
    if (fs.existsSync(LOCAL_NODE_ID_FILE)) {
      const id = fs.readFileSync(LOCAL_NODE_ID_FILE, 'utf8').trim();
      if (id && NODE_ID_RE.test(id)) return id;
    }
  } catch {}
  return null;
}

function _persistNodeId(id) {
  try {
    if (!fs.existsSync(NODE_ID_DIR)) {
      fs.mkdirSync(NODE_ID_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(NODE_ID_FILE, id, { encoding: 'utf8', mode: 0o600 });
    return;
  } catch {}
  try {
    fs.writeFileSync(LOCAL_NODE_ID_FILE, id, { encoding: 'utf8', mode: 0o600 });
    return;
  } catch {}
}

function generateMessageId() {
  return 'msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function getNodeId() {
  if (_cachedNodeId) return _cachedNodeId;

  if (process.env.A2A_NODE_ID) {
    _cachedNodeId = String(process.env.A2A_NODE_ID);
    return _cachedNodeId;
  }

  const persisted = _loadPersistedNodeId();
  if (persisted) {
    _cachedNodeId = persisted;
    return _cachedNodeId;
  }

  console.warn('[a2aProtocol] A2A_NODE_ID is not set. Computing node ID from device fingerprint. ' +
    'This ID may change across machines or environments. ' +
    'Set A2A_NODE_ID after registering at https://evomap.ai to use a stable identity.');

  const deviceId = getDeviceId();
  const agentName = process.env.AGENT_NAME || 'default';
  const raw = deviceId + '|' + agentName + '|' + process.cwd();
  const computed = 'node_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);

  _persistNodeId(computed);
  _cachedNodeId = computed;
  return _cachedNodeId;
}

// --- Base message builder ---

function buildMessage(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('buildMessage requires a params object');
  }
  var messageType = params.messageType;
  var payload = params.payload;
  var senderId = params.senderId;
  if (!VALID_MESSAGE_TYPES.includes(messageType)) {
    throw new Error('Invalid message type: ' + messageType + '. Valid: ' + VALID_MESSAGE_TYPES.join(', '));
  }
  return {
    protocol: PROTOCOL_NAME,
    protocol_version: PROTOCOL_VERSION,
    message_type: messageType,
    message_id: generateMessageId(),
    sender_id: senderId || getNodeId(),
    timestamp: new Date().toISOString(),
    payload: payload || {},
  };
}

// --- Typed message builders ---

function buildHello(opts) {
  var o = opts || {};
  return buildMessage({
    messageType: 'hello',
    senderId: o.nodeId,
    payload: {
      capabilities: o.capabilities || {},
      gene_count: typeof o.geneCount === 'number' ? o.geneCount : null,
      capsule_count: typeof o.capsuleCount === 'number' ? o.capsuleCount : null,
      env_fingerprint: captureEnvFingerprint(),
    },
  });
}

function buildPublish(opts) {
  var o = opts || {};
  var asset = o.asset;
  if (!asset || !asset.type || !asset.id) {
    throw new Error('publish: asset must have type and id');
  }
  // Generate signature: HMAC-SHA256 of asset_id with node secret
  var assetIdVal = asset.asset_id || computeAssetId(asset);
  var nodeSecret = process.env.A2A_NODE_SECRET || getNodeId();
  var signature = crypto.createHmac('sha256', nodeSecret).update(assetIdVal).digest('hex');
  return buildMessage({
    messageType: 'publish',
    senderId: o.nodeId,
    payload: {
      asset_type: asset.type,
      asset_id: assetIdVal,
      local_id: asset.id,
      asset: asset,
      signature: signature,
    },
  });
}

// Build a bundle publish message containing Gene + Capsule (+ optional EvolutionEvent).
// Hub requires payload.assets = [Gene, Capsule] since bundle enforcement was added.
function buildPublishBundle(opts) {
  var o = opts || {};
  var gene = o.gene;
  var capsule = o.capsule;
  var event = o.event || null;
  if (!gene || gene.type !== 'Gene' || !gene.id) {
    throw new Error('publishBundle: gene must be a valid Gene with type and id');
  }
  if (!capsule || capsule.type !== 'Capsule' || !capsule.id) {
    throw new Error('publishBundle: capsule must be a valid Capsule with type and id');
  }
  if (o.modelName && typeof o.modelName === 'string') {
    gene.model_name = o.modelName;
    capsule.model_name = o.modelName;
  }
  gene.asset_id = computeAssetId(gene);
  capsule.asset_id = computeAssetId(capsule);
  var geneAssetId = gene.asset_id;
  var capsuleAssetId = capsule.asset_id;
  var nodeSecret = process.env.A2A_NODE_SECRET || getNodeId();
  var signatureInput = [geneAssetId, capsuleAssetId].sort().join('|');
  var signature = crypto.createHmac('sha256', nodeSecret).update(signatureInput).digest('hex');
  var assets = [gene, capsule];
  if (event && event.type === 'EvolutionEvent') {
    if (o.modelName && typeof o.modelName === 'string') {
      event.model_name = o.modelName;
    }
    event.asset_id = computeAssetId(event);
    assets.push(event);
  }
  var publishPayload = {
    assets: assets,
    signature: signature,
  };
  if (o.chainId && typeof o.chainId === 'string') {
    publishPayload.chain_id = o.chainId;
  }
  return buildMessage({
    messageType: 'publish',
    senderId: o.nodeId,
    payload: publishPayload,
  });
}

function buildFetch(opts) {
  var o = opts || {};
  var fetchPayload = {
    asset_type: o.assetType || null,
    local_id: o.localId || null,
    content_hash: o.contentHash || null,
  };
  if (Array.isArray(o.signals) && o.signals.length > 0) {
    fetchPayload.signals = o.signals;
  }
  if (o.searchOnly === true) {
    fetchPayload.search_only = true;
  }
  if (Array.isArray(o.assetIds) && o.assetIds.length > 0) {
    fetchPayload.asset_ids = o.assetIds;
  }
  return buildMessage({
    messageType: 'fetch',
    senderId: o.nodeId,
    payload: fetchPayload,
  });
}

function buildReport(opts) {
  var o = opts || {};
  return buildMessage({
    messageType: 'report',
    senderId: o.nodeId,
    payload: {
      target_asset_id: o.assetId || null,
      target_local_id: o.localId || null,
      validation_report: o.validationReport || null,
    },
  });
}

function buildDecision(opts) {
  var o = opts || {};
  var validDecisions = ['accept', 'reject', 'quarantine'];
  if (!validDecisions.includes(o.decision)) {
    throw new Error('decision must be one of: ' + validDecisions.join(', '));
  }
  return buildMessage({
    messageType: 'decision',
    senderId: o.nodeId,
    payload: {
      target_asset_id: o.assetId || null,
      target_local_id: o.localId || null,
      decision: o.decision,
      reason: o.reason || null,
    },
  });
}

function buildRevoke(opts) {
  var o = opts || {};
  return buildMessage({
    messageType: 'revoke',
    senderId: o.nodeId,
    payload: {
      target_asset_id: o.assetId || null,
      target_local_id: o.localId || null,
      reason: o.reason || null,
    },
  });
}

// --- Validation ---

function isValidProtocolMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.protocol !== PROTOCOL_NAME) return false;
  if (!msg.message_type || !VALID_MESSAGE_TYPES.includes(msg.message_type)) return false;
  if (!msg.message_id || typeof msg.message_id !== 'string') return false;
  if (!msg.timestamp || typeof msg.timestamp !== 'string') return false;
  return true;
}

// Try to extract a raw asset from either a protocol message or a plain asset object.
// This enables backward-compatible ingestion of both old-format and new-format payloads.
function unwrapAssetFromMessage(input) {
  if (!input || typeof input !== 'object') return null;
  // If it is a protocol message with a publish payload, extract the asset.
  if (input.protocol === PROTOCOL_NAME && input.message_type === 'publish') {
    var p = input.payload;
    if (p && p.asset && typeof p.asset === 'object') return p.asset;
    return null;
  }
  // If it is a plain asset (Gene/Capsule/EvolutionEvent), return as-is.
  if (input.type === 'Gene' || input.type === 'Capsule' || input.type === 'EvolutionEvent') {
    return input;
  }
  return null;
}

// --- File Transport ---

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function defaultA2ADir() {
  return process.env.A2A_DIR || path.join(getGepAssetsDir(), 'a2a');
}

function fileTransportSend(message, opts) {
  var dir = (opts && opts.dir) || defaultA2ADir();
  var subdir = path.join(dir, 'outbox');
  ensureDir(subdir);
  var filePath = path.join(subdir, message.message_type + '.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(message) + '\n', 'utf8');
  return { ok: true, path: filePath };
}

function fileTransportReceive(opts) {
  var dir = (opts && opts.dir) || defaultA2ADir();
  var subdir = path.join(dir, 'inbox');
  if (!fs.existsSync(subdir)) return [];
  var files = fs.readdirSync(subdir).filter(function (f) { return f.endsWith('.jsonl'); });
  var messages = [];
  for (var fi = 0; fi < files.length; fi++) {
    try {
      var raw = fs.readFileSync(path.join(subdir, files[fi]), 'utf8');
      var lines = raw.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      for (var li = 0; li < lines.length; li++) {
        try {
          var msg = JSON.parse(lines[li]);
          if (msg && msg.protocol === PROTOCOL_NAME) messages.push(msg);
        } catch (e) {}
      }
    } catch (e) {}
  }
  return messages;
}

function fileTransportList(opts) {
  var dir = (opts && opts.dir) || defaultA2ADir();
  var subdir = path.join(dir, 'outbox');
  if (!fs.existsSync(subdir)) return [];
  return fs.readdirSync(subdir).filter(function (f) { return f.endsWith('.jsonl'); });
}

// --- HTTP Transport (connects to evomap-hub) ---

function httpTransportSend(message, opts) {
  var hubUrl = (opts && opts.hubUrl) || process.env.A2A_HUB_URL;
  if (!hubUrl) return { ok: false, error: 'A2A_HUB_URL not set' };
  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/' + message.message_type;
  var body = JSON.stringify(message);
  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: body,
  })
    .then(function (res) { return res.json(); })
    .then(function (data) { return { ok: true, response: data }; })
    .catch(function (err) { return { ok: false, error: err.message }; });
}

function httpTransportReceive(opts) {
  var hubUrl = (opts && opts.hubUrl) || process.env.A2A_HUB_URL;
  if (!hubUrl) return Promise.resolve([]);
  var assetType = (opts && opts.assetType) || null;
  var signals = (opts && Array.isArray(opts.signals)) ? opts.signals : null;
  var fetchMsg = buildFetch({ assetType: assetType, signals: signals });
  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/fetch';
  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: JSON.stringify(fetchMsg),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data && data.payload && Array.isArray(data.payload.results)) {
        return data.payload.results;
      }
      return [];
    })
    .catch(function () { return []; });
}

function httpTransportList() {
  return ['http'];
}

// --- Heartbeat ---

var _heartbeatTimer = null;
var _heartbeatStartedAt = null;
var _heartbeatConsecutiveFailures = 0;
var _heartbeatTotalSent = 0;
var _heartbeatTotalFailed = 0;
var _heartbeatFpSent = false;
var _latestAvailableWork = [];
var _latestOverdueTasks = [];
var _pendingCommitmentUpdates = [];
var _cachedHubNodeSecret = null;
var _heartbeatIntervalMs = 0;
var _heartbeatRunning = false;

var NODE_SECRET_FILE = path.join(NODE_ID_DIR, 'node_secret');

function _loadPersistedNodeSecret() {
  try {
    if (fs.existsSync(NODE_SECRET_FILE)) {
      var s = fs.readFileSync(NODE_SECRET_FILE, 'utf8').trim();
      if (s && /^[a-f0-9]{64}$/i.test(s)) return s;
    }
  } catch {}
  return null;
}

function _persistNodeSecret(secret) {
  try {
    if (!fs.existsSync(NODE_ID_DIR)) {
      fs.mkdirSync(NODE_ID_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(NODE_SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function getHubUrl() {
  return process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
}

function buildHubHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  var secret = getHubNodeSecret();
  if (secret) headers['Authorization'] = 'Bearer ' + secret;
  return headers;
}

function sendHelloToHub() {
  var hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });

  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/hello';
  var nodeId = getNodeId();
  var msg = buildHello({ nodeId: nodeId, capabilities: {} });
  msg.sender_id = nodeId;

  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(15000),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var secret = (data && data.payload && data.payload.node_secret)
        || (data && data.node_secret)
        || null;
      if (secret && /^[a-f0-9]{64}$/i.test(secret)) {
        _cachedHubNodeSecret = secret;
        _persistNodeSecret(secret);
      }
      return { ok: true, response: data };
    })
    .catch(function (err) { return { ok: false, error: err.message }; });
}

function getHubNodeSecret() {
  if (process.env.A2A_NODE_SECRET) return process.env.A2A_NODE_SECRET;
  if (_cachedHubNodeSecret) return _cachedHubNodeSecret;
  var persisted = _loadPersistedNodeSecret();
  if (persisted) {
    _cachedHubNodeSecret = persisted;
    return persisted;
  }
  if (process.env.A2A_HUB_TOKEN) return process.env.A2A_HUB_TOKEN;
  return null;
}

function _scheduleNextHeartbeat(delayMs) {
  if (!_heartbeatRunning) return;
  if (_heartbeatTimer) clearTimeout(_heartbeatTimer);
  var delay = delayMs || _heartbeatIntervalMs;
  _heartbeatTimer = setTimeout(function () {
    if (!_heartbeatRunning) return;
    sendHeartbeat().catch(function () {});
    _scheduleNextHeartbeat();
  }, delay);
  if (_heartbeatTimer.unref) _heartbeatTimer.unref();
}

function sendHeartbeat() {
  var hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });

  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/heartbeat';
  var nodeId = getNodeId();
  var bodyObj = {
    node_id: nodeId,
    sender_id: nodeId,
    version: PROTOCOL_VERSION,
    uptime_ms: _heartbeatStartedAt ? Date.now() - _heartbeatStartedAt : 0,
    timestamp: new Date().toISOString(),
  };

  var meta = {};

  if (process.env.WORKER_ENABLED === '1') {
    var domains = (process.env.WORKER_DOMAINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    meta.worker_enabled = true;
    meta.worker_domains = domains;
    meta.max_load = Math.max(1, Number(process.env.WORKER_MAX_LOAD) || 5);
  }

  if (_pendingCommitmentUpdates.length > 0) {
    meta.commitment_updates = _pendingCommitmentUpdates.splice(0);
  }

  if (!_heartbeatFpSent) {
    try {
      var fp = captureEnvFingerprint();
      if (fp && fp.evolver_version) {
        meta.env_fingerprint = fp;
        _heartbeatFpSent = true;
      }
    } catch {}
  }

  if (Object.keys(meta).length > 0) {
    bodyObj.meta = meta;
  }

  var body = JSON.stringify(bodyObj);

  _heartbeatTotalSent++;

  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: body,
    signal: AbortSignal.timeout(10000),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data && (data.error === 'rate_limited' || data.status === 'rate_limited')) {
        var retryMs = Number(data.retry_after_ms) || 0;
        var policy = data.policy || {};
        var windowMs = Number(policy.window_ms) || 0;
        var backoff = retryMs > 0 ? retryMs + 5000 : (windowMs > 0 ? windowMs + 5000 : _heartbeatIntervalMs);
        if (backoff > _heartbeatIntervalMs) {
          console.warn('[Heartbeat] Rate limited by hub. Next attempt in ' + Math.round(backoff / 1000) + 's. ' +
            'Consider increasing HEARTBEAT_INTERVAL_MS to >= ' + (windowMs || backoff) + 'ms.');
          _scheduleNextHeartbeat(backoff);
        }
        return { ok: false, error: 'rate_limited', retryMs: backoff };
      }
      if (data && data.status === 'unknown_node') {
        console.warn('[Heartbeat] Node not registered on hub. Sending hello to re-register...');
        return sendHelloToHub().then(function (helloResult) {
          if (helloResult.ok) {
            console.log('[Heartbeat] Re-registered with hub successfully.');
            _heartbeatConsecutiveFailures = 0;
          } else {
            console.warn('[Heartbeat] Re-registration failed: ' + (helloResult.error || 'unknown'));
          }
          return { ok: helloResult.ok, response: data, reregistered: helloResult.ok };
        });
      }
      if (Array.isArray(data.available_work)) {
        _latestAvailableWork = data.available_work;
      }
      if (Array.isArray(data.overdue_tasks) && data.overdue_tasks.length > 0) {
        _latestOverdueTasks = data.overdue_tasks;
        console.warn('[Commitment] ' + data.overdue_tasks.length + ' overdue task(s) detected via heartbeat.');
      }
      _heartbeatConsecutiveFailures = 0;
      try {
        var logPath = getEvolverLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        var now = new Date();
        try {
          fs.utimesSync(logPath, now, now);
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            try {
              var fd = fs.openSync(logPath, 'a');
              fs.closeSync(fd);
              fs.utimesSync(logPath, now, now);
            } catch (innerErr) {
              console.warn('[Heartbeat] Failed to create evolver_loop.log: ' + innerErr.message);
            }
          } else {
            console.warn('[Heartbeat] Failed to touch evolver_loop.log: ' + e.message);
          }
        }
      } catch (outerErr) {
        console.warn('[Heartbeat] Failed to ensure evolver_loop.log: ' + outerErr.message);
      }
      return { ok: true, response: data };
    })
    .catch(function (err) {
      _heartbeatConsecutiveFailures++;
      _heartbeatTotalFailed++;
      if (_heartbeatConsecutiveFailures === 3) {
        console.warn('[Heartbeat] 3 consecutive failures. Network issue? Last error: ' + err.message);
      } else if (_heartbeatConsecutiveFailures === 10) {
        console.warn('[Heartbeat] 10 consecutive failures. Hub may be unreachable. (' + err.message + ')');
      } else if (_heartbeatConsecutiveFailures % 50 === 0) {
        console.warn('[Heartbeat] ' + _heartbeatConsecutiveFailures + ' consecutive failures. (' + err.message + ')');
      }
      return { ok: false, error: err.message };
    });
}

function getLatestAvailableWork() {
  return _latestAvailableWork;
}

function consumeAvailableWork() {
  var work = _latestAvailableWork;
  _latestAvailableWork = [];
  return work;
}

function getOverdueTasks() {
  return _latestOverdueTasks;
}

function consumeOverdueTasks() {
  var tasks = _latestOverdueTasks;
  _latestOverdueTasks = [];
  return tasks;
}

/**
 * Queue a commitment deadline update to be sent with the next heartbeat.
 * @param {string} taskId
 * @param {string} deadlineIso - ISO-8601 deadline
 * @param {boolean} [isAssignment] - true if this is a WorkAssignment
 */
function queueCommitmentUpdate(taskId, deadlineIso, isAssignment) {
  if (!taskId || !deadlineIso) return;
  _pendingCommitmentUpdates.push({
    task_id: taskId,
    deadline: deadlineIso,
    assignment: !!isAssignment,
  });
}

function startHeartbeat(intervalMs) {
  if (_heartbeatRunning) return;
  _heartbeatIntervalMs = intervalMs || Number(process.env.HEARTBEAT_INTERVAL_MS) || 360000; // default 6min
  _heartbeatStartedAt = Date.now();
  _heartbeatRunning = true;

  sendHelloToHub().then(function (r) {
    if (r.ok) console.log('[Heartbeat] Registered with hub. Node: ' + getNodeId());
    else console.warn('[Heartbeat] Hello failed (will retry via heartbeat): ' + (r.error || 'unknown'));
  }).catch(function () {}).then(function () {
    if (!_heartbeatRunning) return;
    // First heartbeat after hello completes, with enough gap to avoid rate limit
    _scheduleNextHeartbeat(Math.max(30000, _heartbeatIntervalMs));
  });
}

function stopHeartbeat() {
  _heartbeatRunning = false;
  if (_heartbeatTimer) {
    clearTimeout(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

function getHeartbeatStats() {
  return {
    running: _heartbeatRunning,
    uptimeMs: _heartbeatStartedAt ? Date.now() - _heartbeatStartedAt : 0,
    totalSent: _heartbeatTotalSent,
    totalFailed: _heartbeatTotalFailed,
    consecutiveFailures: _heartbeatConsecutiveFailures,
  };
}

// --- Transport registry ---

var transports = {
  file: {
    send: fileTransportSend,
    receive: fileTransportReceive,
    list: fileTransportList,
  },
  http: {
    send: httpTransportSend,
    receive: httpTransportReceive,
    list: httpTransportList,
  },
};

function getTransport(name) {
  var n = String(name || process.env.A2A_TRANSPORT || 'file').toLowerCase();
  var t = transports[n];
  if (!t) throw new Error('Unknown A2A transport: ' + n + '. Available: ' + Object.keys(transports).join(', '));
  return t;
}

function registerTransport(name, impl) {
  if (!name || typeof name !== 'string') throw new Error('transport name required');
  if (!impl || typeof impl.send !== 'function' || typeof impl.receive !== 'function') {
    throw new Error('transport must implement send() and receive()');
  }
  transports[name] = impl;
}

module.exports = {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  VALID_MESSAGE_TYPES,
  getNodeId,
  buildMessage,
  buildHello,
  buildPublish,
  buildPublishBundle,
  buildFetch,
  buildReport,
  buildDecision,
  buildRevoke,
  isValidProtocolMessage,
  unwrapAssetFromMessage,
  getTransport,
  registerTransport,
  fileTransportSend,
  fileTransportReceive,
  fileTransportList,
  httpTransportSend,
  httpTransportReceive,
  httpTransportList,
  sendHeartbeat,
  sendHelloToHub,
  startHeartbeat,
  stopHeartbeat,
  getHeartbeatStats,
  getLatestAvailableWork,
  consumeAvailableWork,
  getOverdueTasks,
  consumeOverdueTasks,
  queueCommitmentUpdate,
  getHubNodeSecret,
  buildHubHeaders,
};
