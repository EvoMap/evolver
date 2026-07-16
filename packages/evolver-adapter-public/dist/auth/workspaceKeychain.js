import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
export const WORKSPACE_KEYCHAIN_SERVICE = 'evomap.evolver.workspace-id';
const WORKSPACE_ID_RE = /^[a-f0-9]{32,}$/i;
const require = createRequire(import.meta.url);
let cachedAddon;
export function resetWorkspaceKeychainAddonCacheForTests() {
    cachedAddon = undefined;
}
export function getWorkspaceKeychainMode(env = process.env) {
    const raw = String(env['EVOLVER_WORKSPACE_KEYCHAIN'] ?? 'auto').trim().toLowerCase();
    return raw === 'force' || raw === 'off' || raw === 'auto' ? raw : 'auto';
}
export function loadWorkspaceKeychainAddon() {
    if (cachedAddon !== undefined)
        return cachedAddon;
    try {
        const mod = require('@napi-rs/keyring');
        cachedAddon = typeof mod.Entry === 'function' ? mod : null;
    }
    catch {
        cachedAddon = null;
    }
    return cachedAddon;
}
const NO_ENTRY_PATTERNS = [
    /no\s+matching\s+entry/i,
    /could\s+not\s+be\s+found/i,
    /element\s+not\s+found/i,
    /\bnoentry\b/i,
    /\bno\s*entry\b/i,
    /not\s+found\s+in\s+(?:secure|keychain)/i,
];
export function isWorkspaceKeychainNoEntryError(err) {
    const message = err instanceof Error ? err.message : '';
    return NO_ENTRY_PATTERNS.some((pattern) => pattern.test(message));
}
export function readFromWorkspaceKeychain(account, addon = loadWorkspaceKeychainAddon()) {
    if (!addon)
        return { available: false, id: null };
    try {
        const entry = new addon.Entry(WORKSPACE_KEYCHAIN_SERVICE, account);
        const raw = entry.getPassword();
        const id = typeof raw === 'string' ? raw.trim() : '';
        return WORKSPACE_ID_RE.test(id) ? { available: true, id } : { available: true, id: null };
    }
    catch (err) {
        return isWorkspaceKeychainNoEntryError(err)
            ? { available: true, id: null }
            : { available: false, id: null };
    }
}
export function writeToWorkspaceKeychain(account, id, addon = loadWorkspaceKeychainAddon()) {
    if (!addon || !WORKSPACE_ID_RE.test(id))
        return false;
    try {
        const entry = new addon.Entry(WORKSPACE_KEYCHAIN_SERVICE, account);
        entry.setPassword(id);
        return true;
    }
    catch {
        return false;
    }
}
export const defaultWorkspaceKeychain = {
    loadAddon: loadWorkspaceKeychainAddon,
    readFromKeychain: (account) => readFromWorkspaceKeychain(account),
    writeToKeychain: (account, id) => writeToWorkspaceKeychain(account, id),
    getMode: getWorkspaceKeychainMode,
};
export function workspaceIdPath(workspaceRoot) {
    return join(workspaceRoot, '.evolver', 'workspace-id');
}
export function resolveWorkspaceRootForIdentity(opts = {}) {
    const env = opts.env ?? process.env;
    const explicit = env['EVOLVER_REPO_ROOT']?.trim();
    if (explicit)
        return workspaceRootForRepo(resolve(explicit));
    const cwd = resolve(opts.cwd ?? process.cwd());
    const repoRoot = findNearestGitRoot(cwd);
    return workspaceRootForRepo(repoRoot ?? cwd);
}
export function resolveWorkspaceId(opts = {}) {
    const env = opts.env ?? process.env;
    const override = env['EVOLVER_WORKSPACE_ID']?.trim();
    if (override)
        return override;
    const workspaceRoot = resolve(opts.workspaceRoot ?? resolveWorkspaceRootForIdentity({ env, cwd: opts.cwd }));
    const file = workspaceIdPath(workspaceRoot);
    const keychain = opts.keychain ?? defaultWorkspaceKeychain;
    const mode = keychain.getMode(env);
    if (mode !== 'off') {
        const addonAvailable = keychain.loadAddon() !== null;
        if (mode === 'force' && !addonAvailable) {
            throw new Error('EVOLVER_WORKSPACE_KEYCHAIN=force but @napi-rs/keyring is not installed or unavailable.');
        }
        if (addonAvailable) {
            const hit = keychain.readFromKeychain(workspaceRoot);
            if (hit.available && hit.id)
                return hit.id;
            if (!hit.available && mode !== 'force') {
                return readWorkspaceIdFromFs(file);
            }
            if (mode === 'force') {
                if (!hit.available) {
                    throw new Error('EVOLVER_WORKSPACE_KEYCHAIN=force: keychain reports unavailable; refusing filesystem fallback.');
                }
                const fresh = randomWorkspaceId();
                if (!keychain.writeToKeychain(workspaceRoot, fresh)) {
                    throw new Error('EVOLVER_WORKSPACE_KEYCHAIN=force: keychain write failed; refusing filesystem fallback.');
                }
                return fresh;
            }
            const fsId = readWorkspaceIdFromFs(file);
            if (fsId) {
                keychain.writeToKeychain(workspaceRoot, fsId);
                return fsId;
            }
            const fresh = writeWorkspaceIdToFs(file);
            if (!fresh)
                return null;
            keychain.writeToKeychain(workspaceRoot, fresh);
            return fresh;
        }
    }
    const existing = readWorkspaceIdFromFs(file);
    if (existing)
        return existing;
    return writeWorkspaceIdToFs(file);
}
export function readWorkspaceIdFromFs(file) {
    return readWorkspaceIdFile(file).id;
}
function readWorkspaceIdFile(file) {
    try {
        const dirStat = safeLstat(dirname(file));
        if (dirStat?.isSymbolicLink())
            return { id: null, repairableInvalid: false };
        const fileStat = safeLstat(file);
        if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile())
            return { id: null, repairableInvalid: false };
        const raw = readFileSync(file, 'utf8').trim();
        if (WORKSPACE_ID_RE.test(raw))
            return { id: raw, repairableInvalid: false };
        return { id: null, repairableInvalid: raw.length >= 32 };
    }
    catch {
        return { id: null, repairableInvalid: false };
    }
}
export function writeWorkspaceIdToFs(file, id = randomWorkspaceId()) {
    if (!WORKSPACE_ID_RE.test(id))
        return null;
    try {
        const dir = dirname(file);
        const dirStat = safeLstat(dir);
        if (dirStat?.isSymbolicLink())
            return null;
        mkdirSync(dir, { recursive: true });
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
        let fd;
        try {
            fd = openSync(file, flags, 0o600);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                return null;
            const existing = readWorkspaceIdFile(file);
            if (existing.id)
                return existing.id;
            return existing.repairableInvalid ? repairInvalidWorkspaceIdFile(file, id) : null;
        }
        try {
            writeSync(fd, `${id}\n`, 0, 'utf8');
        }
        finally {
            closeSync(fd);
        }
        try {
            chmodSync(file, 0o600);
        }
        catch { /* best-effort on Windows */ }
        return id;
    }
    catch {
        return null;
    }
}
function repairInvalidWorkspaceIdFile(file, id) {
    try {
        const dirStat = safeLstat(dirname(file));
        if (dirStat?.isSymbolicLink())
            return null;
        const fileStat = safeLstat(file);
        if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile())
            return null;
        const fd = openWorkspaceIdForRepair(file);
        try {
            writeSync(fd, `${id}\n`, 0, 'utf8');
        }
        finally {
            closeSync(fd);
        }
        try {
            chmodSync(file, 0o600);
        }
        catch { /* best-effort on Windows */ }
        return id;
    }
    catch {
        return null;
    }
}
function openWorkspaceIdForRepair(file) {
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow === 'number') {
        return openSync(file, constants.O_WRONLY | constants.O_TRUNC | noFollow);
    }
    return openSync(file, 'w', 0o600);
}
function randomWorkspaceId() {
    return randomBytes(16).toString('hex');
}
function safeLstat(path) {
    try {
        return lstatSync(path);
    }
    catch {
        return null;
    }
}
function findNearestGitRoot(start) {
    let dir = resolve(start);
    for (;;) {
        if (safeLstat(join(dir, '.git')))
            return dir;
        if (basename(dir) === 'node_modules')
            return null;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
function workspaceRootForRepo(repoRoot) {
    const workspace = join(repoRoot, 'workspace');
    const st = safeLstat(workspace);
    return st?.isDirectory() ? workspace : repoRoot;
}