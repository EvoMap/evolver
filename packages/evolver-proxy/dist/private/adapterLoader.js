import { hub as hubNs } from '@evomap/evolver-core';
import { withPrivateAccountAssetCompatibility, } from './accountAssetCompatibility.js';
const DEFAULT_PRIVATE_ADAPTER_MODULE = '@evomap/evolver-adapter-private';
export function resolvePrivateEnterpriseToken(env) {
    return firstEnv(env, 'EVOMAP_ENTERPRISE_TOKEN', 'EVOMAP_PRIVATE_HUB_TOKEN', 'PHUB_ENTERPRISE_TOKEN', 'PRIVATE_HUB_ENTERPRISE_TOKEN');
}
/** One-shot invitation token (evoinv_…), matching the hub's official onboarding script (A2A_INVITATION_TOKEN).
 *  Preferred over the enterprise token for the default token_required enrollment mode. */
export function resolvePrivateInvitationToken(env) {
    return firstEnv(env, 'A2A_INVITATION_TOKEN');
}
export function resolvePrivateNodeSecret(env) {
    return firstEnv(env, 'EVOMAP_NODE_SECRET', 'A2A_NODE_SECRET');
}
export function resolvePrivateEnterpriseSubject(env) {
    return firstEnv(env, 'EVOMAP_ENTERPRISE_SUBJECT', 'EVOMAP_PRIVATE_SUBJECT', 'PHUB_ENTERPRISE_SUBJECT', 'USER') ?? 'evolver-proxy';
}
export async function connectPrivateProxyHub(opts) {
    const invitationToken = resolvePrivateInvitationToken(opts.env);
    const token = resolvePrivateEnterpriseToken(opts.env);
    const nodeSecret = resolvePrivateNodeSecret(opts.env);
    if (nodeSecret && !isNodeSecret(nodeSecret)) {
        throw new Error('Private Hub node_secret 必须是 64 位十六进制字符串');
    }
    if (!token && !invitationToken && !nodeSecret) {
        throw new Error('EVOMAP_HUB_MODE=private 需要 A2A_NODE_SECRET / EVOMAP_NODE_SECRET、A2A_INVITATION_TOKEN 或 EVOMAP_ENTERPRISE_TOKEN');
    }
    const moduleName = opts.env['EVOMAP_PRIVATE_ADAPTER_MODULE']?.trim() || DEFAULT_PRIVATE_ADAPTER_MODULE;
    const connectPrivateHub = await loadConnectPrivateHub(moduleName, opts.importer ?? ((specifier) => import(specifier)));
    const now = opts.now ?? (() => Date.now());
    const subject = resolvePrivateEnterpriseSubject(opts.env);
    const { hub, auth } = connectPrivateHub({
        hubUrl: opts.hubUrl,
        senderId: opts.senderId,
        env: opts.env,
        now,
        sso: {
            identity: () => ({ subject }),
            exchange: async () => ({ token: token ?? nodeSecret ?? '' }),
            now,
        },
        ...(nodeSecret ? { nodeSecret } : {}),
        ...(!nodeSecret && invitationToken ? { invitationToken } : {}),
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    assertPrivateLifecycle(hub, moduleName);
    if (nodeSecret)
        await adoptReadyNodeSecret(auth, nodeSecret);
    if (!hub.agentDirectory) {
        hub.agentDirectory = hubNs.unsupportedAgentDirectoryCapability('private_hub_agent_directory_not_supported');
    }
    const compatibleHub = withPrivateAccountAssetCompatibility(hub, {
        baseUrl: opts.hubUrl,
        auth,
        senderId: opts.senderId,
        env: opts.env,
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    return {
        hub: compatibleHub,
        auth,
        hello: nodeSecret
            ? async (helloOpts) => await helloWithReadyPrivateCredential(compatibleHub, auth, nodeSecret, opts.senderId, helloOpts)
            : (helloOpts) => compatibleHub.hello(helloOpts),
    };
}
async function loadConnectPrivateHub(moduleName, importer) {
    let loaded;
    try {
        loaded = await importer(moduleName);
    }
    catch (err) {
        throw new Error(`EVOMAP_HUB_MODE=private 需要安装/链接 ${moduleName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mod = asRecord(loaded);
    const connect = mod?.['connectPrivateHub'];
    if (typeof connect !== 'function') {
        throw new Error(`${moduleName} 未导出 connectPrivateHub，无法装配 private hub runtime`);
    }
    return connect;
}
function assertPrivateLifecycle(hub, moduleName) {
    const candidate = asRecord(hub);
    if (typeof candidate?.['hello'] !== 'function' || typeof candidate['heartbeat'] !== 'function') {
        throw new Error(`${moduleName} 的 hub 缺少 hello/heartbeat lifecycle 方法，无法接入 evolver-proxy`);
    }
}
async function adoptReadyNodeSecret(auth, nodeSecret) {
    const candidate = auth;
    if (typeof candidate.adoptNodeSecret === 'function') {
        candidate.adoptNodeSecret.call(auth, nodeSecret);
    }
    if (!await authenticatesWithNodeSecret(auth, nodeSecret)) {
        throw new Error('private Hub adapter cannot activate the configured node_secret');
    }
}
async function helloWithReadyPrivateCredential(hub, auth, nodeSecret, senderId, opts) {
    if (await authenticatesWithNodeSecret(auth, nodeSecret))
        return readyPrivateHello(senderId);
    return await hub.hello(opts);
}
async function authenticatesWithNodeSecret(auth, nodeSecret) {
    const signed = await auth.authenticate({ method: 'GET', path: '/a2a/assets/published-by-me' });
    const authorization = headerValue(signed.headers, 'authorization');
    const bodySecret = signed.bodyFields?.['node_secret'];
    return authorization === `Bearer ${nodeSecret}` || bodySecret === nodeSecret;
}
function headerValue(headers, name) {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower)
            return value;
    }
    return undefined;
}
function trimmedSenderId(senderId) {
    return senderId()?.trim() || undefined;
}
function readyPrivateHello(senderId) {
    const nodeId = trimmedSenderId(senderId);
    return { ok: true, ...(nodeId ? { nodeId } : {}) };
}
function isNodeSecret(value) {
    return /^[a-f0-9]{64}$/i.test(value);
}
function firstEnv(env, ...keys) {
    for (const key of keys) {
        const value = env[key]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}