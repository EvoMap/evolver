import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { algo, events, util } from '@evomap/evolver-core';
const ACTIVE_FILE = 'memory_graph.v2.jsonl';
const COMPACT_FILE = 'memory_graph.compact.jsonl';
const LOCK_FILE = 'memory_graph.lock';
const RECOVERY_FILE = 'memory_graph.recovery.json';
const ARCHIVE_PATTERN = /^memory_graph\.v2\.(\d{13})\.jsonl\.gz$/;
const DEFAULT_MAX_COMPACT_BYTES = 2 * 1024 * 1024;
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
    importedFingerprints = new Map();
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
        const sourceScope = scopeHash(`source:${source}`);
        const parsed = parseV1Outcome(raw, workspaceScope, this.userScope, sourceScope);
        if (!parsed)
            return false;
        return this.withGraphLock(() => {
            const dedupeScope = `${workspaceScope}\u0000${this.userScope}\u0000${sourceScope}`;
            const stateFingerprint = this.importStateFingerprint();
            let cache = this.importedFingerprints.get(dedupeScope);
            if (!cache || cache.stateFingerprint !== stateFingerprint) {
                const values = new Set();
                for (const record of this.readImportRecords()) {
                    if (record.workspaceScope !== workspaceScope || record.userScope !== this.userScope)
                        continue;
                    if (record.sourceScope && record.sourceScope !== sourceScope)
                        continue;
                    if (record.sourceFingerprint)
                        values.add(record.sourceFingerprint);
                    if (record.legacySourceFingerprint)
                        values.add(record.legacySourceFingerprint);
                }
                cache = { stateFingerprint, values };
                this.importedFingerprints.set(dedupeScope, cache);
            }
            if ((parsed.sourceFingerprint && cache.values.has(parsed.sourceFingerprint))
                || (parsed.legacySourceFingerprint && cache.values.has(parsed.legacySourceFingerprint)))
                return false;
            if (!this.appendRecordUnlocked(parsed))
                return false;
            if (parsed.sourceFingerprint)
                cache.values.add(parsed.sourceFingerprint);
            if (parsed.legacySourceFingerprint)
                cache.values.add(parsed.legacySourceFingerprint);
            cache.stateFingerprint = this.importStateFingerprint();
            return true;
        });
    }
    maintain() {
        return this.withGraphLock(() => this.maintainUnlocked());
    }
    maintainUnlocked() {
        this.ensureSecureDir();
        const health = this.inspectHealthUnlocked();
        if (health.archives > 0 && this.compactRequiresRecovery()) {
            const recovered = this.recoverFromArchivesUnlocked();
            if (recovered.recovery === 'recovered')
                return recovered;
        }
        const activePath = join(this.dir, ACTIVE_FILE);
        if (!existsSync(activePath) || statSync(activePath).size < this.maxActiveBytes) {
            return {
                rotated: false,
                compactedRecords: health.compactedRecords,
                corruptLines: health.corruptLines,
                oversizedLines: health.oversizedLines,
                archives: health.archives,
                recovery: health.recovery,
            };
        }
        return this.rotateAndCompactUnlocked();
    }
    recoverFromArchives() {
        return this.withGraphLock(() => this.recoverFromArchivesUnlocked());
    }
    recoverFromArchivesUnlocked() {
        this.ensureSecureDir();
        const diagnostics = emptyDiagnostics();
        const compactRecords = this.readCompact(diagnostics);
        const archiveRecords = [];
        for (const file of this.archiveFiles().slice(-this.archiveRetention)) {
            const path = join(this.dir, file);
            if (!this.secureRegularFile(path))
                continue;
            try {
                const compressed = this.readRawBounded(path, this.maxActiveBytes);
                if (compressed === null) {
                    diagnostics.truncated = true;
                    continue;
                }
                const raw = gunzipSync(compressed, { maxOutputLength: this.maxActiveBytes + this.maxLineBytes });
                archiveRecords.push(...this.parseBuffer(raw, diagnostics));
            }
            catch {
                diagnostics.corruptLines += 1;
            }
        }
        const compacted = mergeRecoveryRecords(compactRecords, archiveRecords, this.maxCompactEdges);
        const compactedRecords = compacted.length > 0 ? this.writeCompact(compacted) : 0;
        if (compactedRecords > 0)
            this.writeRecoveryMarker();
        return {
            rotated: false,
            compactedRecords,
            corruptLines: diagnostics.corruptLines,
            oversizedLines: diagnostics.oversizedLines,
            archives: this.archiveFiles().length,
            recovery: compactedRecords > 0 ? 'recovered' : 'degraded',
        };
    }
    inspectHealth() {
        if (!existsSync(this.dir))
            return emptyHealth();
        try {
            return this.withGraphLock(() => this.inspectHealthUnlocked());
        }
        catch (error) {
            if (error instanceof MemoryGraphBusyError) {
                return { ...emptyHealth(), recovery: 'degraded', busy: true };
            }
            throw error;
        }
    }
    inspectHealthUnlocked() {
        if (!existsSync(this.dir))
            return emptyHealth();
        const dirStat = lstatSync(this.dir);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
            throw new Error('memory_graph_dir_rejected');
        const compactDiagnostics = emptyDiagnostics();
        const activeDiagnostics = emptyDiagnostics();
        const compactPath = join(this.dir, COMPACT_FILE);
        const activePath = join(this.dir, ACTIVE_FILE);
        const compactedRecords = this.readCompact(compactDiagnostics).length;
        const activeRecords = this.readWholeBounded(activePath, activeDiagnostics, this.maxActiveBytes).length;
        const archives = this.archiveFiles().length;
        const oversizedFiles = Number(fileExceeds(compactPath, this.maxCompactBytes)) + Number(fileExceeds(activePath, this.maxActiveBytes));
        const rejectedFiles = Number(existsSync(compactPath) && !this.secureRegularFile(compactPath))
            + Number(existsSync(activePath) && !this.secureRegularFile(activePath));
        const corruptLines = compactDiagnostics.corruptLines + activeDiagnostics.corruptLines + rejectedFiles;
        const oversizedLines = compactDiagnostics.oversizedLines + activeDiagnostics.oversizedLines;
        const compactMissingWithArchives = archives > 0 && (!existsSync(compactPath) || statSync(compactPath).size === 0);
        const degraded = corruptLines > 0 || oversizedLines > 0 || oversizedFiles > 0 || compactMissingWithArchives;
        const records = compactedRecords + activeRecords;
        return {
            recovery: degraded ? 'degraded' : records === 0 ? 'empty' : this.hasRecoveryMarker() ? 'recovered' : 'healthy',
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
        let value;
        let operationError;
        let operationFailed = false;
        try {
            this.ensureSecureDir();
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
    importStateFingerprint() {
        return [COMPACT_FILE, ACTIVE_FILE].map((file) => {
            const path = join(this.dir, file);
            if (!existsSync(path))
                return `${file}:missing`;
            const stat = lstatSync(path, { bigint: true });
            return `${file}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        }).join('|');
    }
    appendRecordUnlocked(record) {
        this.ensureSecureDir();
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line) > this.maxLineBytes)
            return false;
        const activePath = join(this.dir, ACTIVE_FILE);
        if (existsSync(activePath) && statSync(activePath).size + Buffer.byteLength(line) > this.maxActiveBytes) {
            const maintenance = this.rotateAndCompactUnlocked();
            if (!maintenance.rotated)
                return false;
        }
        const fd = openNoFollow(activePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile())
                return false;
            writeSync(fd, line, undefined, 'utf8');
            fsyncSync(fd);
            return true;
        }
        finally {
            closeSync(fd);
        }
    }
    rotateAndCompactUnlocked() {
        const diagnostics = emptyDiagnostics();
        const activePath = join(this.dir, ACTIVE_FILE);
        const records = [...this.readCompact(diagnostics), ...this.readWholeBounded(activePath, diagnostics, this.maxActiveBytes)];
        const compacted = compactRecords(records, this.maxCompactEdges);
        const compactedRecords = this.writeCompact(compacted);
        if (compacted.length > 0 && compactedRecords === 0) {
            return {
                rotated: false,
                compactedRecords: 0,
                corruptLines: diagnostics.corruptLines,
                oversizedLines: diagnostics.oversizedLines,
                archives: this.archiveFiles().length,
                recovery: 'degraded',
            };
        }
        if (compacted.length === 0 || compactedRecords > 0)
            this.clearRecoveryMarker();
        let rotated = false;
        if (existsSync(activePath) && this.secureRegularFile(activePath)) {
            const raw = this.readRawTail(activePath, this.maxActiveBytes);
            if (statSync(activePath).size > raw.length)
                diagnostics.truncated = true;
            const archivePath = this.nextArchivePath();
            this.writeAtomic(archivePath, gzipSync(raw));
            this.writeAtomic(activePath, Buffer.alloc(0));
            rotated = true;
        }
        this.pruneArchives();
        return {
            rotated,
            compactedRecords,
            corruptLines: diagnostics.corruptLines,
            oversizedLines: diagnostics.oversizedLines,
            archives: this.archiveFiles().length,
            recovery: diagnostics.corruptLines > 0 || diagnostics.oversizedLines > 0 || diagnostics.truncated
                ? 'degraded'
                : compactedRecords > 0 ? 'healthy' : 'empty',
        };
    }
    compactRequiresRecovery() {
        const path = join(this.dir, COMPACT_FILE);
        if (!existsSync(path) || !this.secureRegularFile(path) || statSync(path).size === 0)
            return true;
        const diagnostics = emptyDiagnostics();
        this.readCompact(diagnostics);
        return diagnostics.corruptLines > 0 || diagnostics.oversizedLines > 0 || diagnostics.truncated;
    }
    readQueryableRecords(diagnostics) {
        this.ensureSecureDir();
        const compactPath = join(this.dir, COMPACT_FILE);
        const compactDiagnostics = emptyDiagnostics();
        let records = this.readCompact(compactDiagnostics);
        const archives = this.archiveFiles().length;
        const compactExists = existsSync(compactPath);
        const compactSecure = compactExists && this.secureRegularFile(compactPath);
        const compactNeedsRecovery = archives > 0 && (!compactExists
            || !compactSecure
            || (compactSecure && statSync(compactPath).size === 0)
            || compactDiagnostics.corruptLines > 0
            || compactDiagnostics.oversizedLines > 0
            || compactDiagnostics.truncated);
        mergeDiagnostics(diagnostics, compactDiagnostics);
        if (compactNeedsRecovery) {
            try {
                const recovery = this.recoverFromArchivesUnlocked();
                if (recovery.recovery === 'recovered') {
                    const recoveredDiagnostics = emptyDiagnostics();
                    records = this.readCompact(recoveredDiagnostics);
                    mergeDiagnostics(diagnostics, recoveredDiagnostics);
                    diagnostics.recovery = 'recovered';
                }
            }
            catch {
                diagnostics.recovery = 'degraded';
            }
        }
        records.push(...this.readWholeBounded(join(this.dir, ACTIVE_FILE), diagnostics, this.maxActiveBytes));
        if (diagnostics.recovery !== 'recovered' && (diagnostics.corruptLines > 0 || diagnostics.oversizedLines > 0 || diagnostics.truncated))
            diagnostics.recovery = 'degraded';
        return records;
    }
    readImportRecords() {
        this.ensureSecureDir();
        const diagnostics = emptyDiagnostics();
        const activePath = join(this.dir, ACTIVE_FILE);
        if (existsSync(activePath)) {
            if (!this.secureRegularFile(activePath) || statSync(activePath).size > this.maxActiveBytes) {
                throw new MemoryGraphImportStateRejectedError();
            }
        }
        return [...this.readCompact(diagnostics), ...this.readWholeBounded(activePath, diagnostics, this.maxActiveBytes)];
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
    readRawTail(path, maxBytes) {
        const fd = openNoFollow(path, constants.O_RDONLY, 0o600);
        try {
            const size = fstatSync(fd).size;
            const bytes = Math.min(size, maxBytes);
            const buffer = readFdBytes(fd, bytes, size - bytes);
            if (size <= bytes)
                return buffer;
            const newline = buffer.indexOf(0x0a);
            return newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0);
        }
        finally {
            closeSync(fd);
        }
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
        if (records.length > 0 && fitted.records.length === 0)
            return 0;
        this.writeAtomic(join(this.dir, COMPACT_FILE), fitted.payload);
        return fitted.records.length;
    }
    writeAtomic(path, payload) {
        this.ensureSecureDir();
        if (existsSync(path) && !this.secureRegularFile(path))
            throw new Error('memory_graph_path_rejected');
        const temp = join(dirname(path), `.${basename(path)}.${this.now()}.tmp`);
        const fd = openNoFollow(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            writeSync(fd, payload);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temp, path);
    }
    ensureSecureDir() {
        if (!existsSync(this.dir))
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const stat = lstatSync(this.dir);
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
    pruneArchives() {
        const files = this.archiveFiles();
        for (const file of files.slice(0, Math.max(0, files.length - this.archiveRetention)))
            unlinkSync(join(this.dir, file));
    }
    writeRecoveryMarker() {
        this.writeAtomic(join(this.dir, RECOVERY_FILE), Buffer.from(`${JSON.stringify({ version: 1, recoveredAt: new Date(this.now()).toISOString() })}\n`, 'utf8'));
    }
    hasRecoveryMarker() {
        const path = join(this.dir, RECOVERY_FILE);
        if (!existsSync(path) || !this.secureRegularFile(path))
            return false;
        try {
            const bytes = this.readRawBounded(path, this.maxLineBytes);
            if (bytes === null)
                return false;
            const raw = JSON.parse(bytes.toString('utf8'));
            return isObject(raw) && raw['version'] === 1 && typeof raw['recoveredAt'] === 'string' && validIso(raw['recoveredAt']) !== null;
        }
        catch {
            return false;
        }
    }
    clearRecoveryMarker() {
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
    if (!workspaceScope || !userScope || !signalFingerprint || !geneId || (status !== 'success' && status !== 'failed') || !at)
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
        ...(safeToken(value['sourceFingerprint'], 128) ? { sourceFingerprint: safeToken(value['sourceFingerprint'], 128) } : {}),
        ...(safeToken(value['sourceScope'], 128) ? { sourceScope: safeToken(value['sourceScope'], 128) } : {}),
        ...(safeToken(value['legacySourceFingerprint'], 128) ? { legacySourceFingerprint: safeToken(value['legacySourceFingerprint'], 128) } : {}),
        ...(positiveCount(value['successCount']) !== undefined ? { successCount: positiveCount(value['successCount']) } : {}),
        ...(positiveCount(value['failCount']) !== undefined ? { failCount: positiveCount(value['failCount']) } : {}),
    };
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
    return record.provenance === 'v1_import' && record.sourceFingerprint
        ? `import\u0000${record.workspaceScope}\u0000${record.userScope}\u0000${record.sourceScope ?? 'legacy-unscoped'}\u0000${record.sourceFingerprint}`
        : `${record.workspaceScope}\u0000${record.userScope}\u0000${record.signalFingerprint}\u0000${record.geneId}`;
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
function boundedOperatorCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : 0;
}
function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.min(1_000_000, Math.floor(count)) : undefined;
}
function positiveInt(value, fallback) {
    return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
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