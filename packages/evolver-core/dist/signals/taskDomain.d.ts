export declare const TASK_DOMAIN_SIGNAL_PREFIX: "task_domain:";
export type TaskDomainResolution = {
    status: 'absent';
} | {
    status: 'resolved';
    slug: string;
} | {
    status: 'ambiguous';
} | {
    status: 'invalid';
};
/** Identify the namespace even when the value is malformed, so it cannot leak into generic matching. */
export declare function isTaskDomainSignal(raw: string): boolean;
/** Remove task-domain tokens from generic matching while preserving their original wire representation elsewhere. */
export declare function withoutTaskDomainSignals(signals: readonly string[]): string[];
/**
 * Resolve one canonical task domain from signal tokens. Parsing is order-independent and fail-closed:
 * malformed tokens invalidate the whole dimension, and distinct valid slugs are ambiguous.
 */
export declare function resolveTaskDomainSignals(signals: readonly string[]): TaskDomainResolution;
/** Emit a canonical wire token. Callers must supply an already-normalized lowercase slug. */
export declare function taskDomainSignal(slug: string): string;