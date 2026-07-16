import { statSync } from 'node:fs';
import { events as ev } from '@evomap/evolver-core';
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
export function fileEventSnapshotSource(eventsPath) {
    return {
        version: () => {
            try {
                const stat = statSync(eventsPath, { bigint: true });
                return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
            }
            catch (error) {
                if (isMissing(error))
                    return 'missing';
                throw error;
            }
        },
        read: () => ev.readEvents(eventsPath),
    };
}
/** Reuses a parsed append-only event snapshot only when the file identity is stable across the read. */
export class EventSnapshotCache {
    source;
    cached;
    constructor(source) {
        this.source = source;
    }
    read() {
        let before;
        try {
            before = this.source.version();
        }
        catch {
            return this.source.read();
        }
        if (this.cached?.version === before)
            return this.cached.events;
        const events = this.source.read();
        let after;
        try {
            after = this.source.version();
        }
        catch {
            return events;
        }
        if (before === after)
            this.cached = { version: after, events };
        return events;
    }
}