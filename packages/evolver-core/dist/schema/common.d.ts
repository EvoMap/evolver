import { z } from 'zod';
/** evolver-core 内部 domain schema 版本 (与 gep-sdk SCHEMA_VERSION 解耦). */
export declare const DOMAIN_SCHEMA_VERSION = "1.0.0";
/** Native brands do not execute then/catch getters or inspect user prototypes.
 * Do not recurse: unknown extension values may legitimately contain these objects. */
export declare function nonRecordObjectType(value: unknown): 'promise' | 'map' | 'set' | 'date' | 'uninspectable' | undefined;
export declare const recordEntry: z.ZodUnknown;
/** ULID (26 char Crockford base32). */
export declare const ulid: z.ZodString;
export declare const sha256Hash: z.ZodString;
/** 防过早冻结的扩展字段 (军杰 §11). */
export declare const extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
/** 大对象走 artifact 引用. */
export declare const artifactRef: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
    size: z.ZodNumber;
}, z.core.$strip>;
export type ArtifactRef = z.infer<typeof artifactRef>;
/** runtime 来源 (D11). 'generic-chat' = 任何输出标准 OpenAI/Anthropic messages 的 AI(经 genericChatAdapter 接入). */
export declare const sourceAgent: z.ZodEnum<{
    cursor: "cursor";
    "claude-code": "claude-code";
    codex: "codex";
    gemini: "gemini";
    antigravity: "antigravity";
    kimi: "kimi";
    kiro: "kiro";
    opencode: "opencode";
    "generic-chat": "generic-chat";
}>;
export type SourceAgent = z.infer<typeof sourceAgent>;
export declare const blastRadius: z.ZodEnum<{
    file: "file";
    module: "module";
    package: "package";
    system: "system";
}>;
export type BlastRadius = z.infer<typeof blastRadius>;