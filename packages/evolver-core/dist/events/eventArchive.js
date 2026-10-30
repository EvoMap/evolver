import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync, lstatSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { readRegularBuffer, assertOptionalRegularFile } from '../assetstore/assetStoreStorage.js';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { auditLockOwned, AuditWriteSkipped } from './boundedAudit.js';
import { rootEvent } from './eventSchema.js';
import { relocateExperienceAudit, recoverExperienceAuditUnderLock } from './experienceAuditJournal.js';
import { journalFileIdentity } from '../util/durableJournal.js';
import { assertNoPendingRootOperation } from './rootEventOperations.js';
import { relocateContextDeliveryProjections } from '../ops/geneContextDeliveryJournal.js';
import { protectedAuditConfigured, protectedAuditRpc, protectedAuditRpcSync, protectedAuditReadSnapshotSync, decodeSnapshotChunk, isProtectedAuditServiceProcess, ProtectedAuditUnavailableError, validateProtectedAuditHistoryVersion, validateProtectedAuditSnapshotHeader } from './protectedAuditRpc.js';
import { auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
export const ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS = 10_000;
// Keep rotation's published and temporary JSONL bytes inside the same physical
// history contract as protected append/read admission.
const MAX_PROTECTED_HISTORY_PHYSICAL_BYTES = 256 * 1024 * 1024;
const SEGMENT_PATTERN = /^root-events-(\d{16})-(\d{16})\.jsonl$/;
export class InvalidRootEventLogError extends Error {
    line;
    code = 'ROOT_EVENT_ARCHIVE_INVALID_LOG';
    constructor(line, reason) {
        super(`root event archive refused invalid active log at line ${line}: ${reason}`);
        this.line = line;
        this.name = 'InvalidRootEventLogError';
    }
}
export class ArchiveSegmentConflictError extends Error {
    archiveId;
    code = 'ROOT_EVENT_ARCHIVE_SEGMENT_CONFLICT';
    constructor(archiveId) {
        super(`root event archive segment ${archiveId} already exists with different content`);
        this.archiveId = archiveId;
        this.name = 'ArchiveSegmentConflictError';
    }
}
export class InvalidRootEventArchiveError extends Error {
    segment;
    line;
    code = 'ROOT_EVENT_ARCHIVE_INVALID_ARCHIVE';
    constructor(segment, line) {
        super(`root event archive segment ${segment} is invalid at line ${line}`);
        this.segment = segment;
        this.line = line;
        this.name = 'InvalidRootEventArchiveError';
    }
}
export class RootEventHistoryGapError extends Error {
    expectedSeq;
    actualSeq;
    code = 'ROOT_EVENT_HISTORY_GAP';
    constructor(expectedSeq, actualSeq) {
        super(`root event history expected seq ${expectedSeq} but found ${actualSeq}`);
        this.expectedSeq = expectedSeq;
        this.actualSeq = actualSeq;
        this.name = 'RootEventHistoryGapError';
    }
}
export function rootEventArchiveDir(path) {
    const ext = extname(path);
    const stem = ext.length > 0 ? basename(path, ext) : basename(path);
    return join(dirname(path), `${stem}.archive`);
}
/**
 * Return an opaque version for the complete active+archived root-event history.
 * On POSIX clients this is computed by the protected service, never by a
 * same-UID WebUI process probing the private files directly.
 */
export async function rootEventHistoryVersion(path) {
    const deadlineAt = Date.now() + 30_000;
    if (protectedAuditConfigured()) {
        return validateProtectedAuditHistoryVersion(await protectedAuditRpc('root_history_version', path, undefined, { deadlineAt }));
    }
    return localRootEventHistoryVersion(path, undefined, deadlineAt);
}
/** Service-only implementation. The optional owner constraint is supplied by
 * the protected service after it resolves the caller's logical path. */
export async function localRootEventHistoryVersion(path, expectedUid, deadlineAt = Date.now() + 30_000) {
    const entries = [];
    let totalBytes = 0n;
    const checkDeadline = () => {
        if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
            throw new ProtectedAuditUnavailableError('request_expired');
        }
    };
    const add = async (kind, file, directory = false) => {
        checkDeadline();
        let stat;
        try {
            stat = await lstat(file, { bigint: true });
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                entries.push(`${kind}:missing`);
                return false;
            }
            throw error;
        }
        checkDeadline();
        if (directory
            ? (!stat.isDirectory() || stat.isSymbolicLink())
            : (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)) {
            throw new ProtectedAuditUnavailableError('root_history_version_untrusted');
        }
        if (expectedUid !== undefined && (stat.uid !== BigInt(expectedUid) || (stat.mode & 63n) !== 0n)) {
            throw new ProtectedAuditUnavailableError('root_history_version_untrusted');
        }
        if (!directory) {
            totalBytes += stat.size;
            // The service owns this admission cap; legacy operational replay remains uncapped.
            if (expectedUid !== undefined && totalBytes > 256n * 1024n * 1024n) {
                throw new ProtectedAuditUnavailableError('root_history_version_capacity');
            }
        }
        entries.push([kind, stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs,
            stat.uid, stat.mode].map(String).join(':'));
        return true;
    };
    await add('active', path);
    const archiveDir = rootEventArchiveDir(path);
    if (await add('archive', archiveDir, true)) {
        const segments = (await readdir(archiveDir)).filter(name => SEGMENT_PATTERN.test(name)).sort();
        checkDeadline();
        for (const name of segments)
            await add(`segment:${name}`, join(archiveDir, name));
    }
    checkDeadline();
    return createHash('sha256').update(entries.join('\n')).digest('hex');
}
export function rootEventArchiveSegmentName(firstSeq, lastSeq) {
    return `root-events-${String(firstSeq).padStart(16, '0')}-${String(lastSeq).padStart(16, '0')}.jsonl`;
}
export function planRootEventArchive(opts) {
    if (protectedAuditConfigured())
        return protectedAuditRpcSync('plan_root_archive', opts.path, opts.keepEvents, { deadlineAt: Date.now() + 30_000 });
    const keepEvents = normalizeKeepEvents(opts.keepEvents);
    const active = readActiveStrict(opts.path);
    const wouldArchive = Math.max(0, active.length - keepEvents);
    const prefix = active.slice(0, wouldArchive);
    readValidatedArchive(opts.path, active);
    const firstSeq = prefix[0]?.event.seq ?? null;
    const lastSeq = prefix[prefix.length - 1]?.event.seq ?? null;
    return {
        mode: 'preview',
        activeRecords: active.length,
        keepEvents,
        wouldArchive,
        retainedRecords: active.length - wouldArchive,
        firstSeq,
        lastSeq,
        archiveId: firstSeq === null || lastSeq === null ? null : `${firstSeq}-${lastSeq}`,
    };
}
export function archiveRootEvents(opts) {
    if (protectedAuditConfigured())
        return protectedAuditRpcSync('archive_root', opts.path, opts.keepEvents, { deadlineAt: Date.now() + 30_000 });
    opts = { ...opts, path: canonicalEventPath(opts.path) };
    const keepEvents = normalizeKeepEvents(opts.keepEvents);
    const lockPath = `${opts.path}.lock`;
    if (auditLockOwned(lockPath))
        throw new AuditWriteSkipped('audit_cleanup_pending');
    mkdirSync(dirname(opts.path), { recursive: true });
    acquireLock(lockPath);
    try {
        assertNoPendingRootOperation(opts.path);
        recoverExperienceAuditUnderLock(opts.path);
        const active = readActiveStrict(opts.path);
        const archivedRecords = Math.max(0, active.length - keepEvents);
        const prefix = active.slice(0, archivedRecords);
        const tail = active.slice(archivedRecords);
        const firstSeq = prefix[0]?.event.seq ?? null;
        const lastSeq = prefix[prefix.length - 1]?.event.seq ?? null;
        const archiveId = firstSeq === null || lastSeq === null ? null : `${firstSeq}-${lastSeq}`;
        let reusedSegment = false;
        const archivedBySeq = readValidatedArchive(opts.path, active);
        if (archiveId !== null && firstSeq !== null && lastSeq !== null) {
            const archiveDir = rootEventArchiveDir(opts.path);
            const missing = [];
            for (const line of prefix) {
                const archived = archivedBySeq.get(line.event.seq);
                if (archived === undefined) {
                    missing.push(line);
                    continue;
                }
                if (JSON.stringify(archived) !== JSON.stringify(line.event)) {
                    throw new ArchiveSegmentConflictError(String(line.event.seq));
                }
                reusedSegment = true;
            }
            if (isProtectedAuditServiceProcess()) {
                const archiveBytes = archiveSegmentFiles(archiveDir).reduce((sum, name) => sum + lstatSync(join(archiveDir, name)).size, 0);
                const missingBytes = Buffer.byteLength(serializeLines(missing));
                const tailBytes = Buffer.byteLength(serializeLines(tail));
                const finalBytes = archiveBytes + missingBytes + tailBytes;
                // Recovery also copies the retained tail before replacing the active
                // inode, even when every prefix record was already published.
                const peakBytes = lstatSync(opts.path).size + finalBytes;
                if (finalBytes > MAX_PROTECTED_HISTORY_PHYSICAL_BYTES
                    || peakBytes > MAX_PROTECTED_HISTORY_PHYSICAL_BYTES) {
                    throw new ProtectedAuditUnavailableError('archive_physical_capacity');
                }
            }
            for (const segment of contiguousGroups(missing)) {
                const missingFirstSeq = segment[0].event.seq;
                const missingLastSeq = segment[segment.length - 1].event.seq;
                const archiveBytes = serializeLines(segment);
                mkdirSync(archiveDir, { recursive: true });
                const segmentPath = join(archiveDir, rootEventArchiveSegmentName(missingFirstSeq, missingLastSeq));
                if (existsSync(segmentPath))
                    throw new ArchiveSegmentConflictError(`${missingFirstSeq}-${missingLastSeq}`);
                durableReplace(`${segmentPath}.tmp`, segmentPath, archiveBytes);
                fsyncDirectoryBestEffort(archiveDir);
            }
            const fileIdentity = (path) => {
                const stat = lstatSync(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                    throw new Error('unsafe_delivery_archive');
                return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            };
            const originalIdentity = fileIdentity(opts.path);
            durableReplace(`${opts.path}.archive.tmp`, opts.path, serializeLines(tail), () => {
                const nextIdentity = fileIdentity(`${opts.path}.archive.tmp`);
                // The existing archive operation already validates/materializes this inventory under the root lock.
                // Build byte locators for receipt rows only; preserve exact serialization and reused segments.
                const locations = new Map();
                let offset = 0;
                for (const item of tail) {
                    const line = `${item.raw}\n`;
                    if (item.event.type === 'value.gene_context_delivery' || item.event.auditOperationId?.startsWith('experience-'))
                        locations.set(line, { offset, identity: nextIdentity });
                    offset += Buffer.byteLength(line);
                }
                let archivesLoaded = false;
                const locate = (line) => {
                    if (!locations.has(line) && !archivesLoaded) {
                        archivesLoaded = true;
                        for (const name of archiveSegmentFiles(archiveDir)) {
                            const path = join(archiveDir, name), identity = fileIdentity(path);
                            let offset = 0;
                            for (const raw of readFileSync(path, 'utf8').split('\n')) {
                                if (!raw)
                                    continue;
                                const event = rootEvent.parse(JSON.parse(raw));
                                const exact = `${raw}\n`;
                                if (event.type === 'value.gene_context_delivery' || event.auditOperationId?.startsWith('experience-'))
                                    locations.set(exact, { archive: name, offset, identity });
                                offset += Buffer.byteLength(exact);
                            }
                        }
                    }
                    return locations.get(line);
                };
                relocateContextDeliveryProjections(opts.path, locate, { before: originalIdentity, after: nextIdentity });
                relocateExperienceAudit(opts.path, line => {
                    const location = locate(line);
                    if (!location)
                        return undefined;
                    const target = location.archive ? join(archiveDir, location.archive) : `${opts.path}.archive.tmp`;
                    return { ...location, identity: journalFileIdentity(target) };
                });
            });
            fsyncDirectoryBestEffort(dirname(opts.path));
        }
        return {
            mode: 'write',
            activeRecordsBefore: active.length,
            keepEvents,
            archivedRecords,
            retainedRecords: tail.length,
            firstSeq,
            lastSeq,
            archiveId,
            reusedSegment,
        };
    }
    finally {
        releaseLock(lockPath);
    }
}
export function readRootEventHistory(path, archiveDir = rootEventArchiveDir(path)) {
    if (protectedAuditConfigured()) {
        if (archiveDir !== rootEventArchiveDir(path))
            throw new ProtectedAuditUnavailableError('custom_archive_path_denied');
        return protectedAuditReadSnapshotSync('root', path);
    }
    // Snapshot active first. Writers publish archive segments before replacing active, so this prevents a reader
    // from combining an old archive inventory with the new active tail and temporarily dropping the rotated prefix.
    const active = readEventsLenient(path);
    const bySeq = new Map();
    for (const file of archiveSegmentFiles(archiveDir)) {
        for (const event of readEventsLenient(join(archiveDir, file))) {
            // Archive segments are immutable: the first segment in canonical order owns a seq. A later conflicting
            // segment cannot silently replace it during operational reads. Strict validation still reports the
            // conflict and blocks archive writes.
            if (!bySeq.has(event.seq))
                bySeq.set(event.seq, event);
        }
    }
    // Preserve the pre-archive fail-soft behavior for routine commands. The active log is the current writer
    // source, so it deterministically wins an active/archive conflict without crashing status/report readers.
    for (const event of active)
        bySeq.set(event.seq, event);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
/** Same operational replay as the synchronous reader, yielding between bounded read/parse batches. */
// shortcut: single-record JSON.parse and final sort remain atomic; offload if either shows measured latency overruns.
export async function readRootEventHistoryAsync(path, options = {}) {
    const deadlineAt = options.deadlineAt ?? Date.now() + 30_000;
    const check = () => {
        if (options.signal?.aborted)
            throw new ProtectedAuditUnavailableError('read_snapshot_aborted');
        if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
            throw new ProtectedAuditUnavailableError('read_snapshot_deadline');
    };
    check();
    if (protectedAuditConfigured())
        return protectedAuditReadRootSnapshotAsync(path, { ...options, deadlineAt });
    const active = await readEventsLenientAsync(path, check);
    check();
    let files;
    try {
        files = await readdir(rootEventArchiveDir(path));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        files = [];
    }
    check();
    const bySeq = new Map();
    for (const name of files.filter(entry => SEGMENT_PATTERN.test(entry)).sort()) {
        const archived = await readEventsLenientAsync(join(rootEventArchiveDir(path), name), check);
        let inspected = 0;
        for (const event of archived) {
            if (!bySeq.has(event.seq))
                bySeq.set(event.seq, event);
            if (++inspected % 256 === 0) {
                await new Promise(resolve => setImmediate(resolve));
                check();
            }
        }
    }
    let inspected = 0;
    for (const event of active) {
        bySeq.set(event.seq, event);
        if (++inspected % 256 === 0) {
            await new Promise(resolve => setImmediate(resolve));
            check();
        }
    }
    check();
    const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    check();
    return ordered;
}
async function readEventsLenientAsync(path, check) {
    check();
    try {
        if (!(await stat(path)).isFile())
            throw new ProtectedAuditUnavailableError('root_history_read_untrusted');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    check();
    let handle;
    try {
        handle = await open(path, 'r');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    return withAuditCleanup(async () => {
        check();
        const metadata = await handle.stat();
        check();
        if (!metadata.isFile())
            throw new ProtectedAuditUnavailableError('root_history_read_untrusted');
        const records = [], decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0, fragments = [];
        const consume = (text) => {
            let start = 0, newline;
            while ((newline = text.indexOf('\n', start)) >= 0) {
                fragments.push(text.slice(start, newline));
                const line = fragments.join('');
                fragments = [];
                check();
                if (line) {
                    try {
                        records.push(rootEvent.parse(JSON.parse(line)));
                    }
                    catch { /* Operational replay keeps the same malformed/torn-row policy. */ }
                }
                start = newline + 1;
            }
            if (start < text.length)
                fragments.push(text.slice(start));
        };
        // Freeze active length before reading so concurrent appends cannot extend this snapshot indefinitely.
        while (offset < metadata.size) {
            check();
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
            check();
            if (bytesRead === 0)
                break;
            offset += bytesRead;
            consume(decoder.write(buffer.subarray(0, bytesRead)));
            await new Promise(resolve => setImmediate(resolve));
            check();
        }
        consume(decoder.end());
        if (fragments.length) {
            const tail = fragments.join('');
            fragments = [];
            consume(`${tail}\n`);
        }
        check();
        return records;
    }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
}
/** Root history alone needs cooperative decoding on the caller's event loop. */
function protectedAuditReadRootSnapshotAsync(path, options = {}) {
    return readProtectedAuditRootSnapshotChunksAsync((method, payload, deadlineAt) => protectedAuditRpc(method, path, payload, { deadlineAt }), options);
}
/** Internal protocol seam; the wrapper retains socket, principal and logical-path admission. */
export async function readProtectedAuditRootSnapshotChunksAsync(request, options = {}) {
    const deadlineAt = options.deadlineAt ?? Date.now() + 30_000;
    const check = () => {
        if (options.signal?.aborted)
            throw new ProtectedAuditUnavailableError('read_snapshot_aborted');
        if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
            throw new ProtectedAuditUnavailableError('read_snapshot_deadline');
    };
    check();
    // Let the original request settle so a received token is still released after cancellation.
    const first = await request('read_root_start', undefined, deadlineAt);
    if (!first || typeof first.token !== 'string' || !/^[a-f0-9-]{36}$/.test(first.token)) {
        validateProtectedAuditSnapshotHeader(first);
    }
    const records = await withAuditCleanup(async () => {
        validateProtectedAuditSnapshotHeader(first);
        check();
        const decoder = new RootEventSnapshotDecoder(check), hash = createHash('sha256');
        let offset = 0;
        for (;;) {
            check();
            const encoded = offset === 0 ? first.chunk : await request('read_root_chunk', { token: first.token, offset }, deadlineAt);
            check();
            const chunk = decodeSnapshotChunk(encoded, offset, first.size);
            hash.update(chunk);
            offset += chunk.length;
            await decoder.write(chunk);
            if (offset === first.size)
                break;
        }
        check();
        if (hash.digest('hex') !== first.sha256)
            throw new ProtectedAuditUnavailableError('read_snapshot_hash_invalid');
        const records = await decoder.finish();
        check();
        return records;
    }, auditCleanupSequence([{ run: async () => {
                // The original token owns this cleanup allowance; read cancellation never renews reads.
                try {
                    await request('read_root_release', { token: first.token }, Date.now() + 30_000);
                }
                catch (error) {
                    // An authenticated absent-token reply confirms release/expiry of this exact owner, even after a lost reply.
                    if (!(error instanceof ProtectedAuditUnavailableError)
                        || error.reason !== 'protected_audit_unavailable: read_snapshot_missing')
                        throw error;
                }
            }, retryFailedOperation: true }]));
    check();
    return records;
}
/** Only a JSON array of RootEvent objects, never a general-purpose streaming JSON API. */
class RootEventSnapshotDecoder {
    check;
    utf8 = new StringDecoder('utf8');
    records = [];
    parts = [];
    phase = 'start';
    emptyAllowed = true;
    depth = 0;
    quoted = false;
    escaped = false;
    constructor(check) {
        this.check = check;
    }
    async write(chunk) { await this.consume(this.utf8.write(chunk)); }
    async finish() {
        await this.consume(this.utf8.end());
        if (this.phase !== 'done' || this.depth !== 0)
            throw new ProtectedAuditUnavailableError('read_snapshot_json_invalid');
        return this.records;
    }
    async consume(text) {
        let start = 0;
        for (let index = 0; index < text.length; index++) {
            if (index % 16_384 === 0) {
                await new Promise(resolve => setImmediate(resolve));
                this.check();
            }
            const char = text[index];
            if (this.depth > 0) {
                if (this.quoted) {
                    if (this.escaped)
                        this.escaped = false;
                    else if (char === '\\')
                        this.escaped = true;
                    else if (char === '"')
                        this.quoted = false;
                }
                else if (char === '"')
                    this.quoted = true;
                else if (char === '{' || char === '[')
                    this.depth++;
                else if (char === '}' || char === ']')
                    this.depth--;
                if (this.depth === 0) {
                    this.parts.push(text.slice(start, index + 1));
                    this.records.push(rootEvent.parse(JSON.parse(this.parts.join(''))));
                    this.parts = [];
                    this.phase = 'separator';
                    start = index + 1;
                }
                continue;
            }
            if (char === ' ' || char === '\n' || char === '\r' || char === '\t')
                continue;
            if (this.phase === 'start' && char === '[')
                this.phase = 'value';
            else if (this.phase === 'value' && char === '{') {
                this.depth = 1;
                start = index;
            }
            else if (this.phase === 'value' && char === ']' && this.emptyAllowed)
                this.phase = 'done';
            else if (this.phase === 'separator' && char === ',') {
                this.phase = 'value';
                this.emptyAllowed = false;
            }
            else if (this.phase === 'separator' && char === ']')
                this.phase = 'done';
            else
                throw new ProtectedAuditUnavailableError('read_snapshot_json_invalid');
        }
        if (this.depth > 0)
            this.parts.push(text.slice(start));
    }
}
/** Strict replay for control-plane decisions that must fail closed on partial or conflicting history. */
export function readRootEventHistoryStrict(path, budget) {
    if (protectedAuditConfigured())
        return protectedAuditReadSnapshotSync('root_strict', path);
    if (budget) {
        budget.check();
        let total = 0;
        for (const source of [path, ...archiveSegmentFiles(rootEventArchiveDir(path)).map(name => join(rootEventArchiveDir(path), name))]) {
            budget.check();
            const stat = assertOptionalRegularFile(source);
            if (stat && stat.nlink !== 1)
                throw new AuditWriteSkipped('not_private_regular_file');
            total += stat?.size ?? 0;
            if (total > budget.maxBytes)
                throw new AuditWriteSkipped('file_too_large');
        }
    }
    const active = readActiveStrict(path, budget);
    const bySeq = readValidatedArchive(path, active, budget);
    for (const line of active) {
        budget?.check();
        bySeq.set(line.event.seq, line.event);
    }
    budget?.check();
    return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}
export function validateRootEventHistory(path) {
    void readRootEventHistoryStrict(path);
}
export function inspectRootEventArchive(path) {
    if (protectedAuditConfigured())
        return protectedAuditRpcSync('inspect_root_archive', path, undefined, { deadlineAt: Date.now() + 30_000 });
    const archiveDir = rootEventArchiveDir(path);
    const files = archiveSegmentFiles(archiveDir);
    let bytes = 0;
    let records = 0;
    let invalidLines = 0;
    let firstSeq = null;
    let lastSeq = null;
    for (const file of files) {
        const raw = readFileSync(join(archiveDir, file), 'utf8');
        bytes += Buffer.byteLength(raw, 'utf8');
        for (const line of raw.split('\n')) {
            if (line.length === 0)
                continue;
            try {
                const event = rootEvent.parse(JSON.parse(line));
                firstSeq ??= event.seq;
                lastSeq = event.seq;
                records += 1;
            }
            catch {
                invalidLines += 1;
            }
        }
    }
    return {
        exists: files.length > 0,
        segments: files.length,
        bytes,
        records,
        invalidLines,
        firstSeq,
        lastSeq,
    };
}
function strictHistoryText(path, budget) {
    if (!budget)
        return readFileSync(path, 'utf8');
    const bytes = readRegularBuffer(path, budget.maxBytes, () => budget.check()) ?? Buffer.alloc(0);
    budget.check();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function readActiveStrict(path, budget) {
    if (!existsSync(path))
        return [];
    const out = [];
    const lines = strictHistoryText(path, budget).split('\n');
    let previousSeq = null;
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (raw.length === 0)
            continue;
        let event;
        budget?.check();
        if (budget && Buffer.byteLength(raw) > 4096)
            throw new InvalidRootEventLogError(index + 1, 'line exceeds audit budget');
        try {
            event = rootEvent.parse(JSON.parse(raw));
        }
        catch {
            throw new InvalidRootEventLogError(index + 1, 'invalid json or event schema');
        }
        if (previousSeq !== null && event.seq !== previousSeq + 1) {
            throw new InvalidRootEventLogError(index + 1, 'seq must be contiguous and strictly increasing');
        }
        previousSeq = event.seq;
        out.push({ event, raw });
    }
    return out;
}
function readEventsLenient(path) {
    if (!existsSync(path))
        return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.length === 0)
            continue;
        try {
            out.push(rootEvent.parse(JSON.parse(line)));
        }
        catch {
            // Active reads retain the existing crash-tail behavior. Strict archive writes refuse these lines.
        }
    }
    return out;
}
function archiveSegmentFiles(archiveDir) {
    if (!existsSync(archiveDir))
        return [];
    return readdirSync(archiveDir).filter((entry) => SEGMENT_PATTERN.test(entry)).sort();
}
function readArchivedEventsStrict(archiveDir, budget) {
    const out = new Map();
    for (const file of archiveSegmentFiles(archiveDir)) {
        budget?.check();
        const lines = strictHistoryText(join(archiveDir, file), budget).split('\n');
        let previousSeq = null;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (line.length === 0)
                continue;
            let event;
            budget?.check();
            if (budget && Buffer.byteLength(line) > 4096)
                throw new InvalidRootEventArchiveError(file, index + 1);
            try {
                event = rootEvent.parse(JSON.parse(line));
            }
            catch {
                throw new InvalidRootEventArchiveError(file, index + 1);
            }
            if (previousSeq !== null && event.seq !== previousSeq + 1) {
                throw new InvalidRootEventArchiveError(file, index + 1);
            }
            previousSeq = event.seq;
            const current = out.get(event.seq);
            if (current !== undefined && JSON.stringify(current) !== JSON.stringify(event)) {
                throw new ArchiveSegmentConflictError(String(event.seq));
            }
            out.set(event.seq, event);
        }
    }
    return out;
}
function readValidatedArchive(path, active, budget) {
    const archived = readArchivedEventsStrict(rootEventArchiveDir(path), budget);
    for (const line of active) {
        budget?.check();
        const existing = archived.get(line.event.seq);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(line.event)) {
            throw new ArchiveSegmentConflictError(String(line.event.seq));
        }
    }
    assertContinuousHistory(archived, active, budget);
    return archived;
}
function assertContinuousHistory(archived, active, budget) {
    const seqs = new Set(archived.keys());
    for (const line of active)
        seqs.add(line.event.seq);
    const ordered = [...seqs].sort((left, right) => left - right);
    if (ordered.length === 0)
        return;
    let expected = 1;
    for (const actual of ordered) {
        budget?.check();
        if (actual !== expected)
            throw new RootEventHistoryGapError(expected, actual);
        expected += 1;
    }
}
function contiguousGroups(lines) {
    const groups = [];
    for (const line of lines) {
        const current = groups[groups.length - 1];
        const previous = current?.[current.length - 1];
        if (current === undefined || previous === undefined || line.event.seq !== previous.event.seq + 1) {
            groups.push([line]);
        }
        else {
            current.push(line);
        }
    }
    return groups;
}
function serializeLines(lines) {
    return lines.length === 0 ? '' : `${lines.map((line) => line.raw).join('\n')}\n`;
}
function durableReplace(tmpPath, finalPath, contents, beforePublish) {
    let fd = null;
    try {
        fd = openSync(tmpPath, 'w', 0o600);
        writeSync(fd, contents, undefined, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        beforePublish?.();
        renameSync(tmpPath, finalPath);
    }
    catch (error) {
        if (fd !== null)
            closeSync(fd);
        rmSync(tmpPath, { force: true });
        throw error;
    }
}
function fsyncDirectoryBestEffort(path) {
    let fd = null;
    try {
        fd = openSync(path, 'r');
        fsyncSync(fd);
    }
    catch {
        // Windows and some filesystems do not support fsync on directories.
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
function normalizeKeepEvents(value) {
    if (value === undefined)
        return ROOT_EVENT_ARCHIVE_DEFAULT_KEEP_EVENTS;
    if (!Number.isFinite(value) || value < 1)
        throw new RangeError('keepEvents must be a positive integer');
    return Math.floor(value);
}