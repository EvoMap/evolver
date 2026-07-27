import { homedir } from 'node:os';
import { join } from 'node:path';
function nonBlank(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
/** Select explicit node credentials without combining conflicting alias namespaces. */
export function resolveExplicitNodeCredentials(env = process.env) {
    const evomap = credentialNamespace(env, 'EVOMAP');
    const a2a = credentialNamespace(env, 'A2A');
    if (evomap.senderId && evomap.nodeSecret)
        return evomap;
    if (a2a.senderId && a2a.nodeSecret)
        return a2a;
    if (evomap.senderId && a2a.senderId && evomap.senderId === a2a.senderId) {
        const selected = evomap.nodeSecret ? evomap : a2a.nodeSecret ? a2a : evomap;
        return selected.nodeSecret ? selected : { senderId: selected.senderId };
    }
    const senderId = evomap.senderId ?? a2a.senderId;
    if (senderId)
        return { senderId };
    const selected = evomap.nodeSecret ? evomap : a2a;
    return selected.nodeSecret
        ? {
            nodeSecret: selected.nodeSecret,
            ...(selected.nodeSecretVersion ? { nodeSecretVersion: selected.nodeSecretVersion } : {}),
        }
        : {};
}
function credentialNamespace(env, prefix) {
    const senderId = nonBlank(env[`${prefix}_NODE_ID`]);
    const nodeSecret = nonBlank(env[`${prefix}_NODE_SECRET`]);
    const nodeSecretVersion = nonBlank(env[`${prefix}_NODE_SECRET_VERSION`]);
    return {
        ...(senderId ? { senderId } : {}),
        ...(nodeSecret ? { nodeSecret } : {}),
        ...(nodeSecretVersion ? { nodeSecretVersion } : {}),
    };
}
/** Resolve the public Hub identity root without coupling credentials to Evolver state. */
export function resolveIdentityHome(env = process.env, homeDir) {
    const explicit = [env['EVOMAP_HOME'], env['EVOMAP_DIR'], env['EVOLVER_HOME']]
        .map(nonBlank)
        .filter((value) => value !== undefined);
    return explicit[0] ?? join(homeDir ?? homedir(), '.evomap');
}