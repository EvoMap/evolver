import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULT_MAX_CAPTURE_BYTES, spawnCapture } from './runnerRegistry.js';
export function triggerFeedbackScopeEnv(env) {
    const agentDir = env['EVOX_CODING_AGENT_DIR'];
    const executable = env['EVOX_KERNEL_EXECUTABLE'];
    if (!agentDir || !isAbsolute(agentDir) || !executable || !isAbsolute(executable))
        return undefined;
    return { ...env, EVOX_CODING_AGENT_DIR: agentDir, EVOX_KERNEL_EXECUTABLE: executable,
        EVOLVER_HOME: join(agentDir, 'evolver'), EVOMAP_HOME: join(agentDir, 'evomap'), EVOMAP_DIR: join(agentDir, 'evomap'), EVOLVER_ENV_FILE: '',
        GEP_ASSETS_DIR: join(agentDir, 'evolver', 'assets'), EVOLUTION_ASSETS_DIR: join(agentDir, 'evolver', 'assets'),
        EVOLUTION_DIR: join(agentDir, 'evolver', 'evolution'), EVOLVER_PROXY_STORE: join(agentDir, 'evolver', 'proxy', 'mailbox.db') };
}
export function createTriggerFeedbackLocalFacade(env, options = {}) {
    const scoped = triggerFeedbackScopeEnv(env);
    if (!scoped)
        return undefined;
    const agentDir = scoped['EVOX_CODING_AGENT_DIR'];
    const now = options.now ?? Date.now;
    let active;
    let nextRecoveryAt = 0;
    const execute = (key, command, runId, signal) => {
        if (active)
            return active.key === key ? active.promise : Promise.resolve({ ok: false, reason: 'trigger_feedback_busy' });
        const promise = (async () => {
            let entry;
            try {
                entry = (options.resolveDispatch ?? (() => createRequire(import.meta.url).resolve('@evomap/evolver-cli/dispatch')))();
            }
            catch {
                return { ok: false, reason: 'trigger_feedback_cli_unsupported' };
            }
            const args = [join(dirname(entry), 'cli.js'), 'trigger-feedback', ...command, '--json'];
            try {
                const result = await (options.capture ?? spawnCapture)(process.execPath, args, { cwd: agentDir, env: scoped, timeoutMs: 25_000, maxOutputBytes: DEFAULT_MAX_CAPTURE_BYTES, ...(signal ? { signal } : {}) });
                if (result.termination !== 'exit' || result.stdoutTruncated)
                    return { ok: false, reason: 'trigger_feedback_unverified' };
                const parsed = JSON.parse(result.stdout);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    return { ok: false, reason: 'trigger_feedback_invalid_response' };
                const value = parsed;
                if (value['command'] !== command[0] || typeof value['ok'] !== 'boolean' || result.code !== (value['ok'] ? 0 : 1)
                    || (runId !== undefined && value['runId'] !== runId))
                    return { ok: false, reason: 'trigger_feedback_invalid_response' };
                if (!value['ok'] && typeof value['reason'] === 'string' && /^trigger_feedback_[a-z_]+$/.test(value['reason']))
                    return value;
                if (value['schemaVersion'] !== 1 || typeof value['localCommitted'] !== 'boolean' || (runId !== undefined
                    ? command[0] === 'sync' && value['localCommitted'] !== true
                    : typeof value['partial'] !== 'boolean'
                        || ['scanned', 'localChanged', 'hubConfirmed', 'pending', 'blocked'].some((field) => typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || Number(value[field]) < 0 || Number(value[field]) > 800)))
                    return { ok: false, reason: 'trigger_feedback_invalid_response' };
                return value;
            }
            catch {
                return { ok: false, reason: 'trigger_feedback_unverified' };
            }
        })();
        const owner = { key, promise };
        active = owner;
        void promise.finally(() => { if (active === owner)
            active = undefined; });
        return promise;
    };
    return {
        invoke(action, runId, remote = false) {
            if (!runId.trim() || Buffer.byteLength(runId) > 256 || (action === 'get' && remote))
                return Promise.resolve({ ok: false, reason: 'trigger_feedback_invalid_input' });
            return execute(JSON.stringify([action, runId, remote]), [action, '--run-id', runId, ...(action === 'get' ? ['--receipt-only'] : []), ...(remote ? ['--hub'] : [])], runId);
        },
        recover(signal) {
            if (signal?.aborted)
                return Promise.resolve({ ok: false, reason: 'trigger_feedback_cancelled' });
            if (active?.key === 'recover')
                return active.promise;
            if (active)
                return Promise.resolve({ ok: false, reason: 'trigger_feedback_busy' });
            if (now() < nextRecoveryAt)
                return Promise.resolve({ command: 'recover', deferred: true, nextRecoveryAt });
            nextRecoveryAt = now() + 30_000;
            return execute('recover', ['recover'], undefined, signal);
        },
    };
}