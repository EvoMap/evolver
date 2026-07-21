import { events as ev } from '@evomap/evolver-core';
type Awaitable<T> = T | PromiseLike<T>;
export type EventSnapshotReader = (eventsPath: string) => Awaitable<readonly ev.ReportEvent[]>;
export interface EventSnapshotSource {
    version(): Awaitable<string>;
    read(): Awaitable<readonly ev.ReportEvent[]>;
}
export declare function fileEventSnapshotSource(eventsPath: string, readEvents?: EventSnapshotReader): EventSnapshotSource;
/** Reuses a parsed event history only when the active file and archive segments stay stable across the read. */
export declare class EventSnapshotCache {
    private readonly source;
    private cached;
    private inFlight;
    constructor(source: EventSnapshotSource);
    read(): Promise<readonly ev.ReportEvent[]>;
    private readOnce;
}
export {};