import { sanitizeExecutionCommand, sanitizeExecutionDiagnostic } from './executionRedaction.js';
import { SHELL_METACHARS, classifyNodeValidationInvocation, isNodeExecutable, splitValidationInvocation, tokenizeValidationCommand } from './validationSyntax.js';
export { BLOCKED_NODE_FLAGS, SHELL_METACHARS, isNodeExecutable, nodeFlagViolation, normalizeExecutableName } from './validationSyntax.js';
export { isValidationCommandAllowed } from './validationCommandPolicy.js';
/** 命令可执行名（跳过白名单环境变量前缀）是否在项目声明的 allowlist 内. */
export function isAllowed(cmd, allowlist) {
    const tokens = tokenizeValidationCommand(cmd);
    const invocation = tokens ? splitValidationInvocation(tokens) : null;
    return invocation !== null && invocation !== 'disallowed_env' && allowlist.includes(invocation.executable);
}
/** Extract the unambiguous script targeted by `node <script> ...`, or null for non-script/unsupported commands. */
export function validationScriptPath(cmd) {
    const tokens = tokenizeValidationCommand(cmd);
    if (!tokens || tokens.length < 2)
        return null;
    const executable = tokens[0] ?? '';
    if (!isNodeExecutable(executable))
        return null;
    if (SHELL_METACHARS.test(cmd))
        return null;
    const invocation = classifyNodeValidationInvocation(executable, tokens.slice(1));
    return invocation.kind === 'script' ? invocation.script : null;
}
/** stdout 摘要 = 首行 + 末行(去 canary.js 隐形约定: 不找魔法字符串, 只留可读摘要). */
export function summarizeStdout(stdout) {
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0)
        return '';
    if (lines.length <= 2)
        return lines.join(' | ');
    return `${lines[0]} … ${lines[lines.length - 1]}`;
}
/**
 * 跑校验(M4A-4). 判价值 = **exit code + stdout 摘要**, 不依赖 canary.js 魔法字符串(批注#22).
 * 不在 allowlist 的命令 auto-deny(不执行, allowed=false), 守无人值守安全.
 */
export async function runValidation(plan, run, signal) {
    const results = [];
    let cancelled = signal?.aborted === true;
    for (const c of plan.commands) {
        if (signal?.aborted) {
            cancelled = true;
            break;
        }
        const sanitizedCommand = sanitizeExecutionCommand(c.cmd);
        const label = sanitizeExecutionDiagnostic(c.label ?? c.cmd).value;
        if (sanitizedCommand.changed || sanitizedCommand.blocked || !isAllowed(c.cmd, plan.allowlist)) {
            results.push({
                label,
                cmd: sanitizedCommand.value,
                allowed: false,
                exitCode: null,
                stdoutSummary: sanitizedCommand.changed || sanitizedCommand.blocked ? 'execution_credential_blocked' : '',
                passed: false,
            });
            continue;
        }
        const out = await run(sanitizedCommand.value, signal, c.cwd);
        results.push({
            label,
            cmd: sanitizedCommand.value,
            allowed: true,
            exitCode: out.exitCode,
            stdoutSummary: sanitizeExecutionDiagnostic(summarizeStdout(out.stdout)).value,
            passed: out.exitCode === 0,
        });
        // runner 可能在返回结果后才观察到取消；此时不能让完整的 exit-0 列表伪装成通过。
        if (signal?.aborted) {
            cancelled = true;
            break;
        }
    }
    // 全部 allowed 的命令都 exit 0 才算通过; 有命令被 deny 视为未通过(校验不完整)
    const passed = !cancelled && results.length > 0 && results.every((r) => r.allowed && r.passed);
    return { results, passed, cancelled };
}