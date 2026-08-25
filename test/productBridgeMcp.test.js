'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const productBridgeMcp = require('../src/adapters/productBridgeMcp');
const shim = require('../src/adapters/scripts/evox-product-shim.js');
const claudeAdapter = require('../src/adapters/claudeCode');
const codexAdapter = require('../src/adapters/codex');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-product-bridge-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const evolverRoot = path.resolve(__dirname, '..');

describe('productBridgeMcp writer', () => {
  it('installs a managed evox-product entry in .mcp.json without touching others', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({
        mcpServers: { playwright: { command: 'npx' } },
      }));
      const result = productBridgeMcp.installClaudeJson({
        configRoot: tmp, evolverRoot, force: false,
      });
      assert.equal(result.changed, true);
      const data = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
      assert.deepEqual(data.mcpServers.playwright, { command: 'npx' });
      assert.equal(data.mcpServers['evox-product']._evox_product_managed, true);
      assert.equal(data.mcpServers['evox-product'].command, process.execPath);
      assert.equal(
        data.mcpServers['evox-product'].args[0],
        productBridgeMcp.shimPath(evolverRoot)
      );
      assert.equal(data._evolver_managed, undefined);
    } finally { cleanup(tmp); }
  });

  it('leaves a user-owned evox-product Claude entry in place', () => {
    const tmp = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({
        mcpServers: { 'evox-product': { command: 'other' } },
      }));
      const result = productBridgeMcp.installClaudeJson({
        configRoot: tmp, evolverRoot, force: false,
      });
      assert.equal(result.skipped, true);
      const data = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
      assert.equal(data.mcpServers['evox-product'].command, 'other');
    } finally { cleanup(tmp); }
  });

  it('uninstall removes only a managed Claude evox-product entry', () => {
    const tmp = makeTmpDir();
    try {
      productBridgeMcp.installClaudeJson({ configRoot: tmp, evolverRoot, force: true });
      const mcpPath = path.join(tmp, '.mcp.json');
      const data = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      data.mcpServers.playwright = { command: 'npx' };
      fs.writeFileSync(mcpPath, JSON.stringify(data));
      assert.equal(productBridgeMcp.uninstallClaudeJson({ configRoot: tmp }), true);
      const after = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      assert.equal(after.mcpServers['evox-product'], undefined);
      assert.deepEqual(after.mcpServers.playwright, { command: 'npx' });
    } finally { cleanup(tmp); }
  });

  it('installs and uninstalls a managed Codex MCP table without rewriting [features]', () => {
    const tmp = makeTmpDir();
    try {
      const tomlPath = path.join(tmp, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
      fs.writeFileSync(tomlPath, '[features]\ncodex_hooks = true\nuser_feature = true\n');
      const result = productBridgeMcp.installCodexToml({
        configRoot: tmp, evolverRoot, force: false,
      });
      assert.equal(result.changed, true);
      const installed = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(installed.includes('[features]'));
      assert.ok(installed.includes('user_feature = true'));
      assert.ok(installed.includes(productBridgeMcp.TOML_MARKER));
      assert.ok(installed.includes(`[${productBridgeMcp.TOML_SECTION}]`));
      assert.ok(installed.includes(productBridgeMcp.shimPath(evolverRoot)));

      assert.equal(productBridgeMcp.uninstallCodexToml({ configRoot: tmp }), true);
      const after = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(!after.includes('evox-product'));
      assert.ok(after.includes('user_feature = true'));
      assert.ok(after.includes('codex_hooks = true'));
    } finally { cleanup(tmp); }
  });

  it('leaves a user-owned Codex evox-product table in place', () => {
    const tmp = makeTmpDir();
    try {
      const tomlPath = path.join(tmp, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
      fs.writeFileSync(
        tomlPath,
        '[mcp_servers.evox-product]\ncommand = "other"\nargs = ["mine"]\n'
      );
      const result = productBridgeMcp.installCodexToml({
        configRoot: tmp, evolverRoot, force: false,
      });
      assert.equal(result.skipped, true);
      const after = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(after.includes('command = "other"'));
      assert.ok(!after.includes(productBridgeMcp.TOML_MARKER));
    } finally { cleanup(tmp); }
  });

  it('claude and codex adapters write and verify the product-bridge MCP', () => {
    const tmp = makeTmpDir();
    try {
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const claude = claudeAdapter.verify({ configRoot: tmp });
      assert.equal(claude.ok, true, JSON.stringify(claude.checks, null, 2));
      assert.ok(claude.checks.some(check => check.id === 'product_bridge_managed' && check.ok));

      claudeAdapter.uninstall({ configRoot: tmp });
      assert.ok(!fs.existsSync(path.join(tmp, '.mcp.json')));

      const tmp2 = makeTmpDir();
      try {
        codexAdapter.install({ configRoot: tmp2, evolverRoot, force: true });
        const codex = codexAdapter.verify({ configRoot: tmp2 });
        assert.equal(codex.ok, true, JSON.stringify(codex.checks, null, 2));
        assert.ok(codex.checks.some(check => check.id === 'product_bridge_managed' && check.ok));
        const toml = fs.readFileSync(path.join(tmp2, '.codex', 'config.toml'), 'utf8');
        assert.ok(toml.includes('codex_hooks = true'));
        assert.ok(toml.includes('[mcp_servers.evox-product]'));
      } finally { cleanup(tmp2); }
    } finally { cleanup(tmp); }
  });
});

