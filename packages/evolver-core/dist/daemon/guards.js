// Resident-daemon preflight guards (ported from v1 evolve/guards.js — the portable, decision-relevant core).
// Before a resident loop starts a cycle it should YIELD when: a human put a cooperative `.evolver.lock` in the
// repo, a release is in flight (last commit is a release bump), or the host is under load. And when it does
// back off, it should persist its partial state (the "dormant hypothesis") so the next cycle resumes instead
// of starting cold. Pairs with ops/health (resource snapshot) — health observes, these decide.
//
// All decision logic is PURE: the caller performs the fs/git/os reads and passes the values in, so every
// branch is deterministically testable. The dormant-state store takes an injected path + clock.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const MIN_ASSUMED_CPU_COUNT = 4; // os.cpus() can return [] (Android/Termux) — floor so load max never collapses to 0
const MIN_LOCK_TTL_MS = 1000; // catches the parseInt('5m')===5 quirk → a 5ms TTL would insta-stale every lock
const MIN_RELEASE_WINDOW_MS = 1000;
/** Clamp os.loadavg() to at most 2× cores so a misreported sample (Windows zeros, Termux process-counters) can't force a permanent backoff. */
export function clampSystemLoad(loadavg, cpuCount) {
    const cap = Math.max(1, cpuCount) * 2;
    return {
        load1m: Math.min(loadavg[0] || 0, cap),
        load5m: Math.min(loadavg[1] || 0, cap),
        load15m: Math.min(loadavg[2] || 0, cap),
    };
}
/** Sensible default load ceiling for N cores (reserve ~10% headroom); floors CPU count so it's never 0. */
export function defaultLoadMax(cpuCount) {
    const cpu = cpuCount > 0 ? cpuCount : MIN_ASSUMED_CPU_COUNT;
    return cpu <= 1 ? 0.9 : cpu * 0.9;
}
/**
 * Cooperative `.evolver.lock`: a human (release script, IDE refactor) drops the file to make the daemon yield;
 * whoever drops it removes it. A lock older than ttlMs is ignored (forgotten lock won't dormant the daemon
 * forever). A future mtime (clock skew) counts as fresh. Pure — caller supplies presence + mtime.
 */
export function evaluateUserLock(input) {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < MIN_LOCK_TTL_MS)
        return { yield: false, reason: 'invalid_ttl' };
    if (!input.present)
        return { yield: false, reason: 'no_lock' };
    if (input.mtimeMs === undefined || !Number.isFinite(input.mtimeMs))
        return { yield: false, reason: 'stat_failed' };
    const ageMs = input.now - input.mtimeMs;
    if (ageMs < 0)
        return { yield: true, reason: 'lock_active_future_mtime', ageMs };
    if (ageMs <= input.ttlMs)
        return { yield: true, reason: 'lock_active', ageMs };
    return { yield: false, reason: 'lock_stale', ageMs };
}
/**
 * Release-window quiet period: if the last commit is a release bump (chore(release)…), a human is mid-deploy —
 * yield until the window passes so the daemon doesn't dirty the tree under a publish. windowMs===0 disables.
 * Pure — caller supplies the last commit subject + unix ts.
 */
export function evaluateReleaseWindow(input) {
    if (input.windowMs === 0)
        return { yield: false, reason: 'disabled' };
    if (!Number.isFinite(input.windowMs) || input.windowMs < MIN_RELEASE_WINDOW_MS)
        return { yield: false, reason: 'invalid_window' };
    if (!Number.isFinite(input.lastCommitUnixTs))
        return { yield: false, reason: 'no_commit' };
    if (!/^chore\(release\)/i.test(String(input.lastCommitSubject ?? '')))
        return { yield: false, reason: 'not_release_commit' };
    const ageMs = input.now - input.lastCommitUnixTs * 1000;
    if (ageMs < 0)
        return { yield: true, reason: 'release_window_future_commit', ageMs };
    if (ageMs <= input.windowMs)
        return { yield: true, reason: 'release_window_active', ageMs };
    return { yield: false, reason: 'window_passed', ageMs };
}
/**
 * Combine the preflight guards in priority order — user lock → release window → system load — and return the
 * first that says yield. `clear` when none fire. The daemon supplies live readings; this stays pure.
 */
export function evaluateGuards(input) {
    if (input.lock) {
        const r = evaluateUserLock({ present: input.lock.present, mtimeMs: input.lock.mtimeMs, now: input.now, ttlMs: input.lock.ttlMs ?? 3_600_000 });
        if (r.yield)
            return { yield: true, reason: 'user_lock', detail: { lockReason: r.reason, ageMs: r.ageMs } };
    }
    if (input.release) {
        const r = evaluateReleaseWindow({ lastCommitSubject: input.release.lastCommitSubject, lastCommitUnixTs: input.release.lastCommitUnixTs, now: input.now, windowMs: input.release.windowMs ?? 300_000 });
        if (r.yield)
            return { yield: true, reason: 'release_window', detail: { windowReason: r.reason, ageMs: r.ageMs } };
    }
    if (input.load) {
        const max = input.load.max ?? defaultLoadMax(input.load.cpuCount ?? MIN_ASSUMED_CPU_COUNT);
        if (input.load.load1m > max)
            return { yield: true, reason: 'system_load', detail: { load1m: input.load.load1m, max } };
    }
    return { yield: false, reason: 'clear' };
}
/**
 * Persists the daemon's partial state before a backoff so the next cycle resumes the same hypothesis instead of
 * starting cold. TTL-bounded — a stale dormant state (older than ttlMs) is discarded on read. Atomic write.
 */
export class DormantHypothesisStore {
    path;
    opts;
    constructor(path, opts = {}) {
        this.path = path;
        this.opts = opts;
    }
    ttl() { return this.opts.ttlMs ?? 3_600_000; }
    now() { return (this.opts.now ?? (() => Date.now()))(); }
    /** Save partial state before backing off. Never throws. */
    write(data) {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const obj = { ...data, created_at: new Date(this.now()).toISOString(), ttl_ms: this.ttl() };
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
            renameSync(tmp, this.path);
        }
        catch { /* non-fatal */ }
    }
    /** Recover partial state, or null if absent/expired/corrupt. Expired state is cleared as a side effect. */
    read() {
        try {
            if (!existsSync(this.path))
                return null;
            const raw = readFileSync(this.path, 'utf8').trim();
            if (!raw)
                return null;
            const obj = JSON.parse(raw);
            const createdAt = obj.created_at ? new Date(obj.created_at).getTime() : 0;
            const ttl = Number.isFinite(Number(obj.ttl_ms)) ? Number(obj.ttl_ms) : this.ttl();
            if (this.now() - createdAt > ttl) {
                this.clear();
                return null;
            }
            return obj;
        }
        catch {
            return null;
        }
    }
    clear() {
        try {
            if (existsSync(this.path))
                unlinkSync(this.path);
        }
        catch { /* non-fatal */ }
    }
}