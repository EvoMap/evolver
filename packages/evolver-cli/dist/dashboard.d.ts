import { type WorkflowProvider } from '@evomap/evolver-webui';
import { type MemoryGraphOperatorStatus } from './localMemoryGraph.js';
export interface DashboardServer {
    readonly token: string;
    readonly launchTicket: string;
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
}
export type DashboardEnv = Readonly<Record<string, string | undefined>>;
export interface DashboardDeps {
    createServer?: (memoryGraphStatus: () => MemoryGraphOperatorStatus, env: DashboardEnv) => DashboardServer;
    env?: DashboardEnv;
    openUrl?: (url: string) => Promise<boolean>;
    waitForShutdown?: () => Promise<void>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    memoryGraphStatus?: () => MemoryGraphOperatorStatus;
}
export interface DashboardCommandOptions {
    eaddrinusePortAttempts?: number;
}
export interface WorkflowStateReader {
    listRunIds(): string[];
    read(runId: string): unknown;
}
export declare function createWorkflowDashboardProvider(store: WorkflowStateReader): WorkflowProvider;
export declare function createDashboardWorkflowProvider(env?: DashboardEnv, defaultStateDir?: () => string): WorkflowProvider;
export declare function createDashboardServer(memoryGraphStatus: () => MemoryGraphOperatorStatus, env?: DashboardEnv): DashboardServer;
export declare function dashboardOpenCommand(url: string, platform?: NodeJS.Platform): {
    command: string;
    args: string[];
};
export declare function runDashboardCommand(argv: readonly string[], deps?: DashboardDeps, options?: DashboardCommandOptions): Promise<number>;