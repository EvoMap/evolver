export interface AggregateLimits {
    memoryBytes: number;
    processes: number;
}
/** 'monitor' means the tree could not be sampled; an unmeasured budget is treated as exceeded. */
export type AggregateLimitExceeded = 'memory' | 'processes' | 'monitor';
export interface ProcessGroupWatchdog {
    /** Kill every process currently attributed to the tree. Synchronous so timeout/abort paths can rely on it. */
    terminate(): void;
    /** Stop polling, sweep what the workload left behind, and resolve once every killed process is really gone. */
    stop(): Promise<void>;
}
/** How the watchdog recognises this run's processes once they left its process group. */
export interface RunIdentity {
    /** `NAME=value` set in the workload's environment. */
    marker: string;
    /** Real paths of the run's own disposable directories; a process working inside one belongs to the run. */
    roots: readonly string[];
}
/**
 * macOS has no unprivileged cgroup, so the aggregate budget is enforced by polling: total RSS and process count of
 * the tree are sampled every POLL_INTERVAL_MS and the whole tree is killed once either exceeds its limit. Unlike a
 * cgroup this is not kernel-enforced: a burst between samples can overshoot, and pages the kernel compressed or
 * swapped out are not counted in RSS.
 */
export declare function watchProcessGroup(rootPid: number, limits: AggregateLimits, onExceeded: (reason: AggregateLimitExceeded) => void, run: RunIdentity): ProcessGroupWatchdog;