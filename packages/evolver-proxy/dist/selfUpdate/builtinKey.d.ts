/** Ed25519 SPKI public key (base64 DER) matching the v2-beta release environment signing key. */
export declare const BUILTIN_SELF_UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAAgoV6aWwJd5zlxOcPqWuxkDB+isQnKydFStV8X3DxMk=";
/** Resolve the self-update verification public key: env override wins, else the built-in key. */
export declare function resolveSelfUpdatePublicKey(env?: NodeJS.ProcessEnv): string;