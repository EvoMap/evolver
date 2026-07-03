import { mailbox, hub as hubNs } from '@evomap/evolver-core';
import { clearLastUpdateOnAck, isLastUpdateRelatedError, readPendingLastUpdate, shouldClearForLastUpdateAck, } from '../selfUpdate/lastUpdate.js';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 360_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_BACKOFF_CAP_MS = 15 * 60_000;
export const MAX_REAUTH_ATTEMPTS = 2;
export const REAUTH_BACKOFF_BASE_MS = 30 * 60_000;
export const REAUTH_BACKOFF_MAX_MS = 4 * 60 * 60_000;
export const HUB_UNREACHABLE_BACKOFF_MS = 60_000;
export const HUB_UNREACHABLE_BACKOFF_MAX_MS = 10 * 60_000;
export const MIN_HUB_UNREACHABLE_RETRY_MS = 1_000;
export const MAX_LAST_ERROR_LENGTH = 1_000;
const K = {
    nodeId: 'node_id',
    reauthUntil: 'lifecycle:reauth_until',
    reauthAttempts: 'lifecycle:reauth_attempts',
    helloRlUntil: 'lifecycle:hello_rl_until',
    hubUnreachableUntil: 'lifecycle:hub_unreachable_until',
    authStatus: 'hub:auth_status',
    lastError: 'sync:last_error',
    nodeSecret: 'node_secret',
    nodeSecretSource: 'node_secret_source',
    nodeSecretVersion: 'node_secret_version',
};
/**
 * LifecycleManager(M6-3): hello/heartbeat/reauth 状态机, 移植 v1 lifecycle/manager.js.
 * node_secret 解析下沉到 HubCapability.auth(M6-5 LegacyAuthShim 双轨); 本层只管:
 * 注册(hello, 持久化 node_id)、心跳节奏、403/401→auth.rotate() 退避(30m→4h, MAX 2 次)、hello 限流尊重.
 * 纯逻辑注入 now/hello/heartbeat → 对 FakeHubCapability 确定性测.
 */
