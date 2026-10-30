import { createHash } from 'node:crypto';
import { openSqliteDatabase } from '../util/sqlite.js';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { rootEventArchiveDir } from '../events/eventArchive.js';
import { rootEvent } from '../events/eventSchema.js';
import { assertOpenedRegularAssetFile } from '../assetstore/assetStoreStorage.js';
import { MAX_LINE_BYTES } from '../events/eventStore.js';
import { Ingestor } from '../events/ingest.js';
import { protectedAuditConfigured, protectedAuditRpc, protectedAuditRpcSync } from '../events/protectedAuditRpc.js';
import { acquireLock, releaseLock, LockReleaseError } from '../util/fileLock.js';
import { GENE_CONTEXT_DELIVERY_EVENT, GENE_CONTEXT_OBSERVATION_EVENT, readGeneContextDeliveryReceipt, geneContextDeliveryIdentity } from './geneContextDelivery.js';
import { builtInContextObservationDispatch, durableObservationIntents, resetObservationAcknowledgements, settleContextObservation } from './contextObservationSettlement.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const SEGMENT = /^root-events-\d{16}-\d{16}\.jsonl$/;
const DEFAULT_BYTES = 512 * 1024;
const PROBE_BYTES = 128;
export class ContextObservationFailure extends Error {
    emitted;
    constructor(cause, emitted) {
        super(cause instanceof Error ? cause.message : 'context_observation_failed', { cause });
        this.emitted = emitted;
    }
}
/** Durable, disposable read model. Only delivery/observation identity and counts are stored, never prompt bodies.
 * Each tick has one bounded scan across archive + active bytes, then indexed per-session queries. The external
 * pid-aware non-waiting lock covers scan and admission. Independent durable intents retain unknown appends
 * after the bounded wait ends, allowing the tick to close without replaying those deliveries.
 * On crash after the event append but before the local marker, the next scan ingests that observation before
 * allowing emission. Incomplete catch-up therefore never means "no delivery", nor permits lexical rewards.
 */
