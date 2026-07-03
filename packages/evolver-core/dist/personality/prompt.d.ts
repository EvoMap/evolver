import { type PersonalityStateInput } from './schema.js';
/**
 * 渲染人格块 (markdown), 供 renderExecPrompt 拼进 agent 指令.
 * 末行显式声明高危变异是否被人格放行, 让 agent 与风险闸看到同一事实.
 */
export declare function renderPersonalityBlock(personality: PersonalityStateInput | null | undefined): string;