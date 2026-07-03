import type { CycleRecord } from './metaSignals.js';
/** Minimal event shape this adapter consumes (a structural subset of RootEvent). */
export interface CycleLogEvent {
    type: string;
    payload?: unknown;
}
/**
 * Fold a window of root_events into per-cycle records (insertion order = chronological), suitable for
 * {@link deriveCycleHistory}. Newest-last, matching deriveCycleHistory's window expectation.
 */
export declare function cycleRecordsFromEvents(events: readonly CycleLogEvent[]): CycleRecord[];