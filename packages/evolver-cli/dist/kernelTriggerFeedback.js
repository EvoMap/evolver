import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { algo, exec } from '@evomap/evolver-core';
export function kernelTriggerFeedbackBinding(env) {
    const executable = env['EVOX_KERNEL_EXECUTABLE'];
    const agentDir = env['EVOX_CODING_AGENT_DIR'];
    if (!executable || !isAbsolute(executable) || !agentDir || !isAbsolute(agentDir))
        throw new Error('trigger_feedback_kernel_unbound');
    const normalized = { ...env, EVOX_CODING_AGENT_DIR: resolve(agentDir), EVOX_KERNEL_EXECUTABLE: resolve(executable) };
    const scoped = exec.triggerFeedbackScopeEnv(normalized);
    if (!scoped)
        throw new Error('trigger_feedback_kernel_unbound');
    return { executable: resolve(executable), agentDir: resolve(agentDir), env: scoped };
}
async function callKernel(binding, args, signal) {
    signal?.throwIfAborted();
    const stdout = await new Promise((accept, reject) => {
        execFile(binding.executable, ['evolve', 'trigger-feedback', ...args, '--json'], {
            env: { ...binding.env }, cwd: binding.agentDir, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}),
        }, (error, output) => {
            if (signal?.aborted)
                reject(signal.reason);
            else if (error)
                reject(new Error(args[0] === 'list' && error.code === 2 ? 'trigger_feedback_recovery_unsupported' : 'trigger_feedback_kernel_read_unavailable'));
            else
                accept(output);
        });
    });
    try {
        return JSON.parse(stdout);
    }
    catch {
        throw new Error('trigger_feedback_kernel_invalid_output');
    }
}
export async function readKernelTriggerFeedback(binding, runId, signal) {
    if (!runId.trim() || Buffer.byteLength(runId) > 256)
        throw new Error('trigger_feedback_invalid_identity');
    return algo.parseKernelTriggerFeedback(await callKernel(binding, ['get', '--run-id', runId], signal), runId);
}
export async function listKernelTriggerFeedback(binding, after = null, signal) {
    if (after !== null && (!after.trim() || Buffer.byteLength(after) > 256))
        throw new Error('trigger_feedback_invalid_identity');
    const raw = await callKernel(binding, ['list', '--snapshots', '--limit', '100', ...(after === null ? [] : ['--after', after])], signal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('trigger_feedback_kernel_invalid_output');
    const page = raw;
    if (page['schema_version'] !== 1 || !Array.isArray(page['snapshots']) || page['snapshots'].length > 100)
        throw new Error('trigger_feedback_recovery_unsupported');
    const snapshots = page['snapshots'].map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value['run_id'] !== 'string')
            throw new Error('trigger_feedback_kernel_invalid_output');
        return algo.parseKernelTriggerFeedback(value, value['run_id']);
    });
    let previous = after;
    for (const snapshot of snapshots) {
        if (previous !== null && snapshot.runId <= previous)
            throw new Error('trigger_feedback_kernel_invalid_output');
        previous = snapshot.runId;
    }
    const nextAfter = page['next_after'];
    if (nextAfter !== null && (typeof nextAfter !== 'string' || nextAfter !== previous || snapshots.length === 0))
        throw new Error('trigger_feedback_kernel_invalid_output');
    return { snapshots, nextAfter: nextAfter };
}