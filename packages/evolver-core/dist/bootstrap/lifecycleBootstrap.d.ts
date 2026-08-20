import { type FileLockProcessStartIdentity } from '../util/fileLock.js';
export declare const LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA = "evolver.lifecycle-bootstrap.v1";
export declare const LIFECYCLE_BOOTSTRAP_LEGACY_BINDING = "legacy-v907";
export declare const LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF = "legacy-v907-env-file";
export declare const LIFECYCLE_BOOTSTRAP_DEADLINE_ENV = "EVOLVER_INTERNAL_BOOTSTRAP_DEADLINE_MS";
export declare const LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV = "EVOLVER_INTERNAL_BOOTSTRAP_TRANSACTION_ID";
export declare const LIFECYCLE_BOOTSTRAP_SUCCESS_FILE = "bootstrap.json";
export declare const LIFECYCLE_BOOTSTRAP_JOURNAL_FILE = "bootstrap-transaction.json";
export declare const LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE = "bootstrap-owner.lock";
export declare const LIFECYCLE_BOOTSTRAP_READINESS_FILE = "bootstrap-readiness.json";
export declare const LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE = "bootstrap-readiness.lock";
export declare const LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA = "evolver.lifecycle-bootstrap-readiness.v1";
export declare const LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_FILE = "bootstrap-manual-transition.json";
export declare const LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA = "evolver.lifecycle-bootstrap-manual-transition.v1";
export declare const MAX_LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_BYTES: number;
export declare const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_FILE = "bootstrap-registration.intent.json";
export declare const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE = "bootstrap-registration.intent.terminal";
export declare const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE = "bootstrap-registration.intent.clearing";
export declare const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA = "evolver.bootstrap-registration-intent.v1";
export declare const LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV = "EVOLVER_INTERNAL_BOOTSTRAP_REGISTRATION_TOKEN";
export declare const MAX_LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_BYTES: number;
export type LifecycleBootstrapTarget = 'launchd' | 'systemd' | 'windows';
export type LifecycleBootstrapManagerBindingKind = 'transaction' | typeof LIFECYCLE_BOOTSTRAP_LEGACY_BINDING;
export interface LifecycleBootstrapLegacyStateRootProof {
    kind: typeof LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF;
    envFilePath: string;
    stateDir: string;
}
export interface LifecycleBootstrapMarker {
    schema: typeof LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA;
    transactionId: string;
    bootstrappedAt: string;
    target: LifecycleBootstrapTarget;
    service: string;
    files: string[];
    managerArtifactPath: string;
    managerBindingKind?: LifecycleBootstrapManagerBindingKind;
    artifacts: Array<{
        path: string;
        size: number;
        sha256: string;
        device?: string;
        inode?: string;
    }>;
    /** Exact legacy companion artifacts retained on disk but never owned by proxy rollback. */
    preservedArtifacts?: Array<{
        path: string;
        size: number;
        sha256: string;
        device?: string;
        inode?: string;
    }>;
    /** Exact env-file attestation required by unpinned #907 launchers. */
    legacyStateRootProof?: LifecycleBootstrapLegacyStateRootProof;
}
/** Exact success marker emitted by the pre-transaction first-run bootstrap merged in #907. */
export interface LegacyLifecycleBootstrapMarker {
    bootstrappedAt: string;
    target: LifecycleBootstrapTarget;
    service: string;
    files: string[];
}
export interface LifecycleBootstrapReadiness {
    schema: typeof LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA;
    transactionId: string;
    pid: number;
    pidProcessStartIdentity: FileLockProcessStartIdentity;
    supervisorPid: number;
    supervisorProcessStartIdentity: FileLockProcessStartIdentity;
    startedAt: string;
    ipcUrl: string;
}
export interface LifecycleBootstrapManualTransition {
    schema: typeof LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA;
    transitionId: string;
    removedTransactionId: string;
    target: LifecycleBootstrapTarget;
    service: string;
    createdAt: string;
}
export interface LifecycleBootstrapRegistrationIntentOwner {
    pid: number;
    token: string;
    processStartIdentity: FileLockProcessStartIdentity;
}
interface LifecycleBootstrapRegistrationIntentBase {
    schema: typeof LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA;
    owner: LifecycleBootstrapRegistrationIntentOwner;
    createdAt: string;
}
export type LifecycleBootstrapRegistrationTerminalOutcome = 'committed' | 'rolled_back' | 'no_child' | 'cancelled';
export type LifecycleBootstrapRegistrationIntent = (LifecycleBootstrapRegistrationIntentBase & {
    state: 'registering';
}) | (LifecycleBootstrapRegistrationIntentBase & {
    state: 'terminal';
    outcome: LifecycleBootstrapRegistrationTerminalOutcome;
    terminalAt: string;
    transactionId?: string;
});
export declare function parseLifecycleBootstrapRegistrationToken(value: unknown): string | undefined;
export declare function parseLifecycleBootstrapManualTransition(value: unknown): LifecycleBootstrapManualTransition | undefined;
export declare function parseLifecycleBootstrapManualTransitionJson(raw: string): LifecycleBootstrapManualTransition | undefined;
export declare function parseLifecycleBootstrapRegistrationIntent(value: unknown): LifecycleBootstrapRegistrationIntent | undefined;
export declare function parseLifecycleBootstrapRegistrationIntentJson(raw: string): LifecycleBootstrapRegistrationIntent | undefined;
export declare function parseLifecycleBootstrapMarker(value: unknown): LifecycleBootstrapMarker | undefined;
export declare function parseLegacyLifecycleBootstrapMarker(value: unknown): LegacyLifecycleBootstrapMarker | undefined;
export declare function parseLegacyLifecycleBootstrapMarkerJson(raw: string): LegacyLifecycleBootstrapMarker | undefined;
export declare function parseLifecycleBootstrapMarkerJson(raw: string): LifecycleBootstrapMarker | undefined;
export declare function parseLifecycleBootstrapReadiness(value: unknown): LifecycleBootstrapReadiness | undefined;
export declare function parseLifecycleBootstrapReadinessJson(raw: string): LifecycleBootstrapReadiness | undefined;
export {};