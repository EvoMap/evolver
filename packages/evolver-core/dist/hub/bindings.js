import { normalizeForPut } from '../assetstore/provider.js';
import { sanitizeBundle, summarizeLeaks } from './sanitize.js';
/** publish 回执非 accepted → 抛此错; SyncEngine 据 terminal 决定是否重试. */
export class PublishRejectedError extends Error {
    status;
    terminal;
    retryAfterMs;
    retryable;
    constructor(status, terminal, reason, retryAfterMs, retryable) {
        super(`publish ${status}${reason ? `: ${reason}` : ''}`);
        this.status = status;
        this.terminal = terminal;
        this.retryAfterMs = retryAfterMs;
        this.retryable = retryable;
        this.name = 'PublishRejectedError';
    }
}
function envelopeToAgentEvent(e) {
    const stableId = e.type === 'proxy_trace' && e.idempotencyKey ? e.idempotencyKey : e.id;
    return {
        id: stableId,
        type: e.type === 'dm_outbound' ? 'dm' : e.type,
        payload: e.payload,
        priority: 'medium',
        createdAt: e.createdAt,
        ...(e.type === 'proxy_trace' && e.idempotencyKey ? { refId: e.idempotencyKey } : {}),
    };
}
/**
 * 把 HubCapability 接到 core 两 seam(M6-1):
 * - asProxyHandler: Dispatcher.handlers.proxy — 按 envelope.type 路由到 hub. 抛错→store.fail()重试;
 *   但 publish 终态(reject/quarantine/402)抛 PublishRejectedError{terminal:true}, 调用方据此不重试(money-safety).
 * - asAssetTransport: assetstore RemoteTransport — 落库前 core normalizeForPut, 不信任远端 asset_id.
 */
export function makeHubBindings(cap, options = {}) {
    const sanCfg = options.sanitize ?? {};
    const sanEnabled = sanCfg.enabled ?? true;
    const sanEnv = sanCfg.env ?? (typeof process !== 'undefined' ? process.env : {});
    /** Single publish chokepoint: sanitize (on by default) → strict + leak found → refuse (terminal, not retryable) → cap.publish the redacted bundle. */
    const publishSanitized = async (bundle, publishOptions) => {
        if (!sanEnabled)
            return publishOptions ? cap.publish(bundle, publishOptions) : cap.publish(bundle);
        const r = sanitizeBundle(bundle, { env: sanEnv, ...(sanCfg.mode ? { mode: sanCfg.mode } : {}) });
        if (r.blocked) {
            throw new PublishRejectedError('leak_blocked', true, `sensitive data detected before publish, refused (not retryable): ${summarizeLeaks(r.leaks)}`);
        }
        const receipt = publishOptions
            ? await cap.publish(r.bundle, publishOptions)
            : await cap.publish(r.bundle);
        const submittedAssetIds = contentAssetIds(r.bundle);
        return submittedAssetIds ? { ...receipt, submittedAssetIds } : receipt;
    };
    return {
        asProxyHandler() {
            return async (e) => {
                switch (e.type) {
                    case 'asset_submit': {
                        // payload 可为 bundle {assets:[...]} 或单资产; 统一成 bundle 数组发.
                        const p = e.payload;
                        const bundle = Array.isArray(p.assets) ? p.assets : [p];
                        const r = await publishSanitized(bundle, { idempotencyKey: e.idempotencyKey });
                        if (r.status !== 'accepted') {
                            throw new PublishRejectedError(r.rejection?.code ?? r.status, r.terminal ?? true, r.reason, r.rejection?.retryAfterMs);
                        }
                        return r;
                    }
                    case 'task_claim': {
                        const p = e.payload;
                        return cap.task.claim(firstString(p.taskId, p.task_id) ?? '');
                    }
                    case 'task_complete': {
                        const p = e.payload;
                        const taskId = firstString(p.taskId, p.task_id);
                        const assetId = firstString(p.assetId, p.asset_id);
                        const claimId = firstString(p.claimId, p.claim_id);
                        if (!claimId) {
                            throw new PublishRejectedError('invalid_task_complete', true, 'claim_id is required because task claim handles are opaque');
                        }
                        const context = taskId && assetId ? { taskId, assetId } : undefined;
                        return cap.task.complete(claimId, p.result, context);
                    }
                    default:
                        // 其余 outbound(atp_*/heartbeat/...) 走 mailbox.push
                        await cap.mailbox.push(envelopeToAgentEvent(e));
                        return { pushed: true };
                }
            };
        },
        asAssetTransport() {
            return {
                putRemote: async (record) => {
                    const { record: clean } = normalizeForPut(record); // 不信任远端 asset_id, core 侧重算
                    const r = await publishSanitized([clean]); // 单资产传输也走 bundle API([asset]) + 发布前脱敏
                    return { stored: r.status === 'accepted' };
                },
                getRemote: async (assetId) => {
                    const got = await cap.fetch({ limit: 10000 });
                    return got.find((a) => a.asset_id === assetId) ?? null;
                },
                searchRemote: (query) => cap.search(query),
                listRemote: (kind, limit) => cap.fetch({ ...(kind ? { kind } : {}), limit }),
            };
        },
    };
}
function contentAssetIds(bundle) {
    const ids = bundle.map((asset) => asset.asset_id);
    return ids.every((id) => typeof id === 'string' && /^sha256:[a-f0-9]{64}$/i.test(id))
        ? ids
        : undefined;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (trimmed)
            return trimmed;
    }
    return undefined;
}