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
const { getGepAssetsDir } = require('./paths');
const { computeAssetId } = require('./contentHash');
const { captureEnvFingerprint } = require('./envFingerprint');
const { getDeviceId } = require('./deviceId');

const PROTOCOL_NAME = 'gep-a2a';
const PROTOCOL_VERSION = '1.0.0';
const VALID_MESSAGE_TYPES = ['hello', 'publish', 'fetch', 'report', 'decision', 'revoke'];

function generateMessageId() {
  return 'msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function getNodeId() {
  if (process.env.A2A_NODE_ID) return String(process.env.A2A_NODE_ID);
  const deviceId = getDeviceId();
  const agentName = process.env.AGENT_NAME || 'default';
  // Include cwd so multiple evolver instances in different directories
  // on the same machine get distinct nodeIds without manual config.
  const raw = deviceId + '|' + agentName + '|' + process.cwd();
  return 'node_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

// --- Base message builder ---

function buildMessage(params) {
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
  var geneAssetId = gene.asset_id || computeAssetId(gene);
  var capsuleAssetId = capsule.asset_id || computeAssetId(capsule);
  var nodeSecret = process.env.A2A_NODE_SECRET || getNodeId();
  var signatureInput = [geneAssetId, capsuleAssetId].sort().join('|');
  var signature = crypto.createHmac('sha256', nodeSecret).update(signatureInput).digest('hex');
  var assets = [gene, capsule];
  if (event && event.type === 'EvolutionEvent') assets.push(event);
  return buildMessage({
    messageType: 'publish',
    senderId: o.nodeId,
    payload: {
      assets: assets,
      signature: signature,
    },
  });
}

function buildFetch(opts) {
  var o = opts || {};
  return buildMessage({
    messageType: 'fetch',
    senderId: o.nodeId,
    payload: {
      asset_type: o.assetType || null,
      local_id: o.localId || null,
      content_hash: o.contentHash || null,
    },
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
  // Use dynamic import for fetch (available in Node 18+)
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  var fetchMsg = buildFetch({ assetType: assetType });
  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/fetch';
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
};
