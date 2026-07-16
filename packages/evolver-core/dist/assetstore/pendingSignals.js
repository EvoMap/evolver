import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { LocalJsonlProvider } from './localJsonl.js';
const MAX_SIGNAL_LENGTH = 200;
export function pendingSignalsPath(baseDir) {
    return join(baseDir, 'pending_signals.json');
}
function envPath(name) {
    const raw = process.env[name]?.trim();
    return raw ? raw : null;
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function nearestExistingDir(start) {
    let current = resolve(start);
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
    return isDirectory(current) ? current : dirname(current);
}
function findRepoRoot(start) {
    let current = nearestExistingDir(start);
    while (current) {
        if (existsSync(join(current, '.git')))
            return current;
        if (basename(current) === 'node_modules')
            return null;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
    return null;
}
function workspaceRootForRepo(repoRoot) {
    const workspace = join(repoRoot, 'workspace');
    return isDirectory(workspace) ? workspace : repoRoot;
}
function workspaceRootFromRepoHint(repoRoot) {
    return workspaceRootForRepo(findRepoRoot(repoRoot) ?? resolve(repoRoot));
}
function workspaceRoot(context = {}) {
    if (context.repoRoot)
        return workspaceRootFromRepoHint(context.repoRoot);
    const openclawWorkspace = envPath('OPENCLAW_WORKSPACE');
    if (openclawWorkspace)
        return resolve(openclawWorkspace);
    const explicitRepoRoot = envPath('EVOLVER_REPO_ROOT');
    if (explicitRepoRoot)
        return workspaceRootFromRepoHint(explicitRepoRoot);
    const cwd = context.cwd ?? process.cwd();
    const repoRoot = findRepoRoot(cwd);
    return repoRoot ? workspaceRootForRepo(repoRoot) : resolve(cwd);
}
function sessionScope() {
    const raw = String(process.env['EVOLVER_SESSION_SCOPE'] ?? '').trim();
    if (!raw)
        return null;
    const safe = raw.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 128);
    if (!safe || /^\.{1,2}$/.test(safe) || /\.\./.test(safe))
        return null;
    return safe;
}
function legacyV1BaseDir(context = {}, allowEnvOverride = true) {
    const override = allowEnvOverride ? envPath('GEP_ASSETS_DIR') : null;
    const baseDir = override ? resolve(override) : join(workspaceRoot(context), '.evolver', 'gep');
    const scope = sessionScope();
    return scope ? join(baseDir, 'scopes', scope) : baseDir;
}
function pendingSignalBaseDirsForStore(store, context = {}) {
    const repoScoped = Boolean(context.repoRoot);
    const baseDirs = repoScoped
        // Autoexec tasks are repo-scoped; global pending files would be drained by whichever task runs first.
        ? [{ baseDir: legacyV1BaseDir(context, false), createIfMissing: false }]
        : [
            { baseDir: store.baseDir, createIfMissing: true },
            { baseDir: legacyV1BaseDir(context), createIfMissing: false },
        ];
    const seen = new Set();
    const out = [];
    for (const candidate of baseDirs) {
        const key = resolve(candidate.baseDir);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(candidate);
    }
    return out;
}
function parsePendingSignals(raw) {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
}
function normalizeSignals(rawSignals) {
    const raw = Array.isArray(rawSignals) ? rawSignals : [];
    const signals = raw
        .map((signal) => (typeof signal === 'string' ? signal.trim() : ''))
        .filter((signal) => signal.length > 0 && signal.length <= MAX_SIGNAL_LENGTH);
    return { rawCount: raw.length, signals };
}
function writeConsumedFile(path) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ signals: [], note: '' })}\n`);
    renameSync(tmp, path);
}
function consumePendingSignalsFromBaseDir(baseDir, createIfMissing) {
    if (createIfMissing)
        mkdirSync(baseDir, { recursive: true });
    const path = pendingSignalsPath(baseDir);
    if (!existsSync(path))
        return { signals: [] };
    const lockPath = `${path}.lock`;
    acquireLock(lockPath);
    try {
        if (!existsSync(path))
            return { signals: [], path };
        const parsed = parsePendingSignals(readFileSync(path, 'utf8'));
        const { rawCount, signals } = normalizeSignals(parsed.signals);
        if (rawCount > 0)
            writeConsumedFile(path);
        return { signals, path };
    }
    finally {
        releaseLock(lockPath);
    }
}
export function consumePendingSignals(baseDir) {
    return consumePendingSignalsFromBaseDir(baseDir, true);
}
function tryConsumePendingSignals(baseDir) {
    try {
        return consumePendingSignalsFromBaseDir(baseDir.baseDir, baseDir.createIfMissing);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[PendingSignals] Failed to consume ${pendingSignalsPath(baseDir.baseDir)}: ${message}`);
        return { signals: [] };
    }
}
export function consumePendingSignalsForStore(store, context = {}) {
    if (!(store instanceof LocalJsonlProvider))
        return { signals: [] };
    const pending = { signals: [] };
    for (const baseDir of pendingSignalBaseDirsForStore(store, context)) {
        const result = tryConsumePendingSignals(baseDir);
        pending.signals.push(...result.signals);
        if (!pending.path && result.path)
            pending.path = result.path;
    }
    return pending;
}
export function mergePendingSignalsForStore(store, baseSignals, context = {}) {
    const merged = [...baseSignals];
    const pending = consumePendingSignalsForStore(store, context);
    let injected = 0;
    for (const signal of pending.signals) {
        if (!merged.includes(signal)) {
            merged.push(signal);
            injected++;
        }
    }
    return { signals: merged, injected, ...(pending.path ? { path: pending.path } : {}) };
}