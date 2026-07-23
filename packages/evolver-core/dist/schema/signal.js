import { z } from 'zod';
import { ulid, extensions } from './common.js';
/** 三层签名·工程层 (军杰 §4.2). camelCase (内部类型, schema §0 / 硬化 A10). */
export const eventSignature = z.string();
/** 三层签名·领域层 (军杰 §4.3), 不含 gene_id. */
export const problemSignature = z.string();
/** 选择压. 三条腿: 结构化强 / corpus 弱 / agent 自标 (批注#13). */
export const signal = z.object({
    signalId: ulid,
    fromMaterial: z.array(ulid).default([]),
    kind: z.enum(['strong_structured', 'weak_corpus', 'agent_marked', 'verified_success']),
    text: z.string(),
    score: z.number().min(0).max(1).default(0),
    eventSignature,
    problemSignature,
    signatureV: z.number().int().positive().default(1),
    discoveredAt: z.string().datetime(),
    extensions,
});