import { checkV1EnvCompat } from '@evomap/evolver-core/v1-env-compat';
export function isReadOnlyStatusInvocation(argv) {
    return argv[0] === 'status' && argv.slice(1).some(arg => arg === '--help' || arg === '-h' || arg === '--live' || arg.startsWith('--live='));
}
/** Executable-only routing; launchers retain their exit contract and prompt hooks arm a process watchdog. */
export async function runCliEntry(argv) {
    checkV1EnvCompat(process.env);
    if (isReadOnlyStatusInvocation(argv)) {
        const { runLiveStatus } = await import('./liveStatus.js');
        return runLiveStatus(argv.slice(1));
    }
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
        let settledCode;
        const finish = () => process.exit(settledCode === undefined ? 1 : Number(process.exitCode ?? settledCode));
        // Own the disposable process before imports or hook work can suspend. The
        // pre-output allowance covers stdin (250ms), selection (750ms), stdout and
        // startup overhead; it does not pretend to interrupt synchronous JS/native work.
        let watchdog = setTimeout(finish, 3000);
        let outputWritten = false;
        try {
            const { runPromptRecallHook } = await import('./promptRecallHook.js');
            const { writeHookStdout } = await import('./promptRecallShared.js');
            const code = await runPromptRecallHook(argv.slice(2), {
                stdout: text => writeHookStdout(text, { destroyOnTimeout: true }),
                stdoutWithSettlement: (text, onSettled) => writeHookStdout(text, { destroyOnTimeout: true, onSettled }),
                onOutputWritten: () => {
                    // Only this disposable process owns forced exit. Confirmed stdout does
                    // not confirm hook settlement: an unfinished hook must never exit success.
                    // A pending Promise does not keep Node alive. Own one referenced guard
                    // until settlement; afterward it only guards lingering OS handles.
                    if (outputWritten)
                        return;
                    outputWritten = true;
                    clearTimeout(watchdog);
                    watchdog = setTimeout(finish, 1000);
                    if (settledCode !== undefined)
                        watchdog.unref();
                },
            });
            settledCode = code;
            return code;
        }
        catch (error) {
            settledCode = 1;
            throw error;
        }
        finally {
            watchdog.unref();
        }
    }
    if (argv[0] === 'experience') {
        const { runExperienceCommand } = await import('./experience.js');
        return runExperienceCommand(argv.slice(1));
    }
    if (argv[0] === 'mcp-stdio') {
        const { runMcpStdioCommand } = await import('./mcpStdio.js');
        return runMcpStdioCommand(argv.slice(1));
    }
    const { dispatch } = await import('./dispatch.js');
    return await Promise.resolve(dispatch(argv));
}