/** Shell-free parsing shared by the validation policy, the observed-check normaliser and the runner. */
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
// Each name only toggles output formatting, locale or test-mode behaviour; none of them loads code or redirects
// a tool to another registry, config file or interpreter (unlike NODE_OPTIONS, PATH or npm_config_*).
export const VALIDATION_ENV_PREFIX_ALLOW = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL']);
const SAFE_ENV_VALUE = /^[A-Za-z0-9_.:/+-]*$/;
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
/** Split a tokenized command into its whitelisted env prefix and the invocation proper. */
export function splitValidationInvocation(tokens) {
    const env = {};
    let index = 0;
    for (; index < tokens.length; index += 1) {
        const match = ENV_ASSIGNMENT.exec(tokens[index]);
        if (!match)
            break;
        const [, name, value] = match;
        if (!VALIDATION_ENV_PREFIX_ALLOW.has(name) || !SAFE_ENV_VALUE.test(value))
            return 'disallowed_env';
        env[name] = value;
    }
    const executable = tokens[index];
    if (!executable)
        return null;
    return { env, executable, args: tokens.slice(index + 1) };
}
/** Parse a validation command for execution, including its whitelisted env prefix. */
export function parseValidationInvocation(cmd) {
    const tokens = tokenizeValidationCommand(cmd);
    if (!tokens)
        return null;
    const invocation = splitValidationInvocation(tokens);
    return invocation === 'disallowed_env' ? null : invocation;
}