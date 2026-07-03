import { resolve, relative, isAbsolute, sep } from 'node:path';
function isUnder(root, p) {
    const r = resolve(root);
    const ap = resolve(p);
    const rel = relative(r, ap);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/**
 * 规划回滚(M4A-4, 批注#20). 三条铁律, 全部满足才回滚:
 * - opt-in: optIn=false 时一律不回滚.
 * - 只动 evolver-owned: 路径必须在 ownedRoots 之内(绝不 reset 主仓 working tree / 仓外文件).
 * - 不删 untracked: 未跟踪文件不回滚(避免破坏用户未提交工作).
 */
export function planRollback(targets, cfg) {
    const willRollback = [];
    const skipped = [];
    for (const t of targets) {
        if (!cfg.optIn) {
            skipped.push({ target: t, reason: 'rollback 未 opt-in' });
            continue;
        }
        if (!cfg.ownedRoots.some((root) => isUnder(root, t.path))) {
            skipped.push({ target: t, reason: '非 evolver-owned 路径' });
            continue;
        }
        if (!t.tracked) {
            skipped.push({ target: t, reason: 'untracked 文件, 不回滚' });
            continue;
        }
        willRollback.push(t);
    }
    return { willRollback, skipped };
}