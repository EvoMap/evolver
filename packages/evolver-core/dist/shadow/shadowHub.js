import { computeAssetId } from '../wire/index.js';
/**
 * shadow 包 HubCapability(M8-1-shadow-c). shadow 下三类碰 hub 状态的动作只记录不执行:
 * - publish → WOULD_PUBLISH, 返回**伪正常回执**(status:accepted/terminal:false), 否则 makeHubBindings
 *   抛 PublishRejectedError 改 SyncEngine 异常/DLQ 路由污染对账(gotcha #1/#4)。
 * - task.complete → WOULD_SETTLE(ATP 结算意图, money-safety 高敏)。
 * - mailbox.push → WOULD_PUSH。
 * 其余(fetch/search/mailbox.poll/ack/status/auth/capabilities)直通真 cap(只读不碰状态)。
 * enforce 模式直接返回原 cap(零开销 pass-through, 秒级回滚)。
 */
export function shadowHubCapability(cap, sink, mode) {
    if (mode === 'enforce')
        return cap;
    return {
        auth: cap.auth,
        publish: async (bundle) => {
            const assetIds = bundle.map((a) => computeAssetId(a) ?? 'sha256:unknown');
            for (const a of bundle)
                sink.record({ action: 'WOULD_PUBLISH', assetId: computeAssetId(a) ?? 'sha256:unknown', assetKind: a.type, payloadSize: JSON.stringify(a).length });
            return { receiptId: `shadow-${(assetIds[0] ?? 'x').slice(7, 19)}`, status: 'accepted', assetId: assetIds[0], assetIds, bundleId: `shadow-bundle`, terminal: false };
        },
        fetch: (q) => cap.fetch(q),
        search: (q) => cap.search(q),
        task: {
            claim: (taskId) => cap.task.claim(taskId), // claim 只读不碰结算, 直通
            complete: async (claimId, result) => {
                sink.record({ action: 'WOULD_SETTLE', claimId, payloadSize: JSON.stringify(result ?? null).length });
                return { status: 'completed' };
            },
            subscribe: (f) => cap.task.subscribe(f),
        },
        mailbox: {
            poll: () => cap.mailbox.poll(),
            ack: (id) => cap.mailbox.ack(id),
            status: () => cap.mailbox.status(),
            push: async (e) => {
                sink.record({ action: 'WOULD_PUSH', envelopeType: e.type, payloadSize: JSON.stringify(e.payload ?? null).length });
            },
        },
        ...(cap.capabilities ? { capabilities: () => cap.capabilities() } : {}),
    };
}