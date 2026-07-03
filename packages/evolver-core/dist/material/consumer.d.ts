import type { MaterialStore } from './materialStore.js';
import type { Material } from '../schema/material.js';
export interface ConsumerOptions {
    store: MaterialStore;
    path?: string;
}
/** consumer group + 进度游标 (at-least-once): committed 仅 ack 后推进, 防重复消费. */
export declare class ConsumerGroups {
    private readonly opts;
    private readonly committed;
    constructor(opts: ConsumerOptions);
    private cur;
    /** 取下一批未 ack 的 (不推进 committed → 崩溃重启再 claim 拿到同批). */
    claim(group: string, batchSize: number): Material[];
    /** ack: 把 committed 推过 acked 的连续前缀. */
    ack(group: string, materialIds: string[]): void;
    /** reset: 'earliest' 重放全部历史 / 指定 index. */
    reset(group: string, to: 'earliest' | number): void;
    position(group: string): number;
    private persist;
}