export type HubMode = 'public' | 'private';
/** 据 EVOMAP_HUB_MODE 选 hub 实现(public|private). 缺省 public. bin 据此挂对应 adapter. */
export declare function resolveHubMode(env: Record<string, string | undefined>): HubMode;
export declare function resolveHubUrl(env: Record<string, string | undefined>): string;
/**
 * Actionable hint for a hub AUTH failure (401/403), tailored to the hub's error code so it does NOT misdirect
 * (#314). In the default PUBLIC mode the proxy DOES send a node_secret for a registered public node, so a 401 has
 * two distinct causes that need opposite remedies:
 *  - `a2a_auth_required`: the hub demanded a credential the public adapter never sends. Since public mode already
 *    sends node_secret, this points at a self-hosted PRIVATE hub. Remedy: switch to private mode.
 *  - any other auth error (credential rejected/invalid): the node_secret WAS sent but rejected, i.e. a public-hub
 *    credential problem (expired/revoked). Remedy: re-register the node. Private mode is only a secondary guess.
 * Returns '' in PRIVATE mode (a 401 there is a token/credential problem with its own startup errors).
 * Pure and non-throwing (unlike resolveHubMode), so it is safe to call on the error path.
 */
export declare function hubAuthFailureHint(env: Record<string, string | undefined>, errorText?: string): string;