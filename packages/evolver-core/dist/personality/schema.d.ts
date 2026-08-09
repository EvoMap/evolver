import { z } from 'zod';
/**
 * PersonalityState = 可进化人格 (v1 src/gep/personality.js 的 v2 端口).
 *
 * 五维行为向量, 各 0..1, 决定进化"风格"而非"内容":
 *  - rigor          严谨度: 越高越保守/协议优先, 是高危变异的准入前提
 *  - creativity     创造性: 越高越倾向 innovate/explore, 跳出局部最优
 *  - verbosity      啰嗦度: 影响产物叙述密度 (纯 prompt 提示, 不改逻辑)
 *  - risk_tolerance 风险容忍: 越高越敢冒险, 但会被风险闸压制
 *  - obedience      服从度: 越高越贴合协议/用户指令
 *
 * 三条用途 (v2 必须保留语义, 见 riskGate.ts / prompt.ts / (PR-2) selection):
 *  1. 注入每轮 GEP prompt, 决定进化风格 (prompt.ts)
 *  2. 变异风险闸: high-risk/innovate 变异只在 rigor≥0.6 且 risk_tolerance≤0.5 放行 (riskGate.ts)
 *  3. 自然选择 + 小步变异自调参, 成功强化/失败淘汰, 全程进事件流可审计 (PR-2)
 */
/** 五维行为轴 (顺序固定 — personalityKey / 遍历依赖它). */
export declare const PERSONALITY_AXES: readonly ["rigor", "creativity", "verbosity", "risk_tolerance", "obedience"];
export type PersonalityAxis = (typeof PERSONALITY_AXES)[number];
/** 保守默认: 协议优先、安全、低风险 (v1 defaultPersonalityState 原值). */
export declare const DEFAULT_PERSONALITY: Readonly<{
    rigor: 0.7;
    creativity: 0.35;
    verbosity: 0.25;
    risk_tolerance: 0.4;
    obedience: 0.85;
}>;
/** 五维人格状态. type 判别标签保留 (v1/事件流互认). */
export declare const personalityState: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"PersonalityState">>;
    rigor: z.ZodDefault<z.ZodNumber>;
    creativity: z.ZodDefault<z.ZodNumber>;
    verbosity: z.ZodDefault<z.ZodNumber>;
    risk_tolerance: z.ZodDefault<z.ZodNumber>;
    obedience: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    type: "PersonalityState";
    rigor: number;
    creativity: number;
    verbosity: number;
    risk_tolerance: number;
    obedience: number;
}, {
    type?: "PersonalityState" | undefined;
    rigor?: number | undefined;
    creativity?: number | undefined;
    verbosity?: number | undefined;
    risk_tolerance?: number | undefined;
    obedience?: number | undefined;
}>;
export type PersonalityState = z.infer<typeof personalityState>;
/**
 * 宽松输入形状: 允许省略 type、缺轴、越界值 —— 凡是会经 normalizePersonalityState 的公共入口都收这个,
 * 由 normalize 夹成合法 PersonalityState. 这样调用方可以直接传 DEFAULT_PERSONALITY 或部分覆盖对象.
 */
