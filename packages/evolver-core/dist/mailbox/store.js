import { mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { ulid as makeUlid } from 'ulid';
import { createEnvelope } from './envelope.js';
const nodeRequire = createRequire(import.meta.url);
function isBunRuntime() {
    return typeof process.versions === 'object' && typeof process.versions.bun === 'string';
}
function openSqliteDatabase(path) {
    if (isBunRuntime()) {
        const { Database } = nodeRequire('bun:sqlite');
        return new Database(path);
    }
    // node:sqlite is exposed only as `node:sqlite` (no bare `sqlite` alias). Load it through createRequire so
    // bundlers do not statically strip the prefix and break Vitest/Vite or Bun standalone builds.
    const { DatabaseSync } = nodeRequire('node:sqlite');
    return new DatabaseSync(path);
}
export const MAX_ATTEMPTS = 5;
export const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
const JSONL_READ_CHUNK_BYTES = 64 * 1024;
export function expBackoffMs(attempt) {
    return Math.min(4000 * 2 ** (attempt - 1), 5 * 60 * 1000); // 4s→8s→…→5min
}
function forEachJsonlRecord(path, onRecord) {
    if (!existsSync(path))
        return;
    const maxLineBytes = Number.isFinite(Number(process.env['EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES']))
        && Number(process.env['EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES']) > 0
        ? Math.floor(Number(process.env['EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES']))
        : DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES;
    const buf = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
    let fd;
    let parts = [];
    let lineBytes = 0;
    let dropping = false;
    const reset = () => { parts = []; lineBytes = 0; dropping = false; };
    const append = (segment) => {
        if (dropping || segment.length === 0)
            return;
        if (lineBytes + segment.length > maxLineBytes) {
            reset();
            dropping = true;
            return;
        }
        parts.push(Buffer.from(segment));
        lineBytes += segment.length;
    };
    const finish = () => {
        if (dropping || lineBytes === 0) {
            reset();
            return;
        }
        const text = Buffer.concat(parts, lineBytes).toString('utf8').trim();
        reset();
        if (!text)
            return;
        try {
            onRecord(JSON.parse(text));
        }
        catch { /* skip corrupt rows */ }
    };
    try {
        fd = openSync(path, 'r');
        for (;;) {
            const bytes = readSync(fd, buf, 0, buf.length, null);
            if (bytes <= 0)
                break;
            let start = 0;
            for (let i = 0; i < bytes; i += 1) {
                if (buf[i] !== 0x0a)
                    continue;
                append(buf.subarray(start, i));
                finish();
                start = i + 1;
            }
            if (start < bytes)
                append(buf.subarray(start, bytes));
        }
        finish();
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function rowToEnvelope(r) {
    return {
        id: r['id'], type: r['type'], direction: r['direction'],
        status: r['status'], handler: r['handler'],
        payload: r['payload'] ? JSON.parse(r['payload']) : {},
        correlationId: r['correlationId'], replyTo: r['replyTo'] ?? null,
        receiptId: r['receiptId'], idempotencyKey: r['idempotencyKey'],
        sourceAgent: r['sourceAgent'], targetAgent: r['targetAgent'],
        runtimeNamespace: r['runtimeNamespace'],
        attempts: r['attempts'], nextRetryAt: r['nextRetryAt'] ?? null,
        ttlAt: r['ttlAt'] ?? null,
        createdAt: r['createdAt'], updatedAt: r['updatedAt'],
        schemaVersion: r['schemaVersion'], feedsMaterial: Boolean(r['feedsMaterial']),
    };
}
/** mailbox sqlite 引擎 (WAL + busy_timeout). 状态机 pending→in_flight→done/failed/expired + 租约 + 重试/DLQ. */
export class MailboxStore {
    db;
    constructor(opts) {
        mkdirSync(dirname(opts.path), { recursive: true });
        this.db = openSqliteDatabase(opts.path);
        this.db.exec('PRAGMA journal_mode = WAL');
        // PRAGMA can't be parameterized, so the value is string-interpolated — sanitize to a non-negative integer
        // first so a non-numeric busyTimeoutMs can never become SQL injection (defense-in-depth; #196).
        const rawBusy = Number(opts.busyTimeoutMs ?? 5000);
        const busyTimeoutMs = Number.isFinite(rawBusy) ? Math.max(0, Math.floor(rawBusy)) : 5000;
        this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, type TEXT, direction TEXT, status TEXT, handler TEXT,
      payload TEXT, correlationId TEXT, replyTo TEXT, receiptId TEXT, idempotencyKey TEXT,
      sourceAgent TEXT, targetAgent TEXT, runtimeNamespace TEXT,
      attempts INTEGER, nextRetryAt INTEGER, ttlAt INTEGER, createdAt INTEGER, updatedAt INTEGER,
      schemaVersion TEXT, feedsMaterial INTEGER, dlq INTEGER DEFAULT 0, leasedUntil INTEGER, workerId TEXT, lastError TEXT)`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_status ON messages(status, handler)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_corr ON messages(correlationId)');
        this.db.exec('CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, result TEXT, at INTEGER)');
        this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    }
    /** 通用 KV 状态(M6: sync 游标 inbound_cursor / lifecycle reauth 退避 / node_id 等). */
    getState(key) {
        const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(key);
        return r ? r['v'] : undefined;
    }
    setState(key, value) {
        this.db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, value);
    }
    /** 投递; 同 id 幂等(OR IGNORE). 返回 receiptId. */
    send(e) {
        const r = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id,type,direction,status,handler,payload,correlationId,replyTo,receiptId,idempotencyKey,sourceAgent,targetAgent,runtimeNamespace,attempts,nextRetryAt,ttlAt,createdAt,updatedAt,schemaVersion,feedsMaterial,dlq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(e.id, e.type, e.direction, e.status, e.handler, JSON.stringify(e.payload), e.correlationId, e.replyTo, e.receiptId, e.idempotencyKey, e.sourceAgent, e.targetAgent, e.runtimeNamespace, e.attempts, e.nextRetryAt, e.ttlAt, e.createdAt, e.updatedAt, e.schemaVersion, e.feedsMaterial ? 1 : 0);
        return { receiptId: e.id, stored: Number(r.changes) > 0 };
    }
    getById(id) {
        const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        return r ? rowToEnvelope(r) : undefined;
    }
    list(opts = {}) {
        const where = [];
        const args = [];
        if (opts.status) {
            where.push('status = ?');
            args.push(opts.status);
        }
        if (opts.handler) {
            where.push('handler = ?');
            args.push(opts.handler);
        }
        if (opts.runtimeNamespace) {
            where.push('runtimeNamespace = ?');
            args.push(opts.runtimeNamespace);
        }
        const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt LIMIT ?`;
        // Clamp the LIMIT bind. The IPC list route feeds this `?limit=` straight from an external query string, so a
        // non-finite value (NaN from `?limit=abc`, Infinity from `?limit=1e400`) would bind as null/error and a huge
        // finite value is an unbounded read (memory DoS) even on the token-authed endpoint. Finite + positive + capped.
        const lim = Number.isFinite(opts.limit) && opts.limit > 0
            ? Math.min(Math.floor(opts.limit), 10_000)
            : 1000;
        args.push(lim);
        return this.db.prepare(sql).all(...args).map(rowToEnvelope);
    }
    countByStatus(status) {
        return Number(this.db.prepare('SELECT COUNT(*) c FROM messages WHERE status = ?').get(status)['c']);
    }
    /** pending 计数(可按 handler/runtimeNamespace 分区), 用于 agent wake 去抖. */
    countPending(handler, runtimeNamespace) {
        const where = ["status='pending'", 'dlq=0'];
        const args = [];
        if (handler !== undefined) {
            where.push('handler=?');
            args.push(handler);
        }
        if (runtimeNamespace !== undefined) {
            where.push('runtimeNamespace=?');
            args.push(runtimeNamespace);
        }
        return Number(this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where.join(' AND ')}`).get(...args)['c']);
    }
    /** 只统计「现在就能 claim」的出站, 供 cadence 判定, 避免 deferred 拉低 idle 退避.
     *  谓词须与 claim() 对齐: 到点 pending + 租约过期的 in_flight 孤儿; 否则孤儿出站(claim 能回收却不被计)会被误判 idle, 恢复最多慢一个 idle 周期. */
    countClaimable(handler, now, runtimeNamespace) {
        const where = ['dlq=0', 'handler=?', "(status='pending' OR (status='in_flight' AND leasedUntil < ?))", '(nextRetryAt IS NULL OR nextRetryAt <= ?)'];
        const args = [handler, now, now];
        if (runtimeNamespace !== undefined) {
            where.push('runtimeNamespace=?');
            args.push(runtimeNamespace);
        }
        return Number(this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where.join(' AND ')}`).get(...args)['c']);
    }
    hasMessageWithIdempotencyKey(idempotencyKey) {
        return this.db.prepare('SELECT 1 FROM messages WHERE idempotencyKey = ? LIMIT 1').get(idempotencyKey) !== undefined;
    }
    hasMessageWithPayload(type, payload) {
        return this.db.prepare('SELECT 1 FROM messages WHERE type = ? AND payload = ? LIMIT 1')
            .get(type, JSON.stringify(payload)) !== undefined;
    }
    /** 原子 claim: pending(或租约过期的 in_flight) → in_flight + 租约. 可按 runtimeNamespace 分区. */
    claim(handler, limit, leaseMs, now, runtimeNamespace) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const nsClause = runtimeNamespace !== undefined ? ' AND runtimeNamespace=?' : '';
            const nsArgs = runtimeNamespace !== undefined ? [runtimeNamespace] : [];
            const rows = this.db.prepare(`SELECT * FROM messages WHERE handler=? AND dlq=0
         AND (status='pending' OR (status='in_flight' AND leasedUntil < ?))
         AND (nextRetryAt IS NULL OR nextRetryAt <= ?)${nsClause}
         ORDER BY createdAt LIMIT ?`).all(handler, now, now, ...nsArgs, limit);
            const workerId = makeUlid();
            const upd = this.db.prepare(`UPDATE messages SET status='in_flight', leasedUntil=?, workerId=?, updatedAt=? WHERE id=?`);
            for (const r of rows)
                upd.run(now + leaseMs, workerId, now, r['id']);
            this.db.exec('COMMIT');
            return rows.map((r) => ({ ...rowToEnvelope(r), status: 'in_flight' }));
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    complete(id, now) {
        this.db.prepare(`UPDATE messages SET status='done', leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`).run(now, id);
    }
    /** 失败: attempts<N→退避回 pending; ≥N→DLQ(不自动丢). */
    fail(id, err, now, maxAttempts = MAX_ATTEMPTS) {
        const m = this.getById(id);
        if (!m)
            return;
        const attempts = m.attempts + 1;
        if (attempts >= maxAttempts) {
            this.db.prepare(`UPDATE messages SET status='failed', dlq=1, attempts=?, lastError=?, leasedUntil=NULL, updatedAt=? WHERE id=?`).run(attempts, err, now, id);
        }
        else {
            this.db.prepare(`UPDATE messages SET status='pending', attempts=?, nextRetryAt=?, lastError=?, leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`)
                .run(attempts, now + expBackoffMs(attempts), err, now, id);
        }
    }
    /** 暂缓: transient upstream outage 不消耗 attempts, 仅设置下次可 claim 时间. */
    defer(id, err, now, retryAfterMs) {
        const delay = Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
        this.db.prepare(`UPDATE messages SET status='pending', nextRetryAt=?, lastError=?, leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`)
            .run(now + delay, err, now, id);
    }
    /** DLQ 重放(人工/agent 显式, 不自动丢). */
    replayDlq(id, now) {
        this.db.prepare(`UPDATE messages SET status='pending', dlq=0, attempts=0, nextRetryAt=NULL, leasedUntil=NULL, updatedAt=? WHERE id=?`).run(now, id);
    }
    dlq() { return this.db.prepare('SELECT * FROM messages WHERE dlq=1').all().map(rowToEnvelope); }
    /** TTL 扫描: ttlAt 过期且未 done/dlq → expired. */
    expireOld(now) {
        const r = this.db.prepare(`UPDATE messages SET status='expired', updatedAt=? WHERE ttlAt < ? AND status NOT IN ('done','expired') AND dlq=0`).run(now, now);
        return Number(r.changes);
    }
    /** M2-5 关联线程: 同 correlationId 全部消息(请求+应答), 按 createdAt 排序. */
    findByCorrelation(correlationId) {
        return this.db.prepare('SELECT * FROM messages WHERE correlationId=? ORDER BY createdAt').all(correlationId).map(rowToEnvelope);
    }
    /** 关联线程中除 requestId 外最新一条 = 应答(durable, 跨重启/进程). */
    getReply(correlationId, requestId) {
        const r = this.db.prepare('SELECT * FROM messages WHERE correlationId=? AND id<>? ORDER BY createdAt DESC LIMIT 1').get(correlationId, requestId);
        return r ? rowToEnvelope(r) : undefined;
    }
    /** 构造并投递一条对 `to` 的应答(继承 correlationId, 收发方对调, replyTo 清空). */
    reply(to, replyType, payload, now, over = {}) {
        const env = createEnvelope({
            type: replyType,
            payload,
            correlationId: to.correlationId,
            sourceAgent: to.targetAgent,
            targetAgent: to.sourceAgent,
            runtimeNamespace: to.runtimeNamespace,
            replyTo: null,
            now,
            ...over,
        });
        const res = this.send(env);
        return { envelope: env, ...res };
    }
    /** M2-5 轻量状态视图(运维/IPC 查询用). */
    getStatus(id) {
        const r = this.db.prepare('SELECT id,type,status,attempts,nextRetryAt,ttlAt,dlq FROM messages WHERE id=?').get(id);
        if (!r)
            return undefined;
        return {
            id: r['id'], type: r['type'], status: r['status'],
            attempts: Number(r['attempts']), nextRetryAt: r['nextRetryAt'] ?? null,
            ttlAt: r['ttlAt'] ?? null, dlq: Number(r['dlq']) === 1,
        };
    }
    /** 幂等(A13): 副作用 handler 用 idempotencyKey 去重; 命中返缓存不重跑. */
    isProcessed(key) { return this.db.prepare('SELECT 1 FROM idempotency WHERE key=?').get(key) !== undefined; }
    getProcessed(key) {
        const r = this.db.prepare('SELECT result FROM idempotency WHERE key=?').get(key);
        return r ? JSON.parse(r['result']) : undefined;
    }
    markProcessed(key, result, now) {
        this.db.prepare('INSERT OR IGNORE INTO idempotency (key,result,at) VALUES (?,?,?)').run(key, JSON.stringify(result ?? null), now);
    }
    /** v1 messages.jsonl → sqlite 迁移(幂等可重入). */
    importJsonl(path) {
        let n = 0;
        forEachJsonlRecord(path, (record) => {
            try {
                if (this.send(record).stored)
                    n += 1;
            }
            catch { /* skip */ }
        });
        return n;
    }
    close() { this.db.close(); }
}