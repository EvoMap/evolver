export interface RollbackConfig {
    ownedRoots: readonly string[];
    optIn: boolean;
}
export interface RollbackTarget {
    path: string;
    tracked: boolean;
}
export interface RollbackPlan {
    willRollback: RollbackTarget[];
    skipped: Array<{
        target: RollbackTarget;
        reason: string;
    }>;
}
/**
 * 规划回滚(M4A-4, 批注#20). 三条铁律, 全部满足才回滚:
 * - opt-in: optIn=false 时一律不回滚.
 * - 只动 evolver-owned: 路径必须在 ownedRoots 之内(绝不 reset 主仓 working tree / 仓外文件).
 * - 不删 untracked: 未跟踪文件不回滚(避免破坏用户未提交工作).
 */
export declare function planRollback(targets: readonly RollbackTarget[], cfg: RollbackConfig): RollbackPlan;