describe('evox-product-shim', () => {
  it('accepts only loopback http grant URLs', () => {
    assert.equal(shim.isLoopbackHttp('http://127.0.0.1:9/mcp/product-bridge/x'), true);
    assert.equal(shim.isLoopbackHttp('http://localhost/mcp'), true);
    assert.equal(shim.isLoopbackHttp('https://127.0.0.1/mcp'), false);
    assert.equal(shim.isLoopbackHttp('http://example.com/mcp'), false);
  });

  it('fails closed when the grant file is missing or not loopback', () => {
    const tmp = makeTmpDir();
    try {
      const missing = path.join(tmp, 'missing.json');
      assert.throws(() => shim.readGrant(missing), /not publishing a product-bridge grant/);

      const bad = path.join(tmp, 'bad.json');
      fs.writeFileSync(bad, JSON.stringify({
        schema: shim.GRANT_SCHEMA,
        url: 'http://example.com/mcp',
        grant: 'ab',
      }));
      assert.throws(() => shim.readGrant(bad), /loopback URL or token/);
    } finally { cleanup(tmp); }
  });

  it('proxies initialize and sends a nonce only on tools/call', async () => {
    const tmp = makeTmpDir();
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          method: JSON.parse(Buffer.concat(chunks).toString('utf8')).method,
          grant: req.headers['x-evox-product-bridge-grant'],
          nonce: req.headers['x-evox-product-bridge-nonce'],
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const grantPath = path.join(tmp, 'product-bridge.json');
    fs.writeFileSync(grantPath, JSON.stringify({
      schema: shim.GRANT_SCHEMA,
      url: `http://127.0.0.1:${port}/mcp/product-bridge/token`,
      grant: 'abc123',
      boot_id: 1,
    }));
    const previous = process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE;
    process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE = grantPath;
    try {
      const init = await shim.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      assert.equal(init.result.ok, true);
      const call = await shim.dispatch({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_session' },
      });
      assert.equal(call.result.ok, true);
      assert.equal(seen[0].method, 'initialize');
      assert.equal(seen[0].grant, 'abc123');
      assert.equal(seen[0].nonce, undefined);
      assert.equal(seen[1].method, 'tools/call');
      assert.equal(seen[1].grant, 'abc123');
      assert.match(seen[1].nonce, /^[0-9a-f]{32}$/);
    } finally {
      if (previous === undefined) delete process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE;
      else process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE = previous;
      await new Promise(resolve => server.close(resolve));
      cleanup(tmp);
    }
  });

  it('stdio initialize fails closed without a grant file', async () => {
    const tmp = makeTmpDir();
    const previous = process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE;
    process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE = path.join(tmp, 'missing.json');
    const child = spawn(process.execPath, [
      path.join(evolverRoot, 'src', 'adapters', 'scripts', 'evox-product-shim.js'),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const payload = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
    }), 'utf8');
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('shim stdio timed out')), 5000);
      child.stdout.on('data', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.includes('\r\n\r\n')) return;
        const headerEnd = raw.indexOf('\r\n\r\n');
        const length = Number(/content-length:\s*(\d+)/i.exec(raw)[1]);
        const body = raw.slice(headerEnd + 4);
        if (Buffer.byteLength(body, 'utf8') < length) return;
        clearTimeout(timer);
        resolve(JSON.parse(body.slice(0, length)));
      });
      child.on('error', reject);
    });
    child.kill();
    if (previous === undefined) delete process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE;
    else process.env.EVOX_PRODUCT_BRIDGE_GRANT_FILE = previous;
    cleanup(tmp);
    assert.equal(response.error.message.includes('not publishing a product-bridge grant'), true);
  });
});
