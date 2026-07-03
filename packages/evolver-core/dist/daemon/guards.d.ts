export interface SystemLoad {
    load1m: number;
    load5m: number;
    load15m: number;
}
/** Clamp os.loadavg() to at most 2× cores so a misreported sample (Windows zeros, Termux process-counters) can't force a permanent backoff. */
export declare function clampSystemLoad(loadavg: readonly [number, number, number], cpuCount: number): SystemLoad;
/** Sensible default load ceiling for N cores (reserve ~10% headroom); floors CPU count so it's never 0. */
export declare function defaultLoadMax(cpuCount: number): number;
export interface YieldDecision {
    yield: boolean;
    reason: string;
    ageMs?: number;
}
/**
 * Cooperative `.evolver.lock`: a human (release script, IDE refactor) drops the file to make the daemon yield;
 * whoever drops it removes it. A lock older than ttlMs is ignored (forgotten lock won't dormant the daemon
 * forever). A future mtime (clock skew) counts as fresh. Pure — caller supplies presence + mtime.
 */
export declare function evaluateUserLock(input: {
    present: boolean;
    mtimeMs?: number;
    now: number;
    ttlMs: number;
}): YieldDecision;
/**
 * Release-window quiet period: if the last commit is a release bump (chore(release)…), a human is mid-deploy —
 * yield until the window passes so the daemon doesn't dirty the tree under a publish. windowMs===0 disables.
 * Pure — caller supplies the last commit subject + unix ts.
 */
export declare function evaluateReleaseWindow(input: {
    lastCommitSubject?: string;
    lastCommitUnixTs?: number;
    now: number;
    windowMs: number;
}): YieldDecision;
export interface GuardInput {
    now: number;
    lock?: {
        present: boolean;
        mtimeMs?: number;
        ttlMs?: number;
    };
    release?: {
        lastCommitSubject?: string;
        lastCommitUnixTs?: number;
        windowMs?: number;
    };
    load?: {
        load1m: number;
        max?: number;
        cpuCount?: number;
    };
}
export interface GuardDecision {
    yield: boolean;
    reason: string;
    detail?: Record<string, unknown>;
}
/**
 * Combine the preflight guards in priority order — user lock → release window → system load — and return the
 * first that says yield. `clear` when none fire. The daemon supplies live readings; this stays pure.
 */
export declare function evaluateGuards(input: GuardInput): GuardDecision;
export interface DormantHypothesis extends Record<string, unknown> {
    created_at?: string;
    ttl_ms?: number;
}
/**
 * Persists the daemon's partial state before a backoff so the next cycle resumes the same hypothesis instead of
 * starting cold. TTL-bounded — a stale dormant state (older than ttlMs) is discarded on read. Atomic write.
 */
export declare class DormantHypothesisStore {
    private readonly path;
    private readonly opts;
    constructor(path: string, opts?: {
        ttlMs?: number;
        now?: () => number;
    });
    private ttl;
    private now;
    /** Save partial state before backing off. Never throws. */
    write(data: Record<string, unknown>): void;
    /** Recover partial state, or null if absent/expired/corrupt. Expired state is cleared as a side effect. */
    read(): DormantHypothesis | null;
    clear(): void;
}