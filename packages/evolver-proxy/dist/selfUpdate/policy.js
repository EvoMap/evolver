// Self-update policy resolution from the EVOLVER_SELF_UPDATE env var.
//
// Default is AUTO. An auto-applying self-update channel is the single highest-value attack surface
// in the fleet, so the auto default stays hard-gated: production auto requires supervisor attestation
// (a generated durable launcher owns relaunch) plus an Ed25519 public key for signed-manifest
// verification, and anything missing fails closed before any update is applied.
//
// The DEFAULT auto is an install-convenience, not an operator assertion: when no durable supervisor
// attestation is present OR no verification public key is available (configured env value or the
// built-in distribution key) OR no self-update target is bindable (npm/JS install shape without a
// standalone binary), resolveEffectiveSelfUpdatePolicy
// degrades it to 'off' (with a warning at startup) so unsupervised foreground runs still start —
// keeping 'auto' would just make createSelfUpdateDeps throw at assembly and crash startup. The
// target-bindability check also rescues residual bad launchers left behind by older bootstraps:
// an attested supervisor running through node degrades to 'off' instead of crash-looping.
// An EXPLICIT EVOLVER_SELF_UPDATE=auto keeps failing closed at assembly (createSelfUpdateDeps throws)
// — the operator asked for auto, silence would hide a misconfiguration.
// Operators can still narrow it explicitly:
//   off    : never apply.
//   prompt : recognized but not auto-applied until an approval store/UI exists.
//   auto   : apply automatically after verification (default).
// Enterprise/air-gap deployments should pin 'off' explicitly in their env file (decided by the
// private adapter, not core).
import { resolveSelfUpdatePublicKey } from './builtinKey.js';
import { selfUpdateProcessTargetBindable } from './releaseBinary.js';
/** Resolve EVOLVER_SELF_UPDATE to a policy. Unset → 'auto' (still gated by supervisor + public key). Unrecognized → 'off' (fail-closed). */
export function resolveSelfUpdatePolicy(env = process.env) {
    const raw = (env['EVOLVER_SELF_UPDATE'] ?? '').trim().toLowerCase();
    if (raw === 'off')
        return 'off';
    if (raw === 'prompt')
        return 'prompt';
    if (raw === 'auto' || raw === '')
        return 'auto';
    return 'off';
}
/** True when the operator set EVOLVER_SELF_UPDATE to any non-blank value. */
export function isSelfUpdateExplicit(env = process.env) {
    return (env['EVOLVER_SELF_UPDATE'] ?? '').trim() !== '';
}
/** Attested only by the generated durable launchers; env files and operators cannot forge the marker. */
export function selfUpdateSupervisorAttested(env) {
    const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR']?.trim();
    return supervisor === 'systemd'
        || supervisor === 'launchd'
        || supervisor === 'windows-scheduled-task';
}
/**
 * True when a verification public key will be available at assembly time: a configured
 * EVOLVER_SELF_UPDATE_PUBLIC_KEY or the built-in distribution key. Must stay aligned with
 * the resolver used by createSelfUpdateDeps so policy never degrades for a key that
 * assembly would accept.
 */
function selfUpdatePublicKeyAvailable(env) {
    return Boolean(resolveSelfUpdatePublicKey(env).trim());
}
/**
 * True when a self-update target can be bound at assembly time: an explicit
 * EVOLVER_SELF_UPDATE_TARGET_PATH or a standalone release binary execPath. Must stay aligned
 * with resolveSelfUpdateTarget as used by createSelfUpdateDeps so policy never keeps 'auto'
 * for a target that assembly would reject.
 */
function selfUpdateTargetBindable(env, execPath) {
    return selfUpdateProcessTargetBindable({ env, processExecPath: execPath });
}
/**
 * Resolve the policy that startup should actually run with. A default (unset) 'auto' without durable
 * supervisor attestation OR without any available public key OR without a bindable self-update target
 * (npm/JS install shape) degrades to 'off' so direct/foreground runs — and residual launchers from a
 * bad bootstrap on a JS install — keep working; an explicit 'auto' passes through untouched and fails
 * closed at assembly time. `execPath` overrides process.execPath for the target-bindability check.
 */
export function resolveEffectiveSelfUpdatePolicy(env = process.env, execPath) {
    const policy = resolveSelfUpdatePolicy(env);
    if (policy === 'auto'
        && !isSelfUpdateExplicit(env)
        && (!selfUpdateSupervisorAttested(env)
            || !selfUpdatePublicKeyAvailable(env)
            || !selfUpdateTargetBindable(env, execPath))) {
        return { policy: 'off', degraded: true };
    }
    return { policy, degraded: false };
}