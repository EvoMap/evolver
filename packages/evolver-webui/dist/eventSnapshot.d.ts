import { events as ev } from '@evomap/evolver-core';
export interface EventSnapshotSource {
    version(): string;
    read(): readonly ev.ReportEvent[];
}
export declare function fileEventSnapshotSource(eventsPath: string): EventSnapshotSource;
/** Reuses a parsed append-only event snapshot only when the file identity is stable across the read. */
export declare class EventSnapshotCache {
    private readonly source;
    private cached;
    constructor(source: EventSnapshotSource);
    read(): readonly ev.ReportEvent[];
}