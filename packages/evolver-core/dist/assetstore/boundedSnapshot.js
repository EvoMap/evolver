import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { LOCAL_ASSET_FILES } from './assetStoreLayout.js';
import { parseProvenanceRecord, parseReviewRecord } from './assetSidecarRecords.js';
import { decodeReferencePair } from '../reference/decoder.js';
import { brandScanRawObject, isExecutionEligible } from '../reference/guard.js';
import { computeAssetId } from '../wire/index.js';
import { PosixSnapshotProcess, PosixSnapshotExitConfirmedError } from './boundedSnapshotPosix.js';
import { WindowsSnapshotReader } from './boundedSnapshotWindows.js';
import { createHash, randomUUID } from 'node:crypto';
import { recentRecords } from './recentRecords.js';
import { measureContextReadStage, startContextReadStage } from './contextReadDiagnostics.js';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
const snapshotInvocation = new AsyncLocalStorage();
function trackSnapshotInvocation(owned) {
    const invocation = snapshotInvocation.getStore();
    if (invocation) {
        invocation.pending.add(owned);
        void owned.finally(() => invocation.pending.delete(owned)).catch(() => undefined);
    }
    return owned;
}
async function closeInvocationWorkers(scope) {
    const outcomes = await Promise.allSettled([...scope.workers.values()].map(worker => worker.close()));
    const errors = outcomes.filter(result => result.status === 'rejected'
        && !(result.reason instanceof PosixSnapshotExitConfirmedError)).map(result => result.reason);
    if (errors.length)
        throw new AggregateError(errors, 'snapshot_cleanup_unconfirmed');
}
/** One product invocation may reuse its descriptor-owning process, never its
 * corpus or handles. Different roots keep independent workers; the same root
 * may borrow its process only after confirmed descriptor closes. Each query
 * opens and verifies a fresh reader. Root slots
 * stay admitted between queries and until the process's actual exit; a timed
 * out query poisons this invocation rather than silently starting a new worker. */
