import type { hub } from '@evomap/evolver-core';
export declare function isNodeSecret(value: string): boolean;
export declare function parseNodeSecretVersion(value: unknown): number | undefined;
export type NodeSecretRotationHandler = (nodeSecret: string, nodeSecretVersion?: number) => void;
export type NodeSecretVersionHandler = (nodeSecretVersion?: number) => void;
/**
 * Fired when the hub HTTP-200s an app-level rejection of our cached node_secret
 * (reason ∈ {node_secret_invalid, rotation_requires_current_secret, invalid_secret}).
 * The locally-cached secret has DIVERGED from the hub's record (hub-side reset,
 * restored-from-backup machine, manual unlink). The handler owns clearing the
 * durable copies (store keys + on-disk legacy files) so the next start re-acquires
 * cleanly via an unauthenticated hello. Mirrors v1 a2aProtocol.js divergence recovery.
 */
export type NodeSecretDivergenceHandler = () => void;
/**
 * LegacyAuthShim exposes node_secret as a transport-neutral credential field. HubFetch promotes it to
 * Authorization: Bearer for GET and strict GEP envelope endpoints before egress.
 */
export declare class LegacyAuthShim implements hub.AuthProvider {
    private nodeSecret;
    private readonly onRotate?;
    private readonly onVersionUpdate?;
    private readonly onDiverged?;
    readonly kind: "oauth_device_token";
    private nodeSecretVersion?;
    constructor(nodeSecret: string | undefined, onRotate?: NodeSecretRotationHandler | undefined, initialNodeSecretVersion?: number, onVersionUpdate?: NodeSecretVersionHandler | undefined, onDiverged?: NodeSecretDivergenceHandler | undefined);
    login(): Promise<hub.Credential>;
    authenticate(): Promise<hub.SignedRequest>;
    rotate(): Promise<hub.Credential>;
    revoke(): Promise<void>;
    getNodeSecretVersion(): number | undefined;
    adoptNodeSecret(nodeSecret: string, nodeSecretVersion?: number): void;
    adoptNodeSecretVersion(nodeSecretVersion?: number): void;
    clearNodeSecret(): void;
    /**
     * Hub rejected our cached node_secret as diverged (v1 a2aProtocol.js L1983-2017).
     * Drop the in-memory secret + version so buildHubHeaders/authenticate fall back to
     * unauthenticated on the next /a2a/hello, then hand off to onDiverged for the durable
     * clear (store keys + on-disk legacy files). Does NOT route through onVersionUpdate —
     * the divergence handler performs the full clear, including the version, atomically.
     */
    notifyNodeSecretDiverged(): void;
}