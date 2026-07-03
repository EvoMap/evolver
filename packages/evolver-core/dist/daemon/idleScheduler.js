// Idle-aware scheduler (ported from v1 gep/idleScheduler.js). A "good neighbour" for the resident loop: when
// the machine has been idle a while, evolution can run harder (distill / reflect / explore) and more often;
// when the user is active, it backs off to a normal cadence. The DECISION logic is pure and config-driven; the
// platform idle reading is an injected probe seam (default best-effort, graceful → -1 → normal cadence).
import { spawnSync } from 'node:child_process';
const IDLE_PROBE_TIMEOUT_MS = 5000;
function defaultIdleCommandRunner(command, args) {
    return spawnSync(command, [...args], { encoding: 'utf8', timeout: IDLE_PROBE_TIMEOUT_MS });
}
let idleCommandRunner = defaultIdleCommandRunner;
function readIdleCommand(command, args) {
    try {
        const result = idleCommandRunner(command, args);
        if (result.status !== 0)
            return null;
        return String(result.stdout ?? '').trim();
    }
    catch {
        // Idle detection is advisory. Treat command failures as unknown idle.
        return null;
    }
}
export const DEFAULT_IDLE_THRESHOLDS = { idleSeconds: 300, deepIdleSeconds: 1800 };
/** Map idle seconds → evolution intensity. Unknown idle (-1) or active → normal. Pure. */
export function determineIntensity(idleSeconds, th = DEFAULT_IDLE_THRESHOLDS) {
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0)
        return 'normal';
    if (idleSeconds >= th.deepIdleSeconds)
        return 'deep';
    if (idleSeconds >= th.idleSeconds)
        return 'aggressive';
    return 'normal';
}
/**
 * Turn an idle reading into a scheduling recommendation: aggressive idle → run twice as often; deep idle → 4×.
 * Pure given idleSeconds. enabled:false → a normal-cadence no-op. The `intensity` is the single signal a consumer
 * acts on (the previous per-action `should*` flags were never consumed anywhere, so they are not emitted —
 * re-derive any action mapping at the consumer from `intensity` if/when one exists).
 */