export class GeneContextObservationIndex {
    db;
    lockPath;
    locked = false;
    owner;
    observing = false;
    historyIdentities = new Map();
    tickBudget = DEFAULT_BYTES;
    progress = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'unavailable' };
    eventsPath;
    identityPath;
    protectedClient;
    protectedToken;
    constructor(eventsPath, indexPath, identityPath) {
        this.eventsPath = canonicalEventPath(eventsPath);
        // Ordinary callers share the historical canonical operation identity across
        // aliases and readers, including pending observations from earlier versions.
        // The service cannot traverse a private client home merely to normalize a
        // legacy operation-hash input. Provisioning guarantees the logical path is
        // absolute and normalized; preserve an explicit service identity byte for byte.
        this.identityPath = identityPath ?? this.eventsPath;
        this.protectedClient = protectedAuditConfigured();
        indexPath ??= `${this.eventsPath}.context-index.sqlite`;
        this.lockPath = `${this.eventsPath}.context-index.sqlite.lock`;
        if (this.protectedClient) {
            if (indexPath !== `${this.eventsPath}.context-index.sqlite`)
                throw new Error('protected_context_index_custom_path_denied');
            this.db = undefined;
            return;
        }
        mkdirSync(dirname(indexPath), { recursive: true });
        try {
            const existing = lstatSync(indexPath);
            if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
                throw new Error('unsafe_context_index');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        // Alternate disposable databases must still serialize scan + emission for one authoritative log.
        // Keep the default lock name compatible with existing workers.
        this.db = openSqliteDatabase(indexPath);
        this.db.exec(`PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS context_cursors (path TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_sequences (seq INTEGER PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_issues (path TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_deliveries (
        session TEXT NOT NULL, seq INTEGER NOT NULL, digest TEXT NOT NULL,
        genes INTEGER NOT NULL, cases INTEGER NOT NULL, truncated INTEGER NOT NULL, observed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session, seq, digest));
      CREATE INDEX IF NOT EXISTS context_pending ON context_deliveries(session, observed, seq);
      CREATE TABLE IF NOT EXISTS context_delivery_identity (
        session TEXT NOT NULL, seq INTEGER NOT NULL, digest TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(session, seq, digest));
      CREATE TABLE IF NOT EXISTS context_observed (
        session TEXT NOT NULL, seq INTEGER NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(session, seq, digest));`);
    }
    /** Returns false rather than blocking the event loop behind another (possibly same-process) tick. */
    beginTick(maxBytes = DEFAULT_BYTES) {
        if (this.protectedClient) {
            if (this.protectedToken)
                throw new Error('context_index_tick_already_open');
            const result = protectedAuditRpcSync('index_begin', this.eventsPath, { maxBytes }, { deadlineAt: Date.now() + 30_000 });
            this.protectedToken = result.token;
            return this.progress = result.progress;
        }
        if (this.locked)
            throw new Error('context_index_tick_already_open');
        this.historyIdentities.clear();
        try {
            this.owner = acquireLock(this.lockPath, { maxTries: 1, waitMs: 0 });
            this.locked = true;
        }
        catch {
            return this.progress = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'busy' };
        }
        try {
            this.db.exec('BEGIN IMMEDIATE');
            this.tickBudget = Number.isSafeInteger(maxBytes) ? Math.max(8192, Math.min(8 * 1024 * 1024, maxBytes)) : DEFAULT_BYTES;
            this.progress = this.advance(this.tickBudget);
            this.db.exec('COMMIT');
        }
        catch {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* no transaction */ }
            this.progress = { status: 'unknown', bytesRead: this.progress.bytesRead, indexedThroughSeq: 0, reason: 'unavailable' };
        }
        return this.progress;
    }
    endTick() {
        if (this.protectedClient) {
            if (this.protectedToken) {
                protectedAuditRpcSync('index_end', this.eventsPath, this.protectedToken, { deadlineAt: Date.now() + 30_000 });
                this.protectedToken = undefined;
            }
            return;
        }
        // Before the bounded observation returns, the index is still in use. Afterwards an
        // independent durable intent owns any unknown append, so the whole-log lease can close.
        if (this.observing)
            throw new Error('context_index_observation_active');
        if (this.locked) {
            if (!this.owner)
                throw new Error('context_index_owner_unavailable');
            const released = releaseLock(this.lockPath, this.owner);
            if (!released.released) {
                this.progress = { ...this.progress, status: 'unknown', reason: 'unavailable' };
                throw new LockReleaseError(released.reason);
            }
            this.locked = false;
            this.owner = undefined;
        }
    }
    close() { this.endTick(); if (!this.protectedClient)
        this.db.close(); }
    getState(key) {
        return this.db.prepare('SELECT value FROM context_state WHERE key=?').get(key)?.value;
    }
    setState(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO context_state VALUES (?, ?)').run(key, value);
    }
    resetHistory() {
        this.historyIdentities.clear();
        // Every table is derived from the same authoritative generation. Keeping observed identities or the
        // frontier while rewinding only a cursor can suppress real observations or emit phantom deliveries.
        this.db.exec(`DELETE FROM context_cursors; DELETE FROM context_issues; DELETE FROM context_deliveries;
      DELETE FROM context_observed; DELETE FROM context_state; DELETE FROM context_sequences; DELETE FROM context_delivery_identity;`);
        this.setState('version', '5');
    }
    advance(maxBytes) {
        // Discard pre-generation-aware caches once, including rows admitted without the writer byte contract.
        if (this.getState('version') !== '5')
            this.resetHistory();
        let bytesRead = 0;
        const rebuild = () => {
            resetObservationAcknowledgements(this.eventsPath);
            this.resetHistory();
            const result = this.advance(maxBytes - bytesRead);
            return { ...result, bytesRead: bytesRead + result.bytesRead };
        };
        let maxSeq = Number(this.getState('maxSeq') ?? 0);
        const issue = (path, reason) => {
            // A later sequence gap must never hide an earlier corrupt row on the same file.
            this.db.prepare(`INSERT INTO context_issues VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET reason=excluded.reason
        WHERE context_issues.reason != 'invalid_row'`).run(path, reason);
        };
        let pending = false;
        let partial = false;
        const archive = rootEventArchiveDir(this.eventsPath);
        let segments;
        try {
            segments = readdirSync(archive).filter((name) => SEGMENT.test(name)).sort().map((name) => join(archive, name));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            segments = [];
        }
        const files = [...segments, this.eventsPath];
        const present = new Set(files);
        const indexed = this.db.prepare('SELECT path FROM context_cursors').all();
        // Absence is not a new authoritative generation. Retain known delivery identities
        // across restarts, but withhold completeness until every previously seen file returns.
        // Rebuilding here could turn an empty surviving log into proof of "no delivery".
        const missingHistory = () => ({ status: 'unknown', bytesRead, indexedThroughSeq: 0, reason: 'history_gap' });
        if (indexed.some(({ path }) => !present.has(path)))
            return missingHistory();
        for (const path of files) {
            if (bytesRead >= maxBytes) {
                pending = true;
                break;
            }
            let fd;
            try {
                const named = lstatSync(path);
                if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1)
                    throw new Error('unsafe_context_history');
                fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
            }
            catch (error) {
                if (error.code === 'ENOENT' && path === this.eventsPath) {
                    if (indexed.some((row) => row.path === path))
                        return missingHistory();
                    continue;
                }
                throw error;
            }
            try {
                const stat = fstatSync(fd);
                assertOpenedRegularAssetFile(fd, path);
                if (!stat.isFile() || stat.nlink !== 1)
                    throw new Error('unsafe_context_history');
                const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
                this.historyIdentities.set(path, { identity, size: stat.size, mtimeMs: stat.mtimeMs });
                const row = this.db.prepare('SELECT state FROM context_cursors WHERE path=?').get(path);
                const cursor = row ? JSON.parse(row.state) : { identity, offset: 0, head: '', tail: '', dropping: false };
                // Older cursors consumed rows beyond a gap. Their derived rows must be revalidated too.
                const priorIssue = this.db.prepare('SELECT reason FROM context_issues WHERE path=?').get(path);
                if (priorIssue?.reason === 'history_gap' && cursor.blockedSeq === undefined)
                    return rebuild();
                if (cursor.identity !== identity || cursor.offset > stat.size)
                    return rebuild();
                // Immutable archive segments need no repeated reads. Active files require boundary fingerprints to
                // recognize same-inode truncate+regrow, not just a smaller size or a rename.
                if (path !== this.eventsPath && cursor.identity === identity && cursor.offset === stat.size
                    && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs && !cursor.dropping && cursor.blockedSeq === undefined)
                    continue;
                const read = (position, length) => {
                    const buffer = Buffer.alloc(length);
                    const count = readSync(fd, buffer, 0, length, position);
                    bytesRead += count;
                    return buffer.subarray(0, count);
                };
                if (cursor.offset > 0) {
                    if (bytesRead + 2 * PROBE_BYTES > maxBytes) {
                        pending = true;
                        break;
                    }
                    const length = Math.min(PROBE_BYTES, cursor.offset);
                    const matches = cursor.identity === identity && cursor.offset <= stat.size
                        && !(cursor.size === stat.size && cursor.mtimeMs !== stat.mtimeMs)
                        && hash(read(0, length)) === cursor.head
                        && hash(read(cursor.offset - length, length)) === cursor.tail;
                    if (!matches)
                        return rebuild();
                }
                const available = Math.min(stat.size - cursor.offset, maxBytes - bytesRead - 2 * PROBE_BYTES);
                if (available <= 0 && cursor.offset < stat.size) {
                    pending = true;
                    break;
                }
                if (available > 0) {
                    const buffer = read(cursor.offset, available);
                    let start = 0;
                    let blocked = false;
                    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
                        if (cursor.dropping)
                            cursor.dropping = false;
                        else {
                            try {
                                if (end - start + 1 > MAX_LINE_BYTES)
                                    throw new Error('line_too_large');
                                const value = JSON.parse(buffer.subarray(start, end).toString('utf8'));
                                const seq = value['seq'];
                                if (!Number.isSafeInteger(seq) || Number(seq) < 1 || typeof value['type'] !== 'string')
                                    throw new Error('invalid_seq');
                                if (Number(seq) > maxSeq + 1 || (cursor.lastSeq !== undefined && Number(seq) <= cursor.lastSeq)) {
                                    issue(path, 'history_gap');
                                    cursor.blockedSeq = Number(seq);
                                    blocked = true;
                                    break; // checkpoint before this row: restored archives must let us replay it, including after restart
                                }
                                // Rotation publishes archives before replacing active. Exact overlap is legitimate;
                                // a different event at the same global seq is not. Store only a digest, never bodies.
                                const digest = hash(JSON.stringify(value));
                                const prior = this.db.prepare('SELECT digest FROM context_sequences WHERE seq=?').get(seq);
                                if (Number(seq) <= maxSeq && prior?.digest !== digest)
                                    throw new Error('conflicting_seq');
                                this.db.prepare('INSERT OR IGNORE INTO context_sequences VALUES (?, ?)').run(seq, digest);
                                if (cursor.blockedSeq !== undefined) {
                                    this.db.prepare("DELETE FROM context_issues WHERE path=? AND reason='history_gap'").run(path);
                                    delete cursor.blockedSeq;
                                }
                                cursor.lastSeq = Number(seq);
                                // Persist the contiguous frontier, not merely the maximum seen seq. A replay of a log
                                // that still has a gap must not accidentally certify its own missing history as complete.
                                if (Number(seq) === maxSeq + 1)
                                    maxSeq = Number(seq);
                                if (value['type'] === GENE_CONTEXT_DELIVERY_EVENT || value['type'] === GENE_CONTEXT_OBSERVATION_EVENT)
                                    this.indexEvent(rootEvent.parse(value));
                            }
                            catch {
                                issue(path, 'invalid_row');
                            }
                        }
                        start = end + 1;
                    }
                    cursor.offset += start;
                    if (!blocked && start === 0 && buffer.length >= MAX_LINE_BYTES) {
                        // The writer limit includes LF: a legal incomplete row has at most MAX_LINE_BYTES - 1 bytes.
                        // Oversized data is corruption, not a partial legal append. Skip it without raising scan budgets.
                        cursor.offset += buffer.length;
                        cursor.dropping = true;
                        issue(path, 'invalid_row');
                    }
                    if (cursor.offset < stat.size) {
                        pending = true;
                        partial = cursor.offset + (buffer.length - start) === stat.size;
                    }
                    const length = Math.min(PROBE_BYTES, cursor.offset);
                    cursor.head = hash(read(0, length));
                    cursor.tail = hash(read(cursor.offset - length, length));
                    cursor.size = stat.size;
                    cursor.mtimeMs = stat.mtimeMs;
                    this.db.prepare('INSERT OR REPLACE INTO context_cursors VALUES (?, ?)').run(path, JSON.stringify(cursor));
                }
            }
            finally {
                closeSync(fd);
            }
            // Finish the earliest unfinished file before consuming later sequences; next tick resumes, never skips a tail.
            if (pending)
                break;
        }
        this.setState('maxSeq', String(maxSeq));
        const integrity = this.db.prepare('SELECT reason FROM context_issues LIMIT 1').get()?.reason;
        return { status: integrity ? 'unknown' : pending ? 'catching_up' : 'complete', bytesRead, indexedThroughSeq: maxSeq,
            ...(integrity ? { reason: integrity } : partial ? { reason: 'partial_tail' } : {}) };
    }
    indexEvent(event) {
        const payload = event['payload'];
        if (!payload || typeof payload['sessionId'] !== 'string' || !payload['sessionId'] || payload['sessionId'].length > 1024)
            return;
        const session = hash(payload['sessionId']);
        if (event['type'] === GENE_CONTEXT_DELIVERY_EVENT && payload['transport'] === 'stdout_written') {
            const receipt = readGeneContextDeliveryReceipt(payload['receipt']);
            if (!receipt)
                return;
            this.db.prepare('INSERT OR IGNORE INTO context_deliveries VALUES (?, ?, ?, ?, ?, ?, 0)')
                .run(session, Number(event['seq']), receipt.digest, receipt.geneAssetIds.length, receipt.capsuleAssetIds.length, Number(receipt.truncated));
            this.db.prepare('INSERT OR IGNORE INTO context_delivery_identity VALUES (?, ?, ?, ?)')
                .run(session, Number(event['seq']), receipt.digest, geneContextDeliveryIdentity(event, payload['sessionId'], receipt.digest));
        }
        else if (event['type'] === GENE_CONTEXT_OBSERVATION_EVENT && Number.isSafeInteger(payload['deliverySeq'])
            && typeof payload['digest'] === 'string' && /^sha256:[a-f0-9]{64}$/.test(payload['digest'])) {
            const delivery = this.db.prepare('SELECT identity FROM context_delivery_identity WHERE session=? AND seq=? AND digest=?')
                .get(session, payload['deliverySeq'], payload['digest']);
            // Current writers stamp the immutable event identity before dispatch. A
            // late old-generation append cannot acknowledge a new same-seq delivery.
            // Legacy unbound observations remain readable, but never pre-acknowledge
            // a delivery which does not yet exist in this authoritative history.
            if (!delivery || Number(payload['deliverySeq']) >= Number(event['seq'])
                || (payload['deliveryIdentity'] !== undefined && payload['deliveryIdentity'] !== delivery['identity']))
                return;
            this.markObserved(session, Number(payload['deliverySeq']), payload['digest']);
        }
    }
    markObserved(session, seq, digest) {
        this.db.prepare('INSERT OR IGNORE INTO context_observed VALUES (?, ?, ?)').run(session, seq, digest);
        this.db.prepare('UPDATE context_deliveries SET observed=1 WHERE session=? AND seq=? AND digest=?').run(session, seq, digest);
    }
    /** A caller without the durable tick must not reserve session work from its owner. */
    get observationReady() {
        return (this.protectedClient ? Boolean(this.protectedToken) : this.locked)
            && this.progress.status === 'complete' && !this.observing;
    }
    /** Includes catch-up/unknown changes after beginTick; callers must not report its initial snapshot as final. */
    get currentProgress() {
        if (this.protectedClient && this.protectedToken) {
            this.progress = protectedAuditRpcSync('index_progress', this.eventsPath, this.protectedToken, { deadlineAt: Date.now() + 30_000 });
        }
        return { ...this.progress };
    }
    async observeSession(sessionId, sink, limit = 64, options = {}) {
        if (this.protectedClient) {
            if (!sink.beginContextObservationV1 || sink.path === undefined
                || canonicalEventPath(sink.path) !== this.eventsPath || !this.protectedToken) {
                throw new Error('context_observation_sink_mismatch');
            }
            const result = await protectedAuditRpc('index_observe', this.eventsPath, { token: this.protectedToken, sessionId, limit }, { deadlineAt: options.deadlineAt ?? Date.now() + 30_000,
                ...(options.signal ? { signal: options.signal } : {}) });
            this.progress = result.progress;
            return result.observation;
        }
        const begin = sink.beginContextObservationV1?.bind(sink);
        if (!begin)
            throw new Error('unsupported_context_observation_sink_v1');
        const assertSink = () => {
            const path = sink.path;
            if (path === undefined || canonicalEventPath(path) !== this.eventsPath)
                throw new Error('context_observation_sink_mismatch');
        };
        assertSink();
        // Non-waiting backpressure matches beginTick: a second caller may retry after the active one.
        if (this.observing)
            return { emitted: 0, hasDelivery: false, historyComplete: false };
        // A path-based lease cannot serialize hardlink aliases. Match the authoritative
        // writer's single-link contract, including aliases/replacements added after scan.
        try {
            let changed = false;
            for (const [path, prior] of this.historyIdentities) {
                const named = lstatSync(path);
                if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1)
                    throw new Error('unsafe_context_history');
                const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
                try {
                    const stat = fstatSync(fd);
                    assertOpenedRegularAssetFile(fd, path);
                    if (!stat.isFile() || stat.nlink !== 1 || `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== prior.identity)
                        throw new Error('unsafe_context_history');
                    if (stat.size !== prior.size || stat.mtimeMs !== prior.mtimeMs)
                        changed = true;
                }
                finally {
                    closeSync(fd);
                }
            }
            if (!this.historyIdentities.has(this.eventsPath)) {
                try {
                    lstatSync(this.eventsPath);
                    changed = true;
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
            }
            if (changed && this.locked && this.progress.status === 'complete') {
                // Catch concurrent appends before claiming absence. All sessions share the ORIGINAL tick byte budget.
                const consumed = this.progress.bytesRead;
                this.db.exec('BEGIN IMMEDIATE');
                try {
                    const refreshed = this.advance(Math.max(0, this.tickBudget - consumed));
                    this.db.exec('COMMIT');
                    this.progress = { ...refreshed, bytesRead: consumed + refreshed.bytesRead };
                }
                catch (error) {
                    try {
                        this.db.exec('ROLLBACK');
                    }
                    catch { /* preserve the original failure */ }
                    throw error;
                }
            }
        }
        catch {
            this.progress = { ...this.progress, status: 'unknown', reason: 'unavailable' };
        }
        const historyComplete = this.locked && this.progress.status === 'complete';
        if (!this.locked)
            return { emitted: 0, hasDelivery: false, historyComplete: false };
        const session = hash(sessionId);
        const hasDelivery = Boolean(this.db.prepare('SELECT 1 FROM context_deliveries WHERE session=? LIMIT 1').get(session));
        // Catch up ALL prior observations first, including after restart; absence in a partial index is not absence.
        if (!historyComplete)
            return { emitted: 0, hasDelivery, historyComplete };
        const cursorKey = `observation-round:${session}`;
        const saved = this.getState(cursorKey);
        const round = saved ? JSON.parse(saved) : { after: 0, through: 0 };
        const query = this.db.prepare(`SELECT d.*, i.identity FROM context_deliveries d JOIN context_delivery_identity i
      ON d.session=i.session AND d.seq=i.seq AND d.digest=i.digest WHERE d.session=? AND observed=0
      AND d.seq>? AND d.seq<=? ORDER BY d.seq LIMIT ?`);
        const rowLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(256, limit)) : 64;
        let rows = query.all(session, round.after, round.through, rowLimit);
        if (!rows.length) {
            // Seal each round's upper bound. An unending stream of newer deliveries
            // cannot prevent returning to old retryable/pending rows after this round.
            round.after = 0;
            round.through = Number(this.db.prepare('SELECT MAX(seq) AS seq FROM context_deliveries WHERE session=?').get(session)?.['seq'] ?? 0);
            rows = query.all(session, 0, round.through, rowLimit);
        }
        let emitted = 0;
        let pending = false;
        const wait = { ...options }, sharedWait = {};
        this.observing = true;
        try {
            for (const row of rows) {
                // Retry unknown entries after visiting the rest, so a bounded oldest page cannot starve later work.
                this.setState(cursorKey, JSON.stringify({ after: row.seq, through: round.through }));
                const raw = { type: GENE_CONTEXT_OBSERVATION_EVENT, human: { title: 'Context delivery attribution unavailable' },
                    payload: { sessionId, deliverySeq: row.seq, digest: row.digest, deliveryIdentity: row.identity, observedUse: 'unknown', reason: 'no_trusted_turn_boundary',
                        geneCount: row.genes, caseCount: row.cases, receiptTruncated: Boolean(row.truncated) } };
                assertSink();
                const dispatch = Ingestor.isBuiltInObservationSink(sink)
                    ? builtInContextObservationDispatch(sink, raw, this.eventsPath)
                    : { version: 1, begin: (attempt) => begin(raw, attempt) };
                const result = await settleContextObservation(durableObservationIntents(this.eventsPath), JSON.stringify([this.identityPath, session, row.identity]), dispatch, wait, sharedWait);
                if (result === 'pending') {
                    pending = true;
                    continue;
                }
                // Count the authoritative append even if the disposable index cannot mark
                // it. Recovery replays the log; an existing committed intent is not new output.
                if (result === 'committed')
                    emitted++;
                this.markObserved(session, row.seq, row.digest);
            }
        }
        catch (error) {
            // A rejected acknowledgement does not prove the append failed. Re-read authoritative events
            // on the next tick before retrying, including after the local marker failed to persist.
            this.progress = { ...this.progress, status: 'unknown', reason: 'unavailable' };
            throw new ContextObservationFailure(error, emitted);
        }
        finally {
            this.observing = false;
        }
        return { emitted, hasDelivery, historyComplete, ...(pending ? { pending: true } : {}) };
    }
}