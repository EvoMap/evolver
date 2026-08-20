import { bootstrap as coreBootstrap, util } from '@evomap/evolver-core';
import type { ServiceTarget } from './lifecycle.js';
export declare const BOOTSTRAP_JOURNAL_FILE = "bootstrap-transaction.json";
export declare const BOOTSTRAP_LOCK_FILE = "bootstrap-owner.lock";
export declare const BOOTSTRAP_SUCCESS_FILE = "bootstrap.json";
declare const BOOTSTRAP_JOURNAL_SCHEMA = "evolver.lifecycle-bootstrap-transaction.v1";
export declare const LEGACY_BOOTSTRAP_REMOVAL_OPERATION = "legacy-v907-remove";
declare const LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING = "legacy-v907-absent";
type BootstrapJournalStage = 'prepared' | 'installing' | 'installed' | 'activating' | 'activated' | 'committing' | 'committed' | 'rollback_pending' | 'rolled_back';
export interface BootstrapArtifactIdentity {
    size: number;
    sha256: string;
    device?: string;
    inode?: string;
}
type BootstrapArtifactClaimOwnership = {
    phase: 'armed';
} | {
    phase: 'created';
    device: string;
    inode: string;
};
export interface BootstrapJournalArtifact {
    path: string;
    claimPath: string;
    rollbackPath: string;
    before: 'absent' | 'legacy_owned';
    identity?: BootstrapArtifactIdentity;
    claimOwnership?: BootstrapArtifactClaimOwnership;
}
type BootstrapPreservedArtifact = coreBootstrap.LifecycleBootstrapMarker['artifacts'][number];
type BootstrapTransactionManagerBinding = {
    artifactPath: string;
    kind?: coreBootstrap.LifecycleBootstrapManagerBindingKind;
} | {
    kind: typeof LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING;
    state: 'absent';
};
export type BootstrapCanonicalStateKind = 'marker' | 'readiness';
export interface BootstrapCanonicalQuarantine {
    kind: BootstrapCanonicalStateKind;
    sourcePath: string;
    quarantinePath: string;
    identity: BootstrapArtifactIdentity & {
        device: string;
        inode: string;
    };
}
export interface BootstrapTransactionJournal {
    schema: typeof BOOTSTRAP_JOURNAL_SCHEMA;
    transactionId: string;
    owner: util.FileLockOwnerRecord & {
        acquiredAt: string;
    };
    target: ServiceTarget;
    service: string;
    managerBefore: 'absent' | 'present' | 'disabled';
    managerBinding: BootstrapTransactionManagerBinding;
    operation?: typeof LEGACY_BOOTSTRAP_REMOVAL_OPERATION;
    stage: BootstrapJournalStage;
    deadlineMs: number;
    artifacts: BootstrapJournalArtifact[];
    preservedArtifacts?: BootstrapPreservedArtifact[];
    successMarkerIdentity?: Pick<BootstrapArtifactIdentity, 'size' | 'sha256'>;
    canonicalQuarantine?: BootstrapCanonicalQuarantine[];
    managerDetached?: boolean;
    artifactsRestored?: boolean;
    activationStarted?: boolean;
    terminalAction?: 'remove_committed';
    lastError?: string;
    updatedAt: string;
}
export interface BootstrapOwnerLock {
    path: string;
    owner: util.FileLockOwnerRecord;
    assertOwned(): void;
    release(): void;
}
interface WindowsAclCheck {
    path: string;
    parentOnly: boolean;
    ownerCurrentOnly?: boolean;
}
/** Test-only ACL dependency seam. Production callers never configure this override. */
export declare function _setBootstrapWindowsAclTrustForTest(assertion: ((checks: readonly WindowsAclCheck[]) => void) | undefined): void;
interface BoundedRegularTextReadOptions {
    platform?: NodeJS.Platform;
    assertWindowsAcl?: (path: string) => void;
    afterAclCheck?: () => void;
    afterRead?: () => void;
    requireOwnerOnly?: boolean;
}
export declare function _readBoundedRegularTextForTest(path: string, maxBytes: number, label: string, options: BoundedRegularTextReadOptions): string;
export declare function writeDurableText(path: string, content: string, mode?: number): void;
export interface BootstrapArtifactPublication {
    claimPath: string;
    /** Invoked once after the fully staged claim is durably bound, then again after final publication. */
    onPublished(path: string, claimPath: string): void;
}
export declare function writeDurableTextExclusive(path: string, content: string, mode?: number, publication?: BootstrapArtifactPublication): void;
export declare function writeDurableBytesExclusive(path: string, content: Uint8Array, mode?: number, publication?: BootstrapArtifactPublication): void;
export declare function writeDurableJsonExclusive(path: string, value: unknown, mode?: number): void;
export declare function removeDurableFile(path: string): void;
export declare function acquireBootstrapOwnerLock(stateDir: string, options?: {
    maxTries?: number;
    waitMs?: number;
}): BootstrapOwnerLock;
export declare function acquireBootstrapReadinessLock(stateDir: string, options?: {
    maxTries?: number;
    waitMs?: number;
}): BootstrapOwnerLock;
export declare function createBootstrapJournal(input: {
    owner: util.FileLockOwnerRecord;
    transactionId?: string;
    target: ServiceTarget;
    service: string;
    deadlineMs: number;
    artifactPaths: readonly string[];
    artifactIdentities: Readonly<Record<string, BootstrapArtifactIdentity>>;
    managerArtifactPath: string;
    now?: number;
}): BootstrapTransactionJournal;
export declare function bootstrapJournalFromMarker(marker: coreBootstrap.LifecycleBootstrapMarker, owner: util.FileLockOwnerRecord, deadlineMs: number, now?: number): BootstrapTransactionJournal;
export declare function bootstrapJournalManagerArtifactPath(journal: Pick<BootstrapTransactionJournal, 'managerBinding'>): string;
export declare function createLegacyBootstrapRemovalJournal(input: {
    owner: util.FileLockOwnerRecord;
    target: ServiceTarget;
    service: string;
    deadlineMs: number;
    managerState: 'absent' | 'present' | 'disabled';
    managerArtifactPath?: string;
    artifacts: coreBootstrap.LifecycleBootstrapMarker['artifacts'];
    preservedArtifacts?: coreBootstrap.LifecycleBootstrapMarker['artifacts'];
    now?: number;
}): BootstrapTransactionJournal;
export declare function bootstrapArtifactClaimPath(path: string, transactionId: string): string;
export declare function bootstrapArtifactRollbackPath(path: string, transactionId: string): string;
export declare function updateBootstrapJournal(journal: BootstrapTransactionJournal, patch: Partial<Omit<BootstrapTransactionJournal, 'schema' | 'transactionId' | 'owner' | 'target' | 'service' | 'managerBefore' | 'managerBinding' | 'artifacts' | 'canonicalQuarantine'>>, now?: number): BootstrapTransactionJournal;
export declare function bootstrapJournalPath(stateDir: string): string;
export declare function bootstrapMarkerPath(stateDir: string): string;
export declare function bootstrapReadinessPath(stateDir: string): string;
export declare function bootstrapManualTransitionPath(stateDir: string): string;
/**
 * Validate the parent's active registration token while the caller owns bootstrap-owner.lock.
 * Absence, a terminal receipt, or any malformed/untrusted presentation blocks before mutation.
 */
