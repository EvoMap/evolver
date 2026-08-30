#!/usr/bin/env node
// EvoX 产品工具的按需 stdio 代理；本进程绝不监听端口。
// Desktop 通过 ~/.evox/product-bridge.json（或 EVOX_PRODUCT_BRIDGE_GRANT_FILE）发布授权。
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const GRANT_SCHEMA = 'evox.product_bridge.grant.v1';
const GRANT_HEADER = 'X-Evox-Product-Bridge-Grant';
const NONCE_HEADER = 'X-Evox-Product-Bridge-Nonce';
const MAX_GRANT_BYTES = 64 * 1024;
export const MAX_STDIO_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_IN_FLIGHT_REQUESTS = 32;
export const MAX_PENDING_STDIO_FRAMES = 64;
export const MAX_PENDING_STDIO_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
export function grantFilePath(env = process.env) {
    const override = String(env['EVOX_PRODUCT_BRIDGE_GRANT_FILE'] ?? '').trim();
    if (override)
        return override;
    return join(homedir(), '.evox', 'product-bridge.json');
}
export function isLoopbackHttp(raw) {
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        return url.protocol === 'http:' && (host === '127.0.0.1' || host === '::1' || host === '[::1]');
    }
    catch {
        return false;
    }
}
export function readGrant(filePath = grantFilePath()) {
    if (!existsSync(filePath)) {
        throw new Error('EvoX Desktop is not publishing a product-bridge grant. Start EvoX Desktop and retry.');
    }
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_GRANT_BYTES) {
        throw new Error('product-bridge grant file is not a regular file');
    }
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (data.schema !== GRANT_SCHEMA) {
        throw new Error(`product-bridge grant schema is not ${GRANT_SCHEMA}`);
    }
    if (!isLoopbackHttp(String(data.url ?? '')) || !String(data.grant ?? '').trim()) {
        throw new Error('product-bridge grant is missing a loopback URL or token');
    }
    return { url: String(data.url).trim(), grant: String(data.grant).trim() };
}
function postJson(url, body, headers) {
    return new Promise((resolvePromise, reject) => {
        const target = new URL(url);
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        if (payload.length > MAX_STDIO_FRAME_BYTES) {
            reject(new Error('product-bridge request is too large'));
            return;
        }
        const req = http.request({
            protocol: target.protocol,
            hostname: target.hostname.replace(/^\[(.*)\]$/, '$1'),
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
        }, (res) => {
            const chunks = [];
            let size = 0;
            let oversized = false;
            res.on('data', (chunk) => {
                if (oversized)
                    return;
                size += chunk.length;
                if (size > MAX_STDIO_FRAME_BYTES) {
                    oversized = true;
                    req.destroy(new Error('product-bridge response is too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (oversized)
                    return;
                if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
                    reject(new Error(`product-bridge returned HTTP ${res.statusCode ?? 500}`));
                    return;
                }
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                if (!raw) {
                    resolvePromise(undefined);
                    return;
                }
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        reject(new Error('product-bridge returned a non-object JSON-RPC message'));
                        return;
                    }
                    resolvePromise(parsed);
                }
                catch {
                    reject(new Error('product-bridge returned invalid JSON'));
                }
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy(new Error('product-bridge request timed out'));
        });
        req.on('error', reject);
        req.end(payload);
    });
}
function rpcError(id, message, code = -32000) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function isJsonRpcResponse(req) {
    return req.id !== undefined && ('result' in req || 'error' in req) && req.method === undefined;
}
/** 将请求、通知和客户端响应转发到回环 product bridge。 */
export async function dispatch(req) {
    if (!req || req.jsonrpc !== '2.0')
        return rpcError(req?.id, 'invalid JSON-RPC request', -32600);
    const isRequest = typeof req.method === 'string' && req.method.length > 0;
    const isResponse = isJsonRpcResponse(req);
    if (!isRequest && !isResponse)
        return rpcError(req.id, 'invalid JSON-RPC request', -32600);
    const expectsResponse = isRequest && req.id !== undefined;
    let grant;
    try {
        grant = readGrant();
    }
    catch (error) {
        return expectsResponse ? rpcError(req.id, error instanceof Error ? error.message : String(error)) : null;
    }
    const headers = { [GRANT_HEADER]: grant.grant };
    if (req.method === 'tools/call')
        headers[NONCE_HEADER] = randomBytes(16).toString('hex');
    try {
        const response = await postJson(grant.url, req, headers);
        if (!expectsResponse)
            return null;
        if (!response)
            return rpcError(req.id, 'product-bridge returned an empty response');
        response['id'] = req.id;
        response['jsonrpc'] = '2.0';
        return response;
    }
    catch (error) {
        return expectsResponse ? rpcError(req.id, error instanceof Error ? error.message : String(error)) : null;
    }
}
/** MCP stdio 使用换行分隔 JSON；解码器限制单帧大小，并排出当前缓冲区中的全部完整帧。 */
export class StdioLineDecoder {
    pending = Buffer.alloc(0);
    discardingOversized = false;
    push(chunk) {
        const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        const frames = [];
        let oversizedFrames = 0;
        let offset = 0;
        while (offset < incoming.length) {
            if (this.discardingOversized) {
                const newline = incoming.indexOf(0x0a, offset);
                if (newline === -1)
                    break;
                this.discardingOversized = false;
                offset = newline + 1;
                continue;
            }
            const newline = incoming.indexOf(0x0a, offset);
            if (newline === -1) {
                const tail = incoming.subarray(offset);
                if (this.pending.length + tail.length > MAX_STDIO_FRAME_BYTES) {
                    this.pending = Buffer.alloc(0);
                    this.discardingOversized = true;
                    oversizedFrames += 1;
                }
                else {
                    this.pending = Buffer.concat([this.pending, tail]);
                }
                break;
            }
            let line = Buffer.concat([this.pending, incoming.subarray(offset, newline)]);
            this.pending = Buffer.alloc(0);
            offset = newline + 1;
            if (line.at(-1) === 0x0d)
                line = line.subarray(0, -1);
            if (line.length === 0)
                continue;
            if (line.length > MAX_STDIO_FRAME_BYTES) {
                oversizedFrames += 1;
                continue;
            }
            frames.push(line.toString('utf8'));
        }
        return { frames, oversizedFrames };
    }
    finish() {
        const incomplete = this.pending.length > 0;
        this.pending = Buffer.alloc(0);
        return { incomplete };
    }
}
/** 对等待转发的完整帧同时施加数量和字节上限。 */
export class BoundedStdioFrameQueue {
    frames = [];
    queuedBytes = 0;
    get length() { return this.frames.length; }
    get bytes() { return this.queuedBytes; }
    enqueue(frame) {
        const bytes = Buffer.byteLength(frame, 'utf8');
        if (this.frames.length >= MAX_PENDING_STDIO_FRAMES || this.queuedBytes + bytes > MAX_PENDING_STDIO_BYTES) {
            return false;
        }
        this.frames.push({ frame, bytes });
        this.queuedBytes += bytes;
        return true;
    }
    shift() {
        const item = this.frames.shift();
        if (!item)
            return undefined;
        this.queuedBytes -= item.bytes;
        return item.frame;
    }
    isBelowResumeWatermark() {
        return this.frames.length <= Math.floor(MAX_PENDING_STDIO_FRAMES / 2)
            && this.queuedBytes <= Math.floor(MAX_PENDING_STDIO_BYTES / 2);
    }
}
/** 启动可注入流和转发函数的 stdio bridge，便于验证背压与协议行为。 */
export function runStdioBridge(input = process.stdin, output = process.stdout, dispatchMessage = dispatch) {
    const decoder = new StdioLineDecoder();
    const pendingFrames = new BoundedStdioFrameQueue();
    let inFlight = 0;
    let inputPaused = false;
    let outputBlocked = false;
    const writeMessage = (message) => {
        if (!output.write(`${JSON.stringify(message)}\n`)) {
            outputBlocked = true;
            pauseInput();
        }
    };
    const processFrame = async (frame) => {
        let req;
        try {
            const parsed = JSON.parse(frame);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                writeMessage(rpcError(null, 'invalid JSON-RPC request', -32600));
                return;
            }
            req = parsed;
        }
        catch (error) {
            writeMessage(rpcError(null, error instanceof Error ? error.message : String(error), -32700));
            return;
        }
        const response = await dispatchMessage(req);
        if (response)
            writeMessage(response);
    };
    const processFrameSafely = (frame) => {
        void processFrame(frame).catch((error) => {
            writeMessage(rpcError(null, error instanceof Error ? error.message : String(error)));
        }).finally(() => {
            inFlight -= 1;
            drainFrames();
        });
    };
    const pauseInput = () => {
        if (inputPaused)
            return;
        inputPaused = true;
        input.pause();
    };
    const resumeInputIfSafe = () => {
        if (!inputPaused || outputBlocked || !pendingFrames.isBelowResumeWatermark())
            return;
        inputPaused = false;
        input.resume();
    };
    const writeOverloadForRequest = (frame) => {
        try {
            const parsed = JSON.parse(frame);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return;
            const request = parsed;
            if (typeof request.method === 'string' && request.id !== undefined) {
                writeMessage(rpcError(request.id, 'product-bridge stdio queue is full', -32001));
            }
        }
        catch {
            // 语法错误会由正常解析路径报告；过载路径不再保留该帧。
        }
    };
    function drainFrames() {
        while (!outputBlocked && inFlight < MAX_IN_FLIGHT_REQUESTS && pendingFrames.length > 0) {
            const frame = pendingFrames.shift();
            if (frame === undefined)
                return;
            inFlight += 1;
            processFrameSafely(frame);
        }
        resumeInputIfSafe();
    }
    output.on('drain', () => {
        outputBlocked = false;
        drainFrames();
    });
    input.on('data', (chunk) => {
        const decoded = decoder.push(chunk);
        for (let index = 0; index < decoded.oversizedFrames; index += 1) {
            writeMessage(rpcError(null, 'product-bridge stdio frame is too large', -32600));
        }
        for (const frame of decoded.frames) {
            if (!outputBlocked && inFlight < MAX_IN_FLIGHT_REQUESTS && pendingFrames.length === 0) {
                inFlight += 1;
                processFrameSafely(frame);
            }
            else if (!pendingFrames.enqueue(frame)) {
                pauseInput();
                writeOverloadForRequest(frame);
            }
        }
        drainFrames();
    });
    input.on('end', () => {
        if (decoder.finish().incomplete)
            writeMessage(rpcError(null, 'incomplete newline-delimited JSON-RPC frame', -32700));
    });
}
function isEntrypoint() {
    const argvPath = process.argv[1];
    return argvPath !== undefined && resolve(argvPath) === resolve(fileURLToPath(import.meta.url));
}
if (isEntrypoint())
    runStdioBridge();