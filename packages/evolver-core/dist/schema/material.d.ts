import { z } from 'zod';
/** 去重 watermark (批注#15): (path,mtime,size)+contentHash 兜底. */
export declare const watermark: z.ZodObject<{
    path: z.ZodString;
    mtime: z.ZodNumber;
    size: z.ZodNumber;
    contentHash: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Watermark = z.infer<typeof watermark>;
/** 进化原材料 (环境). 来自 runtime session/tool 日志, 或 agent-无关的 proxy LLM-trace (#95). */
export declare const material: z.ZodObject<{
    materialId: z.ZodString;
    sourceAgent: z.ZodOptional<z.ZodEnum<{
        cursor: "cursor";
        "claude-code": "claude-code";
        codex: "codex";
        gemini: "gemini";
        antigravity: "antigravity";
        kimi: "kimi";
        workbuddy: "workbuddy";
        dsh: "dsh";
        grok: "grok";
        kiro: "kiro";
        opencode: "opencode";
        "generic-chat": "generic-chat";
    }>>;
    sourceKind: z.ZodDefault<z.ZodEnum<{
        runtime_session: "runtime_session";
        proxy_trace: "proxy_trace";
    }>>;
    sourcePath: z.ZodString;
    kind: z.ZodEnum<{
        session_log: "session_log";
        tool_event: "tool_event";
        llm_trace: "llm_trace";
    }>;
    watermark: z.ZodObject<{
        path: z.ZodString;
        mtime: z.ZodNumber;
        size: z.ZodNumber;
        contentHash: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    capturedAt: z.ZodString;
    consumerGroup: z.ZodString;
    payloadRef: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        sha256: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strip>>;
    payload: z.ZodOptional<z.ZodUnknown>;
    feedsMaterial: z.ZodDefault<z.ZodBoolean>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
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
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SourceCursor = z.infer<typeof sourceCursor>;
/** Material payload inline 上限 (硬化 B): 超走 artifact 引用. */
export declare const MATERIAL_PAYLOAD_INLINE_MAX_BYTES: number;