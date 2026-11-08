import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pinSharedDirectory } from './sharedDirectory.js';
import { assertInstallerSyncScopeActive } from './installerSync.js';
import { readSharedFileSnapshot, sameSharedFileIdentity, syncSharedDirectory } from './sharedFileCommit.js';
export const INSTALLER_JOURNAL_STORAGE_SCHEMA = 'evolver.installer.journal.v1';
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
function hash(raw) { return createHash('sha256').update(raw).digest('hex'); }
function contentPath(dir, digest) {
    if (!DIGEST_RE.test(digest))
        throw new Error('Invalid installer recovery content reference');
    return join(dir, 'content', digest);
}
function readContent(dir, digest, check, cache) {
    const cached = cache.get(digest);
    if (cached !== undefined)
        return cached;
    const path = contentPath(dir, digest);
    check(path, false);
    if (lstatSync(path).size > MAX_CONTENT_BYTES)
        throw new Error('Installer recovery content exceeds the size limit');
    const snapshot = readSharedFileSnapshot(path);
    if (snapshot.raw === null || Buffer.byteLength(snapshot.raw) > MAX_CONTENT_BYTES || hash(snapshot.raw) !== digest)
        throw new Error('Installer recovery content is missing or corrupt');
    cache.set(digest, snapshot.raw);
    return snapshot.raw;
}
let evidenceHookForTest;
export function _setInstallerEvidencePhaseHookForTest(hook) { evidenceHookForTest = hook; }
function recordOwnedPublication(path, prepared, publication) {
    const current = readSharedFileSnapshot(path);
    if (current.raw !== prepared.raw || !sameSharedFileIdentity(current.identity, prepared.identity)) {
        throw new Error('Installer recovery published content changed');
    }
    publication.published = true;
}
/** Publish private evidence without registering it as a runtime artifact. Unknown partial bytes or a
 * replaced pending inode are retained; cleanup never deletes another writer's replacement. */
export function publishInstallerEvidence(path, raw, existingAllowed = false, publication) {
    assertInstallerSyncScopeActive();
    if (publication)
        delete publication.published;
    const directory = pinSharedDirectory(dirname(path));
    const pending = join(directory.path, `.pending-${randomUUID()}`);
    let fd;
    let identity;
    let failed = false;
    let primary;
    try {
        fd = directory.open(pending, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
        identity = fstatSync(fd, { bigint: true });
        evidenceHookForTest?.('created', pending, path);
        writeFileSync(fd, raw, 'utf8');
        evidenceHookForTest?.('written', pending, path);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        evidenceHookForTest?.('synced', pending, path);
        const prepared = readSharedFileSnapshot(pending);
        if (prepared.identity?.dev !== String(identity.dev) || prepared.identity.ino !== String(identity.ino) || prepared.raw !== raw) {
            throw new Error('Installer recovery pending content changed');
        }
        let linked = false;
        try {
            if (process.platform === 'win32') {
                directory.assertCurrent();
                linkSync(pending, path);
            }
            else
                directory.link(pending, path);
            linked = true;
        }
        catch (error) {
            if (!existingAllowed || error?.code !== 'EEXIST')
                throw error;
        }
        if (linked && publication)
            recordOwnedPublication(path, prepared, publication);
        directory.sync();
        evidenceHookForTest?.('published', pending, path);
        directory.assertCurrent();
    }
    catch (error) {
        failed = true;
        primary = error;
    }
    finally {
        try {
            if (fd !== undefined) {
                closeSync(fd);
                fd = undefined;
            }
        }
        catch (closeError) {
            if (!failed) {
                failed = true;
                primary = closeError;
            }
        }
        try {
            if (identity) {
                const current = readSharedFileSnapshot(pending);
                if (current.identity?.dev === String(identity.dev) && current.identity.ino === String(identity.ino)
                    && (current.raw === raw || current.raw === '')) {
                    if (process.platform === 'win32') {
                        directory.assertCurrent();
                        unlinkSync(pending);
                    }
                    else
                        directory.unlink(pending);
                }
            }
        }
        catch (cleanupError) {
            if (cleanupError?.code !== 'ENOENT') {
                if (!failed) {
                    failed = true;
                    primary = cleanupError;
                }
                else if (primary instanceof Error)
                    primary.cleanupError = cleanupError;
            }
        }
        try {
            directory.close();
        }
        catch (closeError) {
            if (!failed) {
                failed = true;
                primary = closeError;
            }
        }
    }
    if (failed)
        throw primary;
}
function storeContent(dir, raw, check, cache) {
    if (raw === null)
        return null;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CONTENT_BYTES)
        throw new Error('Installer recovery content exceeds the size limit');
    const digest = hash(raw);
    const path = contentPath(dir, digest);
    try {
        check(path, false);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        const contentDir = join(dir, 'content');
        mkdirSync(contentDir, { recursive: true, mode: 0o700 });
        check(contentDir, true);
        publishInstallerEvidence(path, raw, true);
    }
    if (readContent(dir, digest, check, cache) !== raw)
        throw new Error('Installer recovery content changed');
    return digest;
}
/** Store each exact pre/post image once. Generations reference content hashes rather than duplicating config
 * bytes in every step; otherwise a valid large config could make the rollback journal exceed its own limit. */
