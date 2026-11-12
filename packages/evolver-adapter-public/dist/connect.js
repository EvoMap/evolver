import { homedir } from 'node:os';
import { join } from 'node:path';
import { hub as hubNs } from '@evomap/evolver-core';
import { PublicHubCapability } from './hubCapability.js';
import { globalFetchLike } from './hubFetch.js';
import { LegacyAuthShim } from './auth/legacyShim.js';
import { PublicOAuthProvider } from './auth/oauthDeviceToken.js';
import { createOAuthHttpTransport } from './auth/oauthHttpTransport.js';
import { KeypairProvider } from './auth/keypair.js';
import { resolveWorkspaceId, resolveWorkspaceRootForIdentity } from './auth/workspaceKeychain.js';
/** 选址装配公版 hub(M6-7): 按 authMode 组 AuthProvider(M6-5) + PublicHubCapability(M6-6). */
export function connectPublicHub(opts) {
    const dir = opts.evomapDir ?? join(homedir(), '.evomap');
    const fetchFn = opts.fetchFn ?? globalFetchLike;
    let auth;
    switch (opts.authMode) {
        case 'legacy':
            auth = new LegacyAuthShim(opts.nodeSecret, opts.onNodeSecretRotated, opts.nodeSecretVersion, opts.onNodeSecretVersionUpdated, opts.onNodeSecretDiverged);
            break;
        case 'keypair':
            if (!opts.registerPublicKey)
                throw new Error('keypair 模式需 registerPublicKey');
            auth = new KeypairProvider({
                credPath: join(dir, 'keys', 'keypair.json'),
                registerPublicKey: opts.registerPublicKey,
            });
            break;
        case 'oauth': {
            // Default to the real HTTP device-flow transport derived from hubUrl;
            // tests/embedders may still inject their own.
            const transport = opts.oauthTransport ?? createOAuthHttpTransport({ hubUrl: opts.hubUrl, fetchFn });
            auth = new PublicOAuthProvider({
                credPath: join(dir, 'token.json'),
                machine: { softIdPath: join(dir, 'machine-id') },
                transport,
                ...(opts.expectedOAuthTokenBinding !== undefined ? { expectedTokenBinding: opts.expectedOAuthTokenBinding } : {}),
            });
            break;
        }
        default: {
            const _x = opts.authMode;
            throw new Error(`未知 authMode: ${String(_x)}`);
        }
    }
    return {
        hub: new PublicHubCapability({
            baseUrl: opts.hubUrl,
            auth,
            fetchFn,
            senderId: opts.senderId,
            antiAbuse: withWorkspaceIdResolver(opts.antiAbuse),
            ...clientsOf(opts),
            ...(opts.onMalformedPublishReceipt ? { onMalformedPublishReceipt: opts.onMalformedPublishReceipt } : {}),
        }),
        auth,
    };
}
// A Proxy passes the clients it serves; a one-shot CLI process serves the one client that started it, named in its env.
function clientsOf(opts) {
    if (opts.clients)
        return { clients: opts.clients };
    const processClient = hubNs.clientIdentityFromEnv(opts.antiAbuse?.env ?? process.env);
    if (!processClient)
        return {};
    return { clients: () => [{ ...processClient, last_seen: new Date().toISOString() }], processClient };
}
function withWorkspaceIdResolver(antiAbuse) {
    if (antiAbuse?.workspaceId || antiAbuse?.workspaceIdResolver)
        return antiAbuse;
    const env = antiAbuse?.env ?? process.env;
    let workspaceRoot;
    return {
        ...(antiAbuse ?? {}),
        workspaceIdResolver: () => {
            workspaceRoot ??= resolveWorkspaceRootForIdentity({ env });
            return resolveWorkspaceId({ env, workspaceRoot });
        },
    };
}