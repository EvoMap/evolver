import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync, } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { algo, events, util } from '@evomap/evolver-core';
const ACTIVE_FILE = 'memory_graph.v2.jsonl';
const COMPACT_FILE = 'memory_graph.compact.jsonl';
const LOCK_FILE = 'memory_graph.lock';
const RECOVERY_FILE = 'memory_graph.recovery.json';
const EPOCH_FILE = 'memory_graph.epoch.json';
const ROTATION_JOURNAL_FILE = 'memory_graph.rotation.json';
const ARCHIVE_PATTERN = /^memory_graph\.v2\.(\d{13})\.jsonl\.gz$/;
const ROTATION_GENERATION_PATTERN = /^\d{13}$/;
const ROTATION_TRANSACTION_PATTERN = /^txn_[a-f0-9]{64}$/;
const ROTATION_STAGE_PATTERN = /^memory_graph\.rotation\.(\d{13})\.(compact|archive|active)\.stage$/;
const ROTATION_TEMP_PATTERN = /^\.(?:memory_graph\.rotation\.json|memory_graph\.rotation\.(\d{13})\.(compact|archive|active)\.stage)\.(\d{13})\.tmp$/;
const RESET_BACKUP_PATTERN = /^memory_graph\.reset\.(\d{13,})$/;
const RESET_PENDING_PATTERN = /^memory_graph\.reset\.pending\.(\d{13,})$/;
const LEGACY_EPOCH_ID = 'legacy';
const DEFAULT_MAX_COMPACT_BYTES = 2 * 1024 * 1024;
const MAX_ROTATION_JOURNAL_BYTES = 64 * 1024;
export function resolveLocalMemoryUserId(info = userInfo()) {
    if (Number.isInteger(info.uid) && info.uid >= 0)
        return String(info.uid);
    return `account:${process.platform}:${info.username.trim().toLowerCase()}:${resolve(info.homedir)}`;
}
export function resolveLocalMemoryUserIdentity(graphDir, info = userInfo()) {
    const userId = resolveLocalMemoryUserId(info);
    if (info.uid !== -1)
        return { userId, legacyUserIds: [] };
    const fromHome = relative(resolve(info.homedir), resolve(graphDir));
    const privateToAccount = fromHome === '' || (!fromHome.startsWith('..') && !isAbsolute(fromHome));
    return { userId, legacyUserIds: privateToAccount ? ['-1'] : [] };
}
export class MemoryGraphImportStateRejectedError extends Error {
    constructor() {
        super('memory_graph_import_state_rejected');
        this.name = 'MemoryGraphImportStateRejectedError';
    }
}
const memoryGraphV1OutcomePlans = new WeakMap();
export class MemoryGraphBusyError extends Error {
    constructor() {
        super('memory_graph_busy');
        this.name = 'MemoryGraphBusyError';
    }
}
export class LocalMemoryGraph {
    dir;
    userScope;
    readableUserScopes;
    now;
    maxActiveBytes;
    maxTailBytes;
    maxLineBytes;
    maxCompactBytes;
    maxCompactEdges;
    archiveRetention;
    onRotationPhase;
    importedFingerprints = new Map();
    rotationCleanupFailed = false;
    constructor(options) {
        this.dir = resolve(options.dir);
        this.userScope = scopeHash(`user:${options.userId}`);
        this.readableUserScopes = new Set([
            this.userScope,
            ...(options.legacyUserIds ?? []).map((userId) => scopeHash(`user:${userId}`)),
        ]);
        this.now = options.now ?? Date.now;
        this.maxActiveBytes = positiveInt(options.maxActiveBytes, 4 * 1024 * 1024);
        this.maxTailBytes = positiveInt(options.maxTailBytes, 512 * 1024);
        this.maxLineBytes = positiveInt(options.maxLineBytes, 16 * 1024);
        this.maxCompactBytes = positiveInt(options.maxCompactBytes, DEFAULT_MAX_COMPACT_BYTES);
        this.maxCompactEdges = positiveInt(options.maxCompactEdges, 4096);
        this.archiveRetention = positiveInt(options.archiveRetention, 3);
        this.onRotationPhase = options.onRotationPhase;
    }
    query(input) {
        const diagnostics = emptyDiagnostics();
        const workspaceScope = this.workspaceScope(input.workspace);
        if (!workspaceScope)
            return { genes: [], diagnostics: { ...diagnostics, recovery: 'degraded' } };
        try {
            return this.withGraphLock(() => {
                const records = this.readQueryableRecords(diagnostics).filter((record) => {
                    if (record.provenance !== 'v2_local' && record.provenance !== 'v1_import') {
                        diagnostics.provenanceRejected += 1;
                        return false;
                    }
                    if (record.workspaceScope !== workspaceScope || !this.readableUserScopes.has(record.userScope)) {
                        diagnostics.scopeRejected += 1;
                        return false;
                    }
                    return true;
                });
                if (this.rotationCleanupFailed)
                    diagnostics.recovery = 'degraded';
                if (records.length === 0 && diagnostics.recovery === 'healthy')
                    diagnostics.recovery = 'empty';
                return algo.deriveMemoryGraphAdvice(records, input.signals, this.now(), diagnostics);
            });
        }
        catch (error) {
            if (error instanceof MemoryGraphBusyError) {
                return { genes: [], diagnostics: { ...diagnostics, recovery: 'degraded', busy: true } };
            }
            throw error;
        }
    }
    recordOutcome(input) {
        const workspaceScope = this.workspaceScope(input.workspace);
        if (!workspaceScope)
            return;
        const geneId = algo.safeMemoryGeneId(input.geneId);
        if (!geneId)
            return;
        const signals = algo.normalizeMemorySignals(input.signals);
        const record = {
            version: 2,
            kind: 'outcome',
            provenance: 'v2_local',
            workspaceScope,
            userScope: this.userScope,
            signalFingerprint: algo.memorySignalFingerprint(signals),
            signals,
            geneId,
            status: input.status,
            score: clampScore(input.score),
            at: validIso(input.at) ?? new Date(this.now()).toISOString(),
        };
        let persisted = false;
        try {
            this.withGraphLock(() => { persisted = this.appendRecordUnlocked(record); });
        }
        catch (error) {
            // The append is already durable, so surfacing only the cleanup failure would invite duplicate retries.
            if (persisted && error instanceof util.LockReleaseError)
                return;
            throw error;
        }
    }
    importV1Outcome(workspace, raw, source = 'legacy-memory-graph') {
        const workspaceScope = this.workspaceScope(workspace);
        if (!workspaceScope)
            return false;
        const sourceScope = scopeHash(`source:${source}`);
        const parsed = parseV1Outcome(raw, workspaceScope, this.userScope, sourceScope);
        if (!parsed)
            return false;
        return this.withGraphLock(() => {
            const dedupeScope = `${workspaceScope}\u0000${this.userScope}\u0000${sourceScope}`;
            const cache = this.importFingerprintCache(dedupeScope, workspaceScope, sourceScope);
            if (hasImportFingerprint(cache.values, parsed))
                return false;
            if (!this.appendRecordUnlocked(parsed))
                return false;
            addImportFingerprints(cache.values, parsed);
            cache.stateFingerprint = this.importStateFingerprint();
            return true;
        });
    }
    /** Builds a stable import forecast without creating or locking the target graph. */
    planV1Outcomes(workspace, raws, source = 'legacy-memory-graph') {
        const total = raws.length;
        const sourceScope = scopeHash(`source:${source}`);
        const workspacePath = workspace ? resolve(workspace) : null;
        const workspaceScope = workspacePath ? this.workspaceScope(workspacePath) : null;
        if (!workspacePath || !workspaceScope) {
            return sealV1OutcomePlan({ total, importable: 0, duplicates: 0, rejected: 0, deferred: total }, {
                graphDir: this.dir,
                userScope: this.userScope,
                workspacePath: null,
                workspaceScope: null,
                sourceScope,
                records: Object.freeze([]),
            });
        }
        const target = this.readStableImportState();
        const fingerprints = collectImportFingerprints(target.records, workspaceScope, this.userScope, sourceScope);
        const records = [];
        let importable = 0;
        let duplicates = 0;
        let rejected = 0;
        for (const raw of raws) {
            const parsed = parseV1Outcome(raw, workspaceScope, this.userScope, sourceScope);
            if (!parsed) {
                rejected += 1;
                continue;
            }
            const normalized = { ...parsed, signals: [...parsed.signals] };
            Object.freeze(normalized.signals);
            Object.freeze(normalized);
            if (hasImportFingerprint(fingerprints, parsed)) {
                duplicates += 1;
                records.push(normalized);
                continue;
            }
            if (!this.importRecordFits(parsed, target.epochId)) {
                rejected += 1;
                continue;
            }
            records.push(normalized);
            addImportFingerprints(fingerprints, normalized);
            importable += 1;
        }
        Object.freeze(records);
        return sealV1OutcomePlan({
            total,
            importable,
            duplicates,
            rejected,
            deferred: 0,
        }, {
            graphDir: this.dir,
            userScope: this.userScope,
            workspacePath,
            workspaceScope,
            sourceScope,
            records,
        });
    }
    /** Applies only the normalized records sealed by planV1Outcomes. */
    applyV1OutcomePlan(plan) {
        const data = memoryGraphV1OutcomePlans.get(plan);
        if (!data || data.graphDir !== this.dir || data.userScope !== this.userScope) {
            throw new Error('memory_graph_import_plan_rejected');
        }
        if (data.records.length === 0)
            return 0;
        const workspacePath = data.workspacePath;
        const workspaceScope = data.workspaceScope;
        if (!workspacePath || !workspaceScope
            || this.workspaceScope(workspacePath) !== workspaceScope) {
            throw new Error('memory_graph_import_plan_rejected');
        }
        let committedImported;
        try {
            return this.withGraphLock(() => {
                const dedupeScope = `${workspaceScope}\u0000${this.userScope}\u0000${data.sourceScope}`;
                const cache = this.importFingerprintCache(dedupeScope, workspaceScope, data.sourceScope);
                let imported = 0;
                for (const record of data.records) {
                    if (hasImportFingerprint(cache.values, record))
                        continue;
                    if (!this.appendRecordUnlocked(record))
                        continue;
                    addImportFingerprints(cache.values, record);
                    imported += 1;
                }
                cache.stateFingerprint = this.importStateFingerprint();
                committedImported = imported;
                return imported;
            });
        }
        catch (error) {
            // The completed appends are durable, so a cleanup-only failure must not invite replay.
            if (committedImported !== undefined && committedImported > 0
                && error instanceof util.LockReleaseError)
                return committedImported;
            throw error;
        }
    }
    maintain() {
        return this.withGraphLock(() => this.withRotationCleanupStatus(this.maintainUnlocked()));
    }
    maintainUnlocked() {
        this.ensureSecureDir();
        const state = this.managedGraphStateFiles();
        const epoch = this.readEpochState();
        const health = this.inspectHealthUnlocked();
        const recoveryDegraded = this.recoveryMarkerState(epoch) === 'degraded';
        if ((health.archives > 0 || recoveryDegraded) && this.compactRequiresRecovery(epoch)) {
            const recovered = this.recoverFromArchivesUnlocked(epoch);
            if (recovered.recovery === 'recovered' || recovered.recovery === 'degraded'
                || (recovered.recovery === 'empty' && health.activeRecords === 0))
                return recovered;
        }
        const activeState = state.find((file) => file.name === ACTIVE_FILE);
        const activeBaseline = epoch.baseline?.active;
        const activeBaselineTruncated = Boolean(activeState && activeBaseline
            && serializedIdentityMatches(activeBaseline.snapshot, activeState.identity)
            && activeState.identity.size < BigInt(activeBaseline.offset));
        const active = activeBaselineTruncated
            ? null
            : this.activePayloadForEpoch(epoch, this.maxActiveBytes);
        if (active === null || !active.exists || active.logicalSize < this.maxActiveBytes) {
            return {
                rotated: false,
                compactedRecords: health.compactedRecords,
                corruptLines: health.corruptLines,
                oversizedLines: health.oversizedLines,
                archives: health.archives,
                recovery: health.recovery,
            };
        }
        return this.rotateAndCompactUnlocked(epoch);
    }
    recoverFromArchives() {
        return this.withGraphLock(() => this.withRotationCleanupStatus(this.recoverFromArchivesUnlocked()));
    }
    /** Enforce archive retention without changing active or compact state. */
    prune() {
        return this.withGraphLock(() => {
            this.ensureSecureDir();
            this.managedGraphStateFiles();
            this.readEpochState();
            this.pruneArchives();
            const health = this.inspectHealthUnlocked();
            return this.withRotationCleanupStatus({
                rotated: false,
                compactedRecords: health.compactedRecords,
                corruptLines: health.corruptLines,
                oversizedLines: health.oversizedLines,
                archives: health.archives,
                recovery: health.recovery,
            });
        });
    }
    /**
     * Copy every managed graph file into a non-active backup, then atomically
     * advance the local storage epoch.
     * The CLI requires explicit opt-in (`--yes`) before calling this method.
     */
    resetGraph() {
        let committed;
        try {
            return this.withGraphLock(() => {
                this.ensureSecureDir();
                this.managedGraphStateFiles();
                this.readEpochState();
                this.ensureEpochStateFile();
                const state = this.managedGraphStateFiles();
                const backup = this.createResetBackupDirectory();
                const copied = [];
                try {
                    for (const file of state) {
                        const payload = this.readResetSource(file);
                        const destination = join(backup.pendingDir, file.name);
                        this.writeAtomic(destination, payload);
                        const copiedIdentity = lstatSync(destination, { bigint: true });
                        const copiedPayload = this.readRawBounded(destination, payload.length);
                        if (!copiedIdentity.isFile() || copiedIdentity.isSymbolicLink()
                            || copiedPayload === null || !copiedPayload.equals(payload)) {
                            throw new Error('memory_graph_reset_backup_failed');
                        }
                        copied.push({ name: file.name, path: destination, identity: copiedIdentity });
                    }
                    this.assertManagedStateUnchanged(state);
                    this.publishResetBackup(backup);
                    this.assertManagedStateUnchanged(state);
                }
                catch {
                    this.cleanupResetPendingDirectory(backup, copied);
                    throw new Error('memory_graph_reset_backup_failed');
                }
                const epochState = {
                    version: 1,
                    epochId: backup.backupId,
                    activatedAt: new Date(this.now()).toISOString(),
                    baseline: this.epochBaselineFromState(state),
                };
                const report = {
                    rotated: false,
                    compactedRecords: 0,
                    corruptLines: 0,
                    oversizedLines: 0,
                    archives: state.filter((file) => ARCHIVE_PATTERN.test(file.name)).length,
                    recovery: 'empty',
                    backupId: backup.backupId,
                    backupFiles: copied.length,
                    epochId: backup.backupId,
                };
                if (this.rotationCleanupFailed)
                    report.recovery = 'degraded';
                try {
                    this.writeEpochState(epochState);
                }
                catch {
                    // The completed backup is intentionally retained. Until this atomic
                    // publish succeeds, readers continue using the previous epoch.
                    throw new Error('memory_graph_reset_failed');
                }
                committed = report;
                this.importedFingerprints.clear();
                return committed;
            });
        }
        catch (error) {
            if (committed) {
                const reason = error instanceof util.LockReleaseError
                    ? error.reason
                    : 'release_failed';
                return { ...committed, lockReleaseWarning: reason };
            }
            throw error;
        }
    }
    managedGraphStateFiles() {
        const names = [
            ...this.archiveFiles(),
            RECOVERY_FILE,
            EPOCH_FILE,
            ACTIVE_FILE,
            COMPACT_FILE,
        ];
        const state = [];
        for (const name of names) {
            const path = join(this.dir, name);
            let identity;
            try {
                identity = lstatSync(path, { bigint: true });
            }
            catch (error) {
                if (isObject(error) && error['code'] === 'ENOENT')
                    continue;
                throw new Error('memory_graph_path_rejected');
            }
            if (!identity.isFile() || identity.isSymbolicLink())
                throw new Error('memory_graph_path_rejected');
            state.push({ name, path, identity });
        }
        return state;
    }
    createResetBackupDirectory() {
        const latest = readdirSync(this.dir)
            .map((name) => BigInt(RESET_BACKUP_PATTERN.exec(name)?.[1]
            ?? RESET_PENDING_PATTERN.exec(name)?.[1]
            ?? 0))
            .reduce((max, value) => value > max ? value : max, 0n);
        const now = BigInt(Math.max(0, Math.floor(this.now())));
        const timestamp = now > latest ? now : latest + 1n;
        const backupId = timestamp.toString().padStart(13, '0');
        const backupDir = join(this.dir, `memory_graph.reset.${backupId}`);
        const pendingDir = join(this.dir, `memory_graph.reset.pending.${backupId}`);
        let created = false;
        try {
            assertPathMissing(backupDir, 'memory_graph_reset_backup_failed');
            assertPathMissing(pendingDir, 'memory_graph_reset_backup_failed');
            mkdirSync(pendingDir, { mode: 0o700 });
            created = true;
            const pendingIdentity = lstatSync(pendingDir, { bigint: true });
            if (!pendingIdentity.isDirectory() || pendingIdentity.isSymbolicLink()) {
                throw new Error('memory_graph_reset_backup_failed');
            }
            return { backupId, backupDir, pendingDir, pendingIdentity };
        }
        catch {
            if (created) {
                try {
                    rmdirSync(pendingDir);
                }
                catch {
                    // Leave an unexpected directory untouched for operator inspection.
                }
            }
            throw new Error('memory_graph_reset_backup_failed');
        }
    }
    publishResetBackup(backup) {
        const identity = lstatSync(backup.pendingDir, { bigint: true });
        if (!identity.isDirectory() || identity.isSymbolicLink()
            || !sameGraphFileIdentity(backup.pendingIdentity, identity)) {
            throw new Error('memory_graph_reset_backup_failed');
        }
        assertPathMissing(backup.backupDir, 'memory_graph_reset_backup_failed');
        renameSync(backup.pendingDir, backup.backupDir);
        const published = lstatSync(backup.backupDir, { bigint: true });
        if (!published.isDirectory() || published.isSymbolicLink()
            || !sameGraphFileIdentity(backup.pendingIdentity, published)) {
            throw new Error('memory_graph_reset_backup_failed');
        }
    }
    cleanupResetPendingDirectory(backup, copied) {
        for (const file of [...copied].reverse()) {
            try {
                const current = lstatSync(file.path, { bigint: true });
                if (current.isFile() && !current.isSymbolicLink()
                    && sameGraphFileIdentity(file.identity, current))
                    unlinkSync(file.path);
            }
            catch {
                // Live graph state was never changed; leave uncertain backup artifacts untouched.
            }
        }
        try {
            const current = lstatSync(backup.pendingDir, { bigint: true });
            if (current.isDirectory() && !current.isSymbolicLink()
                && sameGraphFileIdentity(backup.pendingIdentity, current)
                && readdirSync(backup.pendingDir).length === 0)
                rmdirSync(backup.pendingDir);
        }
        catch {
            // A completed rename or an uncertain replacement must remain untouched.
        }
    }
    readResetSource(file) {
        const limit = file.name === ACTIVE_FILE
            ? this.maxActiveBytes + this.maxLineBytes
            : file.name === COMPACT_FILE
                ? this.maxCompactBytes + this.maxLineBytes
                : file.name === RECOVERY_FILE || file.name === EPOCH_FILE
                    ? this.maxLineBytes
                    : this.maxActiveBytes + this.maxLineBytes;
        if (file.identity.size > BigInt(limit))
            throw new Error('memory_graph_reset_backup_failed');
        const fd = openNoFollow(file.path, constants.O_RDONLY, 0o600);
        try {
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()
                || !sameGraphFileSnapshot(file.identity, before)
                || before.size > BigInt(limit))
                throw new Error('memory_graph_reset_backup_failed');
            const payload = readFdBytes(fd, Number(before.size), 0);
            const after = fstatSync(fd, { bigint: true });
            if (payload.length !== Number(before.size)
                || !sameGraphFileSnapshot(before, after))
                throw new Error('memory_graph_reset_backup_failed');
            return payload;
        }
        finally {
            closeSync(fd);
        }
    }
    assertManagedStateUnchanged(expected) {
        const current = this.managedGraphStateFiles();
        if (current.length !== expected.length)
            throw new Error('memory_graph_reset_backup_failed');
        for (let index = 0; index < expected.length; index += 1) {
            const before = expected[index];
            const after = current[index];
            if (!before || !after || before.name !== after.name
                || !sameGraphFileSnapshot(before.identity, after.identity)) {
                throw new Error('memory_graph_reset_backup_failed');
            }
        }
    }
    ensureEpochStateFile() {
        const path = join(this.dir, EPOCH_FILE);
        try {
            lstatSync(path);
            this.readEpochState();
            return;
        }
        catch (error) {
            if (!isObject(error) || error['code'] !== 'ENOENT') {
                if (error instanceof Error && error.message === 'memory_graph_epoch_rejected')
                    throw error;
                throw new Error('memory_graph_epoch_rejected');
            }
        }
        if (this.hasResetBackup())
            throw new Error('memory_graph_epoch_rejected');
        this.writeEpochState({
            version: 1,
            epochId: LEGACY_EPOCH_ID,
            activatedAt: new Date(this.now()).toISOString(),
        });
    }
    currentEpochId() {
        return this.readEpochState().epochId;
    }
    epochBaselineFromState(state) {
        const active = state.find((file) => file.name === ACTIVE_FILE);
        const compact = state.find((file) => file.name === COMPACT_FILE);
        const recovery = state.find((file) => file.name === RECOVERY_FILE);
        const archives = state
            .filter((file) => ARCHIVE_PATTERN.test(file.name))
            .slice(-this.archiveRetention)
            .map((file) => ({ name: file.name, snapshot: serializeGraphFileSnapshot(file.identity) }));
        if (active && active.identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('memory_graph_epoch_rejected');
        }
        return {
            active: active
                ? { snapshot: serializeGraphFileSnapshot(active.identity), offset: Number(active.identity.size) }
                : null,
            compact: compact ? serializeGraphFileSnapshot(compact.identity) : null,
            recovery: recovery ? serializeGraphFileSnapshot(recovery.identity) : null,
            archives,
        };
    }
    readEpochState() {
        const path = join(this.dir, EPOCH_FILE);
        let identity;
        try {
            identity = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT') {
                if (this.hasResetBackup())
                    throw new Error('memory_graph_epoch_rejected');
                return { version: 1, epochId: LEGACY_EPOCH_ID, activatedAt: new Date(0).toISOString() };
            }
            throw new Error('memory_graph_epoch_rejected');
        }
        if (!identity.isFile() || identity.isSymbolicLink()
            || identity.size > BigInt(this.maxLineBytes))
            throw new Error('memory_graph_epoch_rejected');
        let fd;
        try {
            fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        }
        catch {
            throw new Error('memory_graph_epoch_rejected');
        }
        try {
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()
                || !sameGraphFileSnapshot(identity, before))
                throw new Error('memory_graph_epoch_rejected');
            const payload = readFdBytes(fd, Number(before.size), 0);
            const after = fstatSync(fd, { bigint: true });
            if (payload.length !== Number(before.size)
                || !sameGraphFileSnapshot(before, after))
                throw new Error('memory_graph_epoch_rejected');
            const raw = JSON.parse(payload.toString('utf8'));
            if (!isObject(raw) || raw['version'] !== 1)
                throw new Error('memory_graph_epoch_rejected');
            const epochId = safeEpochId(raw['epochId']);
            const activatedAt = typeof raw['activatedAt'] === 'string' ? validIso(raw['activatedAt']) : null;
            if (!epochId || !activatedAt)
                throw new Error('memory_graph_epoch_rejected');
            const hasBaseline = Object.prototype.hasOwnProperty.call(raw, 'baseline');
            const baseline = hasBaseline ? parseEpochBaseline(raw['baseline']) : null;
            if (hasBaseline && !baseline)
                throw new Error('memory_graph_epoch_rejected');
            if (epochId !== LEGACY_EPOCH_ID) {
                if (!/^\d{13,}$/.test(epochId))
                    throw new Error('memory_graph_epoch_rejected');
                let backup;
                try {
                    backup = lstatSync(join(this.dir, `memory_graph.reset.${epochId}`));
                }
                catch {
                    throw new Error('memory_graph_epoch_rejected');
                }
                if (!backup.isDirectory() || backup.isSymbolicLink()) {
                    throw new Error('memory_graph_epoch_rejected');
                }
            }
            return {
                version: 1,
                epochId,
                activatedAt,
                ...(baseline ? { baseline } : {}),
            };
        }
        catch {
            throw new Error('memory_graph_epoch_rejected');
        }
        finally {
            closeSync(fd);
        }
    }
    writeEpochState(state) {
        const payload = Buffer.from(JSON.stringify(state) + '\n', 'utf8');
        if (payload.length > this.maxLineBytes)
            throw new Error('memory_graph_epoch_rejected');
        this.writeAtomic(join(this.dir, EPOCH_FILE), payload);
    }
    hasResetBackup() {
        return readdirSync(this.dir).some((name) => RESET_BACKUP_PATTERN.test(name));
    }
    compactMatchesEpochBaseline(epoch) {
        const baseline = epoch.baseline?.compact;
        if (!baseline)
            return false;
        try {
            const current = lstatSync(join(this.dir, COMPACT_FILE), { bigint: true });
            return current.isFile() && !current.isSymbolicLink()
                && serializedSnapshotMatches(baseline, current);
        }
        catch {
            return false;
        }
    }
    readCompactForEpoch(epoch, diagnostics) {
        return this.compactMatchesEpochBaseline(epoch) ? [] : this.readCompact(diagnostics);
    }
    activeLogicalWindow(epoch, identity) {
        const active = epoch.baseline?.active;
        if (!active || !serializedIdentityMatches(active.snapshot, identity)) {
            return {
                offset: 0,
                size: identity.size > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(identity.size),
                invalid: identity.size > BigInt(Number.MAX_SAFE_INTEGER),
            };
        }
        const offset = active.offset;
        if (identity.size < BigInt(offset) || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            return { offset, size: 0, invalid: true };
        }
        return { offset, size: Number(identity.size) - offset, invalid: false };
    }
    activePayloadForEpoch(epoch, maxBytes) {
        const path = join(this.dir, ACTIVE_FILE);
        let identity;
        try {
            identity = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT') {
                return { payload: Buffer.alloc(0), logicalSize: 0, exists: false };
            }
            throw new Error('memory_graph_rotation_backup_failed');
        }
        if (!identity.isFile() || identity.isSymbolicLink()) {
            throw new Error('memory_graph_path_rejected');
        }
        const window = this.activeLogicalWindow(epoch, identity);
        if (window.invalid || window.size > maxBytes) {
            throw new Error('memory_graph_rotation_backup_failed');
        }
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink()
                || !sameGraphFileSnapshot(identity, before)) {
                throw new Error('memory_graph_rotation_backup_failed');
            }
            const payload = readFdBytes(fd, window.size, window.offset);
            const after = fstatSync(fd, { bigint: true });
            if (payload.length !== window.size || !sameGraphFileSnapshot(before, after)) {
                throw new Error('memory_graph_rotation_backup_failed');
            }
            return { payload, logicalSize: window.size, exists: true };
        }
        finally {
            closeSync(fd);
        }
    }
    readActiveForEpoch(epoch, diagnostics, maxBytes) {
        const path = join(this.dir, ACTIVE_FILE);
        if (!existsSync(path) || !this.secureRegularFile(path))
            return [];
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const identity = fstatSync(fd, { bigint: true });
            if (!identity.isFile() || identity.isSymbolicLink())
                return [];
            const window = this.activeLogicalWindow(epoch, identity);
            if (window.invalid) {
                diagnostics.truncated = true;
                return [];
            }
            const bytes = Math.min(window.size, maxBytes);
            const position = window.offset + window.size - bytes;
            const buffer = readFdBytes(fd, bytes, position);
            diagnostics.bytesRead += buffer.length;
            diagnostics.truncated ||= window.size > buffer.length;
            if (window.size <= buffer.length)
                return this.parseBuffer(buffer, diagnostics);
            const newline = buffer.indexOf(0x0a);
            return this.parseBuffer(newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0), diagnostics);
        }
        finally {
            closeSync(fd);
        }
    }
    currentArchiveFiles(epoch) {
        const baseline = new Map((epoch.baseline?.archives ?? [])
            .map((entry) => [entry.name, entry.snapshot]));
        return this.archiveFiles().slice(-this.archiveRetention).filter((file) => {
            const expected = baseline.get(file);
            if (!expected)
                return true;
            try {
                const current = lstatSync(join(this.dir, file), { bigint: true });
                return !current.isFile() || current.isSymbolicLink()
                    || !serializedSnapshotMatches(expected, current);
            }
            catch {
                return true;
            }
        });
    }
    recoverFromArchivesUnlocked(epochState) {
        this.ensureSecureDir();
        this.managedGraphStateFiles();
        const epoch = epochState ?? this.readEpochState();
        const currentEpoch = epoch.epochId;
        const diagnostics = emptyDiagnostics();
        const compactRecords = this.readCompactForEpoch(epoch, diagnostics)
            .filter((record) => recordEpochId(record) === currentEpoch);
        const archiveRecords = [];
        const maxArchiveBytes = gzipRotationByteBound(this.maxActiveBytes);
        const maxArchiveOutputBytes = safeRotationByteSum(this.maxActiveBytes, this.maxLineBytes);
        for (const file of this.currentArchiveFiles(epoch)) {
            const path = join(this.dir, file);
            if (maxArchiveBytes === null || maxArchiveOutputBytes === null) {
                diagnostics.truncated = true;
                continue;
            }
            if (!this.secureRegularFile(path)) {
                diagnostics.corruptLines += 1;
                continue;
            }
            try {
                const compressed = this.readRawBounded(path, maxArchiveBytes);
                if (compressed === null) {
                    diagnostics.truncated = true;
                    continue;
                }
                const raw = gunzipSync(compressed, { maxOutputLength: maxArchiveOutputBytes });
                archiveRecords.push(...this.parseBuffer(raw, diagnostics)
                    .filter((record) => recordEpochId(record) === currentEpoch));
            }
            catch {
                diagnostics.corruptLines += 1;
            }
        }
        const compacted = mergeRecoveryRecords(compactRecords, archiveRecords, this.maxCompactEdges);
        const incomplete = this.recoveryMarkerState(epoch) === 'degraded'
            || diagnostics.corruptLines > 0
            || diagnostics.oversizedLines > 0
            || diagnostics.truncated;
        // Persist the conservative state before publishing a partial compact so a
        // marker-write failure cannot leave an apparently healthy partial recovery.
        if (incomplete)
            this.writeRecoveryMarker(currentEpoch, 'degraded');
        const compactedRecords = compacted.length > 0 ? this.writeCompact(compacted).records : 0;
        const recovery = incomplete
            || (compacted.length > 0 && compactedRecords === 0)
            ? 'degraded'
            : compactedRecords > 0 ? 'recovered' : 'empty';
        if (!incomplete)
            this.writeRecoveryMarker(currentEpoch, recovery);
        return {
            rotated: false,
            compactedRecords,
            corruptLines: diagnostics.corruptLines,
            oversizedLines: diagnostics.oversizedLines,
            archives: this.archiveFiles().length,
            recovery,
        };
    }
    inspectHealth() {
        try {
            const stat = lstatSync(this.dir);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error('memory_graph_dir_rejected');
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT')
                return emptyHealth();
            throw new Error('memory_graph_dir_rejected');
        }
        try {
            return this.withGraphLock(() => {
                const health = this.inspectHealthUnlocked();
                return this.rotationCleanupFailed ? { ...health, recovery: 'degraded' } : health;
            });
        }
        catch (error) {
            if (error instanceof MemoryGraphBusyError) {
                return { ...emptyHealth(), recovery: 'degraded', busy: true };
            }
            throw error;
        }
    }
    inspectHealthUnlocked() {
        let dirStat;
        try {
            dirStat = lstatSync(this.dir);
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT')
                return emptyHealth();
            throw new Error('memory_graph_dir_rejected');
        }
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
            throw new Error('memory_graph_dir_rejected');
        this.managedGraphStateFiles();
        const epoch = this.readEpochState();
        const epochId = epoch.epochId;
        const compactDiagnostics = emptyDiagnostics();
        const activeDiagnostics = emptyDiagnostics();
        const compactPath = join(this.dir, COMPACT_FILE);
        const activePath = join(this.dir, ACTIVE_FILE);
        const compactedRecords = this.readCompactForEpoch(epoch, compactDiagnostics)
            .filter((record) => recordEpochId(record) === epochId).length;
        const activeRecords = this.readActiveForEpoch(epoch, activeDiagnostics, this.maxActiveBytes)
            .filter((record) => recordEpochId(record) === epochId).length;
        const archives = this.archiveFiles().length;
        let activeOversized = false;
        if (existsSync(activePath) && this.secureRegularFile(activePath)) {
            const activeIdentity = lstatSync(activePath, { bigint: true });
            const window = this.activeLogicalWindow(epoch, activeIdentity);
            activeOversized = window.invalid || window.size > this.maxActiveBytes;
        }
        const oversizedFiles = Number(!this.compactMatchesEpochBaseline(epoch)
            && fileExceeds(compactPath, this.maxCompactBytes))
            + Number(activeOversized);
        const rejectedFiles = Number(existsSync(compactPath) && !this.secureRegularFile(compactPath))
            + Number(existsSync(activePath) && !this.secureRegularFile(activePath));
        const corruptLines = compactDiagnostics.corruptLines + activeDiagnostics.corruptLines + rejectedFiles;
        const oversizedLines = compactDiagnostics.oversizedLines + activeDiagnostics.oversizedLines;
        const archiveProbe = compactedRecords === 0 && archives > 0
            ? this.inspectArchivesForEpoch(epoch)
            : { containsCurrent: false, unreadable: false };
        const compactMissingWithArchives = archiveProbe.containsCurrent || archiveProbe.unreadable;
        const marker = this.recoveryMarkerState(epoch);
        const degraded = corruptLines > 0 || oversizedLines > 0 || oversizedFiles > 0
            || compactMissingWithArchives || marker === 'degraded';
        const records = compactedRecords + activeRecords;
        return {
            recovery: degraded ? 'degraded' : records === 0 ? 'empty' : marker === 'recovered' ? 'recovered' : 'healthy',
            compactedRecords,
            activeRecords,
            corruptLines,
            oversizedLines,
            oversizedFiles,
            archives,
        };
    }
    withGraphLock(operation) {
        this.ensureSecureDir();
        const lockPath = join(this.dir, LOCK_FILE);
        try {
            util.acquireLock(lockPath);
        }
        catch (error) {
            if (error instanceof util.LockTimeoutError)
                throw new MemoryGraphBusyError();
            throw error;
        }
        this.rotationCleanupFailed = false;
        let value;
        let operationError;
        let operationFailed = false;
        try {
            this.ensureSecureDir();
            this.reconcileRotationUnlocked();
            value = operation();
        }
        catch (error) {
            operationFailed = true;
            operationError = error;
        }
        let releaseError;
        try {
            const released = util.releaseLock(lockPath);
            const reliable = released.released
                && (released.reason === 'released' || released.reason === 'released_with_cleanup_error');
            if (!reliable)
                releaseError = new util.LockReleaseError(released.reason);
        }
        catch (error) {
            releaseError = error;
        }
        if (operationFailed)
            throw operationError;
        if (releaseError !== undefined)
            throw releaseError;
        return value;
    }
    importFingerprintCache(dedupeScope, workspaceScope, sourceScope) {
        const stateFingerprint = this.importStateFingerprint();
        let cache = this.importedFingerprints.get(dedupeScope);
        if (!cache || cache.stateFingerprint !== stateFingerprint) {
            cache = {
                stateFingerprint,
                values: collectImportFingerprints(this.readImportRecords(), workspaceScope, this.userScope, sourceScope),
            };
            this.importedFingerprints.set(dedupeScope, cache);
        }
        return cache;
    }
    readStableImportState() {
        let directoryIdentity;
        try {
            directoryIdentity = lstatSync(this.dir, { bigint: true });
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT') {
                return { epochId: LEGACY_EPOCH_ID, records: [] };
            }
            throw new MemoryGraphImportStateRejectedError();
        }
        if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
            throw new MemoryGraphImportStateRejectedError();
        }
        const before = this.importStateFingerprint();
        const epochId = this.currentEpochId();
        const records = this.readImportRecordsFromExistingDir();
        let afterDirectoryIdentity;
        try {
            afterDirectoryIdentity = lstatSync(this.dir, { bigint: true });
        }
        catch {
            throw new MemoryGraphImportStateRejectedError();
        }
        const after = this.importStateFingerprint();
        if (!sameGraphFileSnapshot(directoryIdentity, afterDirectoryIdentity) || before !== after) {
            throw new MemoryGraphImportStateRejectedError();
        }
        return { epochId, records };
    }
    persistedRecordLine(record, epochId) {
        return Buffer.from(JSON.stringify({ ...record, epochId }) + '\n', 'utf8');
    }
    importRecordFits(record, epochId) {
        const line = this.persistedRecordLine(record, epochId);
        return line.length <= this.maxLineBytes && line.length <= this.maxActiveBytes;
    }
    importStateFingerprint() {
        const epochId = this.currentEpochId();
        return [EPOCH_FILE, COMPACT_FILE, ACTIVE_FILE].map((file) => {
            const path = join(this.dir, file);
            let stat;
            try {
                stat = lstatSync(path, { bigint: true });
            }
            catch (error) {
                if (isObject(error) && error['code'] === 'ENOENT')
                    return `${file}:missing`;
                throw new MemoryGraphImportStateRejectedError();
            }
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new MemoryGraphImportStateRejectedError();
            return `${file}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        }).concat(`epoch:${epochId}`).join('|');
    }
    appendRecordUnlocked(record) {
        this.ensureSecureDir();
        const state = this.managedGraphStateFiles();
        const epoch = this.readEpochState();
        const line = this.persistedRecordLine(record, epoch.epochId);
        if (line.length > this.maxLineBytes || line.length > this.maxActiveBytes)
            return false;
        const activePath = join(this.dir, ACTIVE_FILE);
        let activeState = state.find((file) => file.name === ACTIVE_FILE);
        const activeWindow = activeState
            ? this.activeLogicalWindow(epoch, activeState.identity)
            : { offset: 0, size: 0, invalid: false };
        if (activeWindow.invalid)
            throw new Error('memory_graph_epoch_rejected');
        if (activeWindow.size + line.length > this.maxActiveBytes) {
            const maintenance = this.rotateAndCompactUnlocked(epoch);
            if (!maintenance.rotated)
                return false;
            activeState = this.managedGraphStateFiles().find((file) => file.name === ACTIVE_FILE);
        }
        const fd = openNoFollow(activePath, constants.O_WRONLY | constants.O_CREAT, 0o600);
        try {
            const stat = fstatSync(fd, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()
                || (activeState && !sameGraphFileSnapshot(activeState.identity, stat))
                || (!activeState && stat.size !== 0n)
                || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
                return false;
            const originalSize = Number(stat.size);
            try {
                writeAll(fd, line, originalSize);
                fsyncSync(fd);
                return true;
            }
            catch (error) {
                try {
                    ftruncateSync(fd, originalSize);
                    fsyncSync(fd);
                }
                catch {
                    throw new Error('memory_graph_append_rollback_failed');
                }
                throw error;
            }
        }
        finally {
            closeSync(fd);
        }
    }
    rotateAndCompactUnlocked(epochState) {
        this.ensureSecureDir();
        const state = this.managedGraphStateFiles();
        const epoch = epochState ?? this.readEpochState();
        const currentEpoch = epoch.epochId;
        const diagnostics = emptyDiagnostics();
        const compactPath = join(this.dir, COMPACT_FILE);
        const activeState = state.find((file) => file.name === ACTIVE_FILE);
        const compactState = state.find((file) => file.name === COMPACT_FILE);
        const activePayload = this.activePayloadForEpoch(epoch, this.maxActiveBytes);
        if (!activeState || activePayload.logicalSize === 0) {
            throw new Error('memory_graph_rotation_backup_failed');
        }
        const activeWindow = this.activeLogicalWindow(epoch, activeState.identity);
        if (activeWindow.invalid || activeWindow.size !== activePayload.logicalSize) {
            throw new Error('memory_graph_rotation_backup_failed');
        }
        const activeSource = {
            snapshot: serializeGraphFileSnapshot(activeState.identity),
            offset: activeWindow.offset,
            ...rotationFileDigest(activePayload.payload),
        };
        let compactSource = null;
        if (compactState) {
            const compactBound = this.compactMatchesEpochBaseline(epoch)
                ? this.maxCompactBytes + this.maxLineBytes
                : this.maxCompactBytes;
            const verified = this.readVerifiedRotationFile(compactPath, compactBound, false, 'memory_graph_rotation_backup_failed');
            if (!verified || !sameGraphFileSnapshot(compactState.identity, verified.identity)) {
                throw new Error('memory_graph_rotation_backup_failed');
            }
            compactSource = {
                snapshot: serializeGraphFileSnapshot(verified.identity),
                ...rotationFileDigest(verified.payload),
            };
        }
        const records = [
            ...this.readCompactForEpoch(epoch, diagnostics),
            ...this.parseBuffer(activePayload.payload, diagnostics),
        ]
            .filter((record) => recordEpochId(record) === currentEpoch);
        const compacted = compactRecords(records, this.maxCompactEdges);
        const fitted = fitCompactRecords(compacted, this.maxCompactBytes);
        if (compacted.length > 0 && fitted.records.length === 0) {
            return {
                rotated: false,
                compactedRecords: 0,
                corruptLines: diagnostics.corruptLines,
                oversizedLines: diagnostics.oversizedLines,
                archives: this.archiveFiles().length,
                recovery: 'degraded',
            };
        }
        const compactPayload = fitted.payload;
        const archivePayload = gzipSync(activePayload.payload);
        const emptyActive = Buffer.alloc(0);
        const archivePath = this.nextArchivePath();
        const generation = ARCHIVE_PATTERN.exec(basename(archivePath))?.[1];
        if (!generation)
            throw new Error('memory_graph_rotation_backup_failed');
        const stageNames = rotationStageNames(generation);
        const preparedWithoutId = {
            version: 1,
            targetGeneration: generation,
            phase: 'prepared',
            epochId: currentEpoch,
            createdAt: new Date(this.now()).toISOString(),
            limits: {
                maxActiveBytes: this.maxActiveBytes,
                maxCompactBytes: this.maxCompactBytes,
                maxLineBytes: this.maxLineBytes,
                archiveRetention: this.archiveRetention,
            },
            source: { active: activeSource, compact: compactSource },
            target: {
                compact: {
                    stageName: stageNames.compact,
                    finalName: COMPACT_FILE,
                    records: fitted.records.length,
                    ...rotationFileDigest(compactPayload),
                },
                archive: {
                    stageName: stageNames.archive,
                    finalName: basename(archivePath),
                    ...rotationFileDigest(archivePayload),
                },
                active: {
                    stageName: stageNames.active,
                    finalName: ACTIVE_FILE,
                    ...rotationFileDigest(emptyActive),
                },
            },
        };
        const preparedWithId = {
            ...preparedWithoutId,
            transactionId: rotationTransactionId(preparedWithoutId),
        };
        const prepared = {
            ...preparedWithId,
            journalDigest: rotationJournalDigest(preparedWithId),
        };
        for (const name of Object.values(stageNames)) {
            assertPathMissing(join(this.dir, name), 'memory_graph_rotation_recovery_failed');
        }
        assertPathMissing(join(this.dir, ROTATION_JOURNAL_FILE), 'memory_graph_rotation_recovery_failed');
        const preparedJournalIdentity = this.writeRotationJournal(prepared);
        this.notifyRotationPhase(prepared, 'commit', 'journal_prepared');
        this.writeRotationStage(prepared, 'compact', compactPayload);
        this.notifyRotationPhase(prepared, 'commit', 'compact_staged');
        this.writeRotationStage(prepared, 'archive', archivePayload);
        this.notifyRotationPhase(prepared, 'commit', 'archive_staged');
        this.writeRotationStage(prepared, 'active', emptyActive);
        this.notifyRotationPhase(prepared, 'commit', 'active_staged');
        this.assertRotationSourceMatches(prepared);
        this.assertRotationStagesMatch(prepared);
        this.assertRotationJournalUnchanged(prepared, preparedJournalIdentity);
        const committedWithoutDigest = { ...prepared, phase: 'committed' };
        const committed = {
            ...committedWithoutDigest,
            journalDigest: rotationJournalDigest(committedWithoutDigest),
        };
        this.writeRotationJournal(committed);
        this.notifyRotationPhase(committed, 'commit', 'journal_committed');
        this.reconcileCommittedRotation(committed, 'commit');
        const degraded = diagnostics.corruptLines > 0
            || diagnostics.oversizedLines > 0
            || diagnostics.truncated;
        return {
            rotated: true,
            compactedRecords: fitted.records.length,
            corruptLines: diagnostics.corruptLines,
            oversizedLines: diagnostics.oversizedLines,
            archives: this.archiveFiles().length,
            recovery: degraded ? 'degraded' : fitted.records.length > 0 ? 'healthy' : 'empty',
        };
    }
    reconcileRotationUnlocked() {
        const journalPath = join(this.dir, ROTATION_JOURNAL_FILE);
        const stageFiles = this.rotationStageFiles();
        const tempFiles = this.rotationTempFiles();
        let journalPresent = true;
        try {
            lstatSync(journalPath);
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT')
                journalPresent = false;
            else
                throw new Error('memory_graph_rotation_journal_rejected');
        }
        if (!journalPresent) {
            for (const name of tempFiles)
                this.removeRotationTemp(name);
            if (stageFiles.length > 0)
                throw new Error('memory_graph_rotation_recovery_failed');
            return;
        }
        const loaded = this.readRotationJournal();
        const journal = loaded.journal;
        const expectedStages = new Set(Object.values(rotationStageNames(journal.targetGeneration)));
        const expectedTemps = new Set(Object.values(rotationTempNames(journal.targetGeneration)));
        if (stageFiles.some((name) => !expectedStages.has(name))
            || tempFiles.some((name) => !expectedTemps.has(name))) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const epoch = this.readEpochState();
        if (epoch.epochId !== journal.epochId) {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
        if (journal.phase === 'prepared') {
            this.assertRotationSourceMatches(journal);
            for (const target of [
                journal.target.compact,
                journal.target.archive,
                journal.target.active,
            ]) {
                this.removeRotationStage(target);
            }
            for (const name of tempFiles)
                this.removeRotationTemp(name);
            this.notifyRotationPhase(journal, 'recovery', 'before_journal_clear');
            this.removeVerifiedRotationFile(journalPath, loaded.identity, 'memory_graph_rotation_recovery_failed');
            this.notifyRotationPhase(journal, 'recovery', 'journal_cleared');
            return;
        }
        for (const name of tempFiles)
            this.removeRotationTemp(name);
        this.reconcileCommittedRotation(journal, 'recovery', loaded.identity);
    }
    reconcileCommittedRotation(journal, mode, journalIdentity) {
        let identity = journalIdentity;
        if (!identity) {
            const loaded = this.readRotationJournal();
            if (loaded.journal.transactionId !== journal.transactionId
                || loaded.journal.phase !== 'committed') {
                throw new Error('memory_graph_rotation_journal_rejected');
            }
            identity = loaded.identity;
        }
        this.assertCommittedRotationCanApply(journal);
        this.publishRotationFile(journal, journal.target.compact, journal.source.compact, mode, 'compact_published');
        this.publishRotationFile(journal, journal.target.archive, null, mode, 'archive_published');
        this.notifyRotationPhase(journal, mode, 'before_active_publish');
        this.publishRotationActive(journal, mode);
        for (const target of [
            journal.target.compact,
            journal.target.archive,
            journal.target.active,
        ]) {
            this.removeRotationStage(target);
        }
        const cleanupFailed = this.completeCommittedRotationCleanup(journal);
        this.rotationCleanupFailed = this.rotationCleanupFailed || cleanupFailed;
        this.notifyRotationPhase(journal, mode, 'before_journal_clear');
        this.assertCommittedRotationApplied(journal);
        this.removeVerifiedRotationFile(join(this.dir, ROTATION_JOURNAL_FILE), identity, 'memory_graph_rotation_recovery_failed');
        this.notifyRotationPhase(journal, mode, 'journal_cleared');
    }
    completeCommittedRotationCleanup(journal) {
        const epoch = this.readEpochState();
        if (epoch.epochId !== journal.epochId) {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
        try {
            this.managedGraphStateFiles();
            this.clearRecoveryMarker(epoch, journal.limits.maxLineBytes);
            this.pruneArchives(journal.limits.archiveRetention);
            return false;
        }
        catch {
            return true;
        }
    }
    withRotationCleanupStatus(report) {
        return this.rotationCleanupFailed ? { ...report, recovery: 'degraded' } : report;
    }
    assertCommittedRotationApplied(journal) {
        for (const target of [
            journal.target.compact,
            journal.target.archive,
            journal.target.active,
        ]) {
            if (!this.rotationTargetMatches(join(this.dir, target.finalName), target)) {
                throw new Error('memory_graph_rotation_recovery_failed');
            }
        }
    }
    assertCommittedRotationCanApply(journal) {
        this.assertRotationFileReady(journal.target.compact, journal.source.compact);
        this.assertRotationFileReady(journal.target.archive, null);
        const activeTarget = journal.target.active;
        const activePath = join(this.dir, activeTarget.finalName);
        if (this.rotationTargetMatches(activePath, activeTarget)) {
            this.assertOptionalRotationStage(activeTarget);
            return;
        }
        if (!this.rotationActiveSourceMatches(activePath, journal.source.active)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.requireRotationTarget(join(this.dir, activeTarget.stageName), activeTarget);
    }
    assertRotationFileReady(target, source) {
        const finalPath = join(this.dir, target.finalName);
        if (this.rotationTargetMatches(finalPath, target)) {
            this.assertOptionalRotationStage(target);
            return;
        }
        if (source === null) {
            assertPathMissing(finalPath, 'memory_graph_rotation_recovery_failed');
        }
        else if (!this.rotationSourceMatches(finalPath, source)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.requireRotationTarget(join(this.dir, target.stageName), target);
    }
    assertOptionalRotationStage(target) {
        const path = join(this.dir, target.stageName);
        const staged = this.readVerifiedRotationFile(path, target.size, true, 'memory_graph_rotation_recovery_failed');
        if (staged && !rotationDigestMatches(staged.payload, target)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
    }
    publishRotationFile(journal, target, source, mode, phase) {
        const finalPath = join(this.dir, target.finalName);
        if (this.rotationTargetMatches(finalPath, target)) {
            this.removeRotationStage(target);
            this.notifyRotationPhase(journal, mode, phase);
            return;
        }
        if (source === null) {
            assertPathMissing(finalPath, 'memory_graph_rotation_recovery_failed');
        }
        else if (!this.rotationSourceMatches(finalPath, source)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const staged = this.requireRotationTarget(join(this.dir, target.stageName), target);
        try {
            renameSync(join(this.dir, target.stageName), finalPath);
            this.syncGraphDirectory();
        }
        catch {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const published = this.requireRotationTarget(finalPath, target);
        if (!sameGraphFileIdentity(staged.identity, published.identity)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.notifyRotationPhase(journal, mode, phase);
    }
    publishRotationActive(journal, mode) {
        const target = journal.target.active;
        const activePath = join(this.dir, target.finalName);
        if (this.rotationTargetMatches(activePath, target)) {
            this.removeRotationStage(target);
            this.notifyRotationPhase(journal, mode, 'active_published');
            return;
        }
        if (!this.rotationActiveSourceMatches(activePath, journal.source.active)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const staged = this.requireRotationTarget(join(this.dir, target.stageName), target);
        try {
            renameSync(join(this.dir, target.stageName), activePath);
            this.syncGraphDirectory();
        }
        catch {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const published = this.requireRotationTarget(activePath, target);
        if (!sameGraphFileIdentity(staged.identity, published.identity)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.notifyRotationPhase(journal, mode, 'active_published');
    }
    writeRotationJournal(journal) {
        const payload = Buffer.from(JSON.stringify(journal) + '\n', 'utf8');
        if (payload.length > MAX_ROTATION_JOURNAL_BYTES) {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
        const committedIdentity = this.writeAtomic(join(this.dir, ROTATION_JOURNAL_FILE), payload, true, journal.targetGeneration);
        const loaded = this.readRotationJournal();
        if (!sameGraphFileIdentity(committedIdentity, loaded.identity)
            || loaded.journal.transactionId !== journal.transactionId
            || loaded.journal.phase !== journal.phase) {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
        return loaded.identity;
    }
    assertRotationJournalUnchanged(journal, expectedIdentity) {
        const loaded = this.readRotationJournal();
        if (!sameGraphFileSnapshot(expectedIdentity, loaded.identity)
            || loaded.journal.transactionId !== journal.transactionId
            || loaded.journal.phase !== journal.phase) {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
    }
    readRotationJournal() {
        const verified = this.readVerifiedRotationFile(join(this.dir, ROTATION_JOURNAL_FILE), MAX_ROTATION_JOURNAL_BYTES, false, 'memory_graph_rotation_journal_rejected');
        if (!verified)
            throw new Error('memory_graph_rotation_journal_rejected');
        try {
            const value = JSON.parse(verified.payload.toString('utf8'));
            const journal = parseRotationJournal(value);
            if (!journal)
                throw new Error('memory_graph_rotation_journal_rejected');
            return { journal, identity: verified.identity };
        }
        catch {
            throw new Error('memory_graph_rotation_journal_rejected');
        }
    }
    writeRotationStage(journal, kind, payload) {
        const target = journal.target[kind];
        if (!rotationDigestMatches(payload, target)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const committedIdentity = this.writeAtomic(join(this.dir, target.stageName), payload, true, journal.targetGeneration);
        const staged = this.requireRotationTarget(join(this.dir, target.stageName), target);
        if (!sameGraphFileIdentity(committedIdentity, staged.identity)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
    }
    assertRotationStagesMatch(journal) {
        for (const target of [
            journal.target.compact,
            journal.target.archive,
            journal.target.active,
        ]) {
            this.requireRotationTarget(join(this.dir, target.stageName), target);
        }
    }
    assertRotationSourceMatches(journal) {
        if (!this.rotationActiveSourceMatches(join(this.dir, ACTIVE_FILE), journal.source.active)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const compactPath = join(this.dir, COMPACT_FILE);
        if (journal.source.compact === null) {
            assertPathMissing(compactPath, 'memory_graph_rotation_recovery_failed');
        }
        else if (!this.rotationSourceMatches(compactPath, journal.source.compact)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
    }
    rotationActiveSourceMatches(path, source) {
        const physicalSize = Number(source.snapshot.size);
        const verified = this.readVerifiedRotationFile(path, physicalSize, true, 'memory_graph_rotation_recovery_failed', { offset: source.offset, size: source.size });
        if (!verified || !serializedSnapshotMatches(source.snapshot, verified.identity))
            return false;
        if (BigInt(source.offset) + BigInt(source.size) !== verified.identity.size)
            return false;
        return rotationDigestMatches(verified.payload, source);
    }
    rotationSourceMatches(path, source) {
        const verified = this.readVerifiedRotationFile(path, source.size, true, 'memory_graph_rotation_recovery_failed');
        return verified !== null
            && serializedSnapshotMatches(source.snapshot, verified.identity)
            && rotationDigestMatches(verified.payload, source);
    }
    rotationTargetMatches(path, target) {
        let identity;
        try {
            identity = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT')
                return false;
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        if (!identity.isFile() || identity.isSymbolicLink()) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        if (identity.size !== BigInt(target.size))
            return false;
        const verified = this.readVerifiedRotationFile(path, target.size, true, 'memory_graph_rotation_recovery_failed');
        return verified !== null && rotationDigestMatches(verified.payload, target);
    }
    requireRotationTarget(path, target) {
        const verified = this.readVerifiedRotationFile(path, target.size, false, 'memory_graph_rotation_recovery_failed');
        if (!verified || !rotationDigestMatches(verified.payload, target)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        return verified;
    }
    removeRotationStage(target) {
        const path = join(this.dir, target.stageName);
        const verified = this.readVerifiedRotationFile(path, target.size, true, 'memory_graph_rotation_recovery_failed');
        if (!verified)
            return;
        if (!rotationDigestMatches(verified.payload, target)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.removeVerifiedRotationFile(path, verified.identity, 'memory_graph_rotation_recovery_failed');
    }
    removeVerifiedRotationFile(path, identity, reason) {
        let current;
        try {
            current = lstatSync(path, { bigint: true });
        }
        catch {
            throw new Error(reason);
        }
        if (!current.isFile() || current.isSymbolicLink()
            || !sameGraphFileSnapshot(identity, current)) {
            throw new Error(reason);
        }
        try {
            unlinkSync(path);
            this.syncGraphDirectory();
        }
        catch {
            throw new Error(reason);
        }
    }
    readVerifiedRotationFile(path, maxBytes, optional, reason, range) {
        let pathBefore;
        try {
            pathBefore = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (optional && isObject(error) && error['code'] === 'ENOENT')
                return null;
            throw new Error(reason);
        }
        if (!pathBefore.isFile() || pathBefore.isSymbolicLink()
            || pathBefore.size > BigInt(maxBytes)
            || pathBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(reason);
        }
        let fd;
        try {
            fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        }
        catch {
            throw new Error(reason);
        }
        try {
            const openedBefore = fstatSync(fd, { bigint: true });
            if (!openedBefore.isFile() || openedBefore.isSymbolicLink()
                || !sameGraphFileSnapshot(pathBefore, openedBefore)) {
                throw new Error(reason);
            }
            const readOffset = range?.offset ?? 0;
            const readSize = range?.size ?? Number(openedBefore.size);
            if (!Number.isSafeInteger(readOffset) || readOffset < 0
                || !Number.isSafeInteger(readSize) || readSize < 0
                || BigInt(readOffset) + BigInt(readSize) > openedBefore.size) {
                throw new Error(reason);
            }
            const payload = readFdBytes(fd, readSize, readOffset);
            const openedAfter = fstatSync(fd, { bigint: true });
            let pathAfter;
            try {
                pathAfter = lstatSync(path, { bigint: true });
            }
            catch {
                throw new Error(reason);
            }
            if (payload.length !== readSize
                || !sameGraphFileSnapshot(openedBefore, openedAfter)
                || !sameGraphFileSnapshot(openedAfter, pathAfter)) {
                throw new Error(reason);
            }
            return { identity: openedAfter, payload };
        }
        finally {
            closeSync(fd);
        }
    }
    rotationStageFiles() {
        try {
            return readdirSync(this.dir).filter((name) => ROTATION_STAGE_PATTERN.test(name));
        }
        catch {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
    }
    rotationTempFiles() {
        try {
            return readdirSync(this.dir).filter((name) => ROTATION_TEMP_PATTERN.test(name));
        }
        catch {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
    }
    removeRotationTemp(name) {
        if (!ROTATION_TEMP_PATTERN.test(name)) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        const path = join(this.dir, name);
        let identity;
        try {
            identity = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isObject(error) && error['code'] === 'ENOENT')
                return;
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        if (!identity.isFile() || identity.isSymbolicLink()) {
            throw new Error('memory_graph_rotation_recovery_failed');
        }
        this.removeVerifiedRotationFile(path, identity, 'memory_graph_rotation_recovery_failed');
    }
    notifyRotationPhase(journal, mode, phase) {
        this.onRotationPhase?.({
            mode,
            phase,
            transactionId: journal.transactionId,
            generation: journal.targetGeneration,
        });
    }
    syncGraphDirectory() {
        if (process.platform === 'win32')
            return;
        const fd = openSync(this.dir, constants.O_RDONLY);
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    compactRequiresRecovery(epoch) {
        if (this.recoveryMarkerState(epoch) === 'degraded')
            return true;
        const path = join(this.dir, COMPACT_FILE);
        const diagnostics = emptyDiagnostics();
        const currentRecords = this.readCompactForEpoch(epoch, diagnostics)
            .filter((record) => recordEpochId(record) === epoch.epochId);
        const compactBaseline = this.compactMatchesEpochBaseline(epoch);
        const compactUnusable = compactBaseline || !existsSync(path)
            || !this.secureRegularFile(path)
            || statSync(path).size === 0
            || currentRecords.length === 0
            || diagnostics.corruptLines > 0
            || diagnostics.oversizedLines > 0
            || diagnostics.truncated;
        if (!compactUnusable)
            return false;
        const archives = this.inspectArchivesForEpoch(epoch);
        return archives.containsCurrent || archives.unreadable;
    }
    readQueryableRecords(diagnostics) {
        this.ensureSecureDir();
        this.managedGraphStateFiles();
        const epoch = this.readEpochState();
        const epochId = epoch.epochId;
        const compactPath = join(this.dir, COMPACT_FILE);
        const compactDiagnostics = emptyDiagnostics();
        let records = this.readCompactForEpoch(epoch, compactDiagnostics)
            .filter((record) => recordEpochId(record) === epochId);
        const archives = this.archiveFiles().length;
        const compactExists = existsSync(compactPath);
        const compactSecure = compactExists && this.secureRegularFile(compactPath);
        const compactUnusable = (this.compactMatchesEpochBaseline(epoch)
            || !compactExists
            || !compactSecure
            || (compactSecure && statSync(compactPath).size === 0)
            || records.length === 0
            || compactDiagnostics.corruptLines > 0
            || compactDiagnostics.oversizedLines > 0
            || compactDiagnostics.truncated);
        const archiveProbe = archives > 0 && compactUnusable
            ? this.inspectArchivesForEpoch(epoch)
            : { containsCurrent: false, unreadable: false };
        const compactNeedsRecovery = compactUnusable
            && (archiveProbe.containsCurrent || archiveProbe.unreadable);
        mergeDiagnostics(diagnostics, compactDiagnostics);
        if (compactNeedsRecovery) {
            try {
                const recovery = this.recoverFromArchivesUnlocked(epoch);
                diagnostics.corruptLines += recovery.corruptLines;
                diagnostics.oversizedLines += recovery.oversizedLines;
                if (recovery.recovery === 'recovered'
                    || (recovery.recovery === 'degraded' && recovery.compactedRecords > 0)) {
                    const recoveredDiagnostics = emptyDiagnostics();
                    records = this.readCompactForEpoch(epoch, recoveredDiagnostics)
                        .filter((record) => recordEpochId(record) === epochId);
                    mergeDiagnostics(diagnostics, recoveredDiagnostics);
                    diagnostics.recovery = recovery.recovery;
                }
                else if (recovery.recovery === 'empty') {
                    records = [];
                    diagnostics.recovery = 'empty';
                }
                else {
                    diagnostics.recovery = 'degraded';
                }
            }
            catch {
                diagnostics.recovery = 'degraded';
            }
        }
        records.push(...this.readActiveForEpoch(epoch, diagnostics, this.maxActiveBytes)
            .filter((record) => recordEpochId(record) === epochId));
        if (this.recoveryMarkerState(epoch) === 'degraded')
            diagnostics.recovery = 'degraded';
        if (diagnostics.recovery !== 'recovered' && (diagnostics.corruptLines > 0 || diagnostics.oversizedLines > 0 || diagnostics.truncated))
            diagnostics.recovery = 'degraded';
        return records;
    }
    readImportRecords() {
        this.ensureSecureDir();
        return this.readImportRecordsFromExistingDir();
    }
    readImportRecordsFromExistingDir() {
        this.managedGraphStateFiles();
        const epoch = this.readEpochState();
        const epochId = epoch.epochId;
        const diagnostics = emptyDiagnostics();
        const activePath = join(this.dir, ACTIVE_FILE);
        if (existsSync(activePath)) {
            if (!this.secureRegularFile(activePath)) {
                throw new MemoryGraphImportStateRejectedError();
            }
            const activeWindow = this.activeLogicalWindow(epoch, lstatSync(activePath, { bigint: true }));
            if (activeWindow.invalid || activeWindow.size > this.maxActiveBytes) {
                throw new MemoryGraphImportStateRejectedError();
            }
        }
        return [...this.readCompactForEpoch(epoch, diagnostics), ...this.readActiveForEpoch(epoch, diagnostics, this.maxActiveBytes)]
            .filter((record) => recordEpochId(record) === epochId);
    }
    readCompact(diagnostics) {
        const path = join(this.dir, COMPACT_FILE);
        if (!existsSync(path) || !this.secureRegularFile(path))
            return [];
        if (statSync(path).size > this.maxCompactBytes) {
            diagnostics.truncated = true;
            diagnostics.oversizedLines += 1;
            return [];
        }
        return this.readWholeBounded(path, diagnostics, this.maxCompactBytes);
    }
    readWholeBounded(path, diagnostics, maxBytes) {
        if (!existsSync(path) || !this.secureRegularFile(path))
            return [];
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile())
                return [];
            if (stat.size > maxBytes) {
                diagnostics.truncated = true;
                return this.readTailFromFd(fd, stat.size, diagnostics, maxBytes);
            }
            const raw = readFdBytes(fd, stat.size, 0);
            diagnostics.bytesRead += raw.length;
            return this.parseBuffer(raw, diagnostics);
        }
        finally {
            closeSync(fd);
        }
    }
    readTail(path, diagnostics, maxBytes = this.maxTailBytes) {
        if (!existsSync(path) || !this.secureRegularFile(path))
            return [];
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const size = fstatSync(fd).size;
            return this.readTailFromFd(fd, size, diagnostics, maxBytes);
        }
        finally {
            closeSync(fd);
        }
    }
    readTailFromFd(fd, size, diagnostics, maxBytes) {
        const bytes = Math.min(size, maxBytes);
        const buffer = readFdBytes(fd, bytes, size - bytes);
        diagnostics.bytesRead += buffer.length;
        diagnostics.truncated ||= size > buffer.length;
        if (size <= buffer.length)
            return this.parseBuffer(buffer, diagnostics);
        const newline = buffer.indexOf(0x0a);
        return this.parseBuffer(newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0), diagnostics);
    }
    parseBuffer(buffer, diagnostics) {
        const out = [];
        for (const line of buffer.toString('utf8').split('\n')) {
            if (!line.trim())
                continue;
            if (Buffer.byteLength(line) > this.maxLineBytes) {
                diagnostics.oversizedLines += 1;
                continue;
            }
            try {
                const raw = JSON.parse(line);
                if (isObject(raw) && raw['version'] === 2 && raw['kind'] === 'outcome' && raw['provenance'] !== 'v2_local' && raw['provenance'] !== 'v1_import') {
                    diagnostics.provenanceRejected += 1;
                    continue;
                }
                const parsed = parseV2Record(raw);
                if (parsed) {
                    out.push(parsed);
                    diagnostics.recordsRead += 1;
                }
                else {
                    diagnostics.corruptLines += 1;
                }
            }
            catch {
                diagnostics.corruptLines += 1;
            }
        }
        return out;
    }
    writeCompact(records) {
        const fitted = fitCompactRecords(records, this.maxCompactBytes);
        if (records.length > 0 && fitted.records.length === 0) {
            return { records: 0, committedIdentity: null };
        }
        const committedIdentity = this.writeAtomic(join(this.dir, COMPACT_FILE), fitted.payload);
        return { records: fitted.records.length, committedIdentity };
    }
    writeAtomic(path, payload, syncDirectory = false, tempTag = String(this.now())) {
        this.ensureSecureDir();
        if (existsSync(path) && !this.secureRegularFile(path))
            throw new Error('memory_graph_path_rejected');
        const temp = join(dirname(path), `.${basename(path)}.${tempTag}.tmp`);
        const fd = openNoFollow(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        let tempIdentity = null;
        let closed = false;
        let published = false;
        try {
            tempIdentity = lstatSync(temp, { bigint: true });
            const descriptorIdentity = fstatSync(fd, { bigint: true });
            if (!tempIdentity.isFile() || tempIdentity.isSymbolicLink()
                || !descriptorIdentity.isFile() || descriptorIdentity.isSymbolicLink()
                || !sameGraphFileIdentity(tempIdentity, descriptorIdentity)) {
                throw new Error('memory_graph_write_failed');
            }
            writeAll(fd, payload);
            fsyncSync(fd);
            closeSync(fd);
            closed = true;
            renameSync(temp, path);
            published = true;
            if (syncDirectory)
                this.syncGraphDirectory();
        }
        finally {
            if (!closed) {
                try {
                    closeSync(fd);
                }
                catch {
                    // Preserve the original write/fsync failure.
                }
            }
            if (!published && tempIdentity !== null) {
                try {
                    const currentIdentity = lstatSync(temp, { bigint: true });
                    if (currentIdentity.isFile() && !currentIdentity.isSymbolicLink()
                        && sameGraphFileIdentity(tempIdentity, currentIdentity))
                        unlinkSync(temp);
                }
                catch {
                    // Never remove an unknown replacement; a same-name leftover is safer than clobbering it.
                }
            }
        }
        if (tempIdentity === null || !published)
            throw new Error('memory_graph_write_failed');
        return tempIdentity;
    }
    ensureSecureDir() {
        let stat;
        try {
            stat = lstatSync(this.dir);
        }
        catch (error) {
            if (!isObject(error) || error['code'] !== 'ENOENT')
                throw new Error('memory_graph_dir_rejected');
            try {
                mkdirSync(this.dir, { recursive: true, mode: 0o700 });
                stat = lstatSync(this.dir);
            }
            catch {
                throw new Error('memory_graph_dir_rejected');
            }
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('memory_graph_dir_rejected');
    }
    secureRegularFile(path) {
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink();
    }
    workspaceScope(workspace) {
        try {
            const absolute = resolve(workspace);
            const linkStat = lstatSync(absolute);
            if (!linkStat.isDirectory() || linkStat.isSymbolicLink())
                return null;
            const canonical = realpathSync(absolute);
            return scopeHash(`workspace:${canonical}`);
        }
        catch {
            return null;
        }
    }
    archiveFiles() {
        if (!existsSync(this.dir))
            return [];
        return readdirSync(this.dir).filter((file) => ARCHIVE_PATTERN.test(file)).sort();
    }
    nextArchivePath() {
        const latest = this.archiveFiles().at(-1);
        const latestTimestamp = latest ? Number(ARCHIVE_PATTERN.exec(latest)?.[1] ?? 0) : 0;
        const timestamp = Math.max(Math.floor(this.now()), latestTimestamp + 1);
        return join(this.dir, `memory_graph.v2.${timestamp}.jsonl.gz`);
    }
    pruneArchives(retention = this.archiveRetention) {
        const files = this.archiveFiles();
        for (const file of files.slice(0, Math.max(0, files.length - retention))) {
            unlinkSync(join(this.dir, file));
        }
    }
    writeRecoveryMarker(epochId, state) {
        this.writeAtomic(join(this.dir, RECOVERY_FILE), Buffer.from(JSON.stringify({
            version: 1,
            recoveredAt: new Date(this.now()).toISOString(),
            epochId,
            state,
        }) + '\n', 'utf8'));
    }
    inspectArchivesForEpoch(epoch) {
        let unreadable = false;
        const maxArchiveBytes = gzipRotationByteBound(this.maxActiveBytes);
        const maxArchiveOutputBytes = safeRotationByteSum(this.maxActiveBytes, this.maxLineBytes);
        for (const file of this.currentArchiveFiles(epoch)) {
            const path = join(this.dir, file);
            try {
                if (maxArchiveBytes === null || maxArchiveOutputBytes === null) {
                    unreadable = true;
                    continue;
                }
                if (!this.secureRegularFile(path)) {
                    unreadable = true;
                    continue;
                }
                const compressed = this.readRawBounded(path, maxArchiveBytes);
                if (compressed === null) {
                    unreadable = true;
                    continue;
                }
                const raw = gunzipSync(compressed, { maxOutputLength: maxArchiveOutputBytes });
                const diagnostics = emptyDiagnostics();
                const records = this.parseBuffer(raw, diagnostics);
                unreadable ||= diagnostics.corruptLines > 0
                    || diagnostics.oversizedLines > 0
                    || diagnostics.truncated;
                if (records.some((record) => recordEpochId(record) === epoch.epochId)) {
                    return { containsCurrent: true, unreadable };
                }
            }
            catch {
                unreadable = true;
            }
        }
        return { containsCurrent: false, unreadable };
    }
    recoveryMarkerState(epoch, maxBytes = this.maxLineBytes) {
        const path = join(this.dir, RECOVERY_FILE);
        if (!existsSync(path))
            return null;
        try {
            const identity = lstatSync(path, { bigint: true });
            if (epoch.baseline?.recovery
                && serializedSnapshotMatches(epoch.baseline.recovery, identity))
                return null;
            if (!identity.isFile() || identity.isSymbolicLink())
                return 'degraded';
            const bytes = this.readRawBounded(path, maxBytes);
            if (bytes === null)
                return 'degraded';
            const raw = JSON.parse(bytes.toString('utf8'));
            if (!isObject(raw) || raw['version'] !== 1
                || typeof raw['recoveredAt'] !== 'string' || validIso(raw['recoveredAt']) === null)
                return 'degraded';
            const markerEpoch = Object.prototype.hasOwnProperty.call(raw, 'epochId')
                ? safeEpochId(raw['epochId'])
                : LEGACY_EPOCH_ID;
            if (markerEpoch !== epoch.epochId)
                return 'degraded';
            const state = raw['state'];
            if (state === undefined)
                return 'recovered';
            return state === 'empty' || state === 'recovered' || state === 'degraded' ? state : 'degraded';
        }
        catch {
            return 'degraded';
        }
    }
    clearRecoveryMarker(epoch, maxBytes = this.maxLineBytes) {
        if (this.recoveryMarkerState(epoch, maxBytes) === 'degraded')
            return;
        const path = join(this.dir, RECOVERY_FILE);
        if (existsSync(path) && this.secureRegularFile(path))
            unlinkSync(path);
    }
    readRawBounded(path, maxBytes) {
        if (!existsSync(path) || !this.secureRegularFile(path))
            return null;
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > maxBytes)
                return null;
            return readFdBytes(fd, stat.size, 0);
        }
        finally {
            closeSync(fd);
        }
    }
}
function rotationStageNames(generation) {
    return {
        compact: 'memory_graph.rotation.' + generation + '.compact.stage',
        archive: 'memory_graph.rotation.' + generation + '.archive.stage',
        active: 'memory_graph.rotation.' + generation + '.active.stage',
    };
}
function rotationTempNames(generation) {
    const stages = rotationStageNames(generation);
    return {
        journal: '.' + ROTATION_JOURNAL_FILE + '.' + generation + '.tmp',
        compact: '.' + stages.compact + '.' + generation + '.tmp',
        archive: '.' + stages.archive + '.' + generation + '.tmp',
        active: '.' + stages.active + '.' + generation + '.tmp',
    };
}
function rotationFileDigest(payload) {
    return {
        size: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
    };
}
function rotationDigestMatches(payload, expected) {
    const actual = rotationFileDigest(payload);
    return actual.size === expected.size && actual.sha256 === expected.sha256;
}
function rotationJournalImmutable(journal) {
    return {
        version: journal.version,
        targetGeneration: journal.targetGeneration,
        epochId: journal.epochId,
        createdAt: journal.createdAt,
        limits: {
            maxActiveBytes: journal.limits.maxActiveBytes,
            maxCompactBytes: journal.limits.maxCompactBytes,
            maxLineBytes: journal.limits.maxLineBytes,
            archiveRetention: journal.limits.archiveRetention,
        },
        source: {
            active: {
                snapshot: journal.source.active.snapshot,
                offset: journal.source.active.offset,
                size: journal.source.active.size,
                sha256: journal.source.active.sha256,
            },
            compact: journal.source.compact === null ? null : {
                snapshot: journal.source.compact.snapshot,
                size: journal.source.compact.size,
                sha256: journal.source.compact.sha256,
            },
        },
        target: {
            compact: {
                stageName: journal.target.compact.stageName,
                finalName: journal.target.compact.finalName,
                size: journal.target.compact.size,
                sha256: journal.target.compact.sha256,
                records: journal.target.compact.records,
            },
            archive: {
                stageName: journal.target.archive.stageName,
                finalName: journal.target.archive.finalName,
                size: journal.target.archive.size,
                sha256: journal.target.archive.sha256,
            },
            active: {
                stageName: journal.target.active.stageName,
                finalName: journal.target.active.finalName,
                size: journal.target.active.size,
                sha256: journal.target.active.sha256,
            },
        },
    };
}
function rotationTransactionId(journal) {
    return 'txn_' + createHash('sha256')
        .update(JSON.stringify(rotationJournalImmutable(journal)))
        .digest('hex');
}
function rotationJournalDigest(journal) {
    return createHash('sha256').update(JSON.stringify({
        ...rotationJournalImmutable(journal),
        transactionId: journal.transactionId,
        phase: journal.phase,
    })).digest('hex');
}
function parseRotationJournal(value) {
    if (!isObject(value) || value['version'] !== 1)
        return null;
    const targetGeneration = typeof value['targetGeneration'] === 'string'
        && ROTATION_GENERATION_PATTERN.test(value['targetGeneration'])
        ? value['targetGeneration']
        : null;
    const transactionId = typeof value['transactionId'] === 'string'
        && ROTATION_TRANSACTION_PATTERN.test(value['transactionId'])
        ? value['transactionId']
        : null;
    const journalDigest = typeof value['journalDigest'] === 'string'
        && /^[a-f0-9]{64}$/.test(value['journalDigest'])
        ? value['journalDigest']
        : null;
    const phase = value['phase'] === 'prepared' || value['phase'] === 'committed'
        ? value['phase']
        : null;
    const epochId = safeEpochId(value['epochId']);
    const createdAt = typeof value['createdAt'] === 'string' ? validIso(value['createdAt']) : null;
    if (!targetGeneration || !transactionId || !journalDigest
        || !phase || !epochId || !createdAt)
        return null;
    const limitsValue = value['limits'];
    if (!isObject(limitsValue))
        return null;
    const maxActiveBytes = parseRotationLimit(limitsValue['maxActiveBytes']);
    const maxCompactBytes = parseRotationLimit(limitsValue['maxCompactBytes']);
    const maxLineBytes = parseRotationLimit(limitsValue['maxLineBytes']);
    const archiveRetention = parseRotationLimit(limitsValue['archiveRetention']);
    if (maxActiveBytes === null || maxCompactBytes === null || maxLineBytes === null
        || archiveRetention === null)
        return null;
    const maxArchiveBytes = gzipRotationByteBound(maxActiveBytes);
    const maxCompactWithLineBytes = safeRotationByteSum(maxCompactBytes, maxLineBytes);
    if (maxArchiveBytes === null || maxCompactWithLineBytes === null)
        return null;
    const limits = {
        maxActiveBytes,
        maxCompactBytes,
        maxLineBytes,
        archiveRetention,
    };
    const sourceValue = value['source'];
    const targetValue = value['target'];
    if (!isObject(sourceValue) || !isObject(targetValue))
        return null;
    const activeSourceValue = sourceValue['active'];
    if (!isObject(activeSourceValue))
        return null;
    const activeSnapshot = parseGraphFileSnapshot(activeSourceValue['snapshot']);
    const activeDigest = parseRotationFileDigest(activeSourceValue, maxActiveBytes);
    const activeOffset = activeSourceValue['offset'];
    const activeSnapshotSize = activeSnapshot ? BigInt(activeSnapshot.size) : null;
    if (!activeSnapshot || !activeDigest || !Number.isSafeInteger(activeOffset)
        || Number(activeOffset) < 0
        || activeSnapshotSize === null
        || activeSnapshotSize > BigInt(Number.MAX_SAFE_INTEGER)
        || BigInt(Number(activeOffset)) + BigInt(activeDigest.size) !== activeSnapshotSize)
        return null;
    const activeSource = {
        snapshot: activeSnapshot,
        offset: Number(activeOffset),
        ...activeDigest,
    };
    let compactSource = null;
    if (sourceValue['compact'] !== null) {
        if (!isObject(sourceValue['compact']))
            return null;
        const compactSnapshot = parseGraphFileSnapshot(sourceValue['compact']['snapshot']);
        const compactDigest = parseRotationFileDigest(sourceValue['compact'], maxCompactWithLineBytes);
        if (!compactSnapshot || !compactDigest
            || compactSnapshot.size !== String(compactDigest.size))
            return null;
        compactSource = { snapshot: compactSnapshot, ...compactDigest };
    }
    const stages = rotationStageNames(targetGeneration);
    const compactTarget = parseRotationTarget(targetValue['compact'], maxCompactBytes, stages.compact, COMPACT_FILE);
    const archiveTarget = parseRotationTarget(targetValue['archive'], maxArchiveBytes, stages.archive, 'memory_graph.v2.' + targetGeneration + '.jsonl.gz');
    const activeTarget = parseRotationTarget(targetValue['active'], 0, stages.active, ACTIVE_FILE);
    const records = isObject(targetValue['compact']) ? targetValue['compact']['records'] : null;
    if (!compactTarget || !archiveTarget || !activeTarget
        || !Number.isSafeInteger(records) || Number(records) < 0
        || activeTarget.sha256 !== rotationFileDigest(Buffer.alloc(0)).sha256)
        return null;
    const journal = {
        version: 1,
        transactionId,
        journalDigest,
        targetGeneration,
        phase,
        epochId,
        createdAt,
        limits,
        source: { active: activeSource, compact: compactSource },
        target: {
            compact: { ...compactTarget, records: Number(records) },
            archive: archiveTarget,
            active: activeTarget,
        },
    };
    return rotationTransactionId(journal) === journal.transactionId
        && rotationJournalDigest(journal) === journal.journalDigest
        ? journal
        : null;
}
function parseRotationLimit(value) {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
function safeRotationByteSum(left, right) {
    const sum = left + right;
    return Number.isSafeInteger(sum) ? sum : null;
}
function gzipRotationByteBound(sourceBytes) {
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0)
        return null;
    const source = BigInt(sourceBytes);
    // Mirrors zlib deflateBound's conservative stream bounds plus the gzip wrapper.
    const fixed = source + (source >> 3n) + (source >> 8n) + (source >> 9n) + 4n;
    const stored = source + (source >> 5n) + (source >> 7n) + (source >> 11n) + 7n;
    const bound = (fixed > stored ? fixed : stored) + 18n;
    return bound <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bound) : null;
}
function parseRotationTarget(value, maxBytes, stageName, finalName) {
    if (!isObject(value) || value['stageName'] !== stageName || value['finalName'] !== finalName) {
        return null;
    }
    const digest = parseRotationFileDigest(value, maxBytes);
    return digest ? { stageName, finalName, ...digest } : null;
}
function parseRotationFileDigest(value, maxBytes) {
    if (!isObject(value))
        return null;
    const size = value['size'];
    const sha256 = value['sha256'];
    if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > maxBytes
        || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
        return null;
    return { size: Number(size), sha256 };
}
const MEMORY_GRAPH_REASON_PATTERN = /scoped memory-graph outcome ([+-]\d+\.\d{3}) \(boost=([+-]?\d+\.\d{2})\)/;
export function sanitizeMemoryGraphSelectionReason(value) {
    if (typeof value !== 'string')
        return undefined;
    const match = MEMORY_GRAPH_REASON_PATTERN.exec(value);
    if (!match?.[1] || !match[2])
        return undefined;
    const outcome = Number(match[1]);
    const boost = Number(match[2]);
    if (!Number.isFinite(outcome) || !Number.isFinite(boost) || Math.abs(outcome) > 1 || Math.abs(boost) > 1)
        return undefined;
    return `scoped memory-graph outcome ${match[1]} (boost=${match[2]})`;
}
export function formatMemoryGraphOperatorStatus(status) {
    const state = status.recovery === 'healthy' || status.recovery === 'degraded'
        || status.recovery === 'recovered' || status.recovery === 'empty'
        ? status.recovery
        : 'degraded';
    const reason = sanitizeMemoryGraphSelectionReason(status.selectionReason);
    return [
        `state=${state}`,
        ...(status.busy === true ? ['busy=1'] : []),
        `corrupt=${boundedOperatorCount(status.corruptLines)}`,
        `oversized_lines=${boundedOperatorCount(status.oversizedLines)}`,
        `oversized_files=${boundedOperatorCount(status.oversizedFiles)}`,
        `archives=${boundedOperatorCount(status.archives)}`,
        ...(reason ? [`selection=${reason}`] : []),
    ].join(' ');
}
export function loadMemoryGraphOperatorStatus(env = process.env) {
    const home = events.evomapHome(env);
    const graphDir = join(home, 'evolution');
    let health;
    try {
        health = new LocalMemoryGraph({
            dir: graphDir,
            ...resolveLocalMemoryUserIdentity(graphDir),
        }).inspectHealth();
    }
    catch {
        health = { ...emptyHealth(), recovery: 'degraded', corruptLines: 1 };
    }
    let selectionReason;
    try {
        const rootEvents = events.readEvents(join(home, 'evolution', 'root_events.jsonl'));
        for (let index = rootEvents.length - 1; index >= 0; index -= 1) {
            const event = rootEvents[index];
            if (event?.type !== 'decision.gene_selected')
                continue;
            selectionReason = sanitizeMemoryGraphSelectionReason(event.payload?.['selectedReason']);
            if (selectionReason)
                break;
        }
    }
    catch {
        // Health remains available even when the optional event rationale cannot be read.
    }
    return { ...health, ...(selectionReason ? { selectionReason } : {}) };
}
function parseV2Record(value) {
    if (!isObject(value) || value['version'] !== 2 || value['kind'] !== 'outcome')
        return null;
    const provenance = value['provenance'];
    if (provenance !== 'v2_local' && provenance !== 'v1_import')
        return null;
    const workspaceScope = safeToken(value['workspaceScope'], 128);
    const userScope = safeToken(value['userScope'], 128);
    const signalFingerprint = safeToken(value['signalFingerprint'], 4096);
    const geneId = typeof value['geneId'] === 'string' ? algo.safeMemoryGeneId(value['geneId']) : '';
    const status = value['status'];
    const at = typeof value['at'] === 'string' ? validIso(value['at']) : null;
    const hasEpoch = Object.prototype.hasOwnProperty.call(value, 'epochId');
    const epochId = hasEpoch ? safeEpochId(value['epochId']) : null;
    if (!workspaceScope || !userScope || !signalFingerprint || !geneId
        || (status !== 'success' && status !== 'failed') || !at || (hasEpoch && !epochId))
        return null;
    return {
        version: 2,
        kind: 'outcome',
        provenance,
        workspaceScope,
        userScope,
        signalFingerprint,
        signals: algo.normalizeMemorySignals(Array.isArray(value['signals']) ? value['signals'].filter((item) => typeof item === 'string') : []),
        geneId,
        status,
        score: clampScore(Number(value['score'])),
        at,
        ...(epochId ? { epochId } : {}),
        ...(safeToken(value['sourceFingerprint'], 128) ? { sourceFingerprint: safeToken(value['sourceFingerprint'], 128) } : {}),
        ...(safeToken(value['sourceScope'], 128) ? { sourceScope: safeToken(value['sourceScope'], 128) } : {}),
        ...(safeToken(value['legacySourceFingerprint'], 128) ? { legacySourceFingerprint: safeToken(value['legacySourceFingerprint'], 128) } : {}),
        ...(positiveCount(value['successCount']) !== undefined ? { successCount: positiveCount(value['successCount']) } : {}),
        ...(positiveCount(value['failCount']) !== undefined ? { failCount: positiveCount(value['failCount']) } : {}),
    };
}
function sealV1OutcomePlan(summary, data) {
    const plan = Object.freeze({ ...summary });
    if (data)
        memoryGraphV1OutcomePlans.set(plan, data);
    return plan;
}
function collectImportFingerprints(records, workspaceScope, userScope, sourceScope) {
    const values = new Set();
    for (const record of records) {
        if (record.workspaceScope !== workspaceScope || record.userScope !== userScope)
            continue;
        if (record.sourceScope && record.sourceScope !== sourceScope)
            continue;
        addImportFingerprints(values, record);
    }
    return values;
}
function hasImportFingerprint(values, record) {
    return Boolean((record.sourceFingerprint && values.has(record.sourceFingerprint))
        || (record.legacySourceFingerprint && values.has(record.legacySourceFingerprint)));
}
function addImportFingerprints(values, record) {
    if (record.sourceFingerprint)
        values.add(record.sourceFingerprint);
    if (record.legacySourceFingerprint)
        values.add(record.legacySourceFingerprint);
}
function parseV1Outcome(value, workspaceScope, userScope, sourceScope) {
    if (!workspaceScope || !isObject(value) || value['type'] !== 'MemoryGraphEvent' || value['kind'] !== 'outcome')
        return null;
    const gene = isObject(value['gene']) ? value['gene'] : null;
    const signal = isObject(value['signal']) ? value['signal'] : null;
    const outcome = isObject(value['outcome']) ? value['outcome'] : null;
    const geneId = typeof gene?.['id'] === 'string' ? algo.safeMemoryGeneId(gene['id']) : '';
    const status = outcome?.['status'];
    const at = typeof value['ts'] === 'string' ? validIso(value['ts']) : null;
    if (!geneId || (status !== 'success' && status !== 'failed') || !at)
        return null;
    const signals = algo.normalizeMemorySignals(Array.isArray(signal?.['signals']) ? signal['signals'].filter((item) => typeof item === 'string') : []);
    const score = clampScore(Number(outcome?.['score']));
    const legacySourceFingerprint = scopeHash(JSON.stringify({
        id: safeToken(value['id'], 240) ?? '',
        at,
        geneId,
        status,
        score,
        signals,
    }));
    const sourceFingerprint = scopeHash(JSON.stringify({
        workspaceScope,
        userScope,
        sourceScope,
        legacySourceFingerprint,
    }));
    return {
        version: 2,
        kind: 'outcome',
        provenance: 'v1_import',
        workspaceScope,
        userScope,
        sourceScope,
        signalFingerprint: algo.memorySignalFingerprint(signals),
        signals,
        geneId,
        status,
        score,
        at,
        sourceFingerprint,
        legacySourceFingerprint,
    };
}
function compactRecords(records, maxEdges) {
    const byEdge = new Map();
    for (const record of records) {
        const key = compactRecordKey(record);
        const current = byEdge.get(key);
        const successCount = (record.successCount ?? (record.status === 'success' ? 1 : 0)) + (current?.successCount ?? (current?.status === 'success' ? 1 : 0));
        const failCount = (record.failCount ?? (record.status === 'failed' ? 1 : 0)) + (current?.failCount ?? (current?.status === 'failed' ? 1 : 0));
        const newest = !current || Date.parse(record.at) >= Date.parse(current.at) ? record : current;
        byEdge.set(key, { ...newest, successCount, failCount });
    }
    return [...byEdge.values()]
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.geneId.localeCompare(right.geneId))
        .slice(0, maxEdges);
}
function compactRecordKey(record) {
    const epoch = recordEpochId(record);
    return record.provenance === 'v1_import' && record.sourceFingerprint
        ? `${epoch}\u0000import\u0000${record.workspaceScope}\u0000${record.userScope}\u0000${record.sourceScope ?? 'legacy-unscoped'}\u0000${record.sourceFingerprint}`
        : `${epoch}\u0000${record.workspaceScope}\u0000${record.userScope}\u0000${record.signalFingerprint}\u0000${record.geneId}`;
}
function mergeRecoveryRecords(compact, archives, maxEdges) {
    const preserved = compactRecords(compact, compact.length);
    const preservedKeys = new Set(preserved.map(compactRecordKey));
    const recovered = compactRecords(archives, archives.length)
        .filter((record) => !preservedKeys.has(compactRecordKey(record)));
    return compactRecords([...preserved, ...recovered], maxEdges);
}
function fitCompactRecords(records, maxBytes) {
    const kept = [];
    const lines = [];
    let bytes = 0;
    for (const record of records) {
        const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        if (bytes + line.length > maxBytes)
            break;
        kept.push(record);
        lines.push(line);
        bytes += line.length;
    }
    return { records: kept, payload: Buffer.concat(lines, bytes) };
}
function emptyDiagnostics() {
    return { bytesRead: 0, recordsRead: 0, corruptLines: 0, oversizedLines: 0, scopeRejected: 0, provenanceRejected: 0, truncated: false, recovery: 'healthy' };
}
function mergeDiagnostics(target, source) {
    target.bytesRead += source.bytesRead;
    target.recordsRead += source.recordsRead;
    target.corruptLines += source.corruptLines;
    target.oversizedLines += source.oversizedLines;
    target.scopeRejected += source.scopeRejected;
    target.provenanceRejected += source.provenanceRejected;
    target.truncated ||= source.truncated;
    if (source.busy === true)
        target.busy = true;
    if (target.recovery !== 'recovered' && source.recovery !== 'healthy')
        target.recovery = source.recovery;
}
function emptyHealth() {
    return {
        recovery: 'empty',
        compactedRecords: 0,
        activeRecords: 0,
        corruptLines: 0,
        oversizedLines: 0,
        oversizedFiles: 0,
        archives: 0,
    };
}
function fileExceeds(path, maxBytes) {
    try {
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size > maxBytes;
    }
    catch {
        return false;
    }
}
function openNoFollow(path, flags, mode) {
    return openSync(path, flags | constants.O_NOFOLLOW, mode);
}
function writeAll(fd, payload, position = null) {
    let offset = 0;
    while (offset < payload.length) {
        const written = writeSync(fd, payload, offset, payload.length - offset, position === null ? null : position + offset);
        if (written <= 0)
            throw new Error('memory_graph_write_failed');
        offset += written;
    }
}
function sameGraphFileIdentity(left, right) {
    const hasStableFileId = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
    if (hasStableFileId)
        return left.dev === right.dev && left.ino === right.ino;
    return left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}
function sameGraphFileSnapshot(left, right) {
    return sameGraphFileIdentity(left, right)
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function serializeGraphFileSnapshot(stat) {
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
        mode: String(stat.mode),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
    };
}
function serializedIdentityMatches(snapshot, stat) {
    const hasStableFileId = snapshot.dev !== '0' || snapshot.ino !== '0'
        || stat.dev !== 0n || stat.ino !== 0n;
    if (hasStableFileId)
        return snapshot.dev === String(stat.dev) && snapshot.ino === String(stat.ino);
    return snapshot.birthtimeNs === String(stat.birthtimeNs) && snapshot.mode === String(stat.mode);
}
function serializedSnapshotMatches(snapshot, stat) {
    return serializedIdentityMatches(snapshot, stat)
        && snapshot.mode === String(stat.mode)
        && snapshot.size === String(stat.size)
        && snapshot.mtimeNs === String(stat.mtimeNs)
        && snapshot.ctimeNs === String(stat.ctimeNs);
}
function parseGraphFileSnapshot(value) {
    if (!isObject(value))
        return null;
    const fields = ['dev', 'ino', 'birthtimeNs', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
    for (const field of fields) {
        const candidate = value[field];
        if (typeof candidate !== 'string' || !/^\d{1,40}$/.test(candidate))
            return null;
    }
    return {
        dev: value['dev'],
        ino: value['ino'],
        birthtimeNs: value['birthtimeNs'],
        mode: value['mode'],
        size: value['size'],
        mtimeNs: value['mtimeNs'],
        ctimeNs: value['ctimeNs'],
    };
}
function parseEpochBaseline(value) {
    if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, 'active')
        || !Object.prototype.hasOwnProperty.call(value, 'compact')
        || !Array.isArray(value['archives']))
        return null;
    let active = null;
    if (value['active'] !== null) {
        if (!isObject(value['active']))
            return null;
        const snapshot = parseGraphFileSnapshot(value['active']['snapshot']);
        const offset = value['active']['offset'];
        if (!snapshot || !Number.isSafeInteger(offset) || Number(offset) < 0
            || snapshot.size !== String(offset))
            return null;
        active = { snapshot, offset: Number(offset) };
    }
    const compact = value['compact'] === null
        ? null
        : parseGraphFileSnapshot(value['compact']);
    if (value['compact'] !== null && !compact)
        return null;
    const hasRecovery = Object.prototype.hasOwnProperty.call(value, 'recovery');
    const recovery = !hasRecovery || value['recovery'] === null
        ? null
        : parseGraphFileSnapshot(value['recovery']);
    if (hasRecovery && value['recovery'] !== null && !recovery)
        return null;
    const archives = [];
    const names = new Set();
    for (const entry of value['archives']) {
        if (!isObject(entry) || typeof entry['name'] !== 'string'
            || !ARCHIVE_PATTERN.test(entry['name']) || names.has(entry['name']))
            return null;
        const snapshot = parseGraphFileSnapshot(entry['snapshot']);
        if (!snapshot)
            return null;
        names.add(entry['name']);
        archives.push({ name: entry['name'], snapshot });
    }
    return { active, compact, ...(hasRecovery ? { recovery } : {}), archives };
}
function assertPathMissing(path, reason) {
    try {
        lstatSync(path);
    }
    catch (error) {
        if (isObject(error) && error['code'] === 'ENOENT')
            return;
        throw new Error(reason);
    }
    throw new Error(reason);
}
function recordEpochId(record) {
    return record.epochId ?? LEGACY_EPOCH_ID;
}
function readFdBytes(fd, length, position) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, position + offset);
        if (read === 0)
            break;
        offset += read;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
}
function scopeHash(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function safeToken(value, maxChars) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : null;
}
function safeEpochId(value) {
    const token = safeToken(value, 128);
    return token && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(token) ? token : null;
}
function boundedOperatorCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : 0;
}
function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : undefined;
}
function positiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function clampScore(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function validIso(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}