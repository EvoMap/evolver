import type { hub } from '@evomap/evolver-core';
/** 公版 inbound 消息(snake_case) → core AgentEvent. */
export declare function inboundToAgentEvent(m: Record<string, unknown>): hub.AgentEvent;
/**
 * SearchQuery(camelCase) → 公版 /a2a/fetch wire(snake_case). 关键: signalsAny → signals(dev 实测 hub 读
 * payload.signals, #69)。text 不是 fetch 字段(自由文本走 semantic-search 端点, 见 hubCapability.search)。
 */
export declare function searchQueryToFetchWire(q: hub.HubQuery): Record<string, unknown>;
/** core AgentEvent(出站) → 公版 outbound 消息(id+type 必填). */
export declare function agentEventToOutbound(e: hub.AgentEvent): Record<string, unknown>;
/** Retry policy for a non-2xx hub status, shared by every money-touching caller (anti-drift, #177). */
export type AtpRetryClass = 'permanent' | 'cooldown' | 'recoverable';
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
export declare function atpRetryClass(status: number): AtpRetryClass;
/** /a2a/publish 响应 → PublishReceipt. 200=accepted; 402/4xx=rejected 终态. */
export declare function publishRespToReceipt(status: number, body: Record<string, unknown>): hub.PublishReceipt;