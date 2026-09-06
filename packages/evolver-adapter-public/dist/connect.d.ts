import type { hub } from '@evomap/evolver-core';
import { PublicHubCapability } from './hubCapability.js';
import type { AntiAbuseTelemetryOptions } from './antiAbuseTelemetry.js';
import type { MalformedPublishReceiptEvent } from './hubCapability.js';
import { type FetchLike } from './hubFetch.js';
import { type OAuthTransport } from './auth/oauthDeviceToken.js';
export type AuthMode = 'oauth' | 'keypair' | 'legacy';
export interface ConnectPublicOptions {
    hubUrl: string;
    authMode: AuthMode;
    senderId: () => string | undefined;
    fetchFn?: FetchLike;
    evomapDir?: string;
    /** legacy 模式: 64-hex node_secret. */
    nodeSecret?: string;
    /** legacy 模式: node_secret 对应的可选 Hub keyring version. */
    nodeSecretVersion?: number;
    /** legacy 模式: hello rotate 返回新 node_secret 后持久化到调用方状态存储. */
    onNodeSecretRotated?: (nodeSecret: string, nodeSecretVersion?: number) => void;
    /** legacy 模式: hello 返回 version 但未轮换 secret 时持久化 version. */
    onNodeSecretVersionUpdated?: (nodeSecretVersion?: number) => void;
    /**
     * legacy 模式: hub HTTP-200 拒绝本地 node_secret(已与 hub 记录漂移)时回调.
     * 实现方负责清除持久副本(store keys + 磁盘 legacy 文件), 下次启动以未认证 hello 重新获取.
     * v1 a2aProtocol.js 的 secret-divergence 自愈.
     */
    onNodeSecretDiverged?: () => void;
    /** oauth 模式: device flow 传输(缺省=真 HTTP, 此处需注入或由 hubUrl 推导). */
    oauthTransport?: OAuthTransport;
    /** keypair 模式: 注册公钥到 hub. */
    registerPublicKey?: (pem: string) => Promise<{
        credentialId: string;
    }>;
    /** Optional anti-abuse metadata context for heartbeat payloads. */
    antiAbuse?: AntiAbuseTelemetryOptions;
    /** Optional non-sensitive notification when publish returns malformed 2xx JSON. */
    onMalformedPublishReceipt?: (event: MalformedPublishReceiptEvent) => void;
}
/** 选址装配公版 hub(M6-7): 按 authMode 组 AuthProvider(M6-5) + PublicHubCapability(M6-6). */
export declare function connectPublicHub(opts: ConnectPublicOptions): {
    hub: PublicHubCapability;
    auth: hub.AuthProvider;
};