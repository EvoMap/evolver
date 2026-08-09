import { type UserInfo } from 'node:os';
import { algo, util } from '@evomap/evolver-core';
export interface LocalMemoryGraphOptions {
    dir: string;
    userId: string;
    legacyUserIds?: readonly string[];
    now?: () => number;
    maxActiveBytes?: number;
    maxTailBytes?: number;
    maxLineBytes?: number;
    maxCompactBytes?: number;
    maxCompactEdges?: number;
    archiveRetention?: number;
    /** @internal Fault-injection seam used to verify restart reconciliation. */
    onRotationPhase?: (event: MemoryGraphRotationEvent) => void;
}
export type MemoryGraphRotationPhase = 'journal_prepared' | 'compact_staged' | 'archive_staged' | 'active_staged' | 'journal_committed' | 'compact_published' | 'archive_published' | 'before_active_publish' | 'active_published' | 'before_journal_clear' | 'journal_cleared';
export interface MemoryGraphRotationEvent {
    mode: 'commit' | 'recovery';
    phase: MemoryGraphRotationPhase;
    transactionId: string;
    generation: string;
}
export declare function resolveLocalMemoryUserId(info?: Pick<UserInfo<string>, 'uid' | 'username' | 'homedir'>): string;
export declare function resolveLocalMemoryUserIdentity(graphDir: string, info?: Pick<UserInfo<string>, 'uid' | 'username' | 'homedir'>): {
    userId: string;
    legacyUserIds: string[];
};
export interface MemoryGraphMaintenanceReport {
    rotated: boolean;
    compactedRecords: number;
    corruptLines: number;
    oversizedLines: number;
    archives: number;
    recovery: 'healthy' | 'degraded' | 'recovered' | 'empty';
}
export interface MemoryGraphResetReport extends MemoryGraphMaintenanceReport {
    backupId: string | null;
    backupFiles: number;
    epochId?: string;
    lockReleaseWarning?: util.ReleaseLockReason;
}
export interface MemoryGraphHealthReport {
    recovery: MemoryGraphMaintenanceReport['recovery'];
    compactedRecords: number;
    activeRecords: number;
    corruptLines: number;
    oversizedLines: number;
    oversizedFiles: number;
    archives: number;
    busy?: boolean;
}
export interface MemoryGraphOperatorStatus extends MemoryGraphHealthReport {
    selectionReason?: string;
}
export interface MemoryGraphV1OutcomePlan {
    readonly total: number;
    readonly importable: number;
    readonly duplicates: number;
    readonly rejected: number;
    readonly deferred: number;
}
export declare class MemoryGraphImportStateRejectedError extends Error {
    constructor();
}
export declare class MemoryGraphBusyError extends Error {
    constructor();
}
export declare class LocalMemoryGraph implements algo.MemoryGraphProvider {
    private readonly dir;
    private readonly userScope;
    private readonly readableUserScopes;
    private readonly now;
    private readonly maxActiveBytes;
    private readonly maxTailBytes;
    private readonly maxLineBytes;
    private readonly maxCompactBytes;
    private readonly maxCompactEdges;
    private readonly archiveRetention;
    private readonly onRotationPhase?;
    private readonly importedFingerprints;
    private rotationCleanupFailed;
    constructor(options: LocalMemoryGraphOptions);
    query(input: algo.MemoryGraphQueryInput): algo.MemoryGraphAdvice;
    recordOutcome(input: algo.MemoryGraphRecordInput): void;
    importV1Outcome(workspace: string, raw: unknown, source?: string): boolean;
    /** Builds a stable import forecast without creating or locking the target graph. */
    planV1Outcomes(workspace: string | null | undefined, raws: readonly unknown[], source?: string): MemoryGraphV1OutcomePlan;
    /** Applies only the normalized records sealed by planV1Outcomes. */
    applyV1OutcomePlan(plan: MemoryGraphV1OutcomePlan): number;
    maintain(): MemoryGraphMaintenanceReport;
    private maintainUnlocked;
    recoverFromArchives(): MemoryGraphMaintenanceReport;
    /** Enforce archive retention without changing active or compact state. */
    prune(): MemoryGraphMaintenanceReport;
    /**
     * Copy every managed graph file into a non-active backup, then atomically
     * advance the local storage epoch.
     * The CLI requires explicit opt-in (`--yes`) before calling this method.
     */
    resetGraph(): MemoryGraphResetReport;
    private managedGraphStateFiles;
    private createResetBackupDirectory;
    private publishResetBackup;
    private cleanupResetPendingDirectory;
    private readResetSource;
    private assertManagedStateUnchanged;
    private ensureEpochStateFile;
    private currentEpochId;
    private epochBaselineFromState;
    private readEpochState;
    private writeEpochState;
    private hasResetBackup;
    private compactMatchesEpochBaseline;
    private readCompactForEpoch;
    private activeLogicalWindow;
    private activePayloadForEpoch;
    private readActiveForEpoch;
    private currentArchiveFiles;
    private recoverFromArchivesUnlocked;
    inspectHealth(): MemoryGraphHealthReport;
    private inspectHealthUnlocked;
    private withGraphLock;
    private importFingerprintCache;
    private readStableImportState;
    private persistedRecordLine;
    private importRecordFits;
    private importStateFingerprint;
    private appendRecordUnlocked;
    private rotateAndCompactUnlocked;
    private reconcileRotationUnlocked;
    private reconcileCommittedRotation;
    private completeCommittedRotationCleanup;
    private withRotationCleanupStatus;
    private assertCommittedRotationApplied;
    private assertCommittedRotationCanApply;
    private assertRotationFileReady;
    private assertOptionalRotationStage;
    private publishRotationFile;
    private publishRotationActive;
    private writeRotationJournal;
    private assertRotationJournalUnchanged;
    private readRotationJournal;
    private writeRotationStage;
    private assertRotationStagesMatch;
    private assertRotationSourceMatches;
    private rotationActiveSourceMatches;
    private rotationSourceMatches;
    private rotationTargetMatches;
    private requireRotationTarget;
    private removeRotationStage;
    private removeVerifiedRotationFile;
    private readVerifiedRotationFile;
    private rotationStageFiles;
    private rotationTempFiles;
    private removeRotationTemp;
    private notifyRotationPhase;
    private syncGraphDirectory;
    private compactRequiresRecovery;
    private readQueryableRecords;
    private readImportRecords;
    private readImportRecordsFromExistingDir;
    private readCompact;
    private readWholeBounded;
    private readTail;
    private readTailFromFd;
    private parseBuffer;
    private writeCompact;
    private writeAtomic;
    private ensureSecureDir;
    private secureRegularFile;
    private workspaceScope;
    private archiveFiles;
    private nextArchivePath;
    private pruneArchives;
    private writeRecoveryMarker;
    private inspectArchivesForEpoch;
    private recoveryMarkerState;
    private clearRecoveryMarker;
    private readRawBounded;
}
export declare function sanitizeMemoryGraphSelectionReason(value: unknown): string | undefined;
export declare function formatMemoryGraphOperatorStatus(status: MemoryGraphOperatorStatus): string;
export declare function loadMemoryGraphOperatorStatus(env?: Record<string, string | undefined>): MemoryGraphOperatorStatus;