import { util } from '@evomap/evolver-core';
export declare function publishLifecycleBootstrapReadiness(input: {
    env: NodeJS.ProcessEnv;
    pid?: number;
    supervisorPid?: number;
    readProcessStartIdentity?: typeof util.readFileLockProcessStartIdentity;
    startedAt: string;
    ipcUrl: string;
}): void;