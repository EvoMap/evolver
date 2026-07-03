export class BootstrapModeError extends Error {
    constructor(message) { super(message); this.name = 'BootstrapModeError'; }
}
/**
 * 解析运行模式(M4A-6, 批注#23). 关键不变量:
 * - **显式**: 模式来自子命令/flag, 不再 isInsideEvolverRepo 自动探测(v1 自举泄漏根因).
 * - **默认项目无关**: normal 模式拒绝任何 preset/self 目标, 主流程对所有项目一视同仁.
 * - self-evolve 必须显式带 preset(seed gene / self-PR 目标拆到此).
 */
export function resolveBootstrap(input) {
    if (input.mode === 'normal') {
        if (input.preset)
            throw new BootstrapModeError('normal 模式不得携带 preset(防 EvoMap/self 硬编码泄漏进默认主流程)');
        return { mode: 'normal', isSelfEvolve: false, projectAgnostic: true, preset: null };
    }
    if (!input.preset)
        throw new BootstrapModeError('self-evolve 模式必须显式提供 preset(seed gene / self-PR 目标)');
    return { mode: 'self-evolve', isSelfEvolve: true, projectAgnostic: false, preset: input.preset };
}
/**
 * 解析子命令为模式. **不读 cwd / 不探测仓库**(显式优先, 去 v1 隐形约定).
 * `evolver self-evolve ...` → self-evolve; 其余 → normal.
 */
export function parseRunMode(argv) {
    return argv[0] === 'self-evolve' ? 'self-evolve' : 'normal';
}