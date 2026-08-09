import { specForType, type Direction, type Handler } from './catalog.js';
export type Status = 'pending' | 'in_flight' | 'done' | 'failed' | 'expired';
export type Priority = 'high' | 'normal' | 'low';
export declare const PRIORITIES: readonly ["high", "normal", "low"];
export declare const ENVELOPE_SCHEMA_VERSION = "1.1.0";
export interface Envelope {
    id: string;
    type: string;
    direction: Direction;
    status: Status;
    handler: Handler;
    payload: unknown;
    correlationId: string;
    replyTo: string | null;
    receiptId: string;
    idempotencyKey: string;
    sourceAgent: string;
    targetAgent: string;
    runtimeNamespace: string;
    priority: Priority;
    attempts: number;
    nextRetryAt: number | null;
    ttlAt: number | null;
    createdAt: number;
    updatedAt: number;
    schemaVersion: string;
    feedsMaterial: boolean;
    lastError: string | null;
}
/** 固定 envelope 字段集 (schema-snapshot 锁; 增删字段必须改此处). */
export declare const ENVELOPE_FIELDS: readonly (keyof Envelope)[];
/** 防原型污染 (v1 GHSA). */
export declare function sanitizePayload(v: unknown): unknown;
export interface CreateEnvelopeInput {
    id?: string;
    type: string;
    payload?: unknown;
    correlationId?: string;
    replyTo?: string | null;
    idempotencyKey?: string;
    sourceAgent?: string;
    targetAgent?: string;
    runtimeNamespace?: string;
    priority?: unknown;
    now?: number;
}
export declare function normalizePriority(value: unknown): Priority;
export declare function createEnvelope(input: CreateEnvelopeInput): Envelope;
export { specForType };