import { acquireBootstrapOwnerLock } from './lifecycleBootstrapTransaction.js';
/** The only task names this module ever probes; nothing outside this set is ever touched. */
export declare const LEGACY_WINDOWS_TASK_NAMES: readonly ["EvoMapEvolverProxyDaemon", "EvoMapEvolverAutoexecDaemon"];
export type LegacyWindowsTaskName = (typeof LEGACY_WINDOWS_TASK_NAMES)[number];
export declare const LEGACY_TASK_SKIP_ENV = "EVOLVER_SKIP_LEGACY_TASK_PROBE";
export declare const LEGACY_TASK_COOLDOWN_FILE = "legacy-task-cleanup.json";
export declare const LEGACY_TASK_PREIMAGE_DIR = "legacy-task-preimages";
export declare const LEGACY_TASK_PROVENANCE_FILE = "legacy-task-provenance.json";
export declare const LEGACY_TASK_PROVENANCE_PUBLIC_KEY_ENV = "EVOLVER_LEGACY_TASK_PROVENANCE_PUBLIC_KEY";
export declare const LEGACY_TASK_PROVENANCE_SCHEMA = "evolver/windows-legacy-task-provenance/v1";
export declare const LEGACY_TASK_COOLDOWN_MS: number;
declare const COOLDOWN_MARKER_SCHEMA = "evolver/legacy-task-cleanup/v1";
export type LegacyTaskCleanupStatus = 'clean' | 'legacy_detected' | 'cleaned' | 'inconclusive' | 'failed' | 'skipped';
export type LegacyTaskClassification = 'absent' | 'legacy' | 'current' | 'foreign' | 'ambiguous';
export interface LegacyTaskRunResult {
    status: number | null;
    error?: Error;
    stdout?: string;
    stderr?: string;
}
/** Spawn seam: tests inject a fake PowerShell; production uses the trusted absolute path. */
export type LegacyTaskRun = (command: string, args: readonly string[], timeoutMs: number) => LegacyTaskRunResult;
export interface LegacyTaskEntry {
    name: string;
    classification: LegacyTaskClassification;
    /** Bounded, operator-safe reason (no raw output, no absolute paths). */
    reason?: string;
    outcome?: 'removed' | 'kept' | 'removal-failed' | 'removal-aborted';
    /** State-relative preimage filename, present once removal succeeded for this task. */
    preimage?: string;
}
export interface LegacyTaskCleanupResult {
    status: LegacyTaskCleanupStatus;
    dryRun: boolean;
    tasks: LegacyTaskEntry[];
    /** Bounded detail for inconclusive/failed/skipped states. */
    detail?: string;
}
export interface LegacyTaskCleanupOptions {
    env: NodeJS.ProcessEnv;
    stateDir?: string;
    dryRun?: boolean;
    platform?: NodeJS.Platform;
    run?: LegacyTaskRun;
    now?: () => number;
    /**
     * Caller already holds the bootstrap owner lock (post-commit bootstrap sweep). When set,
     * this module asserts ownership through the seam instead of re-acquiring the lock.
     */
    assertOwner?: () => void;
    lock?: {
        maxTries?: number;
        waitMs?: number;
    };
}
export interface LegacyTaskProbeResult {
    conclusive: boolean;
    legacy: string[];
    detail: string;
}
export interface LegacyTaskProvenancePayload {
    schema: typeof LEGACY_TASK_PROVENANCE_SCHEMA;
    taskName: LegacyWindowsTaskName;
    taskPath: '\\';
    definitionHash: string;
    principalSid: string;
    issuedAt: string;
    expiresAt?: string;
    signatureAlg: 'ed25519';
}
export interface LegacyTaskProvenanceReceipt extends LegacyTaskProvenancePayload {
    signature: string;
}
interface LoadedLegacyTaskProvenance {
    receipts: ReadonlyMap<LegacyWindowsTaskName, LegacyTaskProvenanceReceipt>;
    detail?: string;
}
interface ProbedTaskRecord {
    name?: unknown;
    present?: unknown;
    ambiguous?: unknown;
    count?: unknown;
    taskPath?: unknown;
    actionCount?: unknown;
    execute?: unknown;
    arguments?: unknown;
    workingDirectory?: unknown;
    triggerCount?: unknown;
    userId?: unknown;
    principalSid?: unknown;
    logonType?: unknown;
    runLevel?: unknown;
    enabled?: unknown;
    restartCount?: unknown;
    description?: unknown;
    definitionHash?: unknown;
}
interface CooldownMarker {
    schema: typeof COOLDOWN_MARKER_SCHEMA;
    lastConclusiveAt: string;
    status: 'clean' | 'cleaned' | 'inconclusive' | 'failed';
    removed: string[];
    /** Consecutive inconclusive/failed sweep count; present only on negative markers. */
    attempts?: number;
    /** Earliest instant the next automatic sweep may retry; present only on negative markers. */
    nextRetryAt?: string;
}
declare function defaultLegacyTaskRun(): LegacyTaskRun;
export declare function canonicalLegacyTaskProvenanceBytes(payload: LegacyTaskProvenancePayload): Buffer;
declare function parseLegacyTaskProvenanceReceipt(value: unknown, publicKey: string, now: number): LegacyTaskProvenanceReceipt | undefined;
declare function loadLegacyTaskProvenance(stateDir: string, env: NodeJS.ProcessEnv, now: number): LoadedLegacyTaskProvenance;
/** True when the automatic entry points must never cross the Task Scheduler boundary. */
export declare function legacyTaskProbeSkipped(env: NodeJS.ProcessEnv): boolean;
declare function renderExportScript(name: LegacyWindowsTaskName, expectedHash?: string, receipt?: LegacyTaskProvenanceReceipt): string;
/**
 * Fingerprint revalidation → stop → revalidation → unregister → absence verification for
 * one task (the bootstrap rollback unregister pattern). Exit codes: 0 removed, 3 count
 * drift, 4 action drift, 5 execute/provenance refusal, 6 TaskPath drift, 7 stop timeout, 8
 * absence not confirmed, 9 scheduler error, 10 definition drift.
 */
