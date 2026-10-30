import { z } from 'zod';
import { ulid, recordEntry } from '../schema/common.js';
export const EVENT_SCHEMA_VERSION = '1.0.0';
export const replayability = z.enum(['deterministic', 'stochastic_recorded', 'stochastic_unreproducible']);
/** 每事件自带叙述 (军杰 §9.2). title 必填. */
export const humanNarrative = z.object({
    title: z.string().min(1).max(80),
    detail: z.string().optional(),
    why: z.string().optional(),
    next: z.string().optional(),
    severity: z.enum(['info', 'notice', 'warn', 'error']).default('info'),
    iconHint: z.string().optional(),
});
/** 人/机操作审计 (军杰 §9.7). */
export const actor = z.object({
    kind: z.enum(['machine', 'human']).default('machine'),
    id: z.string().optional(),
});
/** AE 事件信封 (军杰 §3.2). 内部类型 camelCase. */
export const rootEvent = z.object({
    seq: z.number().int().nonnegative(),
    eventId: ulid,
    ts: z.string().datetime(),
    type: z.string().min(1),
    schemaVersion: z.string().default(EVENT_SCHEMA_VERSION),
    replayability: replayability.default('deterministic'),
    payload: z.unknown().default({}),
    human: humanNarrative,
    actor: actor.default({ kind: 'machine' }),
    /** Replay identity minted by the root writer (local or separate-UID service), never raw client metadata. */
    auditOperationId: z.string().min(1).max(128).optional(),
    auditRequestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    /** Experience writer's witnessed physical namespace, never caller supplied. */
    experienceAuditNamespace: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
// Raw in-process events have not necessarily crossed JSON yet. Guard only actor's
// record slot; payload is deliberately unknown and must retain its existing domain.
const rootEventInput = recordEntry.pipe(rootEvent.extend({
    actor: recordEntry.pipe(actor).default({ kind: 'machine' }),
}));
export function parseRootEvent(input) {
    return rootEventInput.parse(input);
}