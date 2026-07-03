import type { RootEvent } from '../events/eventSchema.js';
import type { PersonalityIngestor } from './events.js';
import type { PersonalityStore } from './store.js';
import { type SelectInput, type SelectResult } from './select.js';
import { type UpdateStatsInput, type UpdateStatsResult } from './stats.js';
import { type ForcePivotInput, type ForcePivotResult } from './pivot.js';
export interface EvolveDeps {
    store: PersonalityStore;
    /** 可选: 传了就把变更记进事件流 (personality.mutated / stats_updated / pivoted). */
    ingestor?: PersonalityIngestor;
    /** 关联的 cycle (进 payload, 便于回溯). */
    cycleId?: string;
}
/** 每轮开始: 选人格 (自然选择 + 触发变异), 落盘, 发 personality.mutated (仅当真有变异). */
export declare function applySelectForRun(deps: EvolveDeps, input?: SelectInput): Promise<SelectResult>;
/** 每轮结束: 把 outcome/score 回写到对应人格桶, 落盘, 发 personality.stats_updated. */
export declare function applyStatsUpdate(deps: EvolveDeps, input: UpdateStatsInput): Promise<UpdateStatsResult>;
/** 平台期: 强制转向到探索模式, 落盘, 发 personality.pivoted. */
export declare function applyForcePivot(deps: EvolveDeps, input: Omit<ForcePivotInput, 'base'>): Promise<ForcePivotResult>;
export type { RootEvent };