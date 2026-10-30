import { z } from 'zod';
export declare const EVENT_SCHEMA_VERSION = "1.0.0";
export declare const replayability: z.ZodEnum<{
    deterministic: "deterministic";
    stochastic_recorded: "stochastic_recorded";
    stochastic_unreproducible: "stochastic_unreproducible";
}>;
export type Replayability = z.infer<typeof replayability>;
/** 每事件自带叙述 (军杰 §9.2). title 必填. */
export declare const humanNarrative: z.ZodObject<{
    title: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    why: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    severity: z.ZodDefault<z.ZodEnum<{
        warn: "warn";
        error: "error";
        info: "info";
        notice: "notice";
    }>>;
    iconHint: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type HumanNarrative = z.infer<typeof humanNarrative>;
/** 人/机操作审计 (军杰 §9.7). */
export declare const actor: z.ZodObject<{
    kind: z.ZodDefault<z.ZodEnum<{
        machine: "machine";
        human: "human";
    }>>;
    id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Actor = z.infer<typeof actor>;
/** AE 事件信封 (军杰 §3.2). 内部类型 camelCase. */
export declare const rootEvent: z.ZodObject<{
    seq: z.ZodNumber;
    eventId: z.ZodString;
    ts: z.ZodString;
    type: z.ZodString;
    schemaVersion: z.ZodDefault<z.ZodString>;
    replayability: z.ZodDefault<z.ZodEnum<{
        deterministic: "deterministic";
        stochastic_recorded: "stochastic_recorded";
        stochastic_unreproducible: "stochastic_unreproducible";
    }>>;
    payload: z.ZodDefault<z.ZodUnknown>;
    human: z.ZodObject<{
        title: z.ZodString;
        detail: z.ZodOptional<z.ZodString>;
        why: z.ZodOptional<z.ZodString>;
        next: z.ZodOptional<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<{
            warn: "warn";
            error: "error";
            info: "info";
            notice: "notice";
        }>>;
        iconHint: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    actor: z.ZodDefault<z.ZodObject<{
        kind: z.ZodDefault<z.ZodEnum<{
            machine: "machine";
            human: "human";
        }>>;
        id: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    auditOperationId: z.ZodOptional<z.ZodString>;
    auditRequestHash: z.ZodOptional<z.ZodString>;
    experienceAuditNamespace: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type RootEvent = z.infer<typeof rootEvent>;
export declare function parseRootEvent(input: unknown): RootEvent;
/** append 入参: seq/eventId/ts 由 store 生成. */
export type RawEvent = {
    type: string;
    payload?: unknown;
    human: z.input<typeof humanNarrative>;
    actor?: z.input<typeof actor>;
    replayability?: Replayability;
    schemaVersion?: string;
    auditOperationId?: string;
    auditRequestHash?: string;
};