export function recommendSchedule(idleSeconds, opts = {}) {
    if (opts.enabled === false)
        return { enabled: false, idleSeconds: -1, intensity: 'normal', sleepMultiplier: 1 };
    const intensity = determineIntensity(idleSeconds, opts.thresholds);
    const sleepMultiplier = intensity === 'aggressive' ? 0.5 : intensity === 'deep' ? 0.25 : 1;
    return { enabled: true, idleSeconds, intensity, sleepMultiplier };
}
export function tryLinuxXprintidle() {
    const out = readIdleCommand('xprintidle', []);
    if (out === null)
        return -1;
    const ms = Number.parseInt(out, 10);
    if (!Number.isFinite(ms) || ms < 0)
        return -1;
    return Math.floor(ms / 1000);
}
export function tryLinuxGnomeMutterIdleMonitor() {
    const out = readIdleCommand('gdbus', [
        'call',
        '--session',
        '--dest',
        'org.gnome.Mutter.IdleMonitor',
        '--object-path',
        '/org/gnome/Mutter/IdleMonitor/Core',
        '--method',
        'org.gnome.Mutter.IdleMonitor.GetIdletime',
    ]);
    if (out === null)
        return -1;
    const match = /uint64\s+(\d+)/.exec(out);
    if (!match)
        return -1;
    const rawMs = match[1];
    if (rawMs === undefined)
        return -1;
    const ms = Number.parseInt(rawMs, 10);
    if (!Number.isFinite(ms) || ms < 0)
        return -1;
    return Math.floor(ms / 1000);
}
export function tryLinuxLoginctlIdleHint() {
    const sessionId = process.env['XDG_SESSION_ID'];
    if (!sessionId || !isSafeLoginctlSessionId(sessionId))
        return -1;
    const out = readIdleCommand('loginctl', ['show-session', sessionId, '-p', 'IdleHint', '-p', 'IdleSinceHint']);
    if (out === null)
        return -1;
    const hintMatch = /(?:^|\n)IdleHint=(yes|no)(?:\n|$)/.exec(out);
    if (!hintMatch)
        return -1;
    const idleHint = hintMatch[1];
    if (idleHint === undefined)
        return -1;
    if (idleHint === 'no')
        return 0;
    const sinceMatch = /(?:^|\n)IdleSinceHint=(\d+)(?:\n|$)/.exec(out);
    if (!sinceMatch)
        return -1;
    const rawSinceUsec = sinceMatch[1];
    if (rawSinceUsec === undefined)
        return -1;
    const sinceUsec = Number.parseInt(rawSinceUsec, 10);
    if (!Number.isFinite(sinceUsec) || sinceUsec <= 0)
        return -1;
    const idleSeconds = Math.floor(((Date.now() * 1000) - sinceUsec) / 1_000_000);
    return idleSeconds >= 0 ? idleSeconds : -1;
}
function isSafeLoginctlSessionId(sessionId) {
    if (!/^[A-Za-z0-9]+$/.test(sessionId))
        return false;
    const lowerSessionId = sessionId.toLowerCase();
    return lowerSessionId !== 'self' && lowerSessionId !== 'auto';
}
const LINUX_IDLE_PROBES = {
    xprintidle: tryLinuxXprintidle,
    'gnome-mutter': tryLinuxGnomeMutterIdleMonitor,
    loginctl: tryLinuxLoginctlIdleHint,
};
function isWaylandSession() {
    return process.env['XDG_SESSION_TYPE']?.toLowerCase() === 'wayland';
}
function isGnomeMutterDesktop() {
    const currentDesktop = process.env['XDG_CURRENT_DESKTOP']?.toLowerCase();
    return currentDesktop?.split(':').some((part) => part === 'gnome' || part.includes('mutter')) === true;
}
function getLinuxIdleMethodOrder() {
    if (!isWaylandSession())
        return ['xprintidle', 'gnome-mutter', 'loginctl'];
    if (isGnomeMutterDesktop())
        return ['gnome-mutter', 'loginctl', 'xprintidle'];
    return ['loginctl', 'xprintidle', 'gnome-mutter'];
}
let cachedLinuxIdleMethod;
export function getLinuxIdleSeconds() {
    if (cachedLinuxIdleMethod) {
        const idleSeconds = LINUX_IDLE_PROBES[cachedLinuxIdleMethod]();
        if (idleSeconds >= 0)
            return idleSeconds;
        cachedLinuxIdleMethod = undefined;
    }
    for (const name of getLinuxIdleMethodOrder()) {
        const idleSeconds = LINUX_IDLE_PROBES[name]();
        if (idleSeconds >= 0) {
            cachedLinuxIdleMethod = name;
            return idleSeconds;
        }
    }
    return -1;
}
export function resetLinuxIdleProbeCacheForTests() {
    cachedLinuxIdleMethod = undefined;
}
export function setIdleCommandRunnerForTests(runner) {
    idleCommandRunner = runner ?? defaultIdleCommandRunner;
}
export function getCachedLinuxIdleMethodForTests() {
    return cachedLinuxIdleMethod;
}
/**
 * Best-effort default idle probe. linux: xprintidle → GNOME Mutter → loginctl; darwin: ioreg HIDIdleTime (ns). win32 and any
 * missing tool → -1 (→ normal cadence) rather than failing — idle detection is an optimization, not a gate.
 */
export function defaultIdleProbe() {
    if (process.platform === 'linux')
        return getLinuxIdleSeconds();
    if (process.platform === 'darwin') {
        const out = readIdleCommand('ioreg', ['-c', 'IOHIDSystem']);
        if (out !== null) {
            const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
            if (match?.[1] !== undefined)
                return Math.floor(Number(match[1]) / 1_000_000_000);
        }
        return -1;
    }
    return -1; // win32 / unsupported / tool missing → unknown
}
/** Convenience: probe idle then recommend. The probe defaults to the platform reader; inject for tests. */
export function getScheduleRecommendation(opts = {}) {
    if (opts.enabled === false)
        return recommendSchedule(-1, { enabled: false });
    return recommendSchedule((opts.probe ?? defaultIdleProbe)(), { ...(opts.thresholds ? { thresholds: opts.thresholds } : {}) });
}