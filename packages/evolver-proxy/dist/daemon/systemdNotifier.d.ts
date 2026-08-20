export interface SystemdNotifyHealth {
    running: boolean;
    ipcListening: boolean;
    lifecycleArmed: boolean;
    lastTickAt?: number;
    nextTickDueAt?: number;
    consecutiveFailures: number;
}
export type SystemdNotifyExec = (command: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
}, callback: (error: Error | null) => void) => void;
interface SystemdNotifierOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    now?: () => number;
    health: () => SystemdNotifyHealth;
    execFile?: SystemdNotifyExec;
    readyRetryDelaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
    notifyCommand?: string;
}
export declare function systemdWatchdogIntervalMs(env?: NodeJS.ProcessEnv): number;
export declare class SystemdNotifier {
    private readonly options;
    private readonly env;
    private readonly platform;
    private readonly now;
    private readonly execFile;
    private readonly readyRetryDelaysMs;
    private readonly sleep;
    private readonly notifyCommand;
    private timer;
    private readySent;
    private readyInFlight;
    constructor(options: SystemdNotifierOptions);
    ready(): Promise<boolean>;
    readyOrThrow(): Promise<void>;
    stop(): void;
    private active;
    private startWatchdog;
    private pingWatchdog;
    private announceReady;
    private readHealth;
    private notify;
}
export {};