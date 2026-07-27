/** 公版 inbound 消息(snake_case) → core AgentEvent. */
export function inboundToAgentEvent(m) {
    return {
        id: String(m['id'] ?? ''),
        type: String(m['type'] ?? ''),
        payload: m['payload'],
        priority: m['priority'] ?? 'medium',
        ...(m['cursor'] ? { cursor: String(m['cursor']) } : {}),
        createdAt: typeof m['created_at'] === 'string' ? Date.parse(m['created_at']) : Number(m['created_at'] ?? 0),
        ...(m['ref_id'] ? { refId: String(m['ref_id']) } : {}),
    };
}
/**
 * SearchQuery(camelCase) → 公版 /a2a/fetch wire(snake_case). 关键: signalsAny → signals(dev 实测 hub 读
 * payload.signals, #69)。text 不是 fetch 字段(自由文本走 semantic-search 端点, 见 hubCapability.search)。
 */
export function searchQueryToFetchWire(q) {
    const out = {};
    if (q.signalsAny && q.signalsAny.length > 0)
        out['signals'] = q.signalsAny;
    if (q.kind)
        out['kind'] = q.kind;
    if (q.category)
        out['category'] = q.category;
    if (q.gene)
        out['gene'] = q.gene;
    if (q.limit !== undefined)
        out['limit'] = q.limit;
    return out;
}
/** core AgentEvent(出站) → 公版 outbound 消息(id+type 必填). */
export function agentEventToOutbound(e) {
    return {
        id: e.id,
        type: e.type,
        payload: e.payload,
        priority: e.priority,
        ...(e.refId ? { ref_id: e.refId } : {}),
    };
}
/**
 * Canonical hub-status → retry policy. ONE source of truth so publish and auto-deliver can never drift on which
 * status means what (the #177 root cause: each caller inlined its own classification).
 *  - permanent : structurally dead, NO retry ever helps — 400 bad-request / 404 gone / 409 duplicate /
 *                422 invalid-payload (a malformed proof fails identically forever).
 *  - cooldown  : the hub is explicitly rate-limiting — 429. Retrying next tick violates the cooldown AND
 *                hammers the economic endpoint, so a loop consumer MUST back off before retrying.
 *  - recoverable: environment-recoverable, retry-later is correct — 402 credit top-up / 403 node rebind, and
 *                5xx / network (status 0) server-side blips.
 * A one-shot caller (publishRespToReceipt) renders ALL non-2xx as `terminal: true` regardless of class — it
 * does not auto-retry, the human re-acts. A LOOP caller (atpAutoDeliver) applies the class: permanent → give up,
 * cooldown → backoff, recoverable → retry next tick. Same map, different retry policy per caller.
 */
export function atpRetryClass(status) {
    if (status === 400 || status === 404 || status === 409 || status === 422)
        return 'permanent';
    if (status === 429)
        return 'cooldown';
    return 'recoverable';
}
/** /a2a/publish 响应 → PublishReceipt. 200=accepted; 402/4xx=rejected 终态. */
export function publishRespToReceipt(status, body) {
    const payload = body['payload'] ?? body;
    const assetIds = payload['asset_ids'];
    const targetAssetId = payload['target_asset_id']
        ?? body['target_asset_id'];
    const assetId = (status === 409 ? targetAssetId : undefined)
        ?? payload['asset_id']
        ?? body['asset_id']
        ?? assetIds?.[0]
        ?? targetAssetId;
    const bundleId = payload['bundle_id'];
    if (status >= 200 && status < 300) {
        const decision = String(payload['decision'] ?? payload['status'] ?? 'accepted');
        const accepted = decision === 'accept' || decision === 'accepted' || decision === 'approved' || decision === 'ok';
        return {
            receiptId: String(payload['receipt_id'] ?? bundleId ?? payload['id'] ?? assetId ?? 'unknown'),
            status: accepted ? 'accepted' : (decision === 'quarantine' ? 'quarantine' : 'rejected'),
            ...(assetId ? { assetId } : {}),
            ...(bundleId ? { bundleId } : {}),
            ...(assetIds ? { assetIds } : {}),
            ...(payload['reason'] ? { reason: String(payload['reason']) } : {}),
            terminal: !accepted, // quarantine/rejected 终态不重试
        };
    }
    // M8-1: 按语义而非纯状态码区分(都终态不重试 = money-safety: 不反复打经济端点).
    // 402=creditShortage(余额不足) / 403=node 失效需 rebind / 409=duplicate / 422=payload 须修 / 429=cooldown.
    const reasonByStatus = { 402: 'credit_shortage', 403: 'node_unauthorized', 409: 'duplicate', 422: 'invalid_payload', 429: 'cooldown' };
    const receipt = {
        receiptId: String(payload['receipt_id'] ?? 'rejected'),
        status: 'rejected',
        reason: String(payload['reason'] ?? reasonByStatus[status] ?? `hub ${status}`),
        ...(assetId ? { assetId } : {}),
        ...(assetIds ? { assetIds } : {}),
        terminal: true,
    };
    if (status === 402) {
        receipt.economic = {
            creditShortage: true,
            ...(payload['required'] !== undefined ? { required: Number(payload['required']) } : {}),
            ...(payload['available'] !== undefined ? { available: Number(payload['available']) } : {}),
            ...(payload['balance_kind'] ? { balanceKind: payload['balance_kind'] } : {}),
        };
    }
    return receipt;
}