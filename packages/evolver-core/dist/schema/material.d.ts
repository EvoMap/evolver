import { z } from 'zod';
/** 去重 watermark (批注#15): (path,mtime,size)+contentHash 兜底. */
export declare const watermark: z.ZodObject<{
    path: z.ZodString;
    mtime: z.ZodNumber;
    size: z.ZodNumber;
    contentHash: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    path: string;
    size: number;
    mtime: number;
    contentHash?: string | undefined;
}, {
    path: string;
    size: number;
    mtime: number;
    contentHash?: string | undefined;
}>;
export type Watermark = z.infer<typeof watermark>;
/** 进化原材料 (环境). 来自 runtime session/tool 日志, 或 agent-无关的 proxy LLM-trace (#95). */
export declare const material: z.ZodEffects<z.ZodObject<{
    materialId: z.ZodString;
    /** Runtime agent that produced a session/tool source. Absent for agent-agnostic origins (proxy trace), #95. */
    sourceAgent: z.ZodOptional<z.ZodEnum<["claude-code", "codex", "cursor", "gemini", "kimi", "kiro", "opencode", "generic-chat"]>>;
    /** Origin class: a runtime agent session, or the proxy gateway's LLM trace (agent-agnostic), #95.
     *  Defaults to runtime_session so pre-#95 records (which only ever held sessions) parse unchanged. */
    sourceKind: z.ZodDefault<z.ZodEnum<["runtime_session", "proxy_trace"]>>;
    sourcePath: z.ZodString;
    kind: z.ZodEnum<["session_log", "tool_event", "llm_trace"]>;
    watermark: z.ZodObject<{
        path: z.ZodString;
        mtime: z.ZodNumber;
        size: z.ZodNumber;
        contentHash: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    }, {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    }>;
    capturedAt: z.ZodString;
    consumerGroup: z.ZodString;
    payloadRef: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        sha256: z.ZodString;
        size: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        path: string;
        sha256: string;
        size: number;
    }, {
        path: string;
        sha256: string;
        size: number;
    }>>;
    payload: z.ZodOptional<z.ZodUnknown>;
    feedsMaterial: z.ZodDefault<z.ZodBoolean>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    materialId: string;
    sourceKind: "runtime_session" | "proxy_trace";
    sourcePath: string;
    kind: "session_log" | "tool_event" | "llm_trace";
    watermark: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    };
    capturedAt: string;
    consumerGroup: string;
    feedsMaterial: boolean;
    extensions: Record<string, unknown>;
    sourceAgent?: "claude-code" | "codex" | "cursor" | "gemini" | "kimi" | "kiro" | "opencode" | "generic-chat" | undefined;
    payloadRef?: {
        path: string;
        sha256: string;
        size: number;
    } | undefined;
    payload?: unknown;
}, {
    materialId: string;
    sourcePath: string;
    kind: "session_log" | "tool_event" | "llm_trace";
    watermark: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    };
    capturedAt: string;
    consumerGroup: string;
    sourceAgent?: "claude-code" | "codex" | "cursor" | "gemini" | "kimi" | "kiro" | "opencode" | "generic-chat" | undefined;
    sourceKind?: "runtime_session" | "proxy_trace" | undefined;
    payloadRef?: {
        path: string;
        sha256: string;
        size: number;
    } | undefined;
    payload?: unknown;
    feedsMaterial?: boolean | undefined;
    extensions?: Record<string, unknown> | undefined;
}>, {
    materialId: string;
    sourceKind: "runtime_session" | "proxy_trace";
    sourcePath: string;
    kind: "session_log" | "tool_event" | "llm_trace";
    watermark: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    };
    capturedAt: string;
    consumerGroup: string;
    feedsMaterial: boolean;
    extensions: Record<string, unknown>;
    sourceAgent?: "claude-code" | "codex" | "cursor" | "gemini" | "kimi" | "kiro" | "opencode" | "generic-chat" | undefined;
    payloadRef?: {
        path: string;
        sha256: string;
        size: number;
    } | undefined;
    payload?: unknown;
}, {
    materialId: string;
    sourcePath: string;
    kind: "session_log" | "tool_event" | "llm_trace";
    watermark: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    };
    capturedAt: string;
    consumerGroup: string;
    sourceAgent?: "claude-code" | "codex" | "cursor" | "gemini" | "kimi" | "kiro" | "opencode" | "generic-chat" | undefined;
    sourceKind?: "runtime_session" | "proxy_trace" | undefined;
    payloadRef?: {
        path: string;
        sha256: string;
        size: number;
    } | undefined;
    payload?: unknown;
    feedsMaterial?: boolean | undefined;
    extensions?: Record<string, unknown> | undefined;
}>;
export type Material = z.infer<typeof material>;
/** 增量读取游标 (硬化 A14): 与 Material 解耦. */
export declare const sourceCursor: z.ZodObject<{
    sourcePath: z.ZodString;
    consumerGroup: z.ZodString;
    byteOffset: z.ZodDefault<z.ZodNumber>;
    lineSeq: z.ZodDefault<z.ZodNumber>;
    lastWatermark: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        mtime: z.ZodNumber;
        size: z.ZodNumber;
        contentHash: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    }, {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    sourcePath: string;
    consumerGroup: string;
    byteOffset: number;
    lineSeq: number;
    lastWatermark?: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    } | undefined;
}, {
    sourcePath: string;
    consumerGroup: string;
    byteOffset?: number | undefined;
    lineSeq?: number | undefined;
    lastWatermark?: {
        path: string;
        size: number;
        mtime: number;
        contentHash?: string | undefined;
    } | undefined;
}>;
export type SourceCursor = z.infer<typeof sourceCursor>;
/** Material payload inline 上限 (硬化 B): 超走 artifact 引用. */
export declare const MATERIAL_PAYLOAD_INLINE_MAX_BYTES: number;