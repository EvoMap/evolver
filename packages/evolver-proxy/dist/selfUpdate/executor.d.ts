import { ops } from '@evomap/evolver-core';
import { type SelfUpdateFailureCode } from './failureCodes.js';
import type { DurableSelfUpdateSession } from './transaction.js';
type DownloadedArtifact = ops.DownloadedArtifact;
/** Structured outcome codes — reported to telemetry; the hub sees WHY an update did/didn't apply. */
export type SelfUpdateOutcome = 'applied' | 'noop' | 'rejected_decision' | 'rejected_verification' | 'download_failed' | 'replace_failed' | 'restart_failed' | 'rollback_failed' | 'already_in_progress' | 'disabled';
export interface SelfUpdateResult {
    outcome: SelfUpdateOutcome;
    reason: string;
    /** Fine-grained stable failure taxonomy for telemetry aggregation. */
    failureCode?: SelfUpdateFailureCode;
    /** The version that was (or would have been) applied. */
    targetVersion?: string;
    /**
     * Which download path produced the staged binary: `'binary'` is the normal
     * precompiled-asset happy path, `'tarball'` means the binary download failed
     * and Channel 1b (release `.tar.gz`) fallback was used. The selected-artifact
     * gate ran in BOTH cases, so apply-semantics are identical, but "tarball
     * used in production" is a useful CDN/rate-limit signal for the hub.
     * Persisted into `last_update.json` (lastUpdate.LastUpdatePayload.applied_via)
     * on success so the hub can observe the channel directly.
     */
    appliedVia?: 'binary' | 'tarball';
    /** Durable installs are not successful until the relaunched daemon completes startup health checks. */
    confirmationPending?: true;
    /** A bounded integrity warning from cleanup that did not change the primary update outcome. */
    cleanupWarning?: string;
}
/** The hub's force_update directive (inbound message payload). */
export interface ForceUpdateDirective {
    required_version?: string;
    manifest?: unknown;
    reason?: string;
    release_url?: string;
    update_channels?: readonly string[];
    directive_id?: string;
    deadline_ms?: number;
    stagger_window_ms?: number;
}
/** Result of downloading the release for `targetVersion`: the staged path + the artifacts to verify. */
export interface DownloadResult {
    /** Where the new version was staged (e.g. a tmp dir). Passed to atomicReplace on success. */
    stagedPath: string;
    /** Exactly one selected artifact (bytes or precomputed sha256) for verification. */
    artifacts: readonly DownloadedArtifact[];
    /**
     * Which channel actually produced the staged bytes — defaults to `'binary'`
     * when the precompiled asset succeeded, `'tarball'` when Channel 1b fallback
     * (release `.tar.gz`) had to extract the binary. The executor threads this
     * onto the SelfUpdateResult as `appliedVia` for telemetry. Optional so
     * legacy/test seams without a notion of channels stay valid.
     */
    appliedVia?: 'binary' | 'tarball';
}
/**
 * Injected I/O seams. Defaults are NOT provided here — the proxy bin wires real implementations (degit/tarball
 * download, fs atomic rename, process.exit(78)); tests pass fakes. Keeping them required makes "did we actually
 * call restart?" trivially observable in tests and stops a real restart leaking into a unit run.
 */
export interface SelfUpdateDeps {
    /** Self-update policy. Only 'auto' applies; 'prompt' needs an approval path before this executor runs. */
    policy: 'off' | 'prompt' | 'auto';
    /** Current installed version (read from package.json by the caller). */
    currentVersion: string;
    /** Lazy cross-process lease that serializes self-update with lifecycle mutations. */
    acquireLifecycleLease?: () => Promise<SelfUpdateLifecycleLease> | SelfUpdateLifecycleLease;
    /** Resolve a trusted manifest when the hub directive does not carry one. */
    resolveManifest?: (directive: ForceUpdateDirective, currentVersion: string) => Promise<unknown> | unknown;
    /** Download the staged release for the target version. Throws/rejects on failure. */
    download: (targetVersion: string, directive: ForceUpdateDirective) => Promise<DownloadResult>;
    /** Atomically replace the install tree with the staged path (preserving node_modules/.env/etc). Throws on fail. */
    atomicReplace: (stagedPath: string) => Promise<void>;
    /** Optional durable transaction: cross-process lock + journal + backup + recovery-aware install. */
    beginTransaction?: (targetVersion: string) => Promise<DurableSelfUpdateSession>;
    /** Signal a restart so the supervisor relaunches the new version. v1 convention: process.exit(78). */
    restart: () => void | Promise<void>;
    /** Optional Ed25519 public key (PEM / raw base64). When set, an unsigned/badly-signed manifest is REJECTED. */
    publicKey?: string;
    /** Best-effort telemetry sink for the structured outcome (never throws into the update path). */
    onTelemetry?: (result: SelfUpdateResult) => void;
    /** One-shot operator warning sink for a lifecycle lease cleanup integrity failure. */
    onCleanupWarning?: (warning: string, result: SelfUpdateResult) => void;
}
export interface SelfUpdateLifecycleLease {
    assertOwned(): Promise<void> | void;
    release(): Promise<void> | void;
}
/** Test-only: reset the mutex between cases. Not part of the public update path. */
export declare function _resetSelfUpdateMutex(): void;
/**
 * Execute a force_update directive end to end: fast exits → lease → resolve/decide → download → VERIFY → replace → restart.
 *
 * Order is load-bearing:
 *  1. policy off → do nothing (explicit opt-out; auto is hard-gated upstream by supervisor + public key).
 *  2. reject malformed/already-satisfied required versions without acquiring the lifecycle owner lease.
 *  3. mutex + lifecycle owner lease: exactly one executor may resolve or mutate release state.
 *  4. resolve and decideUpdate (pure): reject bad manifests or NOOP under the held lease.
 *  5. download the staged release.
 *  6. verifySelectedManifestArtifact (pure) — THE GATE. Fail → no write, no restart.
 *  7. atomicReplace, then restart(). Only reached after verification passed.
 *
 * Never throws: every failure becomes a structured SelfUpdateResult so the daemon can report it and keep running
 * on the old (intact) version.
 */
export declare function executeForceUpdate(directive: ForceUpdateDirective, deps: SelfUpdateDeps): Promise<SelfUpdateResult>;
export {};