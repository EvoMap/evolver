import { mailbox, shadow as shadow_ } from '@evomap/evolver-core';
type MailboxStore = mailbox.MailboxStore;
type ShadowMode = shadow_.ShadowMode;
export interface DeployLockInfo {
    version: string;
    pid: number;
    at: number;
}
/**
 * .evolver.lock 幂等(M8-3, v1.81 教训): 同 version 重试部署 = 可重入(不重复 apply);
 * 不同 version 持锁中 = 拒(防并发半失败); 过期锁(超 staleMs)= 接管.
 */
export declare function acquireDeployLock(lockPath: string, version: string, pid: number, now: number, staleMs?: number): {
    acquired: boolean;
    reentrant: boolean;
    existing?: DeployLockInfo;
};
export declare function releaseDeployLock(lockPath: string): void;
export interface PreStopResult {
    safe: boolean;
    issues: string[];
    inFlight: number;
    shadowPinned: boolean;
}
/**
 * 停机前状态冻结检查(M8-3, 配 daemon 闸2 drain). enforce 下 in_flight 消息=潜在孤儿(丢进化证据)→ issue;
 * **shadow 下 in_flight 是故意留的(complete no-op), 不算孤儿**(gotcha: 区分 shadow-pinned vs 真孤儿)。
 */
export declare function preStopChecks(opts: {
    store: MailboxStore;
    shadowMode: ShadowMode;
    lastWriteAt: number;
    now: number;
    maxStaleMs?: number;
}): PreStopResult;
export interface DeployEnvInput {
    gitUserName?: string;
    gitUserEmail?: string;
    lockfilesAligned: boolean;
}
/** 部署 fail-fast(M8-3, v1.81 教训): git identity 配齐 + npm·bun lockfile 对齐, 否则拒部署防半失败. */
export declare function verifyDeployEnv(c: DeployEnvInput): {
    ok: boolean;
    failures: string[];
};
export {};