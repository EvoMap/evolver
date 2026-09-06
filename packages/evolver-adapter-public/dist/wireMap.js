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
    if (q.domain)
        out['domain'] = q.domain;
    if (q.limit !== undefined)
        out['limit'] = q.limit;
    return out;
}
/** Free discovery phase on /a2a/fetch. Keep this separate from the paid/full fetch mapper. */
export function searchQueryToSearchOnlyWire(q) {
    return { ...searchQueryToFetchWire(q), search_only: true };
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
/** /a2a/publish 响应 → PublishReceipt. 2xx 必须包含显式成功/拒绝决议；缺失或畸形回执 fail closed. */
export function publishRespToReceipt(status, body, retryAfterMs) {
    const bodyRecord = isRecord(body) ? body : {};
    const rawPayload = bodyRecord['payload'];
    const malformedPayload = rawPayload !== undefined && !isRecord(rawPayload);
    const payload = isRecord(rawPayload) ? rawPayload : bodyRecord;
    const rawAssetIds = payload['asset_ids'];
    const malformedAssetIds = rawAssetIds !== undefined
        && (!Array.isArray(rawAssetIds) || rawAssetIds.some((value) => typeof value !== 'string'));
    const assetIds = !malformedAssetIds && Array.isArray(rawAssetIds) ? rawAssetIds : undefined;
    const targetAssetId = stringField(payload, 'target_asset_id') ?? stringField(bodyRecord, 'target_asset_id');
    const assetId = (status === 409 ? targetAssetId : undefined)
        ?? stringField(payload, 'asset_id')
        ?? stringField(bodyRecord, 'asset_id')
        ?? assetIds?.[0]
        ?? targetAssetId;
    const bundleId = stringField(payload, 'bundle_id');
    const receiptId = nonBlankString(payload['receipt_id']);
    const hasDecisionField = Object.prototype.hasOwnProperty.call(payload, 'decision');
    const hasStatusField = Object.prototype.hasOwnProperty.call(payload, 'status');
    const explicitDecision = explicitPublishDecision(payload['decision']);
    const explicitStatus = explicitPublishDecision(payload['status']);
    const decision = explicitDecision ?? explicitStatus;
    const invalidDecisionField = (hasDecisionField && explicitDecision === undefined)
        || (hasStatusField && explicitStatus === undefined);
    const accepted = decision === 'accepted';
    const contradictory = hasDecisionField
        && hasStatusField
        && (explicitDecision === undefined || explicitStatus === undefined || explicitDecision !== explicitStatus);
    const explicitError = hasFieldWithValue(payload, 'error') || hasFieldWithValue(bodyRecord, 'error');
    const explicitOkFalse = payload['ok'] === false || bodyRecord['ok'] === false;
    if (status >= 200 && status < 300) {
        if (decision === undefined
            || malformedPayload
            || invalidDecisionField
            || contradictory
            || explicitError
            || explicitOkFalse
            || malformedAssetIds
            || (accepted && receiptId === undefined)) {
            return {
                receiptId: receiptId ?? 'malformed_receipt',
                status: 'rejected',
                terminal: true,
                reason: 'malformed publish receipt',
                rejection: { code: 'invalid_payload' },
            };
        }
        return {
            receiptId: receiptId ?? 'rejected',
            status: decision,
            ...(assetId ? { assetId } : {}),
            ...(bundleId ? { bundleId } : {}),
            ...(assetIds ? { assetIds } : {}),
            ...(typeof payload['reason'] === 'string' && payload['reason'] ? { reason: payload['reason'] } : {}),
            terminal: decision !== 'accepted', // quarantine/rejected 终态不重试
        };
    }
    // M8-1: 按语义而非纯状态码区分(都终态不重试 = money-safety: 不反复打经济端点).
    // 402=creditShortage(余额不足) / 403=node 失效需 rebind / 409=duplicate / 422=payload 须修 / 429=cooldown.
    const reasonByStatus = { 402: 'credit_shortage', 403: 'node_unauthorized', 409: 'duplicate', 422: 'invalid_payload', 429: 'cooldown' };
    const rejectionCodeByStatus = {
        400: 'invalid_request',
        402: 'credit_shortage',
        403: 'node_unauthorized',
        404: 'not_found',
        409: 'duplicate',
        422: 'invalid_payload',
        429: 'cooldown',
    };
    const receipt = {
        receiptId: receiptId ?? 'rejected',
        status: 'rejected',
        reason: nonBlankString(payload['reason']) ?? reasonByStatus[status] ?? `hub ${status}`,
        ...(assetId ? { assetId } : {}),
        ...(assetIds ? { assetIds } : {}),
        terminal: true,
        rejection: {
            code: rejectionCodeByStatus[status] ?? 'hub_rejected',
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
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
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringField(record, key) {
    return typeof record[key] === 'string' ? record[key] : undefined;
}
function nonBlankString(value) {
    if (typeof value !== 'string')
        return undefined;
    const valueTrimmed = value.trim();
    return valueTrimmed.length > 0 ? valueTrimmed : undefined;
}
function hasFieldWithValue(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
}
function explicitPublishDecision(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    if (normalized === 'accept' || normalized === 'accepted' || normalized === 'approved' || normalized === 'ok')
        return 'accepted';
    if (normalized === 'quarantine')
        return 'quarantine';
    if (normalized === 'reject' || normalized === 'rejected')
        return 'rejected';
    return undefined;
}