export interface WfqItem {
    id: string;
    weight: number;
    enqueuedAt: number;
}
/** 加权公平队列骨架 (军杰§7): 防单一高频霸占, age_boost 防饿死. */
export declare class WeightedFairQueue {
    private items;
    enqueue(item: WfqItem): void;
    size(): number;
    /** pick = argmax(weight + age_boost); age_boost = min(log2(1+waitMin), 4). */
    pick(now: number): WfqItem | undefined;
}