declare function renderMutationScript(name: LegacyWindowsTaskName, expectedHash?: string, receipt?: LegacyTaskProvenanceReceipt): string;
/**
 * Restore refuses to overwrite: it re-registers a persisted preimage only when the known
 * name is currently absent. Exit codes: 0 restored, 3 name already present, 4 registration
 * verification failed after a guarded rollback, 5 preimage changed while restoring, 9
 * scheduler error, 11 rollback could not prove that the just-registered generation was still
 * present (the task is deliberately left for operator inspection).
 */
declare function renderRestoreScript(name: LegacyWindowsTaskName, preimageReadPath: string, expectedHash?: string): string;
declare function parseProbeRecords(stdout: string): ProbedTaskRecord[] | undefined;
export declare function classifyProbedTask(record: ProbedTaskRecord | undefined, provenance?: LegacyTaskProvenanceReceipt): {
    classification: LegacyTaskClassification;
    reason?: string;
};
declare function preimageDirFor(stateDir: string): string;
declare function cooldownMarkerPath(stateDir: string): string;
declare function readCooldownMarker(stateDir: string): CooldownMarker | undefined;
/** Negative-backoff delay for inconclusive/failed sweeps: 1h base, doubling, capped at 24h. */
declare function legacyTaskNegativeBackoffMs(attempts: number): number;
declare function writeCooldownMarker(stateDir: string, status: 'clean' | 'cleaned', removed: string[], now: () => number): void;
declare function writeNegativeCooldownMarker(stateDir: string, status: 'inconclusive' | 'failed', attempts: number, now: () => number): void;
/**
 * Manual cleanup owns the lifecycle lock before it probes.  Without this outer lock a clean
 * probe could race a concurrent bootstrap that registers a legacy-named task and then publish
 * a positive cooldown marker, suppressing the next real sweep for 24 hours.  Automatic callers
 * already hold the same lock and pass `assertOwner`, while dry-run remains read-only.
 */
