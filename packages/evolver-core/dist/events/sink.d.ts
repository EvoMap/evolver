import type { RootEvent } from './eventSchema.js';
/** ingest 成功落盘后的 fan-out 接收口 (observer bus 实现之). */
export interface EventSink {
    dispatch(event: RootEvent): void;
}