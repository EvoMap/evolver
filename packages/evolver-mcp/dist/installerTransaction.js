import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sameRuntimePath } from './runtimePathIdentity.js';
import { pinSharedDirectory } from './sharedDirectory.js';
import { withUninstallPostimages } from './installerUninstallVerification.js';
import { assertInstallerSyncCallback, assertInstallerSyncScopeActive, runInstallerSyncCallback } from './installerSync.js';
import { hub, util } from '@evomap/evolver-core';
import { encodeInstallerJournal, decodeInstallerJournal, publishInstallerEvidence, INSTALLER_JOURNAL_STORAGE_SCHEMA } from './installerJournalStorage.js';
import { assertSharedPathSafe, commitSharedFile, readSharedFileSnapshot, sameSharedFileIdentity, syncSharedDirectory, withSharedFileCommitObserver, SharedFileConflictError, sharedFileCompensationActive, } from './sharedFileCommit.js';
export const INSTALLER_TRANSACTION_SCHEMA = 'evolver.installer.transaction.v1';
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{64}$/;
export function installerTransactionFromError(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function'))
        return undefined;
    try {
        const value = error.transaction;
        return value && value.schema === INSTALLER_TRANSACTION_SCHEMA && typeof value.transaction_id === 'string' ? value : undefined;
    }
    catch {
        return undefined;
    }
}
export class InstallerTransactionError extends Error {
    code;
    transaction;
    constructor(code, message, transaction, options) {
        super(message, options);
        this.code = code;
        this.transaction = transaction;
        this.name = 'InstallerTransactionError';
    }
}
function hash(raw) { return createHash('sha256').update(raw).digest('hex'); }
function sameSnapshot(left, right) {
    return left.raw === right.raw && sameSharedFileIdentity(left.identity, right.identity);
}
function validateID(id) {
    if (!ID_RE.test(id))
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer transaction ID');
}
function assertPrivate(path, directory) {
    assertSharedPathSafe(path);
    const stat = lstatSync(path);
    if (directory ? !stat.isDirectory() : !stat.isFile())
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal path');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) {
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal is not private to the current user');
    }
}
function assertPrivateRoot(root, secure = false) {
    try {
        assertPrivate(root, true);
        if (process.platform === 'win32') {
            const acl = new hub.PowerShellWindowsAclOps({ redactDiagnostics: true });
            if (secure)
                acl.securePrivateDirectory(root);
            else
                acl.assertPrivateTree(root);
        }
    }
    catch (cause) {
        if (cause instanceof InstallerTransactionError || cause.code === 'ENOENT')
            throw cause;
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer recovery storage has unsafe permissions or parents; use a trusted private home and retry recovery', undefined, { cause });
    }
}
function transactionDir(root, id) { validateID(id); return join(root, id); }
function snapshotValid(value) {
    if (!value || typeof value !== 'object')
        return false;
    const snapshot = value;
    if (snapshot.raw === null)
        return snapshot.identity === null;
    const identity = snapshot.identity;
    return typeof snapshot.raw === 'string' && !!identity && typeof identity === 'object'
        && ['dev', 'ino', 'size', 'uid', 'gid'].every(key => typeof identity[key] === 'string'
            && /^\d+$/.test(identity[key]))
        && typeof identity.mtimeNs === 'string' && /^-?\d+$/.test(identity.mtimeNs)
        && typeof identity.mode === 'number' && Number.isInteger(identity.mode) && identity.mode >= 0 && identity.mode <= 0o777
        && typeof identity.sha256 === 'string' && identity.sha256 === hash(snapshot.raw);
}
function validateJournal(value, root, id) {
    if (!value || typeof value !== 'object')
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal');
    const journal = value;
    if (journal.schema !== INSTALLER_TRANSACTION_SCHEMA || journal.id !== id || typeof journal.root !== 'string' || !sameRuntimePath(journal.root, root)
        || typeof journal.binding !== 'string' || !ID_RE.test(journal.binding)
        || !['prepared', 'applying', 'committed', 'rollback_pending', 'rolled_back', 'released'].includes(journal.state)
        || !Array.isArray(journal.targets) || !Array.isArray(journal.artifacts) || !Array.isArray(journal.steps)
        || !Array.isArray(journal.completed) || !Array.isArray(journal.blocked)) {
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal identity or schema changed');
    }
    const paths = new Set();
    const ids = new Set();
    for (const target of journal.targets) {
        if (!target || typeof target.id !== 'string' || ids.has(target.id) || !Array.isArray(target.paths)) {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal target set');
        }
        ids.add(target.id);
        for (const path of target.paths) {
            if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || [...paths].some(existing => sameRuntimePath(existing, path))) {
                throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal artifact set');
            }
            paths.add(path);
        }
    }
    if (journal.completed.some(id => !ids.has(id)) || new Set(journal.completed).size !== journal.completed.length
        || journal.blocked.some(id => !ids.has(id)) || journal.artifacts.length !== paths.size) {
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal completion evidence');
    }
    for (const artifact of journal.artifacts) {
        if (!artifact || !journal.targets.some(target => target.id === artifact.target && target.paths.includes(artifact.path))
            || !paths.delete(artifact.path) || !snapshotValid(artifact.before) || !snapshotValid(artifact.current)) {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer journal snapshot');
        }
    }
    for (const step of journal.steps) {
        const artifact = journal.artifacts[step?.artifact];
        if (!artifact || !Number.isInteger(step.artifact) || !snapshotValid(step.before)
            || step.nextRaw !== null && typeof step.nextRaw !== 'string' || !step.paths || typeof step.paths !== 'object'
            || step.prepared !== undefined && !snapshotValid(step.prepared)
            || step.displaced !== undefined && !snapshotValid(step.displaced)
            || step.published !== undefined && !snapshotValid(step.published)
            || step.publicationAttempted !== undefined && step.publicationAttempted !== true
            || step.finished !== undefined && typeof step.finished !== 'boolean'
            || step.retainedOriginal !== undefined && (step.retainedOriginal !== true || !step.before.identity || !step.paths.movedLive)) {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer write evidence');
        }
        // Recovery never trusts arbitrary scratch paths supplied by a journal.
        for (const [label, path] of Object.entries(step.paths)) {
            const kind = label === 'prepared' ? 'next' : label === 'displaced' ? 'previous' : 'live';
            const suffix = typeof path === 'string' ? /\.evolver-(?:next|previous|live)-(\d+-[a-f0-9-]{36})$/.exec(basename(path))?.[1] : undefined;
            const expected = suffix ? join(dirname(artifact.path), `.${basename(artifact.path)}.evolver-${kind}-${suffix}`) : undefined;
            if (!['prepared', 'displaced', 'movedLive'].includes(label) || typeof path !== 'string' || !isAbsolute(path)
                || !expected || !sameRuntimePath(path, expected)) {
                throw new InstallerTransactionError('TRANSACTION_INVALID', 'Invalid installer recovery scratch path');
            }
        }
    }
    return journal;
}
function readJournal(root, id) {
    const dir = transactionDir(root, id);
    try {
        assertPrivate(dir, true);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const names = readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
    let loaded;
    const contentCache = new Map();
    for (const [index, name] of names.entries()) {
        if (name !== `${String(index).padStart(8, '0')}.json`)
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal has a missing generation');
        const path = join(dir, name);
        assertPrivate(path, false);
        if (lstatSync(path).size > MAX_JOURNAL_BYTES)
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal exceeds the recovery size limit');
        let record;
        try {
            record = JSON.parse(readSharedFileSnapshot(path).raw ?? '');
        }
        catch {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal is incomplete or corrupt');
        }
        if (!record || typeof record !== 'object' || record.schema !== INSTALLER_JOURNAL_STORAGE_SCHEMA
            || typeof record.previous !== 'string' || typeof record.digest !== 'string') {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal has an invalid storage envelope');
        }
        const expected = hash(JSON.stringify([record.previous, record.journal]));
        if (record.schema !== INSTALLER_JOURNAL_STORAGE_SCHEMA || record.previous !== (loaded?.digest ?? '') || expected !== record.digest) {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal checksum chain changed');
        }
        try {
            const decoded = decodeInstallerJournal(record.journal, dir, assertPrivate, contentCache);
            loaded = { journal: validateJournal(decoded, root, id), sequence: index, digest: expected };
        }
        catch (cause) {
            if (cause instanceof InstallerTransactionError)
                throw cause;
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer recovery content is missing or corrupt; preserve the runtime files and inspect private-state evidence', undefined, { cause });
        }
    }
    if (!loaded)
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer journal has no durable preparation');
    return loaded;
}
export function inspectInstallerTransactions(root, id) {
    assertSharedPathSafe(root);
    let names;
    try {
        assertPrivateRoot(root);
        names = id ? [id] : readdirSync(root).filter(name => ID_RE.test(name));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    return names.map(name => readJournal(root, name)).filter((loaded) => !!loaded).map(loaded => summary(loaded.journal));
}
function resolutionDigest(journal) {
    return hash(JSON.stringify([journal.id, journal.state, journal.steps.length,
        journal.artifacts.map(artifact => readSharedFileSnapshot(artifact.path).identity)]));
}
function retainedEvidencePaths(journal) {
    return [...new Set(journal.steps.filter(step => step.retainedOriginal).flatMap(step => {
            const path = step.paths.movedLive;
            try {
                const identity = readSharedFileSnapshot(path).identity;
                // An editor may change the original inode; a replacement pathname is not our retained evidence.
                return identity && identity.dev === step.before.identity?.dev && identity.ino === step.before.identity?.ino ? [path] : [];
            }
            catch {
                return [];
            }
        }))];
}
function summary(journal) {
    let resolution;
    if (journal.state === 'rollback_pending') {
        try {
            resolution = resolutionDigest(journal);
        }
        catch { /* Inaccessible paths cannot be acknowledged. */ }
    }
    const metadata = journal.metadata;
    const pathRef = (path, kind) => {
        const base = metadata?.scope === 'user' ? metadata.options?.homeDir : metadata?.options?.configRoot;
        if (typeof base === 'string') {
            const local = relative(resolve(base), path);
            if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))
                return `${metadata?.scope === 'user' ? '~/' : ''}${local.replaceAll('\\', '/')}`;
        }
        return `<${kind}:${metadata?.runtime ?? 'installer'}:${metadata?.scope ?? 'scope'}>`;
    };
    const targetRef = (target) => {
        const planned = Array.isArray(metadata?.plan?.targets) ? metadata.plan.targets.find(item => item && typeof item === 'object' && item.target_id === target.id)?.target_ref : undefined;
        if (typeof planned === 'string')
            return planned;
        return target.paths[0] ? pathRef(target.paths[0], 'managed') : `<managed:${metadata?.runtime ?? 'installer'}:${metadata?.scope ?? 'scope'}>`;
    };
    return {
        ...(typeof metadata?.runtime === 'string' ? { runtime: metadata.runtime } : {}),
        ...(metadata?.scope === 'user' || metadata?.scope === 'project' ? { scope: metadata.scope } : {}),
        ...(metadata?.action === 'install' || metadata?.action === 'uninstall' ? { action: metadata.action } : {}),
        schema: INSTALLER_TRANSACTION_SCHEMA, transaction_id: journal.id, state: journal.state, state_durable: true,
        complete: journal.state === 'committed' || journal.state === 'rolled_back' || journal.state === 'released',
        completed_target_ids: [...journal.completed], blocked_target_ids: [...journal.blocked],
        ...(journal.steps.some(step => step.retainedOriginal) ? { retained_paths: retainedEvidencePaths(journal).map(path => pathRef(path, 'retained')) } : {}),
        targets: journal.targets.map(target => {
            const artifacts = journal.artifacts.filter(artifact => artifact.target === target.id);
            let unchanged = false;
            try {
                unchanged = artifacts.every(artifact => sameSnapshot(readSharedFileSnapshot(artifact.path), artifact.current));
            }
            catch { /* Verification stays false. */ }
            return { target_id: target.id, target_ref: targetRef(target),
                committed: artifacts.some(artifact => artifact.current.raw !== artifact.before.raw),
                verified: unchanged && journal.completed.includes(target.id) && !journal.blocked.includes(target.id) };
        }),
        recovery: journal.state === 'prepared' || journal.state === 'applying' ? ['resume', 'rollback']
            : journal.state === 'rollback_pending' ? ['rollback', ...(resolution ? ['accept-current'] : [])] : [],
        ...(resolution ? { resolution_digest: resolution } : {}),
    };
}
export class InstallerTransaction {
    root;
    journal;
    selected;
    verifying;
    released = false;
    rollbackOnError = false;
    assertActive() {
        if (this.released)
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer transaction scope lease has been released');
        assertInstallerSyncScopeActive();
    }
    armRollback() { this.assertActive(); this.rollbackOnError = true; }
    sequence;
    digest;
    stateUnconfirmed = false;
    directory;
    constructor(root, journal, loaded) {
        this.root = root;
        this.journal = journal;
        this.sequence = loaded?.sequence ?? -1;
        this.digest = loaded?.digest ?? '';
        this.directory = pinSharedDirectory(transactionDir(root, journal.id));
        Object.assign(this.observer, { publicationAttempted: (path) => this.publicationAttempted(path) });
        try {
            this.directory.assertCurrent();
            if (!loaded)
                this.save();
        }
        catch (error) {
            try {
                this.directory.close();
            }
            catch (cleanupError) {
                if (error instanceof Error)
                    error.cleanupError = cleanupError;
            }
            throw error;
        }
    }
    releaseDirectory() { this.released = true; this.directory.close(); }
    get status() {
        const value = summary(this.journal);
        return { ...value, complete: value.complete && !this.stateUnconfirmed, state_durable: !this.stateUnconfirmed };
    }
    /** Private backup consumers keep the original paths; public summaries contain only safe references. */
    get retainedPaths() { this.assertActive(); return retainedEvidencePaths(this.journal); }
    get metadata() { return this.journal.metadata; }
    get targets() { return this.journal.targets; }
    get binding() { return this.journal.binding; }
    hasCompleted(id) { return this.journal.completed.includes(id); }
    wasChanged(id) {
        return this.journal.artifacts.some(artifact => artifact.target === id && artifact.current.raw !== artifact.before.raw);
    }
    save() {
        this.assertActive();
        const next = this.sequence + 1;
        const dir = transactionDir(this.root, this.journal.id);
        try {
            this.directory.assertCurrent();
            assertPrivate(dir, true);
            const encoded = encodeInstallerJournal(this.journal, dir, assertPrivate);
            const digest = hash(JSON.stringify([this.digest, encoded]));
            const raw = JSON.stringify({ schema: INSTALLER_JOURNAL_STORAGE_SCHEMA, previous: this.digest, journal: encoded, digest });
            if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) {
                this.stateUnconfirmed = true;
                throw new InstallerTransactionError('TRANSACTION_IO', 'Installer transaction metadata exceeds journal capacity', this.status);
            }
            const path = join(dir, `${String(next).padStart(8, '0')}.json`);
            const publication = {};
            try {
                publishInstallerEvidence(path, raw, false, publication);
            }
            finally {
                // Reserve the owned generation even if a later sync, close or path check fails.
                if (publication.published) {
                    this.sequence = next;
                    this.digest = digest;
                }
            }
            this.directory.assertCurrent();
            this.stateUnconfirmed = false;
        }
        catch (cause) {
            this.stateUnconfirmed = true;
            if (cause instanceof InstallerTransactionError)
                throw cause;
            throw new InstallerTransactionError('TRANSACTION_IO', 'Cannot persist installer recovery evidence; check private-state permissions and available disk space before retrying recovery', this.status, { cause });
        }
    }
    conflict(id) {
        this.journal.blocked = [...new Set([...this.journal.blocked, id])];
        this.stateUnconfirmed = true;
        let cause;
        try {
            this.save();
        }
        catch (error) {
            cause = error;
        }
        throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Runtime configuration or ownership evidence changed; user content was not overwritten', this.status, cause === undefined ? undefined : { cause });
    }
    publicationAttempted(path) {
        const index = this.journal.artifacts.findIndex(artifact => sameRuntimePath(artifact.path, path));
        return index < 0 ? undefined : this.journal.steps.some(step => step.artifact === index && step.publicationAttempted);
    }
    canRebase(artifact) {
        return !sharedFileCompensationActive() && !this.publicationAttempted(artifact.path)
            && this.journal.metadata?.source === 'installer'
            && !artifact.path.endsWith('.evolver-backup.json') && !this.hasCompleted(artifact.target)
            && artifact.current.raw === artifact.before.raw
            && !this.journal.steps.some(step => this.journal.artifacts[step.artifact] === artifact && !step.finished);
    }
    rebase(artifact, current) {
        artifact.before = current;
        artifact.current = current;
        this.journal.blocked = this.journal.blocked.filter(id => id !== artifact.target);
        this.save();
    }
    observer = (options, paths) => {
        const index = this.journal.artifacts.findIndex(artifact => sameRuntimePath(artifact.path, options.path) && artifact.target === this.selected);
        if (index < 0)
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer attempted an unconfirmed artifact write', this.status);
        const artifact = this.journal.artifacts[index];
        const current = readSharedFileSnapshot(artifact.path);
        if (!sameSnapshot(current, artifact.current) && this.canRebase(artifact)) {
            if (current.raw !== (options.expectedRaw ?? null))
                throw new SharedFileConflictError(artifact.path);
            this.rebase(artifact, current);
        }
        if (!sameSnapshot(current, artifact.current) || current.raw !== (options.expectedRaw ?? null))
            this.conflict(artifact.target);
        if (sharedFileCompensationActive() && artifact.path.endsWith('.evolver-backup.json')) {
            const config = this.journal.artifacts.find(candidate => candidate.target === artifact.target && candidate.path === artifact.path.replace(/\.evolver-backup\.json$/, ''));
            if (config && this.publicationAttempted(config.path) && !sameSnapshot(readSharedFileSnapshot(config.path), config.current))
                this.conflict(artifact.target);
        }
        options.expectedIdentity = current.identity;
        const step = { artifact: index, before: current, nextRaw: options.nextRaw ?? null, paths,
            ...(options.retainOriginal ? { retainedOriginal: true } : {}) };
        this.journal.steps.push(step);
        this.save();
        return {
            prepared: () => {
                if (paths.prepared)
                    step.prepared = readSharedFileSnapshot(paths.prepared);
                this.save();
            },
            publishing: () => { step.publicationAttempted = true; this.save(); },
            displaced: (snapshot) => { step.displaced = snapshot; this.save(); },
            published: (publication) => {
                const actual = readSharedFileSnapshot(artifact.path);
                if (actual.raw !== step.nextRaw || !sameSnapshot(actual, publication))
                    this.conflict(artifact.target);
                step.published = actual;
                artifact.current = actual;
                this.save();
            },
            finished: () => {
                const actual = readSharedFileSnapshot(artifact.path);
                // A failing primitive may have conditionally restored its original bytes. Do not adopt an arbitrary
                // concurrent replacement as our receipt just because the installer threw after writing.
                if (sameSnapshot(actual, artifact.current) || sameSnapshot(actual, step.before)
                    || step.displaced && sameSnapshot(actual, step.displaced)
                    || step.prepared && sameSnapshot(actual, step.prepared))
                    artifact.current = actual;
                else
                    this.journal.blocked = [...new Set([...this.journal.blocked, artifact.target])];
                step.finished = true;
                this.save();
            },
        };
    };
    /** Resolve writes that reached publication but crashed before their durable receipt. */
    reconcile(targetId) {
        for (const artifact of this.journal.artifacts) {
            if (targetId !== undefined && artifact.target !== targetId)
                continue;
            const actual = readSharedFileSnapshot(artifact.path);
            if (sameSnapshot(actual, artifact.current))
                continue;
            if (this.canRebase(artifact)) {
                this.rebase(artifact, actual);
                continue;
            }
            const step = [...this.journal.steps].reverse().find(step => this.journal.artifacts[step.artifact] === artifact);
            if (step && !step.finished && (step.prepared && sameSnapshot(actual, step.prepared)
                || step.published && sameSnapshot(actual, step.published))) {
                artifact.current = actual;
                this.save();
                continue;
            }
            if (step && !step.finished && actual.raw === null && step.paths.movedLive) {
                const moved = readSharedFileSnapshot(step.paths.movedLive);
                if (sameSnapshot(moved, step.before)) {
                    // The crash-only missing-path window. No-clobber publication restores the displaced config first;
                    // a concurrent file creation at the live path wins and is reported as a conflict.
                    artifact.current = actual;
                    this.selected = artifact.target;
                    withSharedFileCommitObserver(this.observer, () => commitSharedFile({
                        path: artifact.path, expectedRaw: undefined, nextRaw: step.before.raw ?? undefined,
                        mode: step.before.identity?.mode,
                    }));
                    continue;
                }
            }
            this.conflict(artifact.target);
        }
    }
    assertCurrent() { this.assertActive(); this.reconcile(); }
    runTarget(id, run, verify) {
        this.assertActive();
        assertInstallerSyncCallback(run);
        assertInstallerSyncCallback(verify);
        if (!this.journal.targets.some(target => target.id === id))
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Unknown transaction target');
        if (this.journal.state === 'rollback_pending' || this.journal.state === 'rolled_back' || this.journal.state === 'released') {
            throw new InstallerTransactionError('TRANSACTION_PENDING', 'This transaction must be rolled back before creating a new plan', this.status);
        }
        this.armRollback();
        this.reconcile();
        if (!this.hasCompleted(id) && this.wasChanged(id))
            this.restoreTargets([id]);
        this.selected = id;
        this.journal.state = 'applying';
        this.journal.blocked = [];
        this.save();
        const result = withSharedFileCommitObserver(this.observer, run);
        this.reconcile();
        const previousVerification = this.verifying;
        this.verifying = id;
        try {
            if (runInstallerSyncCallback(verify) !== true)
                throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Installer target read-back verification failed', this.status);
        }
        finally {
            this.verifying = previousVerification;
        }
        this.reconcile();
        if (!this.hasCompleted(id))
            this.journal.completed.push(id);
        this.save();
        return result;
    }
    markRollbackBlocked() {
        this.assertActive();
        this.journal.state = 'rollback_pending';
        this.journal.blocked = this.journal.targets.map(target => target.id);
        this.stateUnconfirmed = true;
        try {
            this.save();
        }
        catch { /* Preserve the primary error; no durable state is claimed after storage failure. */ }
    }
    cleanupScratch(id) {
        for (const step of this.journal.steps.filter(step => this.journal.artifacts[step.artifact]?.target === id)) {
            for (const [label, path] of Object.entries(step.paths)) {
                const expected = label === 'prepared' ? step.prepared : label === 'displaced' ? step.displaced ?? step.before : step.before;
                const actual = readSharedFileSnapshot(path);
                if (step.retainedOriginal && label === 'movedLive') {
                    if (actual.raw === null && step.published || actual.identity && (actual.identity.dev !== step.before.identity?.dev || actual.identity.ino !== step.before.identity?.ino))
                        this.conflict(id);
                    continue; // Recovery evidence keeps the original inode for an editor's still-open descriptor.
                }
                if (actual.raw === null)
                    continue;
                if (!expected || !sameSnapshot(actual, expected))
                    this.conflict(id);
                commitSharedFile({ path, expectedRaw: actual.raw, nextRaw: undefined, expectedIdentity: actual.identity });
            }
        }
    }
    verifyUninstall(verify) {
        this.assertActive();
        assertInstallerSyncCallback(verify);
        if (this.journal.metadata?.action !== 'uninstall') {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Uninstall verification requires the recorded uninstall action');
        }
        this.reconcile();
        const images = this.journal.artifacts.filter(artifact => {
            if (!this.hasCompleted(artifact.target) && this.verifying !== artifact.target)
                return false;
            const step = this.journal.steps.findLast(step => this.journal.artifacts[step.artifact] === artifact);
            return !!step?.finished && !!step.published && sameSnapshot(step.published, artifact.current);
        }).map(artifact => ({ path: artifact.path, snapshot: artifact.current }));
        return withUninstallPostimages(images, () => runInstallerSyncCallback(verify) === true);
    }
    commit(verify) {
        this.assertActive();
        assertInstallerSyncCallback(verify);
        this.reconcile();
        if (this.journal.targets.some(target => !this.hasCompleted(target.id)) || runInstallerSyncCallback(verify) !== true) {
            throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Full installer transaction verification failed', this.status);
        }
        for (const target of this.journal.targets)
            this.cleanupScratch(target.id);
        this.journal.state = 'committed';
        this.save();
    }
    restoreTargets(ids) {
        for (const id of [...ids].reverse()) {
            const artifacts = this.journal.artifacts.filter(artifact => artifact.target === id);
            for (const step of this.journal.steps.filter(step => step.retainedOriginal && this.journal.artifacts[step.artifact]?.target === id)) {
                const retained = readSharedFileSnapshot(step.paths.movedLive);
                if (retained.raw === null ? step.published !== undefined : !sameSnapshot(retained, step.before))
                    this.conflict(id);
            }
            // A config and its ownership metadata are a unit. If either drifted, do not delete the other one's evidence.
            for (const artifact of artifacts) {
                if (!sameSnapshot(readSharedFileSnapshot(artifact.path), artifact.current))
                    this.conflict(id);
            }
            const lastWrite = (artifact) => this.journal.steps.findLastIndex(step => this.journal.artifacts[step.artifact] === artifact);
            for (const artifact of artifacts.sort((left, right) => lastWrite(right) - lastWrite(left))) {
                if (artifact.current.raw === artifact.before.raw)
                    continue;
                this.selected = id;
                withSharedFileCommitObserver(this.observer, () => commitSharedFile({
                    path: artifact.path, expectedRaw: artifact.current.raw ?? undefined, expectedIdentity: artifact.current.identity, nextRaw: artifact.before.raw ?? undefined,
                    // Keep existing privacy hardening: compensation never widens the current file's permissions.
                    mode: (artifact.before.identity?.mode ?? 0o600) & (artifact.current.identity?.mode ?? 0o777),
                }));
            }
            this.journal.completed = this.journal.completed.filter(target => target !== id);
            this.save();
        }
    }
    /** Explicitly acknowledge a reviewed manual reconciliation. No runtime file or ownership backup is changed. */
    acceptCurrent(expectedDigest) {
        this.assertActive();
        if (this.journal.state !== 'rollback_pending' || !ID_RE.test(expectedDigest) || resolutionDigest(this.journal) !== expectedDigest) {
            throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Manual reconciliation confirmation is stale; inspect the current transaction again', this.status);
        }
        for (const artifact of this.journal.artifacts)
            artifact.current = readSharedFileSnapshot(artifact.path);
        // Recheck after capture so concurrent replacements cannot be silently acknowledged.
        if (resolutionDigest(this.journal) !== expectedDigest)
            throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Runtime files changed during manual reconciliation', this.status);
        this.journal.state = 'released';
        this.journal.completed = [];
        this.journal.blocked = [];
        this.save();
        return this.status;
    }
    rollback() {
        this.assertActive();
        if (this.journal.state === 'rolled_back' || this.journal.state === 'released')
            return this.status;
        this.journal.state = 'rollback_pending';
        this.journal.blocked = [];
        this.save();
        // Independent targets can still be restored when one target is user-modified or inaccessible.
        for (const target of [...this.journal.targets].reverse()) {
            try {
                this.reconcile(target.id);
                this.restoreTargets([target.id]);
                this.cleanupScratch(target.id);
            }
            catch {
                this.journal.blocked = [...new Set([...this.journal.blocked, target.id])];
                this.save();
            }
        }
        if (!this.journal.blocked.length) {
            this.journal.state = 'rolled_back';
            this.journal.completed = [];
            this.save();
        }
        return this.status;
    }
}
/** One scope-wide lease covers preparation, target execution, recovery and journal publication. */
export function withInstallerTransaction(options, run) {
    assertInstallerSyncScopeActive();
    assertInstallerSyncCallback(run);
    if (options.validatePrepared)
        assertInstallerSyncCallback(options.validatePrepared);
    const root = resolve(options.root);
    validateID(options.id);
    assertSharedPathSafe(root);
    let existed = true;
    try {
        lstatSync(root);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        existed = false;
    }
    if (!existed && !options.targets)
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer transaction not found');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertPrivateRoot(root, !existed);
    const lock = join(root, 'owner.lock');
    const owner = util.acquireLock(lock);
    let primary;
    let failed = false;
    let result;
    let lastTransaction;
    try {
        const loaded = readJournal(root, options.id);
        if (loaded && options.binding !== undefined && loaded.journal.binding !== options.binding) {
            throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Installer transaction intent changed', summary(loaded.journal));
        }
        if (!loaded && (!options.targets || !options.binding))
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Installer transaction not found');
        const targets = options.targets?.map(target => ({ id: target.id, paths: target.paths.map(path => resolve(path)) }));
        if (!loaded) {
            const paths = targets.flatMap(target => target.paths);
            for (const name of readdirSync(root).filter(name => ID_RE.test(name))) {
                const prior = readJournal(root, name);
                const existing = summary(prior.journal);
                if (existing.complete)
                    continue;
                if (prior.journal.artifacts.some(artifact => paths.some(path => sameRuntimePath(path, artifact.path)))) {
                    throw new InstallerTransactionError('TRANSACTION_PENDING', 'An overlapping installer transaction needs recovery first', existing);
                }
            }
        }
        const journal = loaded?.journal ?? {
            schema: INSTALLER_TRANSACTION_SCHEMA, id: options.id, root, binding: options.binding, state: 'prepared',
            targets: targets, completed: [], steps: [], blocked: [], metadata: options.metadata ?? null,
            artifacts: targets.flatMap(target => target.paths.map(path => {
                const before = readSharedFileSnapshot(path);
                return { path, target: target.id, before, current: before };
            })),
        };
        validateJournal(journal, root, options.id);
        if (!loaded && options.validatePrepared) {
            // Validate the exact captured identities under the scope lease, before any journal is published.
            if (runInstallerSyncCallback(() => options.validatePrepared(journal.artifacts.map(artifact => ({
                path: artifact.path, target: artifact.target, identity: artifact.before.identity ? { ...artifact.before.identity } : null,
            })))) !== true)
                throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Installer preparation validation failed');
        }
        if (!loaded) {
            mkdirSync(transactionDir(root, options.id), { mode: 0o700 });
            syncSharedDirectory(root);
        }
        const transaction = new InstallerTransaction(root, journal, loaded);
        lastTransaction = transaction;
        try {
            result = runInstallerSyncCallback(() => run(transaction));
        }
        catch (error) {
            let status = transaction.status;
            if (transaction.rollbackOnError && !status.complete) {
                try {
                    status = transaction.rollback();
                }
                catch (rollbackError) {
                    transaction.markRollbackBlocked();
                    status = transaction.status;
                    if (error instanceof Error)
                        error.rollbackError = rollbackError;
                }
            }
            if (error instanceof Error)
                error.transaction = status;
            throw error;
        }
    }
    catch (error) {
        failed = true;
        primary = error;
    }
    let releaseError;
    try {
        const released = util.releaseLock(lock, owner);
        if (!released.released)
            releaseError = new util.LockReleaseError(released.reason);
    }
    catch (error) {
        releaseError = error;
    }
    try {
        lastTransaction?.releaseDirectory();
    }
    catch (error) {
        releaseError = releaseError === undefined ? error : new AggregateError([releaseError, error], 'Installer transaction cleanup failed');
    }
    if (releaseError !== undefined) {
        if (failed && primary instanceof Error)
            primary.lockReleaseError = releaseError;
        else
            throw new InstallerTransactionError('TRANSACTION_IO', 'Installer transaction lease cleanup failed; retry recovery after checking private-state permissions', lastTransaction?.status, { cause: releaseError });
    }
    if (failed)
        throw primary;
    return result;
}