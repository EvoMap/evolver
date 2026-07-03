import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { mailbox, shadow as shadow_ } from '@evomap/evolver-core';
/**
 * .evolver.lock 幂等(M8-3, v1.81 教训): 同 version 重试部署 = 可重入(不重复 apply);
 * 不同 version 持锁中 = 拒(防并发半失败); 过期锁(超 staleMs)= 接管.
 */
export function acquireDeployLock(lockPath, version, pid, now, staleMs = 10 * 60_000) {
    if (existsSync(lockPath)) {
        try {
            const info = JSON.parse(readFileSync(lockPath, 'utf8'));
            if (info.version === version)
                return { acquired: true, reentrant: true, existing: info }; // 同版本重试
            if (now - info.at < staleMs)
                return { acquired: false, reentrant: false, existing: info }; // 他版本持锁中
            // 过期 → 接管
        }
        catch { /* 坏锁文件 → 接管 */ }
    }
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ version, pid, at: now }));
    return { acquired: true, reentrant: false };
}
export function releaseDeployLock(lockPath) { try {
    rmSync(lockPath);
}
catch { /* ignore */ } }
/**
 * 停机前状态冻结检查(M8-3, 配 daemon 闸2 drain). enforce 下 in_flight 消息=潜在孤儿(丢进化证据)→ issue;
 * **shadow 下 in_flight 是故意留的(complete no-op), 不算孤儿**(gotcha: 区分 shadow-pinned vs 真孤儿)。
 */
export function preStopChecks(opts) {
    const issues = [];
    const inFlight = opts.store.countByStatus('in_flight');
    const shadowPinned = opts.shadowMode === 'shadow';
    if (!shadowPinned && inFlight > 0)
        issues.push(`${inFlight} 条 in_flight 消息未完成(潜在孤儿, 须 drain 后再停)`);
    const stale = opts.now - opts.lastWriteAt;
    if (opts.maxStaleMs !== undefined && stale > opts.maxStaleMs)
        issues.push(`root_events 已 ${Math.round(stale / 1000)}s 无写入(疑挂死)`);
    return { safe: issues.length === 0, issues, inFlight, shadowPinned };
}
/** 部署 fail-fast(M8-3, v1.81 教训): git identity 配齐 + npm·bun lockfile 对齐, 否则拒部署防半失败. */
export function verifyDeployEnv(c) {
    const failures = [];
    if (!c.gitUserName)
        failures.push('git user.name 未配');
    if (!c.gitUserEmail)
        failures.push('git user.email 未配');
    if (!c.lockfilesAligned)
        failures.push('npm·bun lockfile 不对齐');
    return { ok: failures.length === 0, failures };
}