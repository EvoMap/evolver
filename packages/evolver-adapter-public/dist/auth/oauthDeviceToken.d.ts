import type { hub } from '@evomap/evolver-core';
import { type MachineIdOptions } from './machineId.js';
export declare const TOKEN_TTL_MS: number;
export declare const ROTATE_BEFORE_MS: number;
export interface DeviceCodeResp {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalMs: number;
}
export interface TokenResp {
    token: string;
    expiresInMs?: number;
    refreshToken?: string;
}
/** 注入的 OAuth device flow 传输(M6-6 真 HTTP; 测试用桩). refresh 走 refresh_token grant. */
export interface OAuthTransport {
    requestDeviceCode: (fingerprint: string) => Promise<DeviceCodeResp>;
    pollToken: (deviceCode: string) => Promise<TokenResp | {
        pending: true;
    }>;
    refresh?: (refreshToken: string) => Promise<TokenResp>;
}
export interface PublicOAuthOptions {
    credPath: string;
    machine: MachineIdOptions;
    transport: OAuthTransport;
    now?: () => number;
    /** 展示 user code 给用户(默认 console). */
    onUserCode?: (d: DeviceCodeResp) => void;
    /** 轮询间隔等待(默认 setTimeout; 测试可注入 no-op). */
    sleep?: (ms: number) => Promise<void>;
    /** 整个 device flow 的最长等待(默认 15min); 超时抛 device_flow_timeout. */
    maxWaitMs?: number;
}
/**
 * device token 认证(M6-5, 默认路径 evolver login). device code flow(学 gh auth login):
 * 显示 user code → 用户在浏览器授权 → 轮询拿 token. 绑机器指纹(CEO: OS machineId+软兜底).
 * hub access token 短寿(~1h)+ refresh_token 续期; 过期前 ROTATE_BEFORE_MS 自动 rotate.
 */
export declare class PublicOAuthProvider implements hub.AuthProvider {
    private readonly opts;
    readonly kind: "oauth_device_token";
    private readonly store;
    private readonly now;
    private readonly sleep;
    private readonly maxWaitMs;
    constructor(opts: PublicOAuthOptions);
    private fingerprint;
    /**
     * Full device-flow login: reuse a still-valid cached token, else request a
     * device code (shown once via onUserCode) and poll until the user approves in
     * the browser, returning + persisting the credential. Drives the poll loop
     * itself (respecting the server interval); a terminal error from the transport
     * (access_denied / expired_token) propagates.
     */
    login(): Promise<hub.Credential>;
    authenticate(): Promise<hub.SignedRequest>;
    rotate(): Promise<hub.Credential>;
    revoke(): Promise<void>;
    private persist;
}