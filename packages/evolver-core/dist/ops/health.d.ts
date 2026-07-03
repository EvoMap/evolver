export type Severity = 'info' | 'warning' | 'critical';
export interface HealthCheck {
    name: string;
    ok: boolean;
    status: string;
    severity?: Severity;
}
export interface HealthReport {
    status: 'ok' | 'warning' | 'error';
    timestamp: string;
    checks: HealthCheck[];
}
export interface HealthThresholds {
    /** disk % used → warning (default 80) / critical (default 90). */
    diskWarnPct: number;
    diskCritPct: number;
    /** memory % used → critical (default 95). */
    memCritPct: number;
    /** process count → warning (default 2000; possible fork bomb / leak). */
    procWarn: number;
}
export interface HealthProbes {
    /** Disk % used (0-100), or -1 if unknown. Default: statfs of the cwd's root. */
    diskPctUsed?: () => number;
    /** Memory % used (0-100). Default: os.freemem/totalmem. */
    memPctUsed?: () => number;
    /** Live process count, or -1 if unavailable on this platform. Default: count of /proc/<pid> (Linux only). */
    procCount?: () => number;
    /** Clock (test seam). Default: real time. */
    now?: () => Date;
    thresholds?: Partial<HealthThresholds>;
}
/**
 * Snapshot host health for the daemon supervisor. Returns the overall status (ok | warning | error) plus a
 * per-check breakdown. Pure given its probes — inject HealthProbes to test each branch deterministically.
 */
export declare function runHealthCheck(probes?: HealthProbes): HealthReport;