export function withSnapshotReadInvocation(run) {
    if (process.platform !== 'linux' && process.platform !== 'darwin')
        return run();
    const current = snapshotInvocation.getStore();
    if (current) {
        if (current.closed || current.poisoned)
            return Promise.reject(new Error('snapshot_invocation_closed'));
        return run();
    }
    const scope = { controller: new AbortController(), workers: new Map(), roots: new Map(), pending: new Set(),
        closed: false, poisoned: false };
    return snapshotInvocation.run(scope, async () => {
        try {
            return await run();
        }
        finally {
            scope.closed = true;
            // A caller deadline can settle before the original read/finally. Join
            // those reads before releasing any root; abort is termination intent only.
            if (scope.pending.size) {
                scope.poisoned = true;
                scope.controller.abort();
            }
            await Promise.allSettled([...scope.pending]);
            let cleanupConfirmed = false;
            // Per-query errors already describe lost reads. A failed graceful
            // shutdown followed by confirmed exit cannot revoke completed snapshots.
            try {
                await closeInvocationWorkers(scope);
                cleanupConfirmed = true;
            }
            finally {
                scope.controller.abort();
                if (cleanupConfirmed)
                    for (const [key, reader] of scope.roots) {
                        if (retainedSnapshotReaders.get(key)?.reader === reader)
                            retainedSnapshotReaders.delete(key);
                        if (activeSnapshotRoots.get(key) === reader)
                            activeSnapshotRoots.delete(key);
                    }
                else
                    for (const [key, reader] of scope.roots) {
                        if (activeSnapshotRoots.get(key) === reader)
                            retainedSnapshotReaders.set(key, { reader, recovering: false });
                    }
            }
        }
    });
}
const ROW_BYTES = 256 * 1024;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fingerprint = (s) => `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const missing = (error) => error?.code === 'ENOENT';
const limit = (n, fallback, max) => {
    const value = n ?? fallback;
    if (!Number.isInteger(value) || value < 0 || value > max)
        throw new Error('invalid_snapshot_budget');
    return value;
};
export async function withSnapshotDeadline(query, run) {
    if (query.deadlineAt !== undefined && !Number.isFinite(query.deadlineAt))
        throw new Error('invalid_snapshot_deadline');
    const controller = new AbortController();
    const abort = () => controller.abort();
    query.signal?.addEventListener('abort', abort, { once: true });
    const deadlineAt = query.deadlineAt ?? Date.now() + 1000;
    let timer;
    const schedule = () => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
            abort();
            return;
        }
        timer = setTimeout(schedule, Math.min(remaining, 0x7fffffff));
    };
    schedule();
    if (query.signal?.aborted || Date.now() >= deadlineAt)
        abort();
    let rejectAbort;
    try {
        const result = await Promise.race([
            Promise.resolve().then(() => {
                // The clock or cancellation may change while dispatch is queued, before
                // the deadline timer gets an event-loop turn. Do not start stale work.
                if (controller.signal.aborted || Date.now() >= deadlineAt) {
                    controller.abort();
                    throw new Error('snapshot_aborted');
                }
                return run(controller.signal);
            }),
            new Promise((_, reject) => {
                rejectAbort = () => reject(new Error('snapshot_aborted'));
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
                if (controller.signal.aborted)
                    rejectAbort();
            }),
        ]);
        // Synchronous final processing can finish before the overdue timer runs.
        if (controller.signal.aborted || Date.now() >= deadlineAt)
            throw new Error('snapshot_aborted');
        return result;
    }
    finally {
        clearTimeout(timer);
        query.signal?.removeEventListener('abort', abort);
        if (rejectAbort)
            controller.signal.removeEventListener('abort', rejectAbort);
        controller.abort();
    }
}
class SnapshotReader {
    query;
    signal;
    pageBytes;
    invocation;
    totalBytes = 0;
    rows = 0;
    states = new Map();
    maxRecords;
    fileBytes;
    totalLimit;
    windows;
    posix;
    directories = new Map();
    files = new Set();
    abortShared;
    closed = false;
    get reusable() { return this.closed; }
    constructor(query, signal, pageBytes, invocation, rootKey) {
        this.query = query;
        this.signal = signal;
        this.pageBytes = pageBytes;
        this.invocation = invocation;
        this.maxRecords = limit(query.maxRecords, 10000, 100000);
        this.fileBytes = limit(query.maxFileBytes, 4 * 1024 * 1024, 16 * 1024 * 1024);
        this.totalLimit = limit(query.maxTotalBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
        this.windows = process.platform === 'win32' ? new WindowsSnapshotReader(this) : undefined;
        if (invocation) {
            if (invocation.closed || invocation.poisoned)
                throw new Error('snapshot_invocation_closed');
            if (rootKey === undefined)
                throw new Error('invalid_snapshot_root');
            this.posix = invocation.workers.get(rootKey) ?? new PosixSnapshotProcess(invocation.controller.signal);
            invocation.workers.set(rootKey, this.posix);
            this.abortShared = () => { invocation.poisoned = true; invocation.controller.abort(); };
            signal.addEventListener('abort', this.abortShared, { once: true });
            if (signal.aborted)
                this.abortShared();
        }
        else
            this.posix = process.platform === 'linux' || process.platform === 'darwin' ? new PosixSnapshotProcess(signal) : undefined;
    }
    get bytesRead() { return this.totalBytes; }
    async close() {
        if (this.posix && !this.invocation) {
            await this.posix.close();
            this.files.clear();
            this.directories.clear();
            this.closed = true;
            return;
        }
        try {
            const outcomes = await Promise.allSettled([
                ...(this.windows ? [this.windows.close()] : []),
                ...[...this.files].map(async (fd) => { await fd.close(); this.files.delete(fd); }),
                ...[...this.directories].reverse().map(async ([path, fd]) => { await fd.close(); this.directories.delete(path); }),
            ]);
            const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
            if (errors.length) {
                const error = new AggregateError(errors, 'posix snapshot cleanup failed');
                if (this.invocation && this.posix) {
                    this.invocation.poisoned = true;
                    this.invocation.controller.abort();
                    try {
                        await closeInvocationWorkers(this.invocation);
                    }
                    catch (cleanup) {
                        if (!(cleanup instanceof PosixSnapshotExitConfirmedError))
                            throw new AggregateError([error, cleanup], 'snapshot_cleanup_unconfirmed');
                    }
                    throw new PosixSnapshotExitConfirmedError(error);
                }
                throw error;
            }
            // Recovery of a completed invocation must join the same actual process,
            // even when this reader's own descriptor closes previously succeeded.
            if (this.invocation?.closed)
                await closeInvocationWorkers(this.invocation);
            this.closed = true;
        }
        finally {
            if (this.abortShared)
                this.signal.removeEventListener('abort', this.abortShared);
        }
    }
    check() {
        if (this.signal.aborted || (this.query.deadlineAt !== undefined && Date.now() >= this.query.deadlineAt))
            throw new Error('snapshot_aborted');
    }
    async yield() { this.check(); await tick(); this.check(); }
    async stat(path, directory = false) {
        this.check();
        if (this.windows)
            return this.windows.stat(path, directory);
        try {
            if (!this.posix)
                throw new Error('unsupported_snapshot_platform');
            const s = await this.posix.lstat(path);
            if (!s)
                return 'missing';
            this.check();
            if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile()))
                throw new Error('unsafe_snapshot_path');
            return directory ? `${s.dev}:${s.ino}:${s.mode}` : fingerprint(s);
        }
        catch (error) {
            if (missing(error))
                return 'missing';
            throw error;
        }
    }
    async track(path, directory = false) {
        const state = await this.stat(path, directory);
        this.states.set(`${directory ? 'd' : 'f'}:${path}`, state);
        return state;
    }
    async pinDirectory(path, parent) {
        const before = await this.track(path, true);
        if (before === 'missing')
            return;
        let fd;
        if (!this.posix)
            throw new Error('unsupported_snapshot_platform');
        if (parent === undefined) {
            fd = await this.posix.openRoot(path);
        }
        else {
            const ancestor = this.directories.get(resolve(parent));
            if (!ancestor)
                throw new Error('snapshot_changed');
            fd = await this.posix.openChild(ancestor.fd, basename(path), true);
        }
        this.directories.set(resolve(path), fd);
        this.check();
        const state = await fd.stat();
        if (!state.isDirectory() || `${state.dev}:${state.ino}:${state.mode}` !== before)
            throw new Error('snapshot_changed');
        this.check();
    }
    async guard(baseDir) {
        if (this.windows) {
            await this.track(baseDir, true);
            await this.track(join(baseDir, 'references'), true);
        }
        else {
            await this.pinDirectory(baseDir);
            await this.pinDirectory(join(baseDir, 'references'), baseDir);
        }
        for (const file of ['.assetstore.lock', '.assetstore-bundle.json']) {
            if (await this.track(join(baseDir, file)) !== 'missing')
                throw new Error('snapshot_writer_active');
        }
    }
    async verify() {
        for (const [key, state] of this.states) {
            if (await this.stat(key.slice(2), key[0] === 'd') !== state)
                throw new Error('snapshot_changed');
        }
        this.check();
    }
    async openFile(path) {
        this.check();
        if (this.windows) {
            const file = await this.windows.open(path);
            if (!file)
                throw new Error('snapshot_changed');
            return file;
        }
        // A renamed/replaced references directory cannot redirect this read outside its pinned parent.
        const parent = this.directories.get(resolve(dirname(path)));
        if (!parent)
            throw new Error('snapshot_changed');
        if (!this.posix)
            throw new Error('unsupported_snapshot_platform');
        const fd = await this.posix.openChild(parent.fd, basename(path));
        this.files.add(fd);
        return {
            async stat() {
                const stat = await fd.stat();
                if (!stat.isFile())
                    throw new Error('snapshot_changed');
                return { state: fingerprint(stat), size: stat.size };
            },
            read: buffer => fd.read(buffer),
            close: async () => { await fd.close(); this.files.delete(fd); },
        };
    }
    async readChunk(fd, maximum) {
        this.check();
        const allowed = this.pageBytes ? await this.pageBytes.allow(maximum) : maximum;
        this.check();
        if (!Number.isInteger(allowed) || allowed < 1 || allowed > maximum)
            throw new Error('invalid_snapshot_budget');
        const buffer = Buffer.allocUnsafe(allowed);
        const bytesRead = await fd.read(buffer);
        this.check();
        this.totalBytes += bytesRead;
        this.pageBytes?.consumed(bytesRead);
        if (this.totalBytes > this.totalLimit)
            throw new Error('snapshot_byte_limit');
        return buffer.subarray(0, bytesRead);
    }
    async read(path) {
        const before = await this.track(path);
        if (before === 'missing')
            return null;
        const fd = await this.openFile(path);
        try {
            this.check();
            const stat = await fd.stat();
            this.check();
            if (stat.state !== before)
                throw new Error('snapshot_changed');
            if (stat.size > BigInt(this.fileBytes) || (!this.pageBytes && stat.size + BigInt(this.totalBytes) > BigInt(this.totalLimit)))
                throw new Error('snapshot_byte_limit');
            const chunks = [];
            const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
            let size = 0;
            // The captured size is already admitted against both byte limits. Do
            // not reserve extra worker budget for EOF or beyond the final chunk;
            // the final descriptor stat still rejects a concurrent size change.
            while (size < Number(stat.size)) {
                this.check();
                const buffer = await this.readChunk(fd, Math.min(64 * 1024, Number(stat.size) - size));
                const bytesRead = buffer.byteLength;
                if (bytesRead === 0)
                    break;
                size += bytesRead;
                if (size > this.fileBytes)
                    throw new Error('snapshot_byte_limit');
                chunks.push(decoder.decode(buffer, { stream: true }));
                await this.yield();
            }
            if ((await fd.stat()).state !== before)
                throw new Error('snapshot_changed');
            this.check();
            chunks.push(decoder.decode());
            return chunks.join('');
        }
        finally {
            await fd.close();
        }
    }
    async jsonl(path, parse, sidecar = false, beforeRecord, onRecord) {
        const raw = await this.read(path);
        if (raw === null)
            return [];
        if (sidecar && raw.length && !raw.endsWith('\n'))
            throw new Error('snapshot_unterminated_sidecar');
        const out = [];
        let start = 0;
        for (let at = 0; at <= raw.length; at++) {
            if (at > start + ROW_BYTES)
                throw new Error('snapshot_row_limit');
            if (at % 16384 === 0)
                await this.yield();
            if (at !== raw.length && raw[at] !== '\n')
                continue;
            const line = raw.slice(start, at);
            start = at + 1;
            if (!line.trim())
                continue;
            if (!sidecar)
                await beforeRecord?.();
            if (sidecar ? out.length >= 100000 : ++this.rows > this.maxRecords)
                throw new Error('snapshot_record_limit');
            if (Buffer.byteLength(line) > ROW_BYTES)
                throw new Error('snapshot_row_limit');
            const row = parse(JSON.parse(line));
            if (row === null)
                throw new Error('invalid_snapshot_row');
            out.push(row);
            if (!sidecar)
                onRecord?.(row);
            if (out.length % 32 === 0)
                await this.yield();
        }
        return out;
    }
    /** Keep one pinned file open across pages. Byte admission occurs before each
     * native read, so a page never preloads the remainder of a large JSONL file. */
    async scanGeneJsonl(path, beforeRecord, onRecord) {
        const before = await this.track(path);
        if (before === 'missing')
            return [];
        const fd = await this.openFile(path);
        try {
            this.check();
            const stat = await fd.stat();
            if (stat.state !== before)
                throw new Error('snapshot_changed');
            if (stat.size > BigInt(this.fileBytes))
                throw new Error('snapshot_byte_limit');
            const expected = Number(stat.size);
            const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
            const out = [];
            let size = 0, pending = '';
            const line = async (raw) => {
                if (!raw.trim())
                    return;
                await beforeRecord();
                if (++this.rows > this.maxRecords)
                    throw new Error('snapshot_record_limit');
                if (Buffer.byteLength(raw) > ROW_BYTES)
                    throw new Error('snapshot_row_limit');
                const record = assetRow(JSON.parse(raw), 'Gene');
                if (!record)
                    throw new Error('invalid_snapshot_row');
                out.push(record);
                onRecord(record);
                if (out.length % 32 === 0)
                    await this.yield();
            };
            while (size < expected) {
                const buffer = await this.readChunk(fd, Math.min(64 * 1024, expected - size));
                if (!buffer.length)
                    throw new Error('snapshot_changed');
                size += buffer.length;
                pending += decoder.decode(buffer, { stream: true });
                let end;
                while ((end = pending.indexOf('\n')) >= 0) {
                    await line(pending.slice(0, end));
                    pending = pending.slice(end + 1);
                }
                if (Buffer.byteLength(pending) > ROW_BYTES)
                    throw new Error('snapshot_row_limit');
                await this.yield();
            }
            pending += decoder.decode();
            await line(pending);
            if ((await fd.stat()).state !== before)
                throw new Error('snapshot_changed');
            this.check();
            return out;
        }
        finally {
            await fd.close();
        }
    }
    async envelope(path, beforeRecord, onRecord) {
        const raw = await this.read(path);
        if (raw === null)
            return [];
        let at = 0;
        const ws = async () => {
            while (/[ \t\r\n]/.test(raw[at] ?? '') && at < raw.length) {
                if (++at % 16384 === 0)
                    await this.yield();
            }
        };
        const expect = async (character) => { await ws(); if (raw[at++] !== character)
            throw new Error('invalid_gene_envelope'); };
        const value = async () => {
            await ws();
            const start = at;
            let depth = 0, quoted = false, escaped = false;
            for (; at < raw.length; at++) {
                if (at - start > ROW_BYTES)
                    throw new Error('snapshot_row_limit');
                if (at % 16384 === 0)
                    await this.yield();
                const ch = raw[at];
                if (quoted) {
                    if (escaped)
                        escaped = false;
                    else if (ch === '\\')
                        escaped = true;
                    else if (ch === '"')
                        quoted = false;
                }
                else {
                    if (depth === 0 && (ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)))
                        break;
                    if (ch === '"')
                        quoted = true;
                    else if (ch === '[' || ch === '{')
                        depth++;
                    else if (ch === ']' || ch === '}')
                        depth--;
                }
            }
            const slice = raw.slice(start, at);
            if (Buffer.byteLength(slice) > ROW_BYTES)
                throw new Error('snapshot_row_limit');
            return JSON.parse(slice);
        };
        const genes = [];
        const keys = new Set();
        await expect('{');
        await ws();
        while (raw[at] !== '}') {
            if (keys.size % 32 === 0)
                await this.yield();
            // A JSON key is a string; consume it independently from the following colon.
            const start = at++;
            let escaped = false;
            while (at < raw.length) {
                if (at - start > ROW_BYTES)
                    throw new Error('snapshot_row_limit');
                if (at % 16384 === 0)
                    await this.yield();
                const ch = raw[at++];
                if (escaped)
                    escaped = false;
                else if (ch === '\\')
                    escaped = true;
                else if (ch === '"')
                    break;
            }
            const keyText = raw.slice(start, at);
            if (Buffer.byteLength(keyText) > ROW_BYTES)
                throw new Error('snapshot_row_limit');
            const key = JSON.parse(keyText);
            if (typeof key !== 'string' || keys.has(key))
                throw new Error('invalid_gene_envelope');
            keys.add(key);
            await expect(':');
            if (key === 'genes') {
                await expect('[');
                await ws();
                while (raw[at] !== ']') {
                    await beforeRecord?.();
                    if (++this.rows > this.maxRecords)
                        throw new Error('snapshot_record_limit');
                    const row = await value();
                    const record = assetRow(row, 'Gene', true);
                    if (!record)
                        throw new Error('invalid_gene_envelope');
                    genes.push(record);
                    onRecord?.(record);
                    if (genes.length % 32 === 0)
                        await this.yield();
                    await ws();
                    if (raw[at] === ']')
                        break;
                    await expect(',');
                    await ws();
                    if (raw[at] === ']')
                        throw new Error('invalid_gene_envelope');
                }
                await expect(']');
            }
            else
                await value();
            await ws();
            if (raw[at] === '}')
                break;
            await expect(',');
            await ws();
            if (raw[at] === '}')
                throw new Error('invalid_gene_envelope');
        }
        await expect('}');
        await ws();
        if (at !== raw.length || !keys.has('genes'))
            throw new Error('invalid_gene_envelope');
        return genes;
    }
}
function assetRow(value, kind, envelope = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const row = value;
    if ((!envelope && row.type !== kind) || (envelope && row.type !== undefined && row.type !== kind)
        || typeof row.asset_id !== 'string' || !row.asset_id)
        return null;
    // Preserve frozen content addresses. Never synthesize a hash to turn legacy identities into exact evidence.
    return envelope && row.type === undefined ? { ...row, type: kind } : row;
}
// A caller deadline is not an OS I/O completion. Keep admission owned by the
// actual scan, including finally/close, so repeated timeouts cannot multiply
// in-flight opens/reads of a stuck source. The process-wide cap also bounds aliases.
const activeSnapshotRoots = new Map();
const retainedSnapshotReaders = new Map();
const MAX_ACTIVE_SNAPSHOT_ROOTS = 64;
function snapshotRootKey(absolute) {
    if (process.platform !== 'win32')
        return absolute;
    try {
        // The filesystem, not a case fold, decides whether two Windows spellings
        // are aliases. Case-sensitive siblings remain distinct, while ordinary
        // case aliases resolve to the same directory before admission.
        return realpathSync.native(absolute);
    }
    catch (error) {
        // A missing root has no file identity to share. The final snapshot verify
        // rejects it if a directory appears while this read is in progress.
        if (missing(error))
            return absolute;
        throw error;
    }
}
async function closeSnapshotOwner(key, reader) {
    const retained = retainedSnapshotReaders.get(key);
    // Another admission may already have recovered this reader and acquired the
    // same root with a new reader. A stale close must not close or release that
    // new owner's slot (nor retry a numeric descriptor that could be reused).
    if (activeSnapshotRoots.get(key) !== reader) {
        if (retained?.reader === reader)
            throw new Error('snapshot_cleanup_unconfirmed');
        return;
    }
    if (retained && (retained.reader !== reader || retained.recovering))
        throw new Error('snapshot_source_busy');
    if (retained)
        retained.recovering = true;
    try {
        await reader.close();
        if (retainedSnapshotReaders.get(key)?.reader === reader)
            retainedSnapshotReaders.delete(key);
        if ((!reader.invocation || reader.invocation.closed) && activeSnapshotRoots.get(key) === reader)
            activeSnapshotRoots.delete(key);
    }
    catch (error) {
        if (error instanceof PosixSnapshotExitConfirmedError) {
            // The syscall outcome was not clean, so this read still fails, but the
            // exited child can own no fd. A new attempt may use a fresh worker.
            if (retainedSnapshotReaders.get(key)?.reader === reader)
                retainedSnapshotReaders.delete(key);
            if (activeSnapshotRoots.get(key) === reader)
                activeSnapshotRoots.delete(key);
            throw error;
        }
        // A failed close retains its existing root slot and cleanup capabilities.
        retainedSnapshotReaders.set(key, { reader, recovering: false });
        throw error;
    }
    finally {
        const current = retainedSnapshotReaders.get(key);
        if (current?.reader === reader)
            current.recovering = false;
    }
}
async function readLocalSnapshotOwned(baseDir, query, capsules, signal, beforeRecord, onReader, onClosed, pageBytes, onRecord, allKinds = false) {
    let finish;
    let snapshot;
    let part = 'root';
    let started;
    let outcome = 'fulfilled';
    // Every optional tap is synchronous and nonthrowing, including creation and
    // finish. An invalid clock discards this call's detail, never invents a zero
    // duration or bypasses the original finally/cleanup/error precedence.
    try {
        finish = startContextReadStage('snapshot_owned');
        if (finish) {
            started = performance.now();
            if (Number.isFinite(started))
                snapshot = { kind: capsules ? 'related' : 'gene' };
        }
    }
    catch { /* Observation cannot prevent admission or original cleanup. */ }
    const settle = snapshot ? (state) => {
        try {
            if (snapshot && part && started !== undefined) {
                const elapsed = performance.now() - started;
                if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= Number.MAX_SAFE_INTEGER)
                    snapshot[part] = [Math.round(elapsed * 100) / 100, state];
                else
                    snapshot = undefined;
            }
            part = undefined;
        }
        catch {
            snapshot = undefined;
        }
    } : undefined;
    const start = snapshot ? (next) => {
        try {
            if (snapshot) {
                part = next;
                started = performance.now();
                if (!Number.isFinite(started))
                    snapshot = undefined;
            }
        }
        catch {
            snapshot = undefined;
        }
    } : undefined;
    try {
        const absolute = resolve(baseDir);
        const key = snapshotRootKey(absolute);
        const retained = retainedSnapshotReaders.get(key);
        if (retained)
            await closeSnapshotOwner(key, retained.reader);
        const invocation = snapshotInvocation.getStore();
        const previous = activeSnapshotRoots.get(key);
        if (previous && (!invocation || previous.invocation !== invocation || !previous.reusable))
            throw new Error('snapshot_source_busy');
        if (!previous && activeSnapshotRoots.size >= MAX_ACTIVE_SNAPSHOT_ROOTS)
            throw new Error('snapshot_source_capacity');
        const reader = new SnapshotReader(query, signal, pageBytes, invocation, key);
        onReader?.(reader, key);
        activeSnapshotRoots.set(key, reader);
        invocation?.roots.set(key, reader);
        try {
            await reader.guard(baseDir);
            settle?.('fulfilled');
            start?.('assets');
            const envelope = await reader.envelope(join(baseDir, 'genes.json'), beforeRecord, onRecord);
            const jsonl = beforeRecord && onRecord
                ? await reader.scanGeneJsonl(join(baseDir, 'genes.jsonl'), beforeRecord, onRecord)
                : await reader.jsonl(join(baseDir, 'genes.jsonl'), (row) => assetRow(row, 'Gene'));
            const cases = capsules || allKinds ? await reader.jsonl(join(baseDir, 'capsules.jsonl'), (row) => assetRow(row, 'Capsule')) : [];
            const other = [];
            if (allKinds)
                for (const kind of ['EvolutionEvent', 'AntiGene']) {
                    other.push(...await reader.jsonl(join(baseDir, LOCAL_ASSET_FILES[kind]), row => assetRow(row, kind)));
                }
            settle?.('fulfilled');
            start?.('metadata');
            const provenance = await reader.jsonl(join(baseDir, 'provenance.jsonl'), parseProvenanceRecord, true);
            const reviewed = await reader.jsonl(join(baseDir, 'review.jsonl'), parseReviewRecord, true);
            const referenceRaw = await reader.read(join(baseDir, 'references', 'references.json'));
            const ids = new Set();
            if (referenceRaw !== null) {
                // References are an independent fence, not an asset corpus. Bound this indivisible decoder call.
                if (Buffer.byteLength(referenceRaw) > ROW_BYTES)
                    throw new Error('snapshot_reference_limit');
                const parsed = JSON.parse(referenceRaw);
                if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 1000)
                    throw new Error('invalid_reference_snapshot');
                for (const entry of parsed.entries) {
                    await reader.yield();
                    const pair = decodeReferencePair(entry);
                    for (const asset of [pair.gene, pair.capsule]) {
                        ids.add(asset.asset_id);
                        if (typeof asset['id'] === 'string')
                            ids.add(asset['id']);
                    }
                }
            }
            const review = new Map();
            let mapped = 0;
            for (const row of reviewed) {
                if (++mapped % 64 === 0)
                    await reader.yield();
                const old = review.get(row.assetId);
                // Exact ReviewLedger.keep precedence: human decisions beat subsequent auto quarantine.
                if (!old || row.state !== 'quarantined' || old.state === 'quarantined')
                    review.set(row.assetId, row);
            }
            const trust = new Map();
            for (const row of provenance) {
                if (++mapped % 64 === 0)
                    await reader.yield();
                trust.set(row.assetId, row);
            }
            const referenceScope = { hasId: (id) => ids.has(id) };
            settle?.('fulfilled');
            start?.('verify');
            await reader.verify();
            settle?.('fulfilled');
            return { genes: [...envelope, ...jsonl], capsules: cases, identities: allKinds ? [...envelope, ...jsonl, ...cases, ...other] : [],
                scanned: envelope.length + jsonl.length + cases.length + other.length,
                bytes: reader.bytesRead,
                provenance: trust, review, referenceScope, referenceIds: Object.freeze([...ids]) };
        }
        finally {
            // A still-active read segment reached finally by rejection. Final cleanup
            // retains its original error precedence and must settle before owned does.
            settle?.('rejected');
            start?.('cleanup');
            await closeSnapshotOwner(key, reader);
            onClosed?.();
            settle?.('fulfilled');
        }
    }
    catch (error) {
        outcome = 'rejected';
        settle?.('rejected');
        throw error;
    }
    finally {
        try {
            finish?.(outcome, undefined, undefined, snapshot);
        }
        catch { /* Even a failing observer cannot replace body/cleanup/onClosed errors. */ }
    }
}
export async function readLocalSnapshot(baseDir, query, capsules) {
    return measureContextReadStage(capsules ? 'related_snapshot' : 'gene_snapshot', () => withSnapshotDeadline(query, signal => {
        return trackSnapshotInvocation(readLocalSnapshotOwned(baseDir, query, capsules, signal));
    }));
}
/** Validate the complete identity authority BEFORE any filtering or result limits.
 * Content equality alone misses out-of-band reference brands; eligibility alone
 * misses replacement methods under an approved ID. Either conflict makes the
 * source unknown. Never compare the declared ID to the computed digest here:
 * explicitly promoted frozen legacy Genes retain their original network IDs.
 */
export async function checkedSnapshotAssets(records, referenceScope, query) {
    const seen = new Map();
    const check = () => {
        if (query.signal?.aborted || (query.deadlineAt !== undefined && Date.now() >= query.deadlineAt))
            throw new Error('snapshot_aborted');
    };
    let scanned = 0;
    for (const asset of records) {
        check();
        const executionEligible = isExecutionEligible(asset, referenceScope);
        const contentId = computeAssetId(asset);
        if (!contentId)
            throw new Error('invalid_snapshot_identity');
        const previous = seen.get(asset.asset_id);
        if (previous) {
            if (previous.contentId !== contentId || previous.executionEligible !== executionEligible)
                throw new Error('conflicting_snapshot_identity');
        }
        else
            seen.set(asset.asset_id, { asset, executionEligible, contentId });
        if (++scanned % 32 === 0)
            await tick();
    }
    check();
    return [...seen.values()];
}
/** Exported production Gene-only read: never touches Capsules/events, even on a cold pool.
 * Full source scan precedes selection so malformed authority/sidecars cannot become local-default approval.
 */
export async function readLocalGeneSnapshot(baseDir, query = {}) {
    const boundedQuery = { ...query, deadlineAt: query.deadlineAt ?? Date.now() + 1000 };
    return withSnapshotDeadline(boundedQuery, async (signal) => {
        const snapshot = await readLocalSnapshot(baseDir, { ...boundedQuery, signal }, false);
        const checked = await checkedSnapshotAssets(snapshot.genes, snapshot.referenceScope, { ...boundedQuery, signal });
        const genes = [];
        let count = 0;
        for (const { asset, executionEligible } of checked) {
            if (signal.aborted || Date.now() >= boundedQuery.deadlineAt)
                throw new Error('snapshot_aborted');
            if (executionEligible)
                genes.push(asset);
            if (++count % 32 === 0)
                await tick();
        }
        if (signal.aborted || Date.now() >= boundedQuery.deadlineAt)
            throw new Error('snapshot_aborted');
        return { ...snapshot, genes, ...(boundedQuery.recent ? {
                recentGenes: recentRecords(checked.map(({ asset }) => asset), 'Gene')
                    .filter(asset => isExecutionEligible(asset, snapshot.referenceScope)),
            } : {}) };
    });
}
/** Capture admission needs every frozen address, including non-execution-eligible
 * records. Use the same reader and aggregate budgets, not an unbounded provider
 * reload or another independent snapshot which could miss a cross-kind writer. */
export async function readLocalExperienceSnapshot(baseDir, query) {
    return withSnapshotDeadline(query, async (signal) => {
        const snapshot = await trackSnapshotInvocation(readLocalSnapshotOwned(baseDir, query, false, signal, undefined, undefined, undefined, undefined, undefined, true));
        const checked = await checkedSnapshotAssets(snapshot.identities, snapshot.referenceScope, { ...query, signal });
        return { ...snapshot, genes: checked.filter(row => row.asset.type === 'Gene' && row.executionEligible).map(row => row.asset) };
    });
}
/** A real, single-pass Local/Foreign scan. The reader and root admission remain
 * owned while a page is paused; the next page resumes the same inode/authority
 * view rather than reopening a path or replaying a scan. */
export function beginLocalGeneScanV1(baseDir, query = {}) {
    const capturedQuery = { ...query };
    const maxRecords = limit(capturedQuery.maxRecords, 10000, 100000);
    const maxTotalBytes = limit(capturedQuery.maxTotalBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
    const deadlineAt = capturedQuery.deadlineAt ?? Date.now() + 1000;
    if (!Number.isFinite(deadlineAt))
        throw new Error('invalid_snapshot_deadline');
    const controller = new AbortController();
    let resume;
    const abort = () => { controller.abort(); resume?.(); };
    let invocation = snapshotInvocation.getStore();
    invocation?.controller.signal.addEventListener('abort', abort, { once: true });
    capturedQuery.signal?.addEventListener('abort', abort, { once: true });
    if (capturedQuery.signal?.aborted || Date.now() >= deadlineAt)
        abort();
    let timer;
    const schedule = () => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
            abort();
            return;
        }
        timer = setTimeout(schedule, Math.min(remaining, 0x7fffffff));
    };
    schedule();
    const sourceId = createHash('sha256').update(resolve(baseDir)).digest('hex');
    const epoch = `${sourceId}:${randomUUID()}`;
    let reader;
    let ownerKey;
    let closedConfirmed = false;
    let task;
    let permits = 0;
    let bytePermits = 0;
    let consumed = 0;
    let pageRows = [];
    let paused = false;
    let notifyPause;
    let continuation;
    let sequence = 0;
    let busy = false;
    let closing;
    let closed = false;
    let failed = false;
    let complete = false;
    const gate = async () => {
        while (permits === 0 && !controller.signal.aborted) {
            paused = true;
            notifyPause?.();
            await new Promise(resolveWait => { resume = resolveWait; });
        }
        if (controller.signal.aborted || Date.now() >= deadlineAt)
            throw new Error('snapshot_aborted');
        paused = false;
        permits--;
        consumed++;
    };
    const pageBytes = {
        async allow(maximum) {
            while (bytePermits === 0 && !controller.signal.aborted) {
                paused = true;
                notifyPause?.();
                await new Promise(resolveWait => { resume = resolveWait; });
            }
            if (controller.signal.aborted || Date.now() >= deadlineAt)
                throw new Error('snapshot_aborted');
            paused = false;
            return Math.min(maximum, bytePermits);
        },
        consumed(actual) { bytePermits -= actual; },
    };
    const run = () => {
        if (!invocation) {
            invocation = snapshotInvocation.getStore();
            invocation?.controller.signal.addEventListener('abort', abort, { once: true });
        }
        if (invocation?.closed || invocation?.poisoned)
            throw new Error('gene_scan_closed');
        const activeQuery = { ...capturedQuery, deadlineAt, maxRecords, maxTotalBytes, signal: controller.signal };
        return trackSnapshotInvocation(measureContextReadStage('gene_snapshot', () => readLocalSnapshotOwned(baseDir, activeQuery, false, controller.signal, gate, (value, key) => { reader = value; ownerKey = key; }, () => { closedConfirmed = true; }, pageBytes, record => { pageRows.push(record); }).then(async (snapshot) => {
            const checked = await checkedSnapshotAssets(snapshot.genes, snapshot.referenceScope, activeQuery);
            const genes = [];
            for (const { asset, executionEligible } of checked)
                if (executionEligible)
                    genes.push(asset);
            if (controller.signal.aborted || Date.now() >= deadlineAt)
                throw new Error('snapshot_aborted');
            const result = { ...snapshot, genes, ...(activeQuery.recent ? {
                    recentGenes: recentRecords(checked.map(({ asset }) => asset), 'Gene')
                        .filter(asset => isExecutionEligible(asset, snapshot.referenceScope)),
                } : {}) };
            if (controller.signal.aborted || Date.now() >= deadlineAt)
                throw new Error('snapshot_aborted');
            return result;
        })));
    };
    const session = {
        async next(options) {
            if (failed)
                throw new Error('gene_scan_failed');
            if (closed)
                throw new Error('gene_scan_closed');
            if (complete)
                throw new Error('gene_scan_complete');
            if (busy || closing)
                throw new Error('gene_scan_busy');
            if (options.continuation !== continuation || !Number.isInteger(options.maxRecords)
                || options.maxRecords < 0 || options.maxRecords > maxRecords - consumed
                || !Number.isInteger(options.maxBytes) || options.maxBytes < 0
                || options.maxBytes > maxTotalBytes - (reader?.bytesRead ?? 0))
                throw new Error('invalid_gene_scan_continuation');
            busy = true;
            try {
                const startRows = consumed, startBytes = reader?.bytesRead ?? 0;
                const pausedAgain = new Promise(resolvePause => { notifyPause = resolvePause; });
                permits = options.maxRecords;
                bytePermits = options.maxBytes;
                pageRows = [];
                if (!task)
                    task = run();
                else {
                    paused = false;
                    resume?.();
                    resume = undefined;
                }
                if (options.maxRecords === 0 && paused)
                    notifyPause?.();
                const outcome = await Promise.race([
                    task.then(snapshot => ({ complete: true, snapshot })),
                    pausedAgain.then(() => ({ complete: false })),
                ]);
                const scanned = consumed - startRows, bytes = (reader?.bytesRead ?? 0) - startBytes;
                if (!outcome.complete)
                    await reader?.verify();
                if (controller.signal.aborted || Date.now() >= deadlineAt)
                    throw new Error('snapshot_aborted');
                if (scanned > options.maxRecords || bytes > options.maxBytes || pageRows.length !== scanned)
                    throw new Error('invalid_gene_scan_accounting');
                complete = outcome.complete;
                continuation = outcome.complete ? undefined : `${epoch}:${++sequence}`;
                const page = { version: 1, sourceId, epoch, scanned, bytes, complete: outcome.complete,
                    rawRows: Object.freeze(pageRows.map(row => brandScanRawObject(structuredClone(row)))),
                    continuation: continuation ?? null, ...(outcome.complete ? { snapshot: outcome.snapshot } : {}) };
                if (controller.signal.aborted || Date.now() >= deadlineAt)
                    throw new Error('snapshot_aborted');
                return page;
            }
            catch (error) {
                // Consumed bytes/rows cannot be rolled back into an old continuation.
                // Poison this session and join its actual reader without masking error.
                failed = true;
                void session.close().catch(() => undefined);
                throw error;
            }
            finally {
                notifyPause = undefined;
                busy = false;
            }
        },
        close() {
            if (closed)
                return Promise.resolve();
            if (closing)
                return closing;
            closing = (async () => {
                controller.abort();
                resume?.();
                try {
                    await task;
                }
                catch { /* scan failure is reported by next; close checks actual ownership below. */ }
                clearTimeout(timer);
                capturedQuery.signal?.removeEventListener('abort', abort);
                invocation?.controller.signal.removeEventListener('abort', abort);
                if (reader && !closedConfirmed) {
                    if (!ownerKey)
                        throw new Error('snapshot_cleanup_unconfirmed');
                    await closeSnapshotOwner(ownerKey, reader);
                    closedConfirmed = true;
                }
                closed = true;
            })();
            const pending = closing;
            void pending.finally(() => { if (closing === pending)
                closing = undefined; }).catch(() => undefined);
            return pending;
        },
    };
    return session;
}