import { z } from 'zod';
import { ulid, extensions, artifactRef, sourceAgent } from './common.js';
/** 去重 watermark (批注#15): (path,mtime,size)+contentHash 兜底. */
export const watermark = z.object({
    path: z.string(),
    mtime: z.number(),
    size: z.number().int().nonnegative(),
    contentHash: z.string().optional(),
});
/** 进化原材料 (环境). 来自 runtime session/tool 日志, 或 agent-无关的 proxy LLM-trace (#95). */
export const material = z.object({
    materialId: ulid,
    /** Runtime agent that produced a session/tool source. Absent for agent-agnostic origins (proxy trace), #95. */
    sourceAgent: sourceAgent.optional(),
    /** Origin class: a runtime agent session, or the proxy gateway's LLM trace (agent-agnostic), #95.
     *  Defaults to runtime_session so pre-#95 records (which only ever held sessions) parse unchanged. */
    sourceKind: z.enum(['runtime_session', 'proxy_trace']).default('runtime_session'),
    sourcePath: z.string(),
    kind: z.enum(['session_log', 'tool_event', 'llm_trace']), // 双吃分级 D17; llm_trace = proxy 网关遥测 (#95)
    watermark,
    capturedAt: z.string().datetime(),
    consumerGroup: z.string(),
    payloadRef: artifactRef.optional(),
    payload: z.unknown().optional(), // <=64KB inline; 超走 payloadRef (硬化 B)
    feedsMaterial: z.boolean().default(true),
    extensions,
}).superRefine((m, ctx) => {
    // Origin self-consistency (#95): a runtime session must name its agent; an agent-agnostic proxy trace must
    // NOT carry one (there is no honest runtime-agent identity to record). Turns the convention into a hard gate.
    if (m.sourceKind === 'runtime_session' && !m.sourceAgent)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceAgent'], message: 'runtime_session material requires sourceAgent' });
    if (m.sourceKind === 'proxy_trace' && m.sourceAgent)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceAgent'], message: 'proxy_trace material is agent-agnostic and must not carry sourceAgent' });
    // kind ↔ origin (#100 bugbot): llm_trace is proxy-only; runtime sessions are session_log/tool_event. Without
    // this, a record could be llm_trace yet runtime_session+agent, contradicting the agent-agnostic trace model.
    if (m.sourceKind === 'proxy_trace' && m.kind !== 'llm_trace')
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'proxy_trace material must have kind llm_trace' });
    if (m.sourceKind === 'runtime_session' && m.kind === 'llm_trace')
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'llm_trace kind is proxy-only; a runtime_session cannot be llm_trace' });
});
/** 增量读取游标 (硬化 A14): 与 Material 解耦. */
export const sourceCursor = z.object({
    sourcePath: z.string(),
    consumerGroup: z.string(),
    byteOffset: z.number().int().nonnegative().default(0),
    lineSeq: z.number().int().nonnegative().default(0),
    lastWatermark: watermark.optional(),
});
/** Material payload inline 上限 (硬化 B): 超走 artifact 引用. */
export const MATERIAL_PAYLOAD_INLINE_MAX_BYTES = 64 * 1024;