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
import { SELF_UPDATE_FAILURE_CODES, classifySelfUpdateError, codeForDecisionReject, } from './failureCodes.js';
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
 * Execute a force_update directive end to end: decide → (mutex) → download → VERIFY → atomic replace → restart.
 *
 * Order is load-bearing:
 *  1. policy off → do nothing (explicit opt-out; auto is hard-gated upstream by supervisor + public key).
 *  2. decideUpdate (pure): reject bad manifests, NOOP when already satisfied (no download, no restart).
 *  3. mutex: exactly one execution; concurrent callers get `already_in_progress` and touch no disk.
 *  4. download the staged release.
 *  5. verifySelectedManifestArtifact (pure) — THE GATE. Fail → no write, no restart.
 *  6. atomicReplace, then restart(). Only reached after verification passed.
 *
 * Never throws: every failure becomes a structured SelfUpdateResult so the daemon can report it and keep running
 * on the old (intact) version.
 */
export async function executeForceUpdate(directive, deps) {
    if (deps.policy !== 'auto') {
        return report(deps, {
            outcome: 'disabled',
            reason: deps.policy === 'prompt' ? 'self_update_policy_prompt_requires_approval' : 'self_update_policy_off',
        });
    }
    const requiredFloor = directive.required_version !== undefined
        ? ops.normalizeRequiredVersion(directive.required_version)
        : undefined;
    if (directive.required_version !== undefined && !requiredFloor) {
        return report(deps, {
            outcome: 'rejected_decision',
            reason: 'required_version_invalid',
            failureCode: SELF_UPDATE_FAILURE_CODES.BAD_REQUIRED_VERSION,
        });
    }
    if (requiredFloor && ops.currentSatisfiesRequiredVersion(deps.currentVersion, requiredFloor)) {
        return report(deps, { outcome: 'noop', reason: 'already_satisfied', targetVersion: requiredFloor });
    }
    let manifest = directive.manifest;
    if (deps.resolveManifest && shouldResolveManifest(directive, manifest, Boolean(deps.publicKey))) {
        try {
            manifest = await deps.resolveManifest(directive, deps.currentVersion);
        }
        catch (err) {
            const targetVersion = ops.normalizeRequiredVersion(directive.required_version);
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED);
            return report(deps, {
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
        return report(deps, {
            outcome: 'rejected_decision',
            reason: decision.reason,
            failureCode: codeForDecisionReject(decision.reason),
            ...(decision.targetVersion ? { targetVersion: decision.targetVersion } : {}),
        });
    }
    if (decision.action === 'noop') {
        return report(deps, { outcome: 'noop', reason: decision.reason, ...(decision.targetVersion ? { targetVersion: decision.targetVersion } : {}) });
    }
    // action === 'proceed'. Take the mutex; a concurrent force_update short-circuits here with NO I/O.
    if (inFlight) {
        return report(deps, { outcome: 'already_in_progress', reason: 'another_update_in_flight' });
    }
    inFlight = true;
    const targetVersion = decision.targetVersion ?? manifest?.version ?? '';
    let transaction;
    try {
        if (deps.beginTransaction) {
            try {
                transaction = await deps.beginTransaction(targetVersion);
            }
            catch (err) {
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.UPDATE_LOCKED);
                return report(deps, {
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
            dl = await deps.download(targetVersion, effectiveDirective);
        }
        catch (err) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED).catch(() => { });
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED);
            return report(deps, {
                outcome: 'download_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        if (transaction) {
            try {
                dl = await transaction.adoptDownloaded(dl);
            }
            catch (err) {
                await transaction.abort(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED).catch(() => { });
                const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
                return report(deps, {
                    outcome: 'replace_failed',
                    reason: classified.detail,
                    failureCode: classified.failureCode,
                    targetVersion,
                });
            }
        }
        // 5. THE GATE: verify the downloaded bytes against the (optionally signed) manifest BEFORE any write.
        const verification = verifySelectedManifestArtifact(manifest, dl.artifacts, ...(deps.publicKey ? [deps.publicKey] : []));
        if (!verification.ok) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION).catch(() => { });
            // Verification failed → write NOTHING, restart NOTHING. Old version stays intact and runnable.
            return report(deps, {
                outcome: 'rejected_verification',
                reason: verification.reason,
                failureCode: SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION,
                targetVersion,
            });
        }
        try {
            await transaction?.markVerified(dl.artifacts);
        }
        catch (err) {
            await transaction?.abort(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED).catch(() => { });
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED);
            return report(deps, {
                outcome: 'replace_failed',
                reason: classified.detail,
                failureCode: classified.failureCode,
                targetVersion,
            });
        }
        // 6. Verified. Atomic replace, then signal restart. A replace failure leaves the old version intact.
        try {
            if (transaction)
                await transaction.install();
            else
                await deps.atomicReplace(dl.stagedPath);
        }
        catch (err) {
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.COPY_FAILED);
            return report(deps, {
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
        report(deps, result);
        try {
            await transaction?.markRestartRequested();
            await deps.restart(); // v1 convention: exit(78) → supervisor relaunches the new version.
        }
        catch (err) {
            const classified = classifySelfUpdateError(err, SELF_UPDATE_FAILURE_CODES.RESTART_FAILED);
            try {
                await transaction?.rollback(classified.failureCode);
            }
            catch (rollbackError) {
                const rollback = classifySelfUpdateError(rollbackError, SELF_UPDATE_FAILURE_CODES.ROLLBACK_FAILED);
                return report(deps, {
                    outcome: 'rollback_failed',
                    reason: rollback.detail,
                    failureCode: rollback.failureCode,
                    targetVersion,
                });
            }
            return report(deps, {
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
        // Released so a later legitimate update (after a failed attempt) can proceed. On the success path the process
        // is exiting anyway; releasing is harmless and keeps the mutex honest if restart() is a test fake that returns.
        inFlight = false;
    }
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