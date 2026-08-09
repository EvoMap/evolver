import { ulid as makeUlid } from 'ulid';
import { specForType, assertKnownType } from './catalog.js';
export const PRIORITIES = Object.freeze(['high', 'normal', 'low']);
export const ENVELOPE_SCHEMA_VERSION = '1.1.0';
/** 固定 envelope 字段集 (schema-snapshot 锁; 增删字段必须改此处). */
export const ENVELOPE_FIELDS = [
    'id', 'type', 'direction', 'status', 'handler', 'payload', 'correlationId', 'replyTo',
    'receiptId', 'idempotencyKey', 'sourceAgent', 'targetAgent', 'runtimeNamespace',
    'priority', 'attempts', 'nextRetryAt', 'ttlAt', 'createdAt', 'updatedAt', 'schemaVersion', 'feedsMaterial',
    'lastError',
];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** 防原型污染 (v1 GHSA). */
export function sanitizePayload(v) {
    if (Array.isArray(v))
        return v.map(sanitizePayload);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v))
            if (!FORBIDDEN_KEYS.has(k))
                out[k] = sanitizePayload(val);
        return out;
    }
    return v;
}
const TTL_MS = { control: 60 * 60 * 1000, default: 7 * 24 * 60 * 60 * 1000 };
export function normalizePriority(value) {
    return value === 'high' || value === 'low' ? value : 'normal';
}
export function createEnvelope(input) {
    const spec = assertKnownType(input.type);
    const id = input.id ?? makeUlid();
    const now = input.now ?? Date.now();
    return {
        id,
        type: input.type,
        direction: spec.direction,
        status: 'pending',
        handler: spec.handler,
        payload: sanitizePayload(input.payload ?? {}),
        correlationId: input.correlationId ?? id,
        replyTo: input.replyTo ?? null,
        receiptId: id, // 投递即返(异步不变量)
        idempotencyKey: input.idempotencyKey ?? id, // 副作用类型应传业务键(硬化 A13)
        sourceAgent: input.sourceAgent ?? '',
        targetAgent: input.targetAgent ?? '',
        runtimeNamespace: input.runtimeNamespace ?? 'default',
        priority: normalizePriority(input.priority),
        attempts: 0,
        nextRetryAt: null,
        ttlAt: now + TTL_MS[spec.ttlClass],
        createdAt: now,
        updatedAt: now,
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        feedsMaterial: spec.feedsMaterial,
        lastError: null,
    };
}
export { specForType };