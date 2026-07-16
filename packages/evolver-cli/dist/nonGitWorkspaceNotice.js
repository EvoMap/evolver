import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { events } from '@evomap/evolver-core';
export const NON_GIT_WORKSPACE_NOTICE_THROTTLE_MS = 24 * 60 * 60 * 1000;
const NON_GIT_WORKSPACE_NOTICE = '[evolver] This workspace is not a git repository; Evolver will still run, but recording, recall, and rollback context may be limited. Run from a project root or initialize git for full context.\n';
const GIT_DETECT_TIMEOUT_MS = 500;
function nonGitWorkspaceNoticeStatePath() {
    return join(events.evomapHome(), 'evolution', 'non-git-workspace-notice.json');
}
function hasGitMarkerAncestor(cwd) {
    let cur = resolve(cwd);
    const root = parse(cur).root;
    for (;;) {
        if (existsSync(join(cur, '.git')))
            return true;
        if (cur === root)
            return false;
        cur = dirname(cur);
    }
}
export function detectGitWorkspace(cwd = process.cwd(), gitProbe = execFileSync) {
    try {
        const out = gitProbe('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: GIT_DETECT_TIMEOUT_MS,
            windowsHide: true,
        }).trim();
        if (out === 'true')
            return 'git';
        if (out === 'false')
            return 'unknown';
        return 'unknown';
    }
    catch (error) {
        const err = error;
        const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : typeof err.stderr === 'string' ? err.stderr : '';
        const msg = `${stderr} ${typeof err.message === 'string' ? err.message : ''}`;
        if (err.status === 128) {
            if (hasGitMarkerAncestor(cwd))
                return 'unknown';
            if (/not a git repository|not a git repo/i.test(msg))
                return 'non_git';
            return 'non_git';
        }
        return 'unknown';
    }
}
function workspaceHash(cwd) {
    const normalized = resolve(cwd);
    return createHash('sha256').update(normalized).digest('hex');
}
function readState(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return { version: 1, workspaces: {} };
        const workspaces = parsed.workspaces;
        if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces))
            return { version: 1, workspaces: {} };
        const out = {};
        for (const [key, value] of Object.entries(workspaces)) {
            if (!/^[a-f0-9]{64}$/.test(key))
                continue;
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            const lastNotifiedAt = value.lastNotifiedAt;
            if (typeof lastNotifiedAt === 'string')
                out[key] = { lastNotifiedAt };
        }
        return { version: 1, workspaces: out };
    }
    catch {
        return { version: 1, workspaces: {} };
    }
}
function writeStateBestEffort(path, state) {
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
    }
    catch {
        // The notice is operator UX only; state persistence must never break hooks.
    }
}
function isThrottled(lastNotifiedAt, now, throttleMs) {
    if (!lastNotifiedAt)
        return false;
    const previous = Date.parse(lastNotifiedAt);
    if (!Number.isFinite(previous))
        return false;
    return now - previous < throttleMs;
}
export function maybeEmitNonGitWorkspaceNotice(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const detect = options.detect ?? detectGitWorkspace;
    const status = detect(cwd);
    if (status !== 'non_git')
        return { status, emitted: false };
    const now = options.now ? options.now() : Date.now();
    const throttleMs = options.throttleMs ?? NON_GIT_WORKSPACE_NOTICE_THROTTLE_MS;
    const statePath = options.statePath ?? nonGitWorkspaceNoticeStatePath();
    const hash = workspaceHash(cwd);
    const state = readState(statePath);
    if (isThrottled(state.workspaces[hash]?.lastNotifiedAt, now, throttleMs)) {
        return { status, emitted: false, workspaceHash: hash };
    }
    const write = options.write ?? ((line) => process.stderr.write(line));
    try {
        write(NON_GIT_WORKSPACE_NOTICE);
    }
    catch {
        return { status, emitted: false, workspaceHash: hash };
    }
    state.workspaces[hash] = { lastNotifiedAt: new Date(now).toISOString() };
    writeStateBestEffort(statePath, state);
    return { status, emitted: true, workspaceHash: hash };
}