#!/usr/bin/env node
import { settleCliProcess } from './cliLifecycle.js';
const argv = process.argv.slice(2);
async function main() {
    if (argv[0] === 'proxy-token') {
        const { runProxyToken } = await import('./proxyToken.js');
        return runProxyToken(argv.slice(1));
    }
    const { dispatch } = await import('./dispatch.js');
    // Single dispatch path (registry in dispatch.ts): async handler if the verb is registered, else the runCli core.
    // Promise.resolve normalizes the sync (runCli → number) and async (handler → Promise<number>) branches to one exit.
    return await Promise.resolve(dispatch(argv));
}
void settleCliProcess(main);