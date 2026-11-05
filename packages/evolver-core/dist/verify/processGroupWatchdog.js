import { execFile, spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
const SYSTEM_PS = '/bin/ps';
const SYSTEM_LSOF = '/usr/sbin/lsof';
const LAUNCHD_PID = 1;
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,rss=,lstart='];
// lstart has one-second resolution, so a process started just before the watch began must still count as new.
const START_SLACK_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const PS_TIMEOUT_MS = 2_000;
const REAP_WAIT_MS = 5_000;
function parseSnapshot(output) {
    const rows = [];
    for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match)
            continue;
        rows.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            rssBytes: Number(match[4]) * 1024,
            started: match[5],
        });
    }
    return rows;
}
const identity = (row) => `${row.pid}@${row.started}`;
const pathIsWithin = (root, target) => {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
function markedPids(pids, marker) {
    const result = spawnSync(SYSTEM_PS, ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: {}, maxBuffer: 16 * 1024 * 1024 });
    const marked = new Set();
    for (const line of (result.stdout ?? '').split('\n')) {
        const match = /^\s*(\d+)\s(.*)$/.exec(line);
        if (match && ` ${match[2]} `.includes(` ${marker} `))
            marked.add(Number(match[1]));
    }
    return marked;
}
// macOS hides the environment of its own platform binaries (/bin/sh, /bin/sleep), so an orphan of those is matched by
// the working directory it inherited instead: no unrelated process works inside this run's private directories.
function pidsWorkingIn(pids, roots) {
    const result = spawnSync(SYSTEM_LSOF, ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: {} });
    const found = new Set();
    let pid = 0;
    for (const line of (result.stdout ?? '').split('\n')) {
        if (line.startsWith('p'))
            pid = Number(line.slice(1));
        else if (line.startsWith('n') && roots.some((root) => pathIsWithin(root, line.slice(1))))
            found.add(pid);
    }
    return found;
}
/**
 * A process that left the group with setsid() before any sample saw it, and whose parent already exited, is told
 * apart by the run's marker in its environment, which it inherited, or, once launchd adopted it, by working inside
 * the run's directories. Each new process is asked once: one that is neither can never become so by itself.
 */
function adoptEscaped(rows, members, { marker, roots, since, cleared }) {
    const unknown = rows.filter((row) => !members.has(row.pid) && row.pid !== process.pid && !cleared.has(identity(row))
        && Date.parse(row.started) >= since);
    if (unknown.length === 0)
        return;
    const marked = markedPids(unknown.map((row) => row.pid), marker);
    const orphans = unknown.filter((row) => !marked.has(row.pid) && row.ppid === LAUNCHD_PID).map((row) => row.pid);
    const working = orphans.length > 0 && roots.length > 0 ? pidsWorkingIn(orphans, roots) : new Set();
    for (const row of unknown) {
        if (marked.has(row.pid) || working.has(row.pid))
            members.set(row.pid, row);
        else
            cleared.add(identity(row));
    }
}
/**
 * Members are the launcher's process group, every process that escaped it (see adoptEscaped), every descendant by
 * parent PID, and every process seen as a member before. All but the first keep a child that called setsid() — or
 * was orphaned to launchd — inside the budget.
 */
function attributeMembers(rows, attribution) {
    const { rootPid, known } = attribution;
    const members = new Map();
    for (const row of rows) {
        if (row.pgid === rootPid || known.has(identity(row)))
            members.set(row.pid, row);
    }
    adoptEscaped(rows, members, attribution);
    let grew = true;
    while (grew) {
        grew = false;
        for (const row of rows) {
            if (!members.has(row.pid) && members.has(row.ppid)) {
                members.set(row.pid, row);
                grew = true;
            }
        }
    }
    for (const row of members.values())
        known.add(identity(row));
    return [...members.values()];
}
function exceeded(members, limits) {
    if (members.length > limits.processes)
        return 'processes';
    const rss = members.reduce((total, row) => total + row.rssBytes, 0);
    return rss > limits.memoryBytes ? 'memory' : null;
}
function killMembers(rootPid, members) {
    try {
        process.kill(-rootPid, 'SIGKILL');
    }
    catch { /* group already empty */ }
    const targets = members.filter((row) => row.pid !== process.pid);
    for (const row of targets) {
        try {
            process.kill(row.pid, 'SIGKILL');
        }
        catch { /* already exited */ }
    }
    return targets;
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/**
 * macOS has no unprivileged cgroup, so the aggregate budget is enforced by polling: total RSS and process count of
 * the tree are sampled every POLL_INTERVAL_MS and the whole tree is killed once either exceeds its limit. Unlike a
 * cgroup this is not kernel-enforced: a burst between samples can overshoot, and pages the kernel compressed or
 * swapped out are not counted in RSS.
 */
export function watchProcessGroup(rootPid, limits, onExceeded, run) {
    const known = new Set();
    const attribution = { rootPid, ...run, since: Date.now() - START_SLACK_MS, known, cleared: new Set() };
    const killed = new Map();
    let stopped = false;
    let sampling = false;
    const snapshotSync = () => {
        const result = spawnSync(SYSTEM_PS, PS_ARGS, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: {} });
        return attributeMembers(parseSnapshot(result.stdout ?? ''), attribution);
    };
    const record = (rows) => { for (const row of rows)
        killed.set(row.pid, row); };
    const terminate = () => record(killMembers(rootPid, snapshotSync()));
    const sample = () => {
        if (stopped || sampling)
            return;
        sampling = true;
        execFile(SYSTEM_PS, PS_ARGS, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: {}, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            sampling = false;
            if (stopped)
                return;
            if (error) {
                terminate();
                onExceeded('monitor');
                return;
            }
            const members = attributeMembers(parseSnapshot(stdout), attribution);
            const reason = exceeded(members, limits);
            if (!reason)
                return;
            record(killMembers(rootPid, members));
            onExceeded(reason);
        });
    };
    const timer = setInterval(sample, POLL_INTERVAL_MS);
    timer.unref?.();
    sample();
    return {
        terminate,
        async stop() {
            if (!stopped) {
                stopped = true;
                clearInterval(timer);
                terminate();
            }
            // An orphan killed after its parent died lingers until launchd reaps it; callers must not report the tree
            // gone (or reuse its scratch) before that.
            const deadline = Date.now() + REAP_WAIT_MS;
            while (Date.now() < deadline && [...killed.keys()].some(processExists)) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        },
    };
}