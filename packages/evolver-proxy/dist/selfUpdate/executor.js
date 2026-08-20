// Force-update EXECUTOR (the I/O side, ported from v1 src/forceUpdate.js executeForceUpdate). This is the only
// place in the codebase that downloads a release, replaces files on disk, and signals a restart. Every risky
// operation is an INJECTED seam (same IoC discipline as exec/selfPr) so tests drive it with fakes and it never
// shells out or touches a real install tree by accident.
//
// THE HARD GATE (verify-before-apply, non-negotiable): after download and BEFORE any filesystem write or restart,
// the executor calls the PURE core verifySelectedManifestArtifact. If verification fails — bad sha256,
// missing/invalid signature
// when a key is configured, anything — the executor writes NOTHING, restarts NOTHING, and returns a structured
// failure. The old version stays intact and runnable. A compromised hub cannot turn this channel into fleet RCE.
//
// Concurrency: a process-level mutex guarantees that concurrent force_update messages execute the update EXACTLY
// once. The second caller short-circuits with `already_in_progress` and performs no I/O.
import { ops } from '@evomap/evolver-core';
import { SELF_UPDATE_FAILURE_CODES, classifySelfUpdateError, codeForDecisionReject, selfUpdateFailure, } from './failureCodes.js';
const { decideUpdate, verifySelectedManifestArtifact } = ops;
// Process-level mutex. Module scope is correct: there is one daemon per process, and v1's _forceUpdateInFlight had
// the same lifetime. Guards against two force_update envelopes (or a heartbeat-driven + mailbox-driven trigger)
// racing the same upgrade and replacing files twice / double-restarting.
let inFlight = false;
/** Test-only: reset the mutex between cases. Not part of the public update path. */
export function _resetSelfUpdateMutex() {
    inFlight = false;
}
function report(deps, result) {
    try {
        deps.onTelemetry?.(result);
    }
    catch {
        /* telemetry must never break the update path */
    }
    return result;
}
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
export async function executeForceUpdate(directive, deps) {
    let selectedResult;
    const finish = (result) => {
        selectedResult = result;
        return report(deps, result);
    };
    if (deps.policy !== 'auto') {
        return finish({
            outcome: 'disabled',
            reason: deps.policy === 'prompt' ? 'self_update_policy_prompt_requires_approval' : 'self_update_policy_off',
        });
    }
    const requiredFloor = directive.required_version !== undefined
        ? ops.normalizeRequiredVersion(directive.required_version)
        : undefined;
    if (directive.required_version !== undefined && !requiredFloor) {
        return finish({
            outcome: 'rejected_decision',
            reason: 'required_version_invalid',
            failureCode: SELF_UPDATE_FAILURE_CODES.BAD_REQUIRED_VERSION,
        });
    }
    if (requiredFloor && ops.currentSatisfiesRequiredVersion(deps.currentVersion, requiredFloor)) {
        return finish({ outcome: 'noop', reason: 'already_satisfied', targetVersion: requiredFloor });
    }
    // The mutex and lifecycle lease precede manifest resolution, which is release I/O too.
    // Policy, malformed required-version, and already-satisfied fast exits remain lock-free.
    if (inFlight) {
        return finish({ outcome: 'already_in_progress', reason: 'another_update_in_flight' });
    }
    inFlight = true;
    let targetVersion = requiredFloor ?? '';
    let lifecycleLease;
    let transaction;
    const assertLifecycleLease = async () => {
        try {
            await lifecycleLease?.assertOwned();
        }
        catch (error) {
            const classified = classifySelfUpdateError(error, SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED);
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED, `self_update_lifecycle_owner_lease_lost:${classified.detail}`, { cause: error });
        }
    };
    try {
        if (deps.acquireLifecycleLease) {
            try {
                lifecycleLease = await deps.acquireLifecycleLease();
                await assertLifecycleLease();
            }
            catch (err) {
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED);
                return finish({
                    outcome: classified.failureCode === SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED
                        ? 'already_in_progress'
                        : 'replace_failed',
                    reason: classified.detail,
                    failureCode: classified.failureCode,
                    ...(targetVersion ? { targetVersion } : {}),
                });
            }
        }
        let manifest = directive.manifest;
        if (deps.resolveManifest && shouldResolveManifest(directive, manifest, Boolean(deps.publicKey))) {
            try {
                await assertLifecycleLease();
                manifest = await deps.resolveManifest(directive, deps.currentVersion);
            }
            catch (err) {
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED);
                if (classified.failureCode === SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED) {
                    return finish({
                        outcome: 'replace_failed',
                        reason: classified.detail,
                        failureCode: classified.failureCode,
                        ...(targetVersion ? { targetVersion } : {}),
                    });
                }
                return finish({
                    outcome: 'download_failed',
                    reason: `manifest_resolve_failed: ${classified.detail}`,
                    failureCode: classified.failureCode,
                    ...(targetVersion ? { targetVersion } : {}),
                });
            }
        }
        const effectiveDirective = { ...directive, manifest };
        const decision = decideUpdate({
            current: deps.currentVersion,
            ...(requiredFloor ? { required: requiredFloor } : {}),
            manifest,
        });
        if (decision.action === 'reject') {
            return finish({
                outcome: 'rejected_decision',
                reason: decision.reason,
                failureCode: codeForDecisionReject(decision.reason),
                ...(decision.targetVersion ? { targetVersion: decision.targetVersion } : {}),
            });
        }
        if (decision.action === 'noop') {
            return finish({
                outcome: 'noop',
                reason: decision.reason,
                ...(decision.targetVersion ? { targetVersion: decision.targetVersion } : {}),
            });
        }
        targetVersion = decision.targetVersion ?? manifest?.version ?? '';
        if (deps.beginTransaction) {
            try {
                await assertLifecycleLease();
                transaction = await deps.beginTransaction(targetVersion);
            }
            catch (err) {
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED);
                return finish({
                    outcome: classified.failureCode === SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED ? 'already_in_progress' : 'replace_failed',
                    reason: classified.detail,
                    failureCode: classified.failureCode,
                    targetVersion,
                });
            }
        }
        // 4. Download the staged release.
        let dl;
        try {
            await assertLifecycleLease();
            dl = await deps.download(targetVersion, effectiveDirective);
        }
        catch (err) {
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED);
            await transaction?.abort(classified.failureCode).catch(() => { });
            if (classified.failureCode === SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED) {
                return finish({
                    outcome: 'replace_failed',
                    reason: classified.detail,
                    failureCode: classified.failureCode,
                    targetVersion,
                });
            }
            return finish({
                outcome: 'download_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        if (transaction) {
            try {
                await assertLifecycleLease();
                dl = await transaction.adoptDownloaded(dl);
            }
            catch (err) {
                await transaction.abort(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED).catch(() => { });
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
                return finish({
                    outcome: 'replace_failed',
                    reason: classified.detail,
                    failureCode: classified.failureCode,
                    targetVersion,
                });
            }
        }
        // 5. THE GATE: verify the downloaded bytes against the (optionally signed) manifest BEFORE any write.
        try {
            await assertLifecycleLease();
        }
        catch (err) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED).catch(() => { });
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.RECOVERY_REQUIRED);
            return finish({
                outcome: 'replace_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        const verification = verifySelectedManifestArtifact(manifest, dl.artifacts, ...(deps.publicKey ? [deps.publicKey] : []));
        if (!verification.ok) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION).catch(() => { });
            // Verification failed → write NOTHING, restart NOTHING. Old version stays intact and runnable.
            return finish({
                outcome: 'rejected_verification',
                reason: verification.reason,
                failureCode: SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION,
                targetVersion,
            });
        }
        try {
            await assertLifecycleLease();
            await transaction?.markVerified(dl.artifacts);
        }
        catch (err) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED).catch(() => { });
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
            return finish({
                outcome: 'replace_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        // 6. Verified. Atomic replace, then signal restart. A replace failure leaves the old version intact.
        try {
            await assertLifecycleLease();
            if (transaction)
                await transaction.install();
            else
                await deps.atomicReplace(dl.stagedPath);
        }
        catch (err) {
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.COPY_FAILED);
            return finish({
                outcome: 'replace_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        const result = {
            outcome: 'applied',
            reason: 'verified_and_replaced',
            targetVersion,
            appliedVia: dl.appliedVia ?? 'binary',
            ...(transaction ? { confirmationPending: true } : {}),
        };
        finish(result);
        try {
            await assertLifecycleLease();
            await transaction?.markRestartRequested();
            await assertLifecycleLease();
            await deps.restart(); // v1 convention: exit(78) → supervisor relaunches the new version.
        }
        catch (err) {
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.RESTART_FAILED);
            try {
                await transaction?.rollback(classified.failureCode);
            }
            catch (rollbackError) {
                const rollback = classifySelfUpdateError(rollbackError, SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED);
                return finish({
                    outcome: 'rollback_failed',
                    reason: rollback.detail,
                    failureCode: rollback.failureCode,
                    targetVersion,
                });
            }
            return finish({
                outcome: 'restart_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        return result;
    }
    finally {
        await transaction?.release().catch(() => { });
        if (lifecycleLease) {
            try {
                await lifecycleLease.release();
            }
            catch (error) {
                if (selectedResult) {
                    selectedResult.cleanupWarning = boundedCleanupWarning(error);
                    if (selectedResult.outcome === 'applied') {
                        selectedResult.reason = 'verified_and_replaced_lifecycle_lease_release_unconfirmed';
                    }
                    try {
                        deps.onCleanupWarning?.(selectedResult.cleanupWarning, selectedResult);
                    }
                    catch {
                        // Cleanup reporting must not replace the primary update outcome.
                    }
                }
            }
        }
        inFlight = false;
    }
}
function boundedCleanupWarning(error) {
    const raw = error instanceof Error ? error.message : String(error);
    const normalized = raw
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (normalized || 'self_update_lifecycle_owner_lease_release_failed').slice(0, 512);
}
function shouldResolveManifest(directive, manifest, signatureRequired) {
    if (manifest === undefined)
        return true;
    const hasGithubReleaseHint = typeof directive.release_url === 'string'
        || directive.update_channels?.includes('github') === true;
    if (!hasGithubReleaseHint)
        return false;
    if (signatureRequired)
        return !hasSignedManifest(manifest);
    return true;
}
function hasSignedManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
        return false;
    const input = manifest;
    return typeof input.signature === 'string'
        && input.signature.length > 0
        && input.signatureAlg === 'ed25519';
}