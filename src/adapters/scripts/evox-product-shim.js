#!/usr/bin/env node
'use strict';

// Stdio MCP proxy for EvoX product tools. The host (Claude Code / Codex)
// launches this on demand; we never listen on a port. Desktop publishes
// the loopback URL + grant at ~/.evox/product-bridge.json (or
// EVOX_PRODUCT_BRIDGE_GRANT_FILE). Missing grant is a hard RPC error, not
// a fake empty tool list.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const GRANT_SCHEMA = 'evox.product_bridge.grant.v1';
const GRANT_HEADER = 'X-Evox-Product-Bridge-Grant';
const NONCE_HEADER = 'X-Evox-Product-Bridge-Nonce';
const MAX_GRANT_BYTES = 64 * 1024;
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function grantFilePath(env = process.env) {
  const override = String(env.EVOX_PRODUCT_BRIDGE_GRANT_FILE || '').trim();
  if (override) return override;
  return path.join(os.homedir(), '.evox', 'product-bridge.json');
}

function isLoopbackHttp(raw) {
  try {
    const url = new URL(String(raw || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'http:' && (
      host === '127.0.0.1' || host === 'localhost' || host === '::1'
    );
  } catch {
    return false;
  }
}

function readGrant(filePath = grantFilePath()) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    throw new Error(
      'EvoX Desktop is not publishing a product-bridge grant. Start EvoX Desktop and retry.'
    );
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_GRANT_BYTES) {
    throw new Error('product-bridge grant file is not a regular file');
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data || data.schema !== GRANT_SCHEMA) {
    throw new Error('product-bridge grant schema is not ' + GRANT_SCHEMA);
  }
  if (!isLoopbackHttp(data.url) || !String(data.grant || '').trim()) {
    throw new Error('product-bridge grant is missing a loopback URL or token');
  }
  return { url: String(data.url).trim(), grant: String(data.grant).trim() };
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    if (payload.length > MAX_RPC_BYTES) {
      reject(new Error('product-bridge request is too large'));
      return;
    }
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RPC_BYTES) {
          req.destroy();
          reject(new Error('product-bridge response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('product-bridge returned invalid JSON'));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('product-bridge request timed out'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function rpcError(id, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } };
}

async function dispatch(req) {
  if (!req || req.jsonrpc !== '2.0' || !req.method) {
    return rpcError(req && req.id, 'invalid JSON-RPC request');
  }
  if (req.id === undefined) return null;
  let grant;
  try {
    grant = readGrant();
  } catch (err) {
    return rpcError(req.id, err.message || String(err));
  }
  const headers = { [GRANT_HEADER]: grant.grant };
  if (req.method === 'tools/call') {
    headers[NONCE_HEADER] = crypto.randomBytes(16).toString('hex');
  }
  try {
    const response = await postJson(grant.url, req, headers);
    if (!response || typeof response !== 'object') {
      return rpcError(req.id, 'product-bridge returned an empty response');
    }
    response.id = req.id;
    response.jsonrpc = '2.0';
    return response;
  } catch (err) {
    return rpcError(req.id, err.message || String(err));
  }
}

function consumeFrames(buffer, onMessage) {
  let offset = 0;
  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) break;
    const header = buffer.slice(offset, headerEnd).toString('utf8');
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      throw new Error('stdio frame is missing Content-Length');
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
    onMessage(JSON.parse(body));
    offset = bodyStart + length;
  }
  return buffer.slice(offset);
}

async function main() {
  let pending = Buffer.alloc(0);
  let queue = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    try {
      pending = consumeFrames(pending, (message) => {
        queue = queue.then(async () => {
          const response = await dispatch(message);
          if (response) writeFrame(response);
        }).catch((err) => {
          writeFrame(rpcError(null, err.message || String(err)));
        });
      });
    } catch (err) {
      writeFrame(rpcError(null, err.message || String(err)));
      pending = Buffer.alloc(0);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  GRANT_SCHEMA,
  grantFilePath,
  isLoopbackHttp,
  readGrant,
  consumeFrames,
  dispatch,
};
