import { ops } from '@evomap/evolver-core';
import { type SelfUpdateFailureCode } from './failureCodes.js';
type DownloadedArtifact = ops.DownloadedArtifact;
/** Structured outcome codes — reported to telemetry; the hub sees WHY an update did/didn't apply. */
export type SelfUpdateOutcome = 'applied' | 'noop' | 'rejected_decision' | 'rejected_verification' | 'download_failed' | 'replace_failed' | 'already_in_progress' | 'disabled';
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
     * and Channel 1b (release `.tar.gz`) fallback was used. The verifyManifest
     * gate ran in BOTH cases, so apply-semantics are identical, but "tarball
     * used in production" is a useful CDN/rate-limit signal for the hub.
     * Persisted into `last_update.json` (lastUpdate.LastUpdatePayload.applied_via)
     * on success so the hub can observe the channel directly.
     */
    appliedVia?: 'binary' | 'tarball';
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
    /** The downloaded artifacts (bytes or precomputed sha256) for verifyManifest. */
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
    /** Resolve a trusted manifest when the hub directive does not carry one. */
    resolveManifest?: (directive: ForceUpdateDirective, currentVersion: string) => Promise<unknown> | unknown;
    /** Download the staged release for the target version. Throws/rejects on failure. */
    download: (targetVersion: string, directive: ForceUpdateDirective) => Promise<DownloadResult>;
    /** Atomically replace the install tree with the staged path (preserving node_modules/.env/etc). Throws on fail. */
    atomicReplace: (stagedPath: string) => Promise<void>;
    /** Signal a restart so the supervisor relaunches the new version. v1 convention: process.exit(78). */
    restart: () => void;
    /** Optional Ed25519 public key (PEM / raw base64). When set, an unsigned/badly-signed manifest is REJECTED. */
    publicKey?: string;
    /** Best-effort telemetry sink for the structured outcome (never throws into the update path). */
    onTelemetry?: (result: SelfUpdateResult) => void;
}
/** Test-only: reset the mutex between cases. Not part of the public update path. */
export declare function _resetSelfUpdateMutex(): void;
/**
 * Execute a force_update directive end to end: decide → (mutex) → download → VERIFY → atomic replace → restart.
 *
 * Order is load-bearing:
 *  1. policy off → do nothing (the default-off risk gate; a half-built channel must not auto-apply).
 *  2. decideUpdate (pure): reject bad manifests, NOOP when already satisfied (no download, no restart).
 *  3. mutex: exactly one execution; concurrent callers get `already_in_progress` and touch no disk.
 *  4. download the staged release.
 *  5. verifyManifest (pure) — THE GATE. Fail → no write, no restart, `rejected_verification`.
 *  6. atomicReplace, then restart(). Only reached after verification passed.
 *
 * Never throws: every failure becomes a structured SelfUpdateResult so the daemon can report it and keep running
 * on the old (intact) version.
 */
export declare function executeForceUpdate(directive: ForceUpdateDirective, deps: SelfUpdateDeps): Promise<SelfUpdateResult>;
export {};