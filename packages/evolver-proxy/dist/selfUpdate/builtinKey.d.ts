/** Ed25519 SPKI public key (base64 DER) matching the release environment signing key.
 * Rotated 2026-09-01: the pre-rotation private key was lost, so installs built before
 * this rotation must reinstall (or set EVOLVER_SELF_UPDATE_PUBLIC_KEY) to update past it. */
export declare const BUILTIN_SELF_UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAebNxmtdPCjYpeRaFbmay4Y3/GY28tB4/hwFEXZrgeoE=";
/** Resolve the self-update verification public key: env override wins, else the built-in key. */
export declare function resolveSelfUpdatePublicKey(env?: NodeJS.ProcessEnv): string;