import { CredentialStore } from './credentialStore.js';
import { resolveMachineId, machineFingerprint } from './machineId.js';
export const TOKEN_TTL_MS = 24 * 60 * 60_000; // fallback only; the hub supplies expiresInMs (~1h)
export const ROTATE_BEFORE_MS = 5 * 60_000; // refresh 5min before expiry (hub access tokens are short-lived ~1h)
/**
 * device token 认证(M6-5, 默认路径 evolver login). device code flow(学 gh auth login):
 * 显示 user code → 用户在浏览器授权 → 轮询拿 token. 绑机器指纹(CEO: OS machineId+软兜底).
 * hub access token 短寿(~1h)+ refresh_token 续期; 过期前 ROTATE_BEFORE_MS 自动 rotate.
 */
export class PublicOAuthProvider {
    opts;
    kind = 'oauth_device_token';
    store;
    now;
    sleep;
    maxWaitMs;
    constructor(opts) {
        this.opts = opts;
        this.store = new CredentialStore(opts.credPath);
        this.now = opts.now ?? (() => Date.now());
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
    }
    fingerprint() { return machineFingerprint(resolveMachineId(this.opts.machine).id); }
    /**
     * Full device-flow login: reuse a still-valid cached token, else request a
     * device code (shown once via onUserCode) and poll until the user approves in
     * the browser, returning + persisting the credential. Drives the poll loop
     * itself (respecting the server interval); a terminal error from the transport
     * (access_denied / expired_token) propagates.
     */
    async login() {
        const cached = this.store.load();
        if (cached && 'token' in cached && (cached.expiresAt ?? 0) - ROTATE_BEFORE_MS > this.now())
            return cached;
        const fp = this.fingerprint();
        const dc = await this.opts.transport.requestDeviceCode(fp);
        (this.opts.onUserCode ?? ((d) => { process.stdout.write(`授权码 ${d.userCode} → ${d.verificationUri}\n`); }))(dc);
        const deadline = this.now() + this.maxWaitMs;
        let intervalMs = dc.intervalMs;
        for (;;) {
            const res = await this.opts.transport.pollToken(dc.deviceCode);
            if (!('pending' in res))
                return this.persist(res, fp);
            if (this.now() >= deadline)
                throw new Error('device_flow_timeout');
            await this.sleep(intervalMs);
            intervalMs += 1000; // gentle back-off; the hub's slow_down also surfaces as pending
        }
    }
    async authenticate() {
        let cred = this.store.load();
        if (!cred || !('token' in cred))
            throw new Error('oauth 未登录, 先 login()');
        if ((cred.expiresAt ?? 0) - ROTATE_BEFORE_MS <= this.now())
            cred = await this.rotate();
        return { headers: { authorization: `Bearer ${cred.token}`, 'x-evomap-device': cred.device ?? '' } };
    }
    async rotate() {
        const cred = this.store.load();
        const fp = this.fingerprint();
        // Prefer a seamless refresh_token rotation; fall back to a fresh device-flow
        // login only when there is no usable refresh token (or no refresh transport).
        if (cred && 'refreshToken' in cred && cred.refreshToken && this.opts.transport.refresh) {
            const res = await this.opts.transport.refresh(cred.refreshToken);
            return this.persist(res, fp, cred.refreshToken);
        }
        return this.login();
    }
    async revoke() { }
    // fallbackRefresh: carry the prior refresh token forward when the hub's refresh
    // response does not rotate it (so a later rotate() still has one to use).
    persist(res, fingerprint, fallbackRefresh) {
        const refreshToken = res.refreshToken ?? fallbackRefresh;
        const cred = {
            id: `oauth-${fingerprint.slice(0, 12)}`, kind: 'oauth_device_token', device: fingerprint,
            token: res.token, expiresAt: this.now() + (res.expiresInMs ?? TOKEN_TTL_MS),
            ...(refreshToken ? { refreshToken } : {}),
        };
        this.store.save(cred);
        return cred;
    }
}