export function encodeInstallerJournal(journal, dir, check) {
    assertInstallerSyncScopeActive();
    const cache = new Map();
    const snapshot = (value) => ({ identity: value.identity, content: storeContent(dir, value.raw, check, cache) });
    const encoded = {
        ...journal,
        artifacts: journal.artifacts.map(artifact => ({ ...artifact, before: snapshot(artifact.before), current: snapshot(artifact.current) })),
        steps: journal.steps.map(step => {
            const { nextRaw, ...rest } = step;
            return {
                ...rest, before: snapshot(step.before), nextContent: storeContent(dir, nextRaw, check, cache),
                ...(step.prepared ? { prepared: snapshot(step.prepared) } : {}),
                ...(step.displaced ? { displaced: snapshot(step.displaced) } : {}),
                ...(step.published ? { published: snapshot(step.published) } : {}),
            };
        }),
    };
    // A cached digest may remain after an earlier publication's directory sync failed.
    if (cache.size > 0)
        syncSharedDirectory(join(dir, 'content'));
    return encoded;
}
export function decodeInstallerJournal(value, dir, check, cache) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid installer journal');
    const journal = value;
    if (!Array.isArray(journal.artifacts) || !Array.isArray(journal.steps))
        throw new Error('Invalid installer journal snapshot set');
    const content = (ref) => {
        if (ref === null)
            return null;
        if (typeof ref !== 'string')
            throw new Error('Invalid installer recovery content reference');
        return readContent(dir, ref, check, cache);
    };
    const snapshot = (ref) => {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref))
            throw new Error('Invalid installer recovery snapshot');
        const stored = ref;
        return { identity: stored.identity, raw: content(stored.content) };
    };
    return {
        ...value,
        artifacts: journal.artifacts.map(artifact => {
            if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
                throw new Error('Invalid installer recovery artifact');
            return { ...artifact, before: snapshot(artifact.before), current: snapshot(artifact.current) };
        }),
        steps: journal.steps.map(step => {
            if (!step || typeof step !== 'object' || Array.isArray(step))
                throw new Error('Invalid installer recovery step');
            const { nextContent, ...rest } = step;
            return { ...rest, before: snapshot(step.before), nextRaw: content(nextContent),
                ...(step.prepared ? { prepared: snapshot(step.prepared) } : {}),
                ...(step.displaced ? { displaced: snapshot(step.displaced) } : {}),
                ...(step.published ? { published: snapshot(step.published) } : {}),
            };
        }),
    };
}