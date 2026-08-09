import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { events as ev } from '@evomap/evolver-core';
const ARCHIVE_SEGMENT_PATTERN = /^root-events-\d{16}-\d{16}\.jsonl$/;
const MAX_VERSIONED_READ_ATTEMPTS = 2;
const EVENT_SNAPSHOT_WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';

try {
  const core = await import(workerData.coreModuleUrl);
  const events = core.events.readEvents(workerData.eventsPath);
  parentPort.postMessage({ ok: true, events });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    },
  });
}
`;
const EVENT_SNAPSHOT_WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(EVENT_SNAPSHOT_WORKER_SOURCE)}`);
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
function statFingerprint(value) {
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}
async function pathFingerprint(path) {
    try {
        return statFingerprint(await stat(path, { bigint: true }));
    }
    catch (error) {
        if (isMissing(error))
            return 'missing';
        throw error;
    }
}
async function archiveFingerprint(eventsPath) {
    const archiveDir = ev.rootEventArchiveDir(eventsPath);
    let entries;
    try {
        entries = (await readdir(archiveDir)).filter((entry) => ARCHIVE_SEGMENT_PATTERN.test(entry)).sort();
    }
    catch (error) {
        if (isMissing(error))
            return 'missing';
        throw error;
    }
    const fingerprints = [];
    for (const entry of entries) {
        fingerprints.push(`${entry}:${await pathFingerprint(join(archiveDir, entry))}`);
    }
    return `${await pathFingerprint(archiveDir)}:[${fingerprints.join(',')}]`;
}
async function fileSnapshotVersion(eventsPath) {
    const [active, archive] = await Promise.all([
        pathFingerprint(eventsPath),
        archiveFingerprint(eventsPath),
    ]);
    return `active=${active};archive=${archive}`;
}
function workerFailure(error) {
    const restored = new Error(error.message);
    restored.name = error.name;
    if (error.code !== undefined)
        Object.assign(restored, { code: error.code });
    return restored;
}
function readEventsInWorker(eventsPath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(EVENT_SNAPSHOT_WORKER_URL, {
            workerData: {
                eventsPath,
                coreModuleUrl: new URL('../../evolver-core/dist/index.js', import.meta.url).href,
            },
        });
        let settled = false;
        const settle = (action) => {
            if (settled)
                return;
            settled = true;
            action();
        };
        worker.once('message', (response) => {
            settle(() => {
                if (response.ok)
                    resolve(response.events);
                else
                    reject(workerFailure(response.error));
            });
        });
        worker.once('error', (error) => settle(() => reject(error)));
        worker.once('exit', (code) => {
            settle(() => reject(new Error(code === 0
                ? 'event snapshot worker exited without a response'
                : `event snapshot worker exited with code ${code}`)));
        });
    });
}
export function fileEventSnapshotSource(eventsPath, readEvents = readEventsInWorker) {
    return {
        version: () => fileSnapshotVersion(eventsPath),
        read: () => readEvents(eventsPath),
    };
}
/** Reuses a parsed event history only when the active file and archive segments stay stable across the read. */
export class EventSnapshotCache {
    source;
    cached;
    inFlight;
    constructor(source) {
        this.source = source;
    }
    read() {
        if (this.inFlight !== undefined)
            return this.inFlight;
        const pending = this.readOnce().finally(() => {
            if (this.inFlight === pending)
                this.inFlight = undefined;
        });
        this.inFlight = pending;
        return pending;
    }
    async readOnce() {
        let before;
        try {
            before = await this.source.version();
        }
        catch {
            return await this.source.read();
        }
        return await this.readVersioned(before, MAX_VERSIONED_READ_ATTEMPTS);
    }
    async readVersioned(before, attemptsRemaining) {
        if (this.cached?.version === before)
            return this.cached.events;
        const events = await this.source.read();
        let after;
        try {
            after = await this.source.version();
        }
        catch {
            return events;
        }
        if (before === after) {
            this.cached = { version: after, events };
            return events;
        }
        if (attemptsRemaining === 1)
            return events;
        return await this.readVersioned(after, attemptsRemaining - 1);
    }
}