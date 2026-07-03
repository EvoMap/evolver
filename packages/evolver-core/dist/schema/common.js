import { z } from 'zod';
/** evolver-core 内部 domain schema 版本 (与 gep-sdk SCHEMA_VERSION 解耦). */
export const DOMAIN_SCHEMA_VERSION = '1.0.0';
/** ULID (26 char Crockford base32). */
export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');
export const sha256Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'invalid sha256');
/** 防过早冻结的扩展字段 (军杰 §11). */
export const extensions = z.record(z.string(), z.unknown()).default({});
/** 大对象走 artifact 引用. */
export const artifactRef = z.object({
    path: z.string(),
    sha256: z.string(),
    size: z.number().int().nonnegative(),
});
/** runtime 来源 (D11). 'generic-chat' = 任何输出标准 OpenAI/Anthropic messages 的 AI(经 genericChatAdapter 接入). */
export const sourceAgent = z.enum(['claude-code', 'codex', 'cursor', 'gemini', 'kimi', 'kiro', 'opencode', 'generic-chat']);
export const blastRadius = z.enum(['file', 'module', 'package', 'system']);