import type { Envelope } from './envelope.js';
import type { Handler } from './catalog.js';
import { type MailboxStore } from './store.js';
export interface DispatchResult {
    id: string;
    handler: Handler;
    handled: boolean;
    fedMaterial: boolean;
    note?: string;
}
/** 三类 handler 实现; 由集成层注入. core=确定性, proxy=hub 往返, agent=智能(嵌入式 runtime 时直接处理). */
export interface DispatchHandlers {
    core: (e: Envelope) => Promise<unknown> | unknown;
    proxy: (e: Envelope) => Promise<unknown> | unknown;
    agent: (e: Envelope) => Promise<unknown> | unknown;
}
export interface DispatcherDeps {
    store: MailboxStore;
    handlers: DispatchHandlers;
    /** 选择性 Material 投喂: dispatch 判定通过才调用(集成层把 envelope→Material). */
    onMaterial?: (e: Envelope) => void | Promise<void>;
    now: () => number;
}
/**
 * 选择性 Material 判定(M2-7). 默认遵目录 feedsMaterial; 两类在 dispatch 决定:
 * - asset_publish_result: 仅 rejected 进(失败=养料 #40); 通过无需.
 * - swarm.*: 仅带结论的进; 中间消息不进.
 */
export declare function shouldFeedMaterial(e: Envelope): boolean;
/**
 * 三-handler 分派器(M2-7). 谁 claim 谁 complete:
 * - daemon 侧 pump core+proxy(确定性/hub 往返).
 * - agent 类常由外部 runtime 经 IPC(M2-6) claim+complete; 嵌入式可显式 pump ['agent'].
 */
export declare class Dispatcher {
    private readonly deps;
    constructor(deps: DispatcherDeps);
    dispatchOne(e: Envelope): Promise<DispatchResult>;
    /** 拉一批并分派. 默认 daemon 侧 core+proxy; agent 由 runtime 经 IPC 拉取. */
    pump(opts?: {
        handlers?: Handler[];
        limit?: number;
        leaseMs?: number;
        runtimeNamespace?: string;
    }): Promise<DispatchResult[]>;
}