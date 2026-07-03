import type { MailboxStore } from './store.js';
export type WakeMode = 'resident' | 'one-shot';
export type WakeAction = 'signal' | 'spawn' | 'none';
/** 一个 runtime 实例的唤醒目标(常驻 vs 一次性). */
export interface WakeTarget {
    runtimeNamespace: string;
    mode: WakeMode;
    /** resident: 唤醒已跑进程(本地信号/写 wake 文件/HTTP poke). */
    signal?: () => Promise<void> | void;
    /** one-shot 或 resident 已死: 拉起进程(spawn `claude` 等). */
    spawn?: () => Promise<void> | void;
    /** resident 存活探测; 返回 false → 回退到 spawn. 默认视为存活. */
    isAlive?: () => boolean;
}
export interface AgentWakerDeps {
    store: MailboxStore;
    /** 静态列表或每次 tick 动态求值(runtime 注册/注销). */
    targets: WakeTarget[] | (() => WakeTarget[]);
    /** 同 namespace 最小唤醒间隔(去抖, 默认 2s). */
    cooldownMs?: number;
    now: () => number;
}
export interface WakeOutcome {
    runtimeNamespace: string;
    action: WakeAction;
    pending: number;
    reason?: string;
}
/**
 * Agent 唤醒器(M2-8). 监视各 namespace 的 pending agent 消息, 去抖后唤醒 runtime:
 * - resident 且存活 → signal(轻量 poke).
 * - one-shot 或 resident 已死 → spawn(拉起进程).
 * runtime 起来后经 IPC(M2-6) claim('agent') 自取消息.
 */
export declare class AgentWaker {
    private readonly deps;
    private readonly lastWake;
    private readonly cooldownMs;
    constructor(deps: AgentWakerDeps);
    private resolveTargets;
    /** 扫一轮: 对有 pending agent 工作且过了冷却的 namespace 触发唤醒. */
    tick(): Promise<WakeOutcome[]>;
    /** 测试/强制: 清冷却(下次 tick 必唤醒). */
    resetCooldown(runtimeNamespace?: string): void;
}