export declare function cleanupLegacyWindowsDaemonTasks(options: LegacyTaskCleanupOptions): LegacyTaskCleanupResult;
/** Read-only probe for `evolver doctor` — never mutates, never throws. */
export declare function probeLegacyWindowsDaemonTasks(options: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    run?: LegacyTaskRun;
    stateDir?: string;
}): LegacyTaskProbeResult;
/**
 * Automatic entry point (SessionStart hook). Throttled by the cooldown marker: after a
 * conclusive success the sweep skips re-probing for the cooldown window; an
 * inconclusive/failed run writes a NEGATIVE backoff marker (1h base, doubling per
 * consecutive failure, capped at 24h) and the sweep skips until `nextRetryAt`, so a
 * constrained host does not spawn PowerShell on every session. A conclusive success
 * overwrites the marker, resetting the backoff counter. Never throws.
 */
export declare function maybeCleanupLegacyWindowsDaemonTasks(options: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    stateDir?: string;
    run?: LegacyTaskRun;
    now?: () => number;
    cooldownMs?: number;
    lock?: {
        maxTries?: number;
        waitMs?: number;
    };
}): LegacyTaskCleanupResult | undefined;
/**
 * Post-bootstrap sweep seam: runs under the already-held bootstrap owner lock and returns
 * report lines for the bootstrap `actions`. Never throws and never fails the bootstrap —
 * but a failed/inconclusive sweep is reported honestly instead of being dropped.
 */
export declare function sweepLegacyWindowsDaemonTasksAfterBootstrap(options: {
    env: NodeJS.ProcessEnv;
    stateDir: string;
    assertOwner: () => void;
    platform?: NodeJS.Platform;
    run?: LegacyTaskRun;
}): string[];
/**
 * Manual restore of a persisted preimage. Only files named `<KnownTaskName>.<stamp>.xml`
 * are accepted, the target name must be currently ABSENT (restore never overwrites), and
 * the XML is validated before it reaches PowerShell. Never throws.
 */
export declare function restoreLegacyTaskPreimage(preimagePath: string, options: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    run?: LegacyTaskRun;
    stateDir?: string;
    lock?: {
        maxTries?: number;
        waitMs?: number;
    };
}): {
    status: 'restored' | 'failed';
    task?: string;
    detail: string;
};
export declare const _legacyTaskInternalsForTest: {
    PROBE_SCRIPT: string;
    acquireBootstrapOwnerLock: typeof acquireBootstrapOwnerLock;
    defaultLegacyTaskRun: typeof defaultLegacyTaskRun;
    canonicalLegacyTaskProvenanceBytes: typeof canonicalLegacyTaskProvenanceBytes;
    parseLegacyTaskProvenanceReceipt: typeof parseLegacyTaskProvenanceReceipt;
    loadLegacyTaskProvenance: typeof loadLegacyTaskProvenance;
    renderExportScript: typeof renderExportScript;
    renderMutationScript: typeof renderMutationScript;
    renderRestoreScript: typeof renderRestoreScript;
    parseProbeRecords: typeof parseProbeRecords;
    readCooldownMarker: typeof readCooldownMarker;
    writeCooldownMarker: typeof writeCooldownMarker;
    writeNegativeCooldownMarker: typeof writeNegativeCooldownMarker;
    negativeBackoffMs: typeof legacyTaskNegativeBackoffMs;
    cooldownMarkerPath: typeof cooldownMarkerPath;
    preimageDirFor: typeof preimageDirFor;
    cleanupClassifiedLegacyTasksForTest: typeof cleanupClassifiedLegacyTasksForTest;
};
/** Test-only wrapper for mutation mechanics; callers must supply preclassified legacy entries. */
declare function cleanupClassifiedLegacyTasksForTest(options: LegacyTaskCleanupOptions, entries: LegacyTaskEntry[], expectedDefinitionHashes?: ReadonlyMap<string, string>, expectedProvenanceReceipts?: ReadonlyMap<string, LegacyTaskProvenanceReceipt>): LegacyTaskCleanupResult;
export {};