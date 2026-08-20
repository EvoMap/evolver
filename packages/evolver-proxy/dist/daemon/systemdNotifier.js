import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
const SYSTEMD_NOTIFY_TIMEOUT_MS = 5_000;
const MIN_WATCHDOG_INTERVAL_MS = 1_000;
const DEFAULT_READY_RETRY_DELAYS_MS = [250, 750];
const MAX_READY_RETRIES = 4;
const MAX_READY_RETRY_DELAY_MS = 5_000;
const SYSTEMD_NOTIFY_CANDIDATES = [
    '/usr/bin/systemd-notify',
    '/bin/systemd-notify',
    '/run/current-system/sw/bin/systemd-notify',
];
const defaultSystemdNotifyExec = (command, args, options, callback) => {
    execFile(command, [...args], options, (error) => { callback(error); });
};
export function systemdWatchdogIntervalMs(env = process.env) {
    const usec = parsePositiveSafeInteger(env['WATCHDOG_USEC']);
    if (usec === undefined)
        return 0;
    return Math.max(MIN_WATCHDOG_INTERVAL_MS, Math.floor(usec / 2_000));
}
export class SystemdNotifier {
    options;
    env;
    platform;
    now;
    execFile;
    readyRetryDelaysMs;
    sleep;
    notifyCommand;
    timer;
    readySent = false;
    readyInFlight;
    constructor(options) {
        this.options = options;
        this.env = options.env ?? process.env;
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? Date.now;
        this.execFile = options.execFile ?? defaultSystemdNotifyExec;
        this.readyRetryDelaysMs = normalizeReadyRetryDelays(options.readyRetryDelaysMs ?? DEFAULT_READY_RETRY_DELAYS_MS);
        this.sleep = options.sleep ?? sleepMs;
        this.notifyCommand = options.notifyCommand
            ?? SYSTEMD_NOTIFY_CANDIDATES.find((candidate) => existsSync(candidate))
            ?? SYSTEMD_NOTIFY_CANDIDATES[0];
    }
    async ready() {
        if (!this.active())
            return false;
        if (this.readySent)
            return true;
        if (this.readyInFlight)
            return this.readyInFlight;
        const health = this.readHealth();
        if (!health?.running || !health.ipcListening || !health.lifecycleArmed)
            return false;
        const attempt = this.announceReady();
        this.readyInFlight = attempt;
        void attempt.then(() => { if (this.readyInFlight === attempt)
            this.readyInFlight = undefined; }, () => { if (this.readyInFlight === attempt)
            this.readyInFlight = undefined; });
        return attempt;
    }
    async readyOrThrow() {
        if (!this.active())
            return;
        if (!await this.ready())
            throw new Error('systemd_ready_notification_failed');
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    active() {
        return this.platform === 'linux' && Boolean(this.env['NOTIFY_SOCKET']?.trim());
    }
    startWatchdog() {
        if (this.timer)
            return;
        // The installed unit may run a stable recovery controller as MainPID and the
        // proxy as its child. NotifyAccess=all intentionally authorizes that child.
        const intervalMs = systemdWatchdogIntervalMs(this.env);
        if (intervalMs === 0)
            return;
        this.timer = setInterval(() => { this.pingWatchdog(intervalMs); }, intervalMs);
        this.timer.unref?.();
    }
    pingWatchdog(freshnessMs) {
        const health = this.readHealth();
        if (!health?.running || !health.ipcListening || !health.lifecycleArmed)
            return;
        if (health.consecutiveFailures !== 0 || health.lastTickAt === undefined)
            return;
        const ageMs = this.now() - health.lastTickAt;
        const plannedSleepHealthy = health.nextTickDueAt !== undefined
            && this.now() <= health.nextTickDueAt + freshnessMs;
        if (!Number.isFinite(ageMs) || ageMs < 0 || (ageMs > freshnessMs && !plannedSleepHealthy))
            return;
        void this.notify('WATCHDOG=1');
    }
    async announceReady() {
        const attempts = this.readyRetryDelaysMs.length + 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const health = this.readHealth();
            if (!health?.running || !health.ipcListening || !health.lifecycleArmed)
                return false;
            if (await this.notify('READY=1')) {
                this.readySent = true;
                this.startWatchdog();
                return true;
            }
            const delayMs = this.readyRetryDelaysMs[attempt];
            if (delayMs !== undefined) {
                try {
                    await this.sleep(delayMs);
                }
                catch {
                    return false;
                }
            }
        }
        return false;
    }
    readHealth() {
        try {
            return this.options.health();
        }
        catch {
            return undefined;
        }
    }
    notify(state) {
        return new Promise((resolve) => {
            try {
                this.execFile(this.notifyCommand, [state], {
                    env: this.env,
                    timeout: SYSTEMD_NOTIFY_TIMEOUT_MS,
                    windowsHide: true,
                }, (error) => { resolve(error === null); });
            }
            catch {
                // Keep delivery failures as data: READY is enforced by readyOrThrow(), while watchdog pings stay best-effort.
                resolve(false);
            }
        });
    }
}
function normalizeReadyRetryDelays(values) {
    return values.slice(0, MAX_READY_RETRIES).map((value) => (Number.isFinite(value)
        ? Math.min(MAX_READY_RETRY_DELAY_MS, Math.max(0, Math.floor(value)))
        : 0));
}
function sleepMs(delayMs) {
    return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}
function parsePositiveSafeInteger(value) {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}