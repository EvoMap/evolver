import { type UserInfo } from 'node:os';
import { algo } from '@evomap/evolver-core';
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
    private readonly importedFingerprints;
    constructor(options: LocalMemoryGraphOptions);
    query(input: algo.MemoryGraphQueryInput): algo.MemoryGraphAdvice;
    recordOutcome(input: algo.MemoryGraphRecordInput): void;
    importV1Outcome(workspace: string, raw: unknown, source?: string): boolean;
    maintain(): MemoryGraphMaintenanceReport;
    private maintainUnlocked;
    recoverFromArchives(): MemoryGraphMaintenanceReport;
    private recoverFromArchivesUnlocked;
    inspectHealth(): MemoryGraphHealthReport;
    private inspectHealthUnlocked;
    private withGraphLock;
    private importStateFingerprint;
    private appendRecordUnlocked;
    private rotateAndCompactUnlocked;
    private compactRequiresRecovery;
    private readQueryableRecords;
    private readImportRecords;
    private readCompact;
    private readWholeBounded;
    private readTail;
    private readTailFromFd;
    private readRawTail;
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
    private hasRecoveryMarker;
    private clearRecoveryMarker;
    private readRawBounded;
}
export declare function sanitizeMemoryGraphSelectionReason(value: unknown): string | undefined;
export declare function formatMemoryGraphOperatorStatus(status: MemoryGraphOperatorStatus): string;
export declare function loadMemoryGraphOperatorStatus(env?: Record<string, string | undefined>): MemoryGraphOperatorStatus;