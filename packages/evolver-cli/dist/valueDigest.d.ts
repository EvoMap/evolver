import { observers } from '@evomap/evolver-core';
/** Markdown file sink: appends each weekly digest to <home>/evolution/value-digest.md (inspectable history). */
export declare function fileDigestSink(path: string): observers.DigestSink;
/** Terminal MOTD sink: prints the digest to stdout (the operator sees it on the next daemon tick). */
export declare function motdDigestSink(write?: (s: string) => void): observers.DigestSink;
/** Fan a digest out to several sinks; one sink throwing does not stop the others (the bus still isolates the
 *  observer as a whole, but a single bad sink should not starve a working one). */
export declare function multiSink(sinks: readonly observers.DigestSink[]): observers.DigestSink;
/** File-backed cadence state so "weekly" survives daemon restarts (the bus is in-process; a week is not). */
export declare class FileDigestState implements observers.DigestStateStore {
    private readonly path;
    constructor(path: string);
    lastDeliveredAt(): number | undefined;
    markDelivered(at: number): void;
}
export interface ValueDigestWiring {
    /** EVOLVER_VALUE_DIGEST !== '0' (default ON). */
    enabled: boolean;
    /** The wired observer (null when disabled). */
    observer: ReturnType<typeof observers.valueDigestObserver> | null;
}
/**
 * Build the live value-digest observer from the environment, reading the SAME ledger material `evolver value`
 * reads (proxy traces + root_events) priced with the adapter's table. Returns enabled=false (no observer) when
 * EVOLVER_VALUE_DIGEST=0. The summaryProvider re-reads disk each tick so the digest reflects current state; the
 * cadence + the measured-value gate (in the core observer) keep that cheap and quiet.
 */
export declare function resolveValueDigestObserver(env?: NodeJS.ProcessEnv, opts?: {
    home?: string;
    eventsPath?: string;
    tracesDir?: string;
    motd?: boolean;
}): ValueDigestWiring;