export class LifecycleManager {
    deps;
    reauthInProgress = false;
    constructor(deps) {
        this.deps = deps;
    }
    get nodeId() { return this.deps.store.getState(K.nodeId); }
    /** 当前上报版本(供 force_update 决策 / hub fleet 观测). */
    get version() { return this.deps.evolverVersion; }
    /** 注册. 尊重 hub hello 限流窗口; 成功持久化 node_id + 清 reauth 退避. 随报当前版本(hub 观测 fleet). */
    async doHello(rotate = false) {
        const now = this.deps.now();
        const hubWait = this.hubUnreachableWaitMs(now);
        if (hubWait > 0)
            return { ok: false, error: 'hub_unreachable_backoff', retryAfterMs: hubWait };
        const rlUntil = Number(this.deps.store.getState(K.helloRlUntil) ?? 0);
        if (rlUntil > now) {
            this.deps.store.setState(K.authStatus, 'rate_limited');
            this.deps.store.setState(K.lastError, `hello_rate_limited:${rlUntil}`);
            return { ok: false, error: 'hello_rate_limited' };
        }
        let res;
        try {
            res = await this.callHello(rotate);
        }
        catch (err) {
            // v1 parity (src/gep/a2aProtocol.js sendHelloToHub, src/proxy/lifecycle/manager.js#hello):
            // hello never rethrows — every failure resolves to {ok:false}. A hub link
            // drop backs off; any other failure (incl. 401/403) lands on the failure
            // terminal in one shot. The hub never rejects auth on node_secret_version
            // (it is a backfill hint only), so there is NO "strip version and retry
            // hello" path. Version clearing is driven solely by the hub response
            // (HubCapability.hello adopts version=undefined when the hub omits it) and
            // by the reauth rotate prelude (clearLegacyNodeSecretVersion before rotate).
            if (isHubUnreachable(err)) {
                return { ok: false, error: 'hub_unreachable', retryAfterMs: this.recordHubUnreachable(err, now) };
            }
            if (isAuthError(err)) {
                res = { ok: false, authError: true, error: safeErrorMessage(err), httpStatus: errorStatus(err) };
            }
            else if (isHubClientError(err)) {
                res = { ok: false, error: safeErrorMessage(err), httpStatus: errorStatus(err) };
            }
            else {
                throw err;
            }
        }
        if (isHubUnreachableResult(res))
            this.recordHubUnreachable(res, now);
        if (res.rateLimitUntilMs)
            this.deps.store.setState(K.helloRlUntil, String(res.rateLimitUntilMs));
        if (res.ok && res.nodeId) {
            this.deps.store.setState(K.nodeId, res.nodeId);
            this.deps.store.setState(K.reauthAttempts, '0');
            this.deps.store.setState(K.reauthUntil, '0');
            this.deps.store.setState(K.hubUnreachableUntil, '0');
            this.deps.store.setState(K.helloRlUntil, '0');
            this.deps.store.setState(K.authStatus, 'ok');
            this.deps.store.setState(K.lastError, '');
        }
        else if (!res.ok) {
            // Secret divergence (HTTP 200, secret already cleared in-memory + durably by HubCapability):
            // do NOT mark auth_failed, do NOT reauth, do NOT arm backoff. The next tick re-hellos
            // unauthenticated and recovers (v1 a2aProtocol.js secret-divergence carve-out). Checked
            // before authError so a diverged secret never enters the reauth-rotate ladder.
            if (res.secretDiverged) {
                this.deps.store.setState(K.authStatus, 'secret_diverged');
                this.deps.store.setState(K.lastError, `hello:${res.error ?? 'secret_diverged'}`);
            }
            else if (res.authError) {
                this.deps.store.setState(K.authStatus, 'auth_failed');
                this.deps.store.setState(K.lastError, `hello:${safeErrorMessage(res.error ?? 'auth_error')}`);
                if (!rotate)
                    await this.reauthenticate();
            }
            else {
                if (res.rateLimitUntilMs)
                    this.deps.store.setState(K.authStatus, 'rate_limited');
                this.deps.store.setState(K.lastError, `hello:${safeErrorMessage(res.error ?? 'failed')}`);
            }
        }
        return res;
    }
    /** 心跳. authError → 触发 reauth 状态机. 随心跳上报当前版本(hub 观测 fleet, #108). */
    async doHeartbeat() {
        try {
            if (this.hubUnreachableWaitMs(this.deps.now()) > 0)
                return { ok: false, reauthed: false };
            const hb = this.heartbeatOptions();
            const sentLastUpdate = hb?.lastUpdate;
            const res = await this.deps.heartbeat(hb);
            // Read `now` AFTER the network round-trip so hub-unreachable backoff windows and lastUpdate ack
            // timing are measured from when the response arrived, not from before the request was sent.
            const now = this.deps.now();
            this.handleLastUpdateAck(res, sentLastUpdate, now);
            this.maybeTriggerForceUpdate(res);
            if (res.ok) {
                this.deps.store.setState(K.hubUnreachableUntil, '0');
                this.deps.store.setState(K.authStatus, 'ok');
                this.deps.store.setState(K.lastError, '');
                return { ok: true, reauthed: false };
            }
            if (res.status === 'unknown_node') {
                this.deps.store.setState(K.authStatus, 'unknown_node');
                this.deps.store.setState(K.lastError, 'heartbeat:unknown_node');
                await this.doHello(false);
                return { ok: false, reauthed: false };
            }
            if (isHubUnreachableResult(res)) {
                this.recordHubUnreachable(res, now);
                return { ok: false, reauthed: false };
            }
            if (res.authError) {
                this.deps.store.setState(K.authStatus, 'auth_failed');
                this.deps.store.setState(K.lastError, `heartbeat:${res.error ?? 'auth_error'}`);
                const reauthed = await this.reauthenticate();
                return { ok: false, reauthed };
            }
            this.deps.store.setState(K.lastError, `heartbeat:${res.error ?? 'failed'}`);
            return { ok: false, reauthed: false };
        }
        catch (err) {
            if (isHubUnreachable(err)) {
                this.recordHubUnreachable(err, this.deps.now());
                return { ok: false, reauthed: false };
            }
            const error = this.recordHeartbeatException(err);
            return { ok: false, reauthed: false, error };
        }
    }
    nextHeartbeatDelay(consecutiveFailures = 0) {
        try {
            const hubWait = this.hubUnreachableWaitMs(this.deps.now());
            if (hubWait > 0)
                return Math.max(MIN_HUB_UNREACHABLE_RETRY_MS, hubWait);
        }
        catch {
            // Store read threw (corrupt state) — treat as a failure signal: force at least one backoff
            // step (base*2) rather than retrying at the bare base interval against a broken local store.
            return this.heartbeatFailureBackoffDelay(Math.max(1, consecutiveFailures));
        }
        return this.heartbeatFailureBackoffDelay(consecutiveFailures);
    }
    heartbeatFailureBackoffDelay(consecutiveFailures) {
        const base = Math.max(MIN_HEARTBEAT_INTERVAL_MS, this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
        if (consecutiveFailures <= 0)
            return base;
        const cap = Math.max(base, HEARTBEAT_BACKOFF_CAP_MS);
        const multiplier = 2 ** Math.min(consecutiveFailures, 30);
        return Math.min(base * multiplier, cap);
    }
    recordHeartbeatException(err) {
        const message = safeErrorMessage(err);
        try {
            this.deps.store.setState(K.lastError, `heartbeat_exception:${message}`);
        }
        catch (stateErr) {
            return `${message}; state_write_failed:${safeErrorMessage(stateErr)}`;
        }
        return message;
    }
    /**
     * 403/401 重认证. 指数退避 30m→4h, 超 MAX_REAUTH_ATTEMPTS 长退避;
     * auth.rotate() 成功后重 hello(rotate) 再注册. 退避状态持久化(进程重启不复位).
     */
    async reauthenticate() {
        const now = this.deps.now();
        if (this.reauthInProgress)
            return false;
        if (this.hubUnreachableWaitMs(now) > 0)
            return false;
        const until = Number(this.deps.store.getState(K.reauthUntil) ?? 0);
        if (until > now)
            return false; // 退避中
        this.reauthInProgress = true;
        try {
            const attempts = Number(this.deps.store.getState(K.reauthAttempts) ?? 0) + 1;
            if (attempts > MAX_REAUTH_ATTEMPTS) {
                this.deps.store.setState(K.reauthAttempts, String(attempts));
                this.setBackoff(attempts, now);
                return false;
            }
            try {
                this.clearLegacyNodeSecretVersion();
                await this.deps.auth.rotate();
                const hello = await this.callHello(true);
                if (hello.secretDiverged) {
                    // v1 parity (a2aProtocol.js L1842-1851): the hub rejected our cached secret as
                    // diverged and HubCapability already cleared it (in-memory + store + on-disk files).
                    // Arming the escalating reauth backoff here would block the natural recovery — the
                    // next tick sends an UNAUTHENTICATED hello the hub treats as a fresh registration.
                    // So reset the reauth ladder, surface the signal, and let the next tick re-hello.
                    this.deps.store.setState(K.reauthAttempts, '0');
                    this.deps.store.setState(K.reauthUntil, '0');
                    this.deps.store.setState(K.authStatus, 'secret_diverged');
                    this.deps.store.setState(K.lastError, 'hello:secret_diverged_cleared');
                    return false;
                }
                if (hello.ok) {
                    const verified = await this.verifyReauthHeartbeat(now);
                    if (verified === 'ok') {
                        this.deps.store.setState(K.reauthAttempts, '0');
                        this.deps.store.setState(K.reauthUntil, '0');
                        this.deps.store.setState(K.hubUnreachableUntil, '0');
                        this.deps.store.setState(K.authStatus, 'recovered');
                        this.deps.store.setState(K.lastError, '');
                        return true;
                    }
                    if (verified === 'hub_unreachable')
                        return false;
                    this.deps.store.setState(K.reauthAttempts, String(attempts));
                    this.setBackoff(attempts, now);
                    return false;
                }
                if (isHubUnreachableResult(hello)) {
                    this.recordHubUnreachable(hello, now);
                    return false;
                }
                this.deps.store.setState(K.reauthAttempts, String(attempts));
                this.setBackoff(attempts, now);
                return false;
            }
            catch (err) {
                if (isHubUnreachable(err)) {
                    this.recordHubUnreachable(err, now);
                    return false;
                }
                this.deps.store.setState(K.reauthAttempts, String(attempts));
                this.setBackoff(attempts, now);
                return false;
            }
        }
        finally {
            this.reauthInProgress = false;
        }
    }
    setBackoff(attempts, now) {
        const backoff = Math.min(REAUTH_BACKOFF_BASE_MS * 2 ** (attempts - 1), REAUTH_BACKOFF_MAX_MS);
        this.deps.store.setState(K.reauthUntil, String(now + backoff));
        this.deps.store.setState(K.authStatus, 'backoff');
        this.deps.store.setState(K.lastError, `reauth_backoff:${attempts}`);
    }
    hubUnreachableWaitMs(now) {
        return Math.max(0, Number(this.deps.store.getState(K.hubUnreachableUntil) ?? 0) - now);
    }
    recordHubUnreachable(err, now) {
        const retryAfter = retryAfterMs(err);
        this.deps.store.setState(K.hubUnreachableUntil, String(now + retryAfter));
        this.deps.store.setState(K.authStatus, 'hub_unreachable');
        this.deps.store.setState(K.lastError, `hub_unreachable:${safeErrorMessage(err)}`);
        return retryAfter;
    }
    clearLegacyNodeSecretVersion() {
        if (this.deps.helloMode === 'enterprise_token')
            return;
        const auth = this.deps.auth;
        this.deps.store.setState(K.nodeSecretVersion, '');
        auth.adoptNodeSecretVersion?.(undefined);
    }
    async verifyReauthHeartbeat(now) {
        try {
            const opts = this.heartbeatOptions();
            const hb = await this.deps.heartbeat(opts);
            this.handleLastUpdateAck(hb, opts?.lastUpdate, now);
            this.maybeTriggerForceUpdate(hb);
            if (hb.ok)
                return 'ok';
            if (isHubUnreachableResult(hb)) {
                this.recordHubUnreachable(hb, now);
                return 'hub_unreachable';
            }
            return 'failed';
        }
        catch (err) {
            if (isHubUnreachable(err)) {
                this.recordHubUnreachable(err, now);
                return 'hub_unreachable';
            }
            throw err;
        }
    }
    heartbeatOptions() {
        const opts = {};
        if (this.deps.evolverVersion)
            opts.evolverVersion = this.deps.evolverVersion;
        const lastUpdate = readPendingLastUpdate(this.deps.store, this.deps.now());
        if (lastUpdate)
            opts.lastUpdate = lastUpdate;
        return Object.keys(opts).length > 0 ? opts : undefined;
    }
    callHello(rotate) {
        const safeRotate = this.deps.helloMode === 'enterprise_token' ? false : rotate;
        return this.deps.hello({ rotate: safeRotate, ...(this.deps.evolverVersion ? { evolverVersion: this.deps.evolverVersion } : {}) });
    }
    handleLastUpdateAck(res, sent, now) {
        if (!sent)
            return;
        if (shouldClearForLastUpdateAck(res.lastUpdateAck)) {
            clearLastUpdateOnAck(this.deps.store, sent, now);
            return;
        }
        if (res.lastUpdateAck?.reason === 'failed')
            return;
        if (res.httpStatus === 400 && (isLastUpdateRelatedError(res.error) || isLastUpdateRelatedError(res.details))) {
            clearLastUpdateOnAck(this.deps.store, sent, now);
            return;
        }
        if (res.ok && res.status !== 'unknown_node' && !res.lastUpdateAck) {
            clearLastUpdateOnAck(this.deps.store, sent, now);
        }
    }
    maybeTriggerForceUpdate(res) {
        if (!res.forceUpdate || typeof res.forceUpdate !== 'object')
            return;
        const source = res.httpStatus === 426 ? 'heartbeat_426' : 'heartbeat_200';
        void this.deps.onForceUpdateDirective?.(res.forceUpdate, source);
    }
}
function isHubUnreachable(err) {
    const e = err;
    return e?.name === 'HubUnreachableError' || e?.code === 'HUB_UNREACHABLE' || e?.error === 'hub_unreachable';
}
function isAuthError(err) {
    const e = err;
    return e?.name === 'AuthError' || e?.authError === true;
}
function isHubClientError(err) {
    const e = err;
    return e?.name === 'HubClientError' && typeof e.status === 'number';
}
function errorStatus(err) {
    const status = err?.status;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
function isHubUnreachableResult(res) {
    return res?.error === 'hub_unreachable' || res?.error === 'hub_unreachable_backoff';
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * Redact secrets/PII then cap length before any durable, UI-exposed telemetry write to
 * `sync:last_error` (mirrors ProxyDaemon's safeHeartbeatTickErrorMessage so the two layers
 * apply the same floor). redactString is pure/total but wrapped defensively.
 */
function safeErrorMessage(err) {
    const message = errorMessage(err);
    try {
        return hubNs.redactString(message).slice(0, MAX_LAST_ERROR_LENGTH);
    }
    catch {
        return message.slice(0, MAX_LAST_ERROR_LENGTH);
    }
}
function retryAfterMs(err) {
    const retry = err?.retryAfterMs
        ?? err?.details?.retryAfterMs;
    const delay = Math.max(MIN_HUB_UNREACHABLE_RETRY_MS, typeof retry === 'number' && Number.isFinite(retry) ? retry : HUB_UNREACHABLE_BACKOFF_MS);
    return Math.min(delay, HUB_UNREACHABLE_BACKOFF_MAX_MS);
}