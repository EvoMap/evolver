import { sanitizeExecutionCommand, sanitizeExecutionDiagnostic } from './executionRedaction.js';
// With shell:false these are passed literally (harmless), but their presence means an injection attempt
// or a command that wrongly assumes a shell (e.g. `a && b`) — reject loudly so it is split, not silently mis-run.
export const SHELL_METACHARS = /[;&|`$<>\n\r]/;
/**
 * Parse one validation command without invoking a shell. Quotes group whitespace and backslash only escapes
 * whitespace, quotes, or another backslash; no variable expansion or command substitution is performed.
 * A null result means the command has an unterminated quote and must be rejected.
 */
export function tokenizeValidationCommand(command) {
    const value = String(command ?? '');
    const tokens = [];
    let current = '';
    let tokenStarted = false;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const ch = value[index];
        if (escaped) {
            current += ch;
            tokenStarted = true;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            const next = value[index + 1];
            if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
                escaped = true;
                tokenStarted = true;
                continue;
            }
        }
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
            }
            else {
                current += ch;
            }
            tokenStarted = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            tokenStarted = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (tokenStarted) {
                tokens.push(current);
                current = '';
                tokenStarted = false;
            }
            continue;
        }
        current += ch;
        tokenStarted = true;
    }
    if (quote !== null)
        return null;
    if (escaped) {
        current += '\\';
        tokenStarted = true;
    }
    if (tokenStarted)
        tokens.push(current);
    return tokens;
}
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
    // Package/test runners execute code selected from package metadata or the checkout, not one declared script.
    '--run', '--test',
    // Input-type changes stdin into an evaluator; validation must always name a script explicitly.
    '--input-type', '-',
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
        // Node stops interpreting its own flags at the first script (or `--` delimiter). Anything after that is
        // an argv value owned by the script, even when it happens to match a blocked Node option name.
        if (a === '--' || !a.startsWith('-'))
            return null;
        const flag = a.split('=')[0] ?? a;
        if (BLOCKED_NODE_FLAGS.has(flag))
            return flag;
    }
    return null;
}
const SAFE_NODE_SCRIPT_FLAGS = new Set(['-c', '--check']);
const SAFE_NODE_NO_SCRIPT_FLAGS = new Set(['-v', '--version', '-h', '--help']);
/**
 * 将 Node 命令限制为明确的脚本位置，防止带参数的选项吞掉下一个 token 后绕过脚本路径检查。
 * 验证只需要普通脚本、语法检查，以及兼容旧 Gene 的 version/help 身份检查；其他前置选项默认拒绝。
 */
export function classifyNodeValidationInvocation(executable, args) {
    if (!isNodeExecutable(executable))
        return { kind: 'invalid' };
    const blocked = nodeFlagViolation(executable, args);
    if (blocked)
        return { kind: 'invalid', option: blocked };
    if (args.length === 1 && SAFE_NODE_NO_SCRIPT_FLAGS.has(args[0])) {
        return { kind: 'safe_no_script' };
    }
    let index = 0;
    let afterEndOfOptions = false;
    while (index < args.length) {
        const token = args[index];
        if (token === '--') {
            afterEndOfOptions = true;
            index += 1;
            break;
        }
        if (SAFE_NODE_SCRIPT_FLAGS.has(token)) {
            index += 1;
            continue;
        }
        if (token.startsWith('-')) {
            return { kind: 'invalid', option: token.split('=')[0] ?? token };
        }
        break;
    }
    const script = args[index];
    if (!script || (!afterEndOfOptions && script.startsWith('-')))
        return { kind: 'invalid' };
    return { kind: 'script', script };
}
/** 命令首 token(可执行名)是否在项目声明的 allowlist 内. */
export function isAllowed(cmd, allowlist) {
    const tokens = tokenizeValidationCommand(cmd);
    const head = tokens?.[0] ?? '';
    return allowlist.includes(head);
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
        const out = await run(sanitizedCommand.value, signal);
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
    const sanitized = sanitizeExecutionCommand(c);
    if (sanitized.changed || sanitized.blocked)
        return false;
    // 不允许命令替换
    if (/`|\$\(/.test(c))
        return false;
    // 移除引号内的内容后检查 shell 元字符
    const stripped = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (SHELL_METACHARS.test(stripped))
        return false;
    // 检查被阻止或会让脚本位置产生歧义的 node 标志
    const tokens = tokenizeValidationCommand(c);
    if (!tokens)
        return false;
    const executable = tokens[0] ?? '';
    if (executable !== 'node')
        return false;
    const args = tokens.slice(1);
    return classifyNodeValidationInvocation(executable, args).kind !== 'invalid';
}