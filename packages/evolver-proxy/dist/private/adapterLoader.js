import { hub as hubNs } from '@evomap/evolver-core';
import { createHash } from 'node:crypto';
import { normalizePrivateHubBaseUrl, withPrivateAccountAssetCompatibility, } from './accountAssetCompatibility.js';
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
    const invitationFingerprint = invitationToken
        ? createHash('sha256').update(invitationToken).digest('hex')
        : undefined;
    const usableInvitationToken = invitationFingerprint !== opts.storedInvitationFingerprint
        ? invitationToken
        : undefined;
    const token = resolvePrivateEnterpriseToken(opts.env);
    const configuredNodeSecret = resolvePrivateNodeSecret(opts.env);
    const nodeSecret = configuredNodeSecret ?? opts.storedNodeSecret?.trim();
    if (nodeSecret && !isNodeSecret(nodeSecret)) {
        throw new Error('Private Hub node_secret 必须是 64 位十六进制字符串');
    }
    if (!token && !usableInvitationToken && !nodeSecret) {
        throw new Error('EVOMAP_HUB_MODE=private 需要 A2A_NODE_SECRET / EVOMAP_NODE_SECRET、A2A_INVITATION_TOKEN 或 EVOMAP_ENTERPRISE_TOKEN');
    }
    const hubUrl = normalizePrivateHubBaseUrl(opts.hubUrl, opts.env);
    const moduleName = opts.env['EVOMAP_PRIVATE_ADAPTER_MODULE']?.trim() || DEFAULT_PRIVATE_ADAPTER_MODULE;
    const connectPrivateHub = await loadConnectPrivateHub(moduleName, opts.importer ?? ((specifier) => import(specifier)));
    const now = opts.now ?? (() => Date.now());
    const subject = resolvePrivateEnterpriseSubject(opts.env);
    const baseConnectionOptions = {
        hubUrl,
        senderId: opts.senderId,
        env: opts.env,
        now,
        sso: {
            identity: () => ({ subject }),
            exchange: async () => ({ token: token ?? nodeSecret ?? '' }),
            now,
        },
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    };
    const primaryInvitationToken = !nodeSecret && !configuredNodeSecret ? usableInvitationToken : undefined;
    const { hub, auth } = connectPrivateHub({
        ...baseConnectionOptions,
        ...(nodeSecret ? { nodeSecret } : {}),
        ...(primaryInvitationToken ? { invitationToken: primaryInvitationToken } : {}),
    });
    assertPrivateLifecycle(hub, moduleName);
    const storedInvitationFallback = nodeSecret && !configuredNodeSecret && usableInvitationToken
        ? connectPrivateHub({ ...baseConnectionOptions, invitationToken: usableInvitationToken })
        : undefined;
    const enterpriseFallback = primaryInvitationToken && token
        ? connectPrivateHub(baseConnectionOptions)
        : undefined;
    if (storedInvitationFallback)
        assertPrivateLifecycle(storedInvitationFallback.hub, moduleName);
    if (enterpriseFallback)
        assertPrivateLifecycle(enterpriseFallback.hub, moduleName);
    if (nodeSecret)
        await adoptReadyNodeSecret(auth, nodeSecret);
    const primaryAdoptions = trackNodeSecretAdoptions(auth);
    const storedInvitationAdoptions = storedInvitationFallback
        ? trackNodeSecretAdoptions(storedInvitationFallback.auth)
        : undefined;
    const enterpriseAdoptions = enterpriseFallback
        ? trackNodeSecretAdoptions(enterpriseFallback.auth)
        : undefined;
    if (!hub.agentDirectory) {
        hub.agentDirectory = hubNs.unsupportedAgentDirectoryCapability('private_hub_agent_directory_not_supported');
    }
    const compatibleHub = withPrivateAccountAssetCompatibility(hub, {
        baseUrl: hubUrl,
        auth,
        senderId: opts.senderId,
        env: opts.env,
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    let readyHelloPending = Boolean(nodeSecret);
    let invitationRedeemed = false;
    let enterpriseFallbackSelected = false;
    let helloInProgress = false;
    const helloWithFallback = async (fallback, adoptions, helloOpts, rotate) => {
        if (!adoptions?.available) {
            throw new Error('private Hub adapter cannot report node_secret adoption');
        }
        if (rotate)
            await fallback.auth.rotate();
        const { result, adoptedNodeSecret } = await adoptions.capture(() => fallback.hub.hello(helloOpts));
        if (!result.ok)
            return result;
        if (!adoptedNodeSecret)
            throw new Error('private Hub fallback did not adopt a node_secret');
        await adoptReadyNodeSecret(fallback.auth, adoptedNodeSecret);
        await adoptReadyNodeSecret(auth, adoptedNodeSecret);
        opts.onNodeSecretAdopted?.(adoptedNodeSecret);
        return result;
    };
    const helloOnce = async (helloOpts) => {
        if (enterpriseFallbackSelected || invitationRedeemed) {
            if (!enterpriseFallback)
                return { ok: false, error: 'private_invitation_reenrollment_required' };
            return helloWithFallback(enterpriseFallback, enterpriseAdoptions, helloOpts, true);
        }
        if (primaryInvitationToken && !primaryAdoptions.available) {
            throw new Error('private Hub adapter cannot report node_secret adoption');
        }
        let result;
        let adoptedNodeSecret;
        let usedAdapterHello = false;
        if (nodeSecret && readyHelloPending) {
            // A stored credential gets one ready probe before a fresh invitation takes over.
            // Clear this before awaiting so a thrown probe cannot starve the fallback forever.
            if (storedInvitationFallback)
                readyHelloPending = false;
            const tracked = await primaryAdoptions.capture(() => helloWithReadyPrivateCredential(compatibleHub, auth, nodeSecret, opts.senderId, helloOpts, primaryAdoptions.available));
            readyHelloPending = false;
            result = tracked.result;
            adoptedNodeSecret = tracked.adoptedNodeSecret;
            if (result.ok && !adoptedNodeSecret && !await authenticatesWithNodeSecret(auth, nodeSecret)) {
                throw new Error('private Hub ready credential hello did not preserve an active node_secret');
            }
        }
        else if (storedInvitationFallback) {
            result = await helloWithFallback(storedInvitationFallback, storedInvitationAdoptions, helloOpts, false);
            if (result.ok) {
                invitationRedeemed = true;
                if (invitationFingerprint)
                    opts.onInvitationRedeemed?.(invitationFingerprint);
            }
            return result;
        }
        else {
            usedAdapterHello = true;
            const tracked = await primaryAdoptions.capture(() => compatibleHub.hello(helloOpts));
            result = tracked.result;
            adoptedNodeSecret = tracked.adoptedNodeSecret;
        }
        if (!result.ok && usedAdapterHello && primaryInvitationToken && enterpriseFallback) {
            const fallbackResult = await helloWithFallback(enterpriseFallback, enterpriseAdoptions, helloOpts, true);
            if (fallbackResult.ok)
                enterpriseFallbackSelected = true;
            return fallbackResult;
        }
        if (result.ok) {
            if (adoptedNodeSecret && adoptedNodeSecret !== nodeSecret) {
                await adoptReadyNodeSecret(auth, adoptedNodeSecret);
                opts.onNodeSecretAdopted?.(adoptedNodeSecret);
            }
            if (usedAdapterHello && primaryInvitationToken) {
                if (!adoptedNodeSecret) {
                    throw new Error('private Hub enrollment did not adopt a node_secret');
                }
                invitationRedeemed = true;
                if (invitationFingerprint)
                    opts.onInvitationRedeemed?.(invitationFingerprint);
            }
        }
        return result;
    };
    const hello = async (helloOpts) => {
        if (helloInProgress)
            throw new Error('concurrent private Hub hello is not supported');
        helloInProgress = true;
        try {
            return await helloOnce(helloOpts);
        }
        finally {
            helloInProgress = false;
        }
    };
    return {
        hub: compatibleHub,
        auth,
        hello,
    };
}
const NODE_SECRET_ADOPTION_TRACKERS = new WeakMap();
function trackNodeSecretAdoptions(auth) {
    const existing = NODE_SECRET_ADOPTION_TRACKERS.get(auth);
    if (existing)
        return existing;
    const candidate = auth;
    const original = candidate.adoptNodeSecret;
    let capturing = false;
    let available = false;
    let adoptedNodeSecret;
    if (typeof original === 'function') {
        const wrapped = function (nodeSecret) {
            original.call(this, nodeSecret);
            if (capturing)
                adoptedNodeSecret = isNodeSecret(nodeSecret) ? nodeSecret : undefined;
        };
        try {
            candidate.adoptNodeSecret = wrapped;
            available = candidate.adoptNodeSecret === wrapped;
        }
        catch {
            // A frozen adapter cannot expose reliable adoption provenance. Enrollment will fail closed below.
        }
    }
    const tracker = {
        get available() { return available; },
        capture: async (operation) => {
            if (capturing)
                throw new Error('concurrent private Hub credential adoption is not supported');
            capturing = true;
            adoptedNodeSecret = undefined;
            try {
                const result = await operation();
                return {
                    result,
                    ...(adoptedNodeSecret ? { adoptedNodeSecret } : {}),
                };
            }
            finally {
                capturing = false;
                adoptedNodeSecret = undefined;
            }
        },
    };
    NODE_SECRET_ADOPTION_TRACKERS.set(auth, tracker);
    return tracker;
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
async function helloWithReadyPrivateCredential(hub, auth, nodeSecret, senderId, opts, canTrackAdoption = true) {
    const nodeId = trimmedSenderId(senderId);
    if (nodeId && await authenticatesWithNodeSecret(auth, nodeSecret))
        return readyPrivateHello(nodeId);
    if (!canTrackAdoption)
        throw new Error('private Hub adapter cannot report node_secret adoption');
    return await hub.hello(opts);
}
async function authenticatesWithNodeSecret(auth, nodeSecret) {
    const signed = await auth.authenticate({ method: 'GET', path: '/a2a/assets/published-by-me' });
    const authorization = headerValue(signed.headers, 'authorization');
    const bodySecret = signed.bodyFields?.['node_secret'];
    return authorization !== undefined
        ? authorization === `Bearer ${nodeSecret}`
        : bodySecret === nodeSecret;
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
function readyPrivateHello(nodeId) {
    return { ok: true, nodeId };
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