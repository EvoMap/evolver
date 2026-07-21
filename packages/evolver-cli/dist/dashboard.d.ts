import { type MemoryGraphOperatorStatus } from './localMemoryGraph.js';
export interface DashboardServer {
    readonly token: string;
    readonly launchTicket: string;
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
}
export interface DashboardDeps {
    createServer?: (memoryGraphStatus: () => MemoryGraphOperatorStatus) => DashboardServer;
    openUrl?: (url: string) => Promise<boolean>;
    waitForShutdown?: () => Promise<void>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    memoryGraphStatus?: () => MemoryGraphOperatorStatus;
}
export interface DashboardCommandOptions {
    eaddrinusePortAttempts?: number;
}
export declare function dashboardOpenCommand(url: string, platform?: NodeJS.Platform): {
    command: string;
    args: string[];
};
export declare function runDashboardCommand(argv: readonly string[], deps?: DashboardDeps, options?: DashboardCommandOptions): Promise<number>;