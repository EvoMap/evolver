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
        };
    }
    const safeCommands = sanitizedPlan.map((command) => command.value);
    const result = await runner(safeCommands, cwd, { ...options, requireIsolation: true });
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