import type { hub } from '@evomap/evolver-core';
export interface KeypairProviderOptions {
    credPath: string;
    /** 注册公钥到 hub(注入; M6-6 真 HTTP). 返回 hub 侧凭证 id. */
    registerPublicKey: (publicKeyPem: string) => Promise<{
        credentialId: string;
    }>;
    revokeRemote?: (credentialId: string) => Promise<void>;
    /** Injected clock (test determinism). Default Date.now. */
    now?: () => number;
    /** Injected per-request nonce generator (test determinism). Default 16 random bytes hex. */
    nonceGen?: () => string;
}
/**
 * Ed25519 keypair 认证(M6-5, 进阶/审计级). 私钥只存本机 0600, authenticate 对 body 签名(审计可信源).
 * rotate=生成新对+注册+撤旧. 实现 core AuthProvider.
 */
export declare class KeypairProvider implements hub.AuthProvider {
    private readonly opts;
    readonly kind: "keypair";
    private readonly store;
    constructor(opts: KeypairProviderOptions);
    login(): Promise<hub.Credential>;
    private generate;
    authenticate(req: hub.HttpRequestLike): Promise<hub.SignedRequest>;
    rotate(): Promise<hub.Credential>;
    revoke(credentialId: string): Promise<void>;
    /**
     * Verify a signed request (reference for the hub side). Checks all three: (1) Ed25519 signature over
     * method+path+body+timestamp+nonce, (2) freshness — timestamp within ±maxSkewMs of now, (3) replay —
     * the nonce has not been seen (when a seenNonces set is supplied; it is mutated to record this nonce).
     * Returns false on any failure (bad sig / stale / replayed). The hub keeps seenNonces with a short TTL.
     */
    static verify(publicKeyPem: string, req: hub.HttpRequestLike, signatureB64: string, proof: {
        timestamp: string;
        nonce: string;
    }, opts?: {
        now?: () => number;
        maxSkewMs?: number;
        seenNonces?: Set<string>;
    }): boolean;
}