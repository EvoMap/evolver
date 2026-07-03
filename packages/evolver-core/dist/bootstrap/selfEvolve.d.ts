export type RunMode = 'normal' | 'self-evolve';
/** 自进化预设(seed gene / self-PR 目标 / 硬编码根). 只在 self-evolve 模式加载, 不进默认主流程. */
export interface EvolvePreset {
    name: string;
    seedGenes: readonly string[];
    selfPrTarget?: {
        repo: string;
        branchPrefix: string;
    };
    ownedRoots?: readonly string[];
}
export interface BootstrapInput {
    mode: RunMode;
    preset?: EvolvePreset;
}
export interface ResolvedBootstrap {
    mode: RunMode;
    isSelfEvolve: boolean;
    projectAgnostic: boolean;
    preset: EvolvePreset | null;
}
export declare class BootstrapModeError extends Error {
    constructor(message: string);
}
/**
 * 解析运行模式(M4A-6, 批注#23). 关键不变量:
 * - **显式**: 模式来自子命令/flag, 不再 isInsideEvolverRepo 自动探测(v1 自举泄漏根因).
 * - **默认项目无关**: normal 模式拒绝任何 preset/self 目标, 主流程对所有项目一视同仁.
 * - self-evolve 必须显式带 preset(seed gene / self-PR 目标拆到此).
 */
export declare function resolveBootstrap(input: BootstrapInput): ResolvedBootstrap;
/**
 * 解析子命令为模式. **不读 cwd / 不探测仓库**(显式优先, 去 v1 隐形约定).
 * `evolver self-evolve ...` → self-evolve; 其余 → normal.
 */
export declare function parseRunMode(argv: readonly string[]): RunMode;