export declare function assertActiveBootstrapRegistrationIntentToken(stateDir: string, tokenValue: unknown): coreBootstrap.LifecycleBootstrapRegistrationIntent;
export declare function readBootstrapManualTransition(stateDir: string): coreBootstrap.LifecycleBootstrapManualTransition | undefined;
/**
 * Persist the operator's remove -> explicit install handoff before any committed
 * manager or artifact mutation. A matching tombstone is an idempotent retry.
 */
export declare function ensureBootstrapManualTransition(stateDir: string, source: {
    transactionId: string;
    target: ServiceTarget;
    service: string;
}, now?: number): coreBootstrap.LifecycleBootstrapManualTransition;
export declare function removeBootstrapManualTransition(stateDir: string, transitionId: string): void;
export declare function writeBootstrapJournal(stateDir: string, journal: BootstrapTransactionJournal): void;
export declare function removeBootstrapJournal(stateDir: string): void;
export declare function parseBootstrapJournal(value: unknown): BootstrapTransactionJournal | undefined;
export declare function readBootstrapJournal(stateDir: string): BootstrapTransactionJournal | undefined;
export declare function readBootstrapMarker(stateDir: string): coreBootstrap.LifecycleBootstrapMarker | undefined;
export interface LegacyBootstrapMarkerRead {
    marker: coreBootstrap.LegacyLifecycleBootstrapMarker;
    raw: string;
    identity: BootstrapArtifactIdentity & {
        device: string;
        inode: string;
    };
}
export declare function readLegacyBootstrapMarker(stateDir: string): LegacyBootstrapMarkerRead | undefined;
export interface LegacyBootstrapAdoptionHooks {
    assertOwner?: () => void;
    beforeQuarantine?: (journal: BootstrapTransactionJournal) => void;
    afterQuarantine?: () => void;
    beforePublish?: (journal: BootstrapTransactionJournal) => void | Promise<void>;
    afterPublish?: () => void;
    beforeFinalize?: () => void;
}
/** Adopt an exact legacy marker through the durable canonical-state transaction. */
export declare function adoptLegacyBootstrapMarker(stateDir: string, expectedLegacy: LegacyBootstrapMarkerRead, marker: coreBootstrap.LifecycleBootstrapMarker, initialJournal: BootstrapTransactionJournal, now?: () => number, hooks?: LegacyBootstrapAdoptionHooks): Promise<void>;
export declare function readBootstrapReadiness(stateDir: string): coreBootstrap.LifecycleBootstrapReadiness | undefined;
export declare function removeBootstrapReadiness(stateDir: string, transactionId: string, beforeMutation?: () => void): void;
export declare function assertTrustedArtifactParent(path: string, platform: NodeJS.Platform, uid?: number): void;
export declare function assertPlannedArtifactsAbsent(paths: readonly string[], platform: NodeJS.Platform, uid?: number): void;
export declare function assertBootstrapTransactionClaimsAbsent(journal: BootstrapTransactionJournal): void;
interface BootstrapArtifactLeafStat {
    nlink: bigint;
    uid: bigint;
    mode: bigint;
}
export type BootstrapArtifactReadRole = 'transaction' | 'owned' | 'preserved';
declare function assertTrustedBootstrapArtifactLeaf(stat: BootstrapArtifactLeafStat, platform: NodeJS.Platform, uid: bigint | undefined, path: string, role: BootstrapArtifactReadRole): void;
export declare const _assertTrustedBootstrapArtifactLeafForTest: typeof assertTrustedBootstrapArtifactLeaf;
export declare function readBootstrapArtifactFile(path: string, maxBytes?: number, hooks?: {
    afterRead?: () => void;
    role?: BootstrapArtifactReadRole;
}): {
    bytes: Buffer;
    identity: BootstrapArtifactIdentity & {
        device: string;
        inode: string;
    };
};
export declare function bootstrapArtifactIdentityForBytes(bytes: Uint8Array): BootstrapArtifactIdentity;
export declare function bootstrapArtifactContentIdentityForFile(path: string): BootstrapArtifactIdentity;
export declare function bootstrapArtifactIdentityForFile(path: string): BootstrapArtifactIdentity & {
    device: string;
    inode: string;
};
export declare function planBootstrapCanonicalQuarantine(stateDir: string, journal: BootstrapTransactionJournal, kinds: readonly BootstrapCanonicalStateKind[]): BootstrapTransactionJournal;
export declare function applyBootstrapCanonicalQuarantine(stateDir: string, journal: BootstrapTransactionJournal, beforeMutation?: () => void): void;
export declare function restoreBootstrapCanonicalQuarantine(stateDir: string, journal: BootstrapTransactionJournal, hooks?: {
    beforeMove?: (entry: Readonly<BootstrapCanonicalQuarantine>) => void;
    afterMove?: (entry: Readonly<BootstrapCanonicalQuarantine>) => void;
}): void;
export declare function finalizeBootstrapCanonicalQuarantine(stateDir: string, journal: BootstrapTransactionJournal, hooks?: {
    beforeMove?: (entry: Readonly<BootstrapCanonicalQuarantine>) => void;
    afterMove?: (entry: Readonly<BootstrapCanonicalQuarantine>) => void;
    beforeDelete?: (entry: Readonly<BootstrapCanonicalQuarantine>) => void;
}): void;
export declare function recordPublishedBootstrapArtifact(journal: BootstrapTransactionJournal, path: string, claimPath: string, persistClaimOwnership: (journal: BootstrapTransactionJournal) => void): BootstrapTransactionJournal;
export declare function captureBootstrapArtifactIdentities(journal: BootstrapTransactionJournal, requirePresent?: boolean): BootstrapTransactionJournal;
export declare function removeOwnedBootstrapArtifacts(journal: BootstrapTransactionJournal, hooks?: {
    beforeStagingQuarantine?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    afterStagingQuarantine?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    beforeStagingDelete?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    beforeQuarantine?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    afterQuarantine?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    beforeQuarantineDelete?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    beforeClaimQuarantine?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
    beforeClaimQuarantineDelete?: (artifact: Readonly<BootstrapJournalArtifact>) => void;
}): void;
export {};