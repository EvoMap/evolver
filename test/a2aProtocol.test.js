const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  VALID_MESSAGE_TYPES,
  buildMessage,
  buildHello,
  buildPublish,
  buildFetch,
  buildReport,
  buildDecision,
  buildRevoke,
  isValidProtocolMessage,
  unwrapAssetFromMessage,
  sendHeartbeat,
} = require('../src/gep/a2aProtocol');

describe('protocol constants', () => {
  it('has expected protocol name', () => {
    assert.equal(PROTOCOL_NAME, 'gep-a2a');
  });

  it('has 6 valid message types', () => {
    assert.equal(VALID_MESSAGE_TYPES.length, 6);
    for (const t of ['hello', 'publish', 'fetch', 'report', 'decision', 'revoke']) {
      assert.ok(VALID_MESSAGE_TYPES.includes(t), `missing type: ${t}`);
    }
  });
});

describe('buildMessage', () => {
  it('builds a valid protocol message', () => {
    const msg = buildMessage({ messageType: 'hello', payload: { test: true } });
    assert.equal(msg.protocol, PROTOCOL_NAME);
    assert.equal(msg.message_type, 'hello');
    assert.ok(msg.message_id.startsWith('msg_'));
    assert.ok(msg.timestamp);
    assert.deepEqual(msg.payload, { test: true });
  });

  it('rejects invalid message type', () => {
    assert.throws(() => buildMessage({ messageType: 'invalid' }), /Invalid message type/);
  });
});

describe('typed message builders', () => {
  it('buildHello includes env_fingerprint', () => {
    const msg = buildHello({});
    assert.equal(msg.message_type, 'hello');
    assert.ok(msg.payload.env_fingerprint);
  });

  it('buildPublish requires asset with type and id', () => {
    assert.throws(() => buildPublish({}), /asset must have type and id/);
    assert.throws(() => buildPublish({ asset: { type: 'Gene' } }), /asset must have type and id/);

    const msg = buildPublish({ asset: { type: 'Gene', id: 'g1' } });
    assert.equal(msg.message_type, 'publish');
    assert.equal(msg.payload.asset_type, 'Gene');
    assert.equal(msg.payload.local_id, 'g1');
    assert.ok(msg.payload.signature);
  });

  it('buildFetch creates a fetch message', () => {
    const msg = buildFetch({ assetType: 'Capsule', localId: 'c1' });
    assert.equal(msg.message_type, 'fetch');
    assert.equal(msg.payload.asset_type, 'Capsule');
  });

  it('buildReport creates a report message', () => {
    const msg = buildReport({ assetId: 'sha256:abc', validationReport: { ok: true } });
    assert.equal(msg.message_type, 'report');
    assert.equal(msg.payload.target_asset_id, 'sha256:abc');
  });

  it('buildDecision validates decision values', () => {
    assert.throws(() => buildDecision({ decision: 'maybe' }), /decision must be/);

    for (const d of ['accept', 'reject', 'quarantine']) {
      const msg = buildDecision({ decision: d, assetId: 'test' });
      assert.equal(msg.payload.decision, d);
    }
  });

  it('buildRevoke creates a revoke message', () => {
    const msg = buildRevoke({ assetId: 'sha256:abc', reason: 'outdated' });
    assert.equal(msg.message_type, 'revoke');
    assert.equal(msg.payload.reason, 'outdated');
  });
});

describe('isValidProtocolMessage', () => {
  it('returns true for well-formed messages', () => {
    const msg = buildHello({});
    assert.ok(isValidProtocolMessage(msg));
  });

  it('returns false for null/undefined', () => {
    assert.ok(!isValidProtocolMessage(null));
    assert.ok(!isValidProtocolMessage(undefined));
  });

  it('returns false for wrong protocol', () => {
    assert.ok(!isValidProtocolMessage({ protocol: 'other', message_type: 'hello', message_id: 'x', timestamp: 'y' }));
  });

  it('returns false for missing fields', () => {
    assert.ok(!isValidProtocolMessage({ protocol: PROTOCOL_NAME }));
  });
});

describe('unwrapAssetFromMessage', () => {
  it('extracts asset from publish message', () => {
    const asset = { type: 'Gene', id: 'g1', strategy: ['test'] };
    const msg = buildPublish({ asset });
    const result = unwrapAssetFromMessage(msg);
    assert.equal(result.type, 'Gene');
    assert.equal(result.id, 'g1');
  });

  it('returns plain asset objects as-is', () => {
    const gene = { type: 'Gene', id: 'g1' };
    assert.deepEqual(unwrapAssetFromMessage(gene), gene);

    const capsule = { type: 'Capsule', id: 'c1' };
    assert.deepEqual(unwrapAssetFromMessage(capsule), capsule);
  });

  it('returns null for unrecognized input', () => {
    assert.equal(unwrapAssetFromMessage(null), null);
    assert.equal(unwrapAssetFromMessage({ random: true }), null);
    assert.equal(unwrapAssetFromMessage('string'), null);
  });
});

describe('sendHeartbeat log touch', () => {
  var tmpDir;
  var originalFetch;
  var originalHubUrl;
  var originalLogsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-hb-test-'));
    originalHubUrl = process.env.A2A_HUB_URL;
    originalLogsDir = process.env.EVOLVER_LOGS_DIR;
    process.env.A2A_HUB_URL = 'http://localhost:19999';
    process.env.EVOLVER_LOGS_DIR = tmpDir;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
    if (originalHubUrl === undefined) {
      delete process.env.A2A_HUB_URL;
    } else {
      process.env.A2A_HUB_URL = originalHubUrl;
    }
    if (originalLogsDir === undefined) {
      delete process.env.EVOLVER_LOGS_DIR;
    } else {
      process.env.EVOLVER_LOGS_DIR = originalLogsDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates mtime of existing evolver_loop.log on successful heartbeat', async () => {
    var logPath = path.join(tmpDir, 'evolver_loop.log');
    fs.writeFileSync(logPath, '');
    var oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(logPath, oldTime, oldTime);

    global.fetch = async () => ({
      json: async () => ({ status: 'ok' }),
    });

    var result = await sendHeartbeat();
    assert.ok(result.ok, 'heartbeat should succeed');

    var mtime = fs.statSync(logPath).mtimeMs;
    assert.ok(mtime > oldTime.getTime(), 'mtime should be newer than the pre-set old time');
  });

  it('creates evolver_loop.log when it does not exist on successful heartbeat', async () => {
    var logPath = path.join(tmpDir, 'evolver_loop.log');
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

    global.fetch = async () => ({
      json: async () => ({ status: 'ok' }),
    });

    var result = await sendHeartbeat();
    assert.ok(result.ok, 'heartbeat should succeed');
    assert.ok(fs.existsSync(logPath), 'evolver_loop.log should be created when missing');
  });
});
