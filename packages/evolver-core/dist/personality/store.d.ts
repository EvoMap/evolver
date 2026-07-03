import { personalityStatePath } from '../events/paths.js';
import { type PersonalityModel, type PersonalityState } from './schema.js';
/** history 上限 (v1 slice(-120) 同值; 防文件无界增长). */
export declare const HISTORY_LIMIT = 120;
/** 全新默认模型 (无持久文件时的种子). */
export declare function defaultPersonalityModel(now?: () => number): PersonalityModel;
export interface PersonalityStoreOptions {
    /** 覆盖持久化路径 (测试注入; 缺省走 personalityStatePath()). */
    path?: string;
    /** 可注入时钟 (确定性测试). */
    now?: () => number;
}
/**
 * 可进化人格模型的持久化 (v1 loadPersonalityModel / savePersonalityModel 端口).
 * - load: 缺失/空/损坏文件 → 回落默认模型 (绝不抛; 人格是软状态, 读坏不该崩进化循环)
 * - save: tmp+rename 原子替换, 跨进程 O_EXCL 锁串行化 (对齐 EventStore / localJsonl 的写法)
 * current 恒被 normalize 到合法五维, stats/history 恒是合法形状.
 */
export declare class PersonalityStore {
    readonly path: string;
    private readonly lockPath;
    private readonly now;
    constructor(opts?: PersonalityStoreOptions);
    /** 读模型; 任何 I/O 或校验失败都回落默认 (不抛). */
    load(): PersonalityModel;
    /** 原子落盘 (规范化 + history 截断 + 刷 updatedAt). 返回实际写入的模型. */
    save(model: PersonalityModel): PersonalityModel;
    /** 读当前人格 (便捷). */
    currentState(): PersonalityState;
    /** 桶键 (便捷). */
    currentKey(): string;
    /** 当前时间的 ISO 串 (走注入时钟) —— 供进化算子给 stats/history/事件打时间戳. */
    nowIso(): string;
}
export { personalityStatePath };