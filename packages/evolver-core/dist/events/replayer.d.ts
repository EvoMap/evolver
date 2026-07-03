import type { RootEvent } from './eventSchema.js';
/** 纯函数视图投影器: 由 root_events 折叠出 MV. */
export interface Projector<S = unknown> {
    readonly name: string;
    initial(): S;
    reduce(state: S, event: RootEvent): S;
}
/** AE→MV 分层 (军杰 §3.6). MV 由 root_events 确定性重建, 写保护(#write 私有 + 读深冻结). */
export declare class Replayer {
    #private;
    readonly dir: string;
    private readonly projectors;
    constructor(opts: {
        dir: string;
        projectors: readonly Projector[];
    });
    private mvPath;
    /** 全量重放重建全部 MV (rebuild-views). */
    rebuild(events: readonly RootEvent[]): void;
    /** 增量: 单事件更新全部 MV. */
    apply(event: RootEvent): void;
    /** 读 MV (深冻结 → 业务代码 mutate 即抛). */
    read<S>(name: string): Readonly<S>;
    /** 删除全部 MV (rebuild-views 前). */
    clear(): void;
}