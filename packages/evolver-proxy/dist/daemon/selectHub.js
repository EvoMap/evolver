import { resolveHubUrl as resolvePublicHubUrl } from '@evomap/evolver-adapter-public';
/** 据 EVOMAP_HUB_MODE 选 hub 实现(public|private). 缺省 public. bin 据此挂对应 adapter. */
export function resolveHubMode(env) {
    const m = (env['EVOMAP_HUB_MODE'] ?? 'public').toLowerCase();
    if (m !== 'public' && m !== 'private')
        throw new Error(`EVOMAP_HUB_MODE 非法: ${m}(public|private)`);
    return m;
}
export function resolveHubUrl(env) {
    if ((env['EVOMAP_HUB_MODE'] ?? 'public').toLowerCase() === 'private')
        return resolvePrivateHubUrl(env);
    return resolvePublicHubUrl(env);
}
function resolvePrivateHubUrl(env) {
    return trimmed(env['EVOMAP_HUB_URL'])
        ?? trimmed(env['A2A_HUB_URL'])
        ?? trimmed(env['EVOLVER_DEFAULT_HUB_URL'])
        ?? resolvePublicHubUrl({});
}
function trimmed(value) {
    const v = value?.trim();
    if (!v)
        return undefined;
    const normalized = v.replace(/\/+$/, '');
    return normalized || undefined;
}
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
export function hubAuthFailureHint(env, errorText = '') {
    const mode = (env['EVOMAP_HUB_MODE'] ?? 'public').toLowerCase();
    if (mode === 'private')
        return '';
    if (/a2a_auth_required/i.test(errorText)) {
        return 'the hub required an auth credential the public adapter does not send, which points to a private hub. Set EVOMAP_HUB_MODE=private and provide the private adapter (@evomap/evolver-adapter-private, or point EVOMAP_PRIVATE_ADAPTER_MODULE at a local build) plus an enterprise token (EVOMAP_ENTERPRISE_TOKEN).';
    }
    return 'the hub rejected the node credential. If this is a private hub, set EVOMAP_HUB_MODE=private with the private adapter and an enterprise token; otherwise the public node secret may be expired or revoked, so re-register the node.';
}