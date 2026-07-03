// Resident-daemon health check (ported from v1 src/ops/health_check.js). A long-running autonomous loop should
// know when its host is unhealthy — out of disk (it writes patches/event logs), memory-pressured, or leaking
// processes (a hung-agent fork bomb) — so the supervisor can pause or alert rather than crash mid-cycle. The
// resource probes are injected seams (default = real OS readings) so the policy is deterministic to test.
import { statfsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { parse as parsePath } from 'node:path';
const DEFAULT_THRESHOLDS = { diskWarnPct: 80, diskCritPct: 90, memCritPct: 95, procWarn: 2000 };
function defaultDiskPctUsed() {
    try {
        const root = process.platform === 'win32' ? (parsePath(process.cwd()).root || 'C:\\') : '/';
        const s = statfsSync(root);
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bavail) * Number(s.bsize); // available to unprivileged users
        if (!(total > 0))
            return -1;
        return Math.round(((total - free) / total) * 100);
    }
    catch {
        return -1;
    }
}
function defaultMemPctUsed() {
    const total = totalmem();
    if (!(total > 0))
        return -1;
    return Math.round(((total - freemem()) / total) * 100);
}
let procCache = -1;
let procCacheAt = 0;
function defaultProcCount(now) {
    if (process.platform !== 'linux')
        return -1;
    try {
        const t = now().getTime();
        if (procCache < 0 || t - procCacheAt > 60_000) { // readdir('/proc') is heavy — cache 60s
            procCache = readdirSync('/proc').filter((f) => /^\d+$/.test(f)).length;
            procCacheAt = t;
        }
        return procCache;
    }
    catch {
        return -1;
    }
}
/**
 * Snapshot host health for the daemon supervisor. Returns the overall status (ok | warning | error) plus a
 * per-check breakdown. Pure given its probes — inject HealthProbes to test each branch deterministically.
 */
export function runHealthCheck(probes = {}) {
    const now = probes.now ?? (() => new Date());
    const th = { ...DEFAULT_THRESHOLDS, ...(probes.thresholds ?? {}) };
    const diskPctUsed = probes.diskPctUsed ?? defaultDiskPctUsed;
    const memPctUsed = probes.memPctUsed ?? defaultMemPctUsed;
    const procCount = probes.procCount ?? (() => defaultProcCount(now));
    const checks = [];
    let critical = 0;
    let warnings = 0;
    const disk = diskPctUsed();
    if (disk < 0) {
        checks.push({ name: 'disk_space', ok: false, status: 'unavailable', severity: 'warning' });
        warnings++;
    }
    else if (disk > th.diskCritPct) {
        checks.push({ name: 'disk_space', ok: false, status: `${disk}% used`, severity: 'critical' });
        critical++;
    }
    else if (disk > th.diskWarnPct) {
        checks.push({ name: 'disk_space', ok: false, status: `${disk}% used`, severity: 'warning' });
        warnings++;
    }
    else {
        checks.push({ name: 'disk_space', ok: true, status: `${disk}% used` });
    }
    const mem = memPctUsed();
    if (mem >= 0 && mem > th.memCritPct) {
        checks.push({ name: 'memory', ok: false, status: `${mem}% used`, severity: 'critical' });
        critical++;
    }
    else {
        checks.push({ name: 'memory', ok: true, status: `${mem < 0 ? 'unknown' : mem + '% used'}` });
    }
    const procs = procCount();
    if (procs >= 0) {
        if (procs > th.procWarn) {
            checks.push({ name: 'process_count', ok: false, status: `${procs} procs`, severity: 'warning' });
            warnings++;
        }
        else {
            checks.push({ name: 'process_count', ok: true, status: `${procs} procs` });
        }
    }
    const status = critical > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok';
    return { status, timestamp: now().toISOString(), checks };
}