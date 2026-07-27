import { hub as hubNs } from '@evomap/evolver-core';
import type { HelloResult, HeartbeatOptions, HeartbeatResult } from '../lifecycle/manager.js';
import { type PrivateAccountAssetHub, type PrivateCompatibilityFetch } from './accountAssetCompatibility.js';
export type PrivateHubWithLifecycle = hubNs.HubCapability & {
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<HelloResult>;
    heartbeat(opts?: HeartbeatOptions): Promise<HeartbeatResult>;
};
export type PrivateProxyHub = PrivateHubWithLifecycle & PrivateAccountAssetHub;
interface PrivateSsoExchange {
    identity: () => {
        subject: string;
        claims?: Record<string, unknown>;
    };
    exchange: (identity: {
        subject: string;
        claims?: Record<string, unknown>;
    }) => Promise<{
        token: string;
        expiresInMs?: number;
    }>;
    now?: () => number;
}
export interface ConnectPrivateHubOptions {
    hubUrl: string;
    sso: PrivateSsoExchange;
    senderId: () => string | undefined;
    env?: Record<string, string | undefined>;
    now?: () => number;
    /** One-shot invitation token (evoinv_…) — preferred over the SSO bearer for token_required hubs. */
    invitationToken?: string;
    /** Ready credential from the standard Private Hub onboarding store. */
    nodeSecret?: string;
    fetchFn?: PrivateCompatibilityFetch;
}
type DynamicImporter = (specifier: string) => Promise<unknown>;
export interface PrivateProxyHubRuntime {
    hub: PrivateProxyHub;
    auth: hubNs.AuthProvider;
    /** Enrollment-aware lifecycle entrypoint. Ready node_secret credentials must not re-run hello. */
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<HelloResult>;
}
export interface ConnectPrivateProxyHubOptions {
    hubUrl: string;
    senderId: () => string | undefined;
    env: Record<string, string | undefined>;
    now?: () => number;
    importer?: DynamicImporter;
    fetchFn?: PrivateCompatibilityFetch;
    /** Durable credential minted by a previous invitation/SSO enrollment. */
    storedNodeSecret?: string;
    /** Persist a newly minted credential before the process can restart. */
    onNodeSecretAdopted?: (nodeSecret: string) => void;
    /** Fingerprint of the last successfully redeemed one-shot invitation. */
    storedInvitationFingerprint?: string;
    /** Persist the non-secret fingerprint after an invitation is redeemed. */
    onInvitationRedeemed?: (fingerprint: string) => void;
}
export declare function resolvePrivateEnterpriseToken(env: Record<string, string | undefined>): string | undefined;
/** One-shot invitation token (evoinv_…), matching the hub's official onboarding script (A2A_INVITATION_TOKEN).
 *  Preferred over the enterprise token for the default token_required enrollment mode. */
export declare function resolvePrivateInvitationToken(env: Record<string, string | undefined>): string | undefined;
export declare function resolvePrivateNodeSecret(env: Record<string, string | undefined>): string | undefined;
export declare function resolvePrivateEnterpriseSubject(env: Record<string, string | undefined>): string;
export declare function connectPrivateProxyHub(opts: ConnectPrivateProxyHubOptions): Promise<PrivateProxyHubRuntime>;
export {};