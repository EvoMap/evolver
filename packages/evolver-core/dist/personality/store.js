import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { personalityStatePath } from '../events/paths.js';
import { DEFAULT_PERSONALITY, normalizePersonalityState, personalityKey, personalityModel, } from './schema.js';
/** history 上限 (v1 slice(-120) 同值; 防文件无界增长). */
export const HISTORY_LIMIT = 120;
/** 全新默认模型 (无持久文件时的种子). */
export function defaultPersonalityModel(now = Date.now) {
    return personalityModel.parse({
        version: 1,
        current: { ...DEFAULT_PERSONALITY },
        stats: {},
        history: [],
        updatedAt: new Date(now()).toISOString(),
    });
}
/**
 * 可进化人格模型的持久化 (v1 loadPersonalityModel / savePersonalityModel 端口).
 * - load: 缺失/空/损坏文件 → 回落默认模型 (绝不抛; 人格是软状态, 读坏不该崩进化循环)
 * - save: tmp+rename 原子替换, 跨进程 O_EXCL 锁串行化 (对齐 EventStore / localJsonl 的写法)
 * current 恒被 normalize 到合法五维, stats/history 恒是合法形状.
 */
export class PersonalityStore {
    path;
    lockPath;
    now;
    constructor(opts = {}) {
        this.path = opts.path ?? personalityStatePath();
        this.lockPath = `${this.path}.lock`;
        this.now = opts.now ?? Date.now;
    }
    /** 读模型; 任何 I/O 或校验失败都回落默认 (不抛). */
    load() {
        if (!existsSync(this.path))
            return defaultPersonalityModel(this.now);
        let raw;
        try {
            const text = readFileSync(this.path, 'utf8');
            if (!text.trim())
                return defaultPersonalityModel(this.now);
            raw = JSON.parse(text);
        }
        catch {
            return defaultPersonalityModel(this.now);
        }
        const parsed = personalityModel.safeParse(raw);
        if (parsed.success) {
            // current 再夹一层, 防手改文件塞进越界值绕过 min/max (safeParse 已挡, 双保险).
            return { ...parsed.data, current: normalizePersonalityState(parsed.data.current) };
        }
        // 部分损坏: 尽量抢救 current, 其余回默认.
        const seed = defaultPersonalityModel(this.now);
        const cur = raw?.current;
        return { ...seed, current: normalizePersonalityState(cur ?? DEFAULT_PERSONALITY) };
    }
    /** 原子落盘 (规范化 + history 截断 + 刷 updatedAt). 返回实际写入的模型. */
    save(model) {
        const out = personalityModel.parse({
            version: 1,
            current: normalizePersonalityState(model.current),
            stats: model.stats ?? {},
            history: (model.history ?? []).slice(-HISTORY_LIMIT),
            updatedAt: new Date(this.now()).toISOString(),
            extensions: model.extensions ?? {},
        });
        mkdirSync(dirname(this.path), { recursive: true });
        acquireLock(this.lockPath);
        try {
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
            renameSync(tmp, this.path); // atomic replace; 崩在中途原文件不动
        }
        finally {
            releaseLock(this.lockPath);
        }
        return out;
    }
    /** 读当前人格 (便捷). */
    currentState() {
        return this.load().current;
    }
    /** 桶键 (便捷). */
    currentKey() {
        return personalityKey(this.load().current);
    }
    /** 当前时间的 ISO 串 (走注入时钟) —— 供进化算子给 stats/history/事件打时间戳. */
    nowIso() {
        return new Date(this.now()).toISOString();
    }
}
export { personalityStatePath };