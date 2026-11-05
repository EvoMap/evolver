import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SHELL_METACHARS, splitValidationInvocation, tokenizeValidationCommand } from './validationSyntax.js';
const TIMEOUT_DURATION = /^\d+(\.\d+)?[smhd]?$/;
const PLAIN_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** The path with every symlink in its existing part followed; a part that does not exist yet is kept as written. */
function realPathOf(path) {
    try {
        return realpathSync(path);
    }
    catch {
        const parent = dirname(path);
        return parent === path ? path : join(realPathOf(parent), basename(path));
    }
}
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Split on `&&` outside quotes; null when the command contains any other unquoted `&`. */
function splitConjunction(command) {
    const segments = [];
    let quote = null;
    let start = 0;
    for (let index = 0; index < command.length; index += 1) {
        const ch = command[index];
        if (quote) {
            if (ch === quote)
                quote = null;
            else if (ch === '\\' && quote === '"')
                index += 1;
            continue;
        }
        if (ch === '"' || ch === "'")
            quote = ch;
        else if (ch === '\\')
            index += 1;
        else if (ch === '&') {
            if (command[index + 1] !== '&')
                return null;
            segments.push(command.slice(start, index));
            index += 1;
            start = index + 1;
        }
    }
    segments.push(command.slice(start));
    return segments.map((segment) => segment.trim());
}
function quoteToken(token) {
    return PLAIN_TOKEN.test(token) ? token : `"${token.replace(/(["\\])/g, '\\$1')}"`;
}
function observedCwd(segment, projectRoot) {
    const tokens = tokenizeValidationCommand(segment);
    if (!tokens || tokens.length !== 2 || tokens[0] !== 'cd')
        return null;
    const dir = tokens[1];
    if (!dir || dir.startsWith('~') || dir.startsWith('-'))
        return null;
    const root = resolve(projectRoot);
    const target = resolve(root, dir);
    return pathIsWithin(root, target) && pathIsWithin(realPathOf(root), realPathOf(target)) ? relative(root, target) : null;
}
/** The sandbox enforces its own deadline, so a `timeout <duration>` wrapper is dropped rather than run. */
function withoutTimeout(tokens) {
    if (tokens[0] !== 'timeout')
        return tokens;
    return TIMEOUT_DURATION.test(tokens[1] ?? '') && tokens.length > 2 ? tokens.slice(2) : null;
}
/**
 * Reduce a check command a host observed (`cd pkg && CI=1 timeout 600 pnpm test`) to the single invocation the
 * sandbox runs plus its working directory. Anything that needs a real shell to mean the same thing is refused
 * rather than approximated, so the verified command is exactly what the host ran.
 */
export function normalizeObservedCheck(command, projectRoot) {
    const text = String(command ?? '').trim();
    if (!text)
        return undefined;
    const segments = splitConjunction(text);
    if (!segments || segments.length > 2 || segments.some((segment) => !segment || SHELL_METACHARS.test(segment)))
        return undefined;
    const cwd = segments.length === 2 ? observedCwd(segments[0], projectRoot) : '';
    if (cwd === null)
        return undefined;
    const tokens = tokenizeValidationCommand(segments[segments.length - 1]);
    if (!tokens)
        return undefined;
    const invocation = splitValidationInvocation(tokens);
    if (!invocation || invocation === 'disallowed_env')
        return undefined;
    const invoked = withoutTimeout([invocation.executable, ...invocation.args]);
    if (!invoked)
        return undefined;
    const envTokens = Object.entries(invocation.env).map(([name, value]) => `${name}=${value}`);
    const normalized = [...envTokens, ...invoked].map(quoteToken).join(' ');
    return cwd ? { command: normalized, cwd } : { command: normalized };
}