export type PersonalityStateInput = Partial<Record<PersonalityAxis, number>> & {
    type?: string;
};
/** 一个人格键的运行统计 (自然选择的适应度原料; PR-2 回写). */
export declare const personalityStats: z.ZodObject<{
    success: z.ZodDefault<z.ZodNumber>;
    fail: z.ZodDefault<z.ZodNumber>;
    /** 增量均值; n 为纳入均值的样本数. */
    avgScore: z.ZodDefault<z.ZodNumber>;
    n: z.ZodDefault<z.ZodNumber>;
    updatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    success: number;
    updatedAt: string | null;
    fail: number;
    n: number;
    avgScore: number;
}, {
    success?: number | undefined;
    updatedAt?: string | null | undefined;
    fail?: number | undefined;
    n?: number | undefined;
    avgScore?: number | undefined;
}>;
export type PersonalityStats = z.infer<typeof personalityStats>;
/** 单条人格变更历史 (可审计; 也镜像进事件流). */
export declare const personalityHistoryEntry: z.ZodObject<{
    at: z.ZodString;
    key: z.ZodString;
    outcome: z.ZodString;
    score: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    notes: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    at: string;
    score: number | null;
    outcome: string;
    key: string;
    notes: string | null;
}, {
    at: string;
    outcome: string;
    key: string;
    score?: number | null | undefined;
    notes?: string | null | undefined;
}>;
export type PersonalityHistoryEntry = z.infer<typeof personalityHistoryEntry>;
/** 持久化模型: 当前人格 + 各键统计 + 变更历史 (v1 loadPersonalityModel 的 v2 形状). */
export declare const personalityModel: z.ZodObject<{
    version: z.ZodDefault<z.ZodLiteral<1>>;
    current: z.ZodDefault<z.ZodObject<{
        type: z.ZodDefault<z.ZodLiteral<"PersonalityState">>;
        rigor: z.ZodDefault<z.ZodNumber>;
        creativity: z.ZodDefault<z.ZodNumber>;
        verbosity: z.ZodDefault<z.ZodNumber>;
        risk_tolerance: z.ZodDefault<z.ZodNumber>;
        obedience: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        type: "PersonalityState";
        rigor: number;
        creativity: number;
        verbosity: number;
        risk_tolerance: number;
        obedience: number;
    }, {
        type?: "PersonalityState" | undefined;
        rigor?: number | undefined;
        creativity?: number | undefined;
        verbosity?: number | undefined;
        risk_tolerance?: number | undefined;
        obedience?: number | undefined;
    }>>;
    stats: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        success: z.ZodDefault<z.ZodNumber>;
        fail: z.ZodDefault<z.ZodNumber>;
        /** 增量均值; n 为纳入均值的样本数. */
        avgScore: z.ZodDefault<z.ZodNumber>;
        n: z.ZodDefault<z.ZodNumber>;
        updatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        success: number;
        updatedAt: string | null;
        fail: number;
        n: number;
        avgScore: number;
    }, {
        success?: number | undefined;
        updatedAt?: string | null | undefined;
        fail?: number | undefined;
        n?: number | undefined;
        avgScore?: number | undefined;
    }>>>;
    history: z.ZodDefault<z.ZodArray<z.ZodObject<{
        at: z.ZodString;
        key: z.ZodString;
        outcome: z.ZodString;
        score: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        notes: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        at: string;
        score: number | null;
        outcome: string;
        key: string;
        notes: string | null;
    }, {
        at: string;
        outcome: string;
        key: string;
        score?: number | null | undefined;
        notes?: string | null | undefined;
    }>, "many">>;
    updatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    extensions: Record<string, unknown>;
    updatedAt: string | null;
    version: 1;
    stats: Record<string, {
        success: number;
        updatedAt: string | null;
        fail: number;
        n: number;
        avgScore: number;
    }>;
    current: {
        type: "PersonalityState";
        rigor: number;
        creativity: number;
        verbosity: number;
        risk_tolerance: number;
        obedience: number;
    };
    history: {
        at: string;
        score: number | null;
        outcome: string;
        key: string;
        notes: string | null;
    }[];
}, {
    extensions?: Record<string, unknown> | undefined;
    updatedAt?: string | null | undefined;
    version?: 1 | undefined;
    stats?: Record<string, {
        success?: number | undefined;
        updatedAt?: string | null | undefined;
        fail?: number | undefined;
        n?: number | undefined;
        avgScore?: number | undefined;
    }> | undefined;
    current?: {
        type?: "PersonalityState" | undefined;
        rigor?: number | undefined;
        creativity?: number | undefined;
        verbosity?: number | undefined;
        risk_tolerance?: number | undefined;
        obedience?: number | undefined;
    } | undefined;
    history?: {
        at: string;
        outcome: string;
        key: string;
        score?: number | null | undefined;
        notes?: string | null | undefined;
    }[] | undefined;
}>;
export type PersonalityModel = z.infer<typeof personalityModel>;
/** 单个变异提案 (作用于一个轴, delta 会被 applyMutations 夹取). */
export declare const personalityMutation: z.ZodObject<{
    type: z.ZodDefault<z.ZodLiteral<"PersonalityMutation">>;
    param: z.ZodEnum<["rigor", "creativity", "verbosity", "risk_tolerance", "obedience"]>;
    delta: z.ZodNumber;
    reason: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "PersonalityMutation";
    delta: number;
    reason: string;
    param: "rigor" | "creativity" | "verbosity" | "risk_tolerance" | "obedience";
}, {
    delta: number;
    param: "rigor" | "creativity" | "verbosity" | "risk_tolerance" | "obedience";
    type?: "PersonalityMutation" | undefined;
    reason?: string | undefined;
}>;
export type PersonalityMutation = z.infer<typeof personalityMutation>;
declare const clamp01: (x: unknown) => number;
/**
 * 把任意输入夹成合法 PersonalityState (缺失/越界/非数 → 夹到 [0,1]).
 * 注意: 与 v1 一致, 非有限值夹为 0 而非默认值 — 显式坏输入不静默"复活"成保守默认.
 */
export declare function normalizePersonalityState(state: unknown): PersonalityState;
/** 严格校验: type 标签对且五轴都是 [0,1] 有限数 (不做夹取, 用于信任边界). */
export declare function isValidPersonalityState(obj: unknown): obj is PersonalityState;
/**
 * 稳定桶键: 五轴各按 0.1 步长量化后拼串. 相近人格落同一桶, 统计才能积累 (v1 personalityKey).
 * 例: "rigor=0.7|creativity=0.4|verbosity=0.2|risk_tolerance=0.4|obedience=0.9"
 */
export declare function personalityKey(state: unknown): string;
/** 由 personalityKey 反解回 PersonalityState (未识别轴回落默认; 自然选择需要). */
export declare function parseKeyToState(key: string): PersonalityState;
export { clamp01 };