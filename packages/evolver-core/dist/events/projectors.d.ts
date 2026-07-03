import type { Projector } from './replayer.js';
/** demo MV: 按 type 计数 + lastSeq (真 cycle timeline 见 M0-9). */
export interface EventCountsMV {
    total: number;
    byType: Record<string, number>;
    lastSeq: number;
}
export declare const eventCountsProjector: Projector<EventCountsMV>;
export declare const DEFAULT_PROJECTORS: readonly Projector[];