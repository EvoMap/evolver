// With shell:false these are passed literally (harmless), but their presence means an injection attempt
// or a command that wrongly assumes a shell (e.g. `a && b`) — reject loudly so it is split, not silently mis-run.
export const SHELL_METACHARS = /[;&|`$<>\n\r]/;
// Node flags that turn `node` into an arbitrary-code evaluator or preload hook. A legit validation command is
// `node <script> [args]`; these flags must be denied by the sandbox and must never be hidden by missing-script skip.
export const BLOCKED_NODE_FLAGS = new Set([
    '-e', '--eval', '-p', '--print', '-i', '--interactive', '-r', '--require',
    '--loader', '--experimental-loader', '--import', '--env-file',
    // Inspector: opens an UNAUTHENTICATED Node debug port (a remote-code-execution channel) for the command's
    // lifetime — never needed by a light `node <script>` validation. (`=value` forms are covered by the
    // split('=') in nodeFlagViolation below.) Hardens both the distill light-validation filter and the sandbox.
    '--inspect', '--inspect-brk', '--inspect-port', '--inspect-publish-uid',
    // Watch: keeps the process alive past its work → hangs validation until the sandbox SIGKILLs it (DoS).
    '--watch', '--watch-path', '--watch-preserve-output',
    // Module-resolution override: can redirect imports/requires to attacker-chosen code paths.
    '--conditions', '-C',
]);
export function normalizeExecutableName(executable) {
    const trimmed = String(executable ?? '').trim();
    const unquoted = trimmed.replace(/^["']|["']$/g, '');
    const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
    return base.toLowerCase().replace(/\.exe$/, '');
}
export function isNodeExecutable(executable) {
    return normalizeExecutableName(executable) === 'node';
}
export function nodeFlagViolation(executable, args) {
    if (!isNodeExecutable(executable))
        return null;
    for (const a of args) {
        const flag = a.split('=')[0] ?? a;
        if (BLOCKED_NODE_FLAGS.has(flag))
            return flag;
    }
    return null;
}
/** 命令首 token(可执行名)是否在项目声明的 allowlist 内. */
export function isAllowed(cmd, allowlist) {
    const head = cmd.trim().split(/\s+/)[0] ?? '';
    return allowlist.includes(head);
}
/** Extract the local script targeted by `node <script> ...`, or null for non-script node commands. */
export function validationScriptPath(cmd) {
    const tokens = String(cmd ?? '').trim().split(/\s+/);
    const executable = tokens[0] ?? '';
    if (tokens.length < 2 || !isNodeExecutable(executable))
        return null;
    if (SHELL_METACHARS.test(cmd) || nodeFlagViolation(executable, tokens.slice(1)))
        return null;
    for (let i = 1; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.startsWith('-'))
            continue;
        return /\.(?:c|m)?js$/.test(token) ? token : null;
    }
    return null;
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
export async function runValidation(plan, run) {
    const results = [];
    for (const c of plan.commands) {
        const label = c.label ?? c.cmd;
        if (!isAllowed(c.cmd, plan.allowlist)) {
            results.push({ label, cmd: c.cmd, allowed: false, exitCode: null, stdoutSummary: '', passed: false });
            continue;
        }
        const out = await run(c.cmd);
        results.push({ label, cmd: c.cmd, allowed: true, exitCode: out.exitCode, stdoutSummary: summarizeStdout(out.stdout), passed: out.exitCode === 0 });
    }
    // 全部 allowed 的命令都 exit 0 才算通过; 有命令被 deny 视为未通过(校验不完整)
    const passed = results.length > 0 && results.every((r) => r.allowed && r.passed);
    return { results, passed };
}
/**
 * 检查验证命令是否安全可作为 Gene.validation 条目使用（忠实移植 v1 policyCheck.isValidationCommandAllowed）。
 * Gene 验证命令只允许 `node …` 形式，不允许非 node 命令（如 pnpm/npm/echo 等）。
 * 安全条件：
 * 1. 必须以 `node ` 开头
 * 2. 不包含命令替换（` 或 $(）
 * 3. 不包含 shell 元字符（引号外）
 * 4. 不包含被阻止的 node 标志（-e/--eval/--print 等）
 */
export function isValidationCommandAllowed(cmd) {
    const c = String(cmd || '').trim();
    if (!c)
        return false;
    // 只允许 node 命令作为验证命令
    if (!c.startsWith('node '))
        return false;
    // 不允许命令替换
    if (/`|\$\(/.test(c))
        return false;
    // 移除引号内的内容后检查 shell 元字符
    const stripped = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (SHELL_METACHARS.test(stripped))
        return false;
    // 检查被阻止的 node 标志
    const tokens = c.split(/\s+/);
    const executable = tokens[0] ?? '';
    const args = tokens.slice(1);
    if (nodeFlagViolation(executable, args))
        return false;
    return true;
}