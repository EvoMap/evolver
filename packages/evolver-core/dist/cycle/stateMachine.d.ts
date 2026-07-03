/** cycle 状态机 (军杰§9.3). */
export type CycleStage = 'none' | 'started' | 'signals_collected' | 'gene_selected' | 'mutation_built' | 'solidified' | 'failed' | 'aborted';
export declare const TERMINAL: ReadonlySet<CycleStage>;
/** 事件类型 → 它把 cycle 推进到的 stage (非 stage 事件返回 null). */
export declare function stageForEventType(type: string): CycleStage | null;
export declare function canTransition(from: CycleStage, to: CycleStage): boolean;