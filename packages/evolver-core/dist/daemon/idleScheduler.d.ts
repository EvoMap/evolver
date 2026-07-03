interface IdleCommandResult {
    status: number | null;
    stdout?: string | Buffer | null;
}
type IdleCommandRunner = (command: string, args: readonly string[]) => IdleCommandResult;
export type Intensity = 'normal' | 'aggressive' | 'deep';
export interface IdleThresholds {
    /** Idle ≥ this (s) → aggressive. Default 300 (5min). */
    idleSeconds: number;
    /** Idle ≥ this (s) → deep. Default 1800 (30min). */
    deepIdleSeconds: number;
}
export declare const DEFAULT_IDLE_THRESHOLDS: IdleThresholds;
/** Map idle seconds → evolution intensity. Unknown idle (-1) or active → normal. Pure. */
export declare function determineIntensity(idleSeconds: number, th?: IdleThresholds): Intensity;
export interface ScheduleRecommendation {
    enabled: boolean;
    idleSeconds: number;
    /** normal / aggressive / deep — encodes the level; a consumer derives any per-intensity action from it. */
    intensity: Intensity;
    /** Poll-interval multiplier: <1 runs more often when idle, 1 = normal cadence. */
    sleepMultiplier: number;
}
/**
 * Turn an idle reading into a scheduling recommendation: aggressive idle → run twice as often; deep idle → 4×.
 * Pure given idleSeconds. enabled:false → a normal-cadence no-op. The `intensity` is the single signal a consumer
 * acts on (the previous per-action `should*` flags were never consumed anywhere, so they are not emitted —
 * re-derive any action mapping at the consumer from `intensity` if/when one exists).
 */
export declare function recommendSchedule(idleSeconds: number, opts?: {
    enabled?: boolean;
    thresholds?: IdleThresholds;
}): ScheduleRecommendation;
/** Reads the OS user-idle time in seconds; -1 when unknown. Inject a fake in tests / a better probe in the daemon. */
export type IdleProbe = () => number;
type LinuxIdleMethodName = 'xprintidle' | 'gnome-mutter' | 'loginctl';
export declare function tryLinuxXprintidle(): number;
export declare function tryLinuxGnomeMutterIdleMonitor(): number;
export declare function tryLinuxLoginctlIdleHint(): number;
export declare function getLinuxIdleSeconds(): number;
export declare function resetLinuxIdleProbeCacheForTests(): void;
export declare function setIdleCommandRunnerForTests(runner?: IdleCommandRunner): void;
export declare function getCachedLinuxIdleMethodForTests(): LinuxIdleMethodName | undefined;
/**
 * Best-effort default idle probe. linux: xprintidle → GNOME Mutter → loginctl; darwin: ioreg HIDIdleTime (ns). win32 and any
 * missing tool → -1 (→ normal cadence) rather than failing — idle detection is an optimization, not a gate.
 */
export declare function defaultIdleProbe(): number;
/** Convenience: probe idle then recommend. The probe defaults to the platform reader; inject for tests. */
export declare function getScheduleRecommendation(opts?: {
    enabled?: boolean;
    thresholds?: IdleThresholds;
    probe?: IdleProbe;
}): ScheduleRecommendation;
export {};