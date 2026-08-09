#!/usr/bin/env node
import { settleCliProcess } from './cliLifecycle.js';
import { bootstrap } from '@evomap/evolver-core';
const argv = process.argv.slice(2);
// Emit deprecation warnings for any V1 env vars still present in the environment.
bootstrap.checkV1EnvCompat(process.env);
async function main() {
    if (argv[0] === 'proxy-token') {
        const { runProxyToken } = await import('./proxyToken.js');
        return runProxyToken(argv.slice(1));
    }
    if (argv[0] === 'inject' && argv[1] === 'prompt-recall') {
        const recallMode = String(process.env['EVOLVER_RECALL_MODE'] ?? '').trim().toLowerCase();
        const hasEnvFile = Boolean(process.env['EVOLVER_ENV_FILE']?.trim());
        if (!hasEnvFile && recallMode !== 'shadow' && recallMode !== 'enforce') {
            process.stdout.write('{}\n');
            return 0;
        }
        const { runPromptRecallHook } = await import('./promptRecallHook.js');
        return runPromptRecallHook(argv.slice(2));
    }
    const { dispatch } = await import('./dispatch.js');
    // Single dispatch path (registry in dispatch.ts): async handler if the verb is registered, else the runCli core.
    // Promise.resolve normalizes the sync (runCli → number) and async (handler → Promise<number>) branches to one exit.
    return await Promise.resolve(dispatch(argv));
}
void settleCliProcess(main);