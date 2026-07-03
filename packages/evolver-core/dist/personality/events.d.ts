import type { Ingestor } from '../events/ingest.js';
import type { RootEvent } from '../events/eventSchema.js';
import { type PersonalityState } from './schema.js';
import type { GateResult } from './riskGate.js';
/**
 * PersonalityState 用途③(可审计): 人格相关变更进事件流.
 * 这里只覆盖 PR-1 两类事件 —— 选定人格 / 风险闸降级; 统计回写与 pivot 属 PR-2.
 * 传薄 Ingestor 接口 (只用 ingest), 不反向依赖 cycleEngine.
 */
export type PersonalityIngestor = Pick<Ingestor, 'ingest'>;
/** 记录本轮选用的人格状态 (注入 prompt 前). */
export declare function emitPersonalitySelected(ingestor: PersonalityIngestor, args: {
    cycleId: string;
    personality: PersonalityState;
    known: boolean;
}): Promise<RootEvent>;
/**
 * 记录风险闸对变异的降级 (仅当真降级了才发; downgraded=false 不发).
 * why 必填 —— 让"Why 面板"能解释这次变异为何被压。
 */
export declare function emitPersonalityRiskGated(ingestor: PersonalityIngestor, args: {
    cycleId: string;
    personality: PersonalityState;
    gate: GateResult;
}): Promise<RootEvent | null>;