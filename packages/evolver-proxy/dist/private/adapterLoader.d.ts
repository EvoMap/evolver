import { hub as hubNs } from '@evomap/evolver-core';
import type { HelloResult, HeartbeatOptions, HeartbeatResult } from '../lifecycle/manager.js';
export type PrivateHubWithLifecycle = hubNs.HubCapability & {
    hello(opts: {
        rotate: boolean;
        evolverVersion?: string;
    }): Promise<HelloResult>;
    heartbeat(opts?: HeartbeatOptions): Promise<HeartbeatResult>;
};
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
}
type DynamicImporter = (specifier: string) => Promise<unknown>;
export interface PrivateProxyHubRuntime {
    hub: PrivateHubWithLifecycle;
    auth: hubNs.AuthProvider;
}
export interface ConnectPrivateProxyHubOptions {
    hubUrl: string;
    senderId: () => string | undefined;
    env: Record<string, string | undefined>;
    now?: () => number;
    importer?: DynamicImporter;
}
export declare function resolvePrivateEnterpriseToken(env: Record<string, string | undefined>): string | undefined;
/** One-shot invitation token (evoinv_…), matching the hub's official onboarding script (A2A_INVITATION_TOKEN).
 *  Preferred over the enterprise token for the default token_required enrollment mode. */
export declare function resolvePrivateInvitationToken(env: Record<string, string | undefined>): string | undefined;
export declare function resolvePrivateEnterpriseSubject(env: Record<string, string | undefined>): string;
export declare function connectPrivateProxyHub(opts: ConnectPrivateProxyHubOptions): Promise<PrivateProxyHubRuntime>;
export {};