import { verify } from '@evomap/evolver-core';
export async function runRequiredSandboxedValidation(commands, cwd, options = {}, runner = verify.runSandboxedValidation) {
    const sanitizedPlan = commands.map((command) => verify.sanitizeExecutionCommand(command));
    if (sanitizedPlan.some((command) => command.changed || command.blocked)) {
        return {
            passed: false,
            score: 0.2,
            results: sanitizedPlan.map((command) => ({
                label: command.value.split(/\s+/)[0] || '<redacted>',
                cmd: command.value,
                allowed: false,
                exitCode: null,
                stdoutSummary: command.changed || command.blocked
                    ? 'execution_credential_blocked'
                    : 'validation_plan_blocked',
                passed: false,
            })),
            skipped: [],
            isolated: false,
            isolationTier: 'none',
        };
    }
    const safeCommands = sanitizedPlan.map((command) => command.value);
    // AutoExec、distill 与 workflow 共用此入口。默认接受 no-network 的独立根、只读源码和断网边界，
    // 不要求宿主能够只读重挂整棵文件系统或提供聚合 cgroup 限额。调用方明确要求 read-only 时不能降档；
    // 实际采用的档位由 core 回执报告，不能用这里的最低要求代替。无效的运行时值原样交给 core 拒绝。
    const minimumIsolation = options.minimumIsolation === undefined ? 'no-network' : options.minimumIsolation;
    const result = await runner(safeCommands, cwd, { ...options, requireIsolation: true, minimumIsolation });
    const sanitized = verify.sanitizeExecutionPayload(result);
    if (!sanitized.blocked)
        return sanitized.value;
    return {
        ...sanitized.value,
        passed: false,
        score: 0.2,
        results: sanitized.value.results.map((entry) => ({
            ...entry,
            allowed: false,
            passed: false,
            stdoutSummary: entry.stdoutSummary || 'execution_credential_blocked',
        })),
    };
}