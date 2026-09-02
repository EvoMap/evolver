// Built-in Ed25519 verification public key for the official v2-beta self-update channel.
//
// A public key is not secret: embedding it lets nodes installed through a trusted
// distribution channel (npm tarball or prebuilt release binary) verify signed update
// manifests with zero per-node configuration. Trust bootstraps from the install
// channel itself (npm registry integrity / release artifact provenance), and every
// later self-update stays signature-gated.
//
// EVOLVER_SELF_UPDATE_PUBLIC_KEY overrides this when set (rotation / private fleets).
/** Ed25519 SPKI public key (base64 DER) matching the release environment signing key.
 * Rotated 2026-09-01: the pre-rotation private key was lost, so installs built before
 * this rotation must reinstall (or set EVOLVER_SELF_UPDATE_PUBLIC_KEY) to update past it. */
export const BUILTIN_SELF_UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAebNxmtdPCjYpeRaFbmay4Y3/GY28tB4/hwFEXZrgeoE=';
/** Resolve the self-update verification public key: env override wins, else the built-in key. */
export function resolveSelfUpdatePublicKey(env = process.env) {
    const configured = env['EVOLVER_SELF_UPDATE_PUBLIC_KEY']?.trim();
    return configured || BUILTIN_SELF_UPDATE_PUBLIC_KEY;
}