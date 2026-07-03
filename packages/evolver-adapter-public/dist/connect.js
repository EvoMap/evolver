import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicHubCapability } from './hubCapability.js';
import { globalFetchLike } from './hubFetch.js';
import { LegacyAuthShim } from './auth/legacyShim.js';
import { PublicOAuthProvider } from './auth/oauthDeviceToken.js';
import { createOAuthHttpTransport } from './auth/oauthHttpTransport.js';
import { KeypairProvider } from './auth/keypair.js';
/** 选址装配公版 hub(M6-7): 按 authMode 组 AuthProvider(M6-5) + PublicHubCapability(M6-6). */
export function connectPublicHub(opts) {
    const dir = opts.evomapDir ?? join(homedir(), '.evomap');
    const fetchFn = opts.fetchFn ?? globalFetchLike;
    let auth;
    switch (opts.authMode) {
        case 'legacy':
            if (!opts.nodeSecret)
                throw new Error('legacy 模式需 nodeSecret');
            auth = new LegacyAuthShim(opts.nodeSecret, opts.onNodeSecretRotated, opts.nodeSecretVersion, opts.onNodeSecretVersionUpdated, opts.onNodeSecretDiverged);
            break;
        case 'keypair':
            if (!opts.registerPublicKey)
                throw new Error('keypair 模式需 registerPublicKey');
            auth = new KeypairProvider({ credPath: join(dir, 'keys', 'keypair.json'), registerPublicKey: opts.registerPublicKey });
            break;
        case 'oauth': {
            // Default to the real HTTP device-flow transport derived from hubUrl;
            // tests/embedders may still inject their own.
            const transport = opts.oauthTransport ?? createOAuthHttpTransport({ hubUrl: opts.hubUrl, fetchFn });
            auth = new PublicOAuthProvider({ credPath: join(dir, 'token.json'), machine: { softIdPath: join(dir, 'machine-id') }, transport });
            break;
        }
        default: {
            const _x = opts.authMode;
            throw new Error(`未知 authMode: ${String(_x)}`);
        }
    }
    return { hub: new PublicHubCapability({ baseUrl: opts.hubUrl, auth, fetchFn, senderId: opts.senderId, antiAbuse: opts.antiAbuse }), auth };
}