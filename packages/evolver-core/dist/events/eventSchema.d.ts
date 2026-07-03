import { z } from 'zod';
export declare const EVENT_SCHEMA_VERSION = "1.0.0";
export declare const replayability: z.ZodEnum<["deterministic", "stochastic_recorded", "stochastic_unreproducible"]>;
export type Replayability = z.infer<typeof replayability>;
/** 每事件自带叙述 (军杰 §9.2). title 必填. */
export declare const humanNarrative: z.ZodObject<{
    title: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    why: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    severity: z.ZodDefault<z.ZodEnum<["info", "notice", "warn", "error"]>>;
    iconHint: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    severity: "warn" | "info" | "notice" | "error";
    title: string;
    detail?: string | undefined;
    why?: string | undefined;
    next?: string | undefined;
    iconHint?: string | undefined;
}, {
    title: string;
    severity?: "warn" | "info" | "notice" | "error" | undefined;
    detail?: string | undefined;
    why?: string | undefined;
    next?: string | undefined;
    iconHint?: string | undefined;
}>;
export type HumanNarrative = z.infer<typeof humanNarrative>;
/** 人/机操作审计 (军杰 §9.7). */
export declare const actor: z.ZodObject<{
    kind: z.ZodDefault<z.ZodEnum<["machine", "human"]>>;
    id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "machine" | "human";
    id?: string | undefined;
}, {
    kind?: "machine" | "human" | undefined;
    id?: string | undefined;
}>;
export type Actor = z.infer<typeof actor>;
/** AE 事件信封 (军杰 §3.2). 内部类型 camelCase. */
export declare const rootEvent: z.ZodObject<{
    seq: z.ZodNumber;
    eventId: z.ZodString;
    ts: z.ZodString;
    type: z.ZodString;
    schemaVersion: z.ZodDefault<z.ZodString>;
    replayability: z.ZodDefault<z.ZodEnum<["deterministic", "stochastic_recorded", "stochastic_unreproducible"]>>;
    payload: z.ZodDefault<z.ZodUnknown>;
    human: z.ZodObject<{
        title: z.ZodString;
        detail: z.ZodOptional<z.ZodString>;
        why: z.ZodOptional<z.ZodString>;
        next: z.ZodOptional<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<["info", "notice", "warn", "error"]>>;
        iconHint: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        severity: "warn" | "info" | "notice" | "error";
        title: string;
        detail?: string | undefined;
        why?: string | undefined;
        next?: string | undefined;
        iconHint?: string | undefined;
    }, {
        title: string;
        severity?: "warn" | "info" | "notice" | "error" | undefined;
        detail?: string | undefined;
        why?: string | undefined;
        next?: string | undefined;
        iconHint?: string | undefined;
    }>;
    actor: z.ZodDefault<z.ZodObject<{
        kind: z.ZodDefault<z.ZodEnum<["machine", "human"]>>;
        id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "machine" | "human";
        id?: string | undefined;
    }, {
        kind?: "machine" | "human" | undefined;
        id?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: string;
    ts: string;
    human: {
        severity: "warn" | "info" | "notice" | "error";
        title: string;
        detail?: string | undefined;
        why?: string | undefined;
        next?: string | undefined;
        iconHint?: string | undefined;
    };
    seq: number;
    eventId: string;
    schemaVersion: string;
    replayability: "deterministic" | "stochastic_recorded" | "stochastic_unreproducible";
    actor: {
        kind: "machine" | "human";
        id?: string | undefined;
    };
    payload?: unknown;
}, {
    type: string;
    ts: string;
    human: {
        title: string;
        severity?: "warn" | "info" | "notice" | "error" | undefined;
        detail?: string | undefined;
        why?: string | undefined;
        next?: string | undefined;
        iconHint?: string | undefined;
    };
    seq: number;
    eventId: string;
    payload?: unknown;
    schemaVersion?: string | undefined;
    replayability?: "deterministic" | "stochastic_recorded" | "stochastic_unreproducible" | undefined;
    actor?: {
        kind?: "machine" | "human" | undefined;
        id?: string | undefined;
    } | undefined;
}>;
export type RootEvent = z.infer<typeof rootEvent>;
/** append 入参: seq/eventId/ts 由 store 生成. */
export type RawEvent = {
    type: string;
    payload?: unknown;
    human: z.input<typeof humanNarrative>;
    actor?: z.input<typeof actor>;
    replayability?: Replayability;
    schemaVersion?: string;
};