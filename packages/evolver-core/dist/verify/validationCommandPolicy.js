import { sanitizeExecutionCommand } from './executionRedaction.js';
import { classifyNodeValidationInvocation, nodeFlagViolation, SHELL_METACHARS, splitValidationInvocation, tokenizeValidationCommand } from './validationSyntax.js';
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.@/+-]*$/;
// Test runners that only read the checkout and its installed dependencies; none of them installs packages.
export const VALIDATION_TEST_TOOLS = new Set(['vitest', 'jest', 'tsc', 'eslint', 'mocha']);
// Package-manager options that switch registry/config/global prefix, leave the checkout, auto-install a package,
// or replace the script shell. Checked only where the package manager (not the script) owns the argument.
const PACKAGE_MANAGER_DENIED_OPTIONS = new Set([
    '--registry', '--userconfig', '--globalconfig', '--prefix', '--global', '-g', '--location', '--config', '-c', '--call',
    '--dir', '-C', '--cwd', '--node-options', '--script-shell', '--shell-emulator', '--yes', '-y', '--package', '-p', '--unsafe-perm',
]);
const NPM_BOOLEAN_OPTIONS = new Set([
    '--workspaces', '--include-workspace-root', '--if-present', '--ignore-scripts', '--foreground-scripts', '--color', '--json',
]);
const NPM_LOG_LEVELS = new Set(['silent', 'error', 'warn', 'notice', 'http', 'info', 'verbose', 'silly']);
const NPM_LOG_ALIASES = new Set(['--silent', '-s', '--quiet', '-q', '--verbose']);
// pnpm/yarn treat these names as built-in commands, never as package.json scripts, and they install, publish,
// mutate config or run an arbitrary binary.
const PNPM_BUILTINS = new Set([
    'add', 'i', 'install', 'it', 'install-test', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'link', 'ln',
    'unlink', 'import', 'rebuild', 'rb', 'prune', 'fetch', 'patch', 'patch-commit', 'patch-remove', 'publish', 'pack',
    'dlx', 'create', 'exec', 'x', 'env', 'setup', 'self-update', 'store', 'server', 'config', 'c', 'set', 'get', 'audit',
    'outdated', 'licenses', 'deploy', 'init', 'login', 'logout', 'adduser', 'whoami', 'approve-builds', 'ignored-builds',
    'cache', 'cat-file', 'cat-index', 'find-hash', 'dedupe', 'doctor', 'bin', 'root', 'list', 'ls', 'why', 'version',
    'access', 'bugs', 'deprecate', 'dist-tag', 'docs', 'edit', 'info', 'view', 'search', 'star', 'token', 'owner',
    'completion', 'help', 'recursive', 'multi', 'm',
]);
const YARN_BUILTINS = new Set([
    'add', 'install', 'remove', 'upgrade', 'upgrade-interactive', 'up', 'dlx', 'exec', 'node', 'npm', 'publish', 'pack',
    'set', 'config', 'plugin', 'policies', 'global', 'link', 'unlink', 'unplug', 'import', 'init', 'create', 'cache',
    'why', 'workspace', 'workspaces', 'rebuild', 'patch', 'patch-commit', 'dedupe', 'constraints', 'stage', 'search',
    'sdks', 'version', 'versions', 'login', 'logout', 'owner', 'tag', 'team', 'info', 'licenses', 'outdated', 'audit',
    'autoclean', 'bin', 'check', 'generate-lock-entry', 'list', 'explain', 'help',
]);
// Each changes what is built or executed (a wrapper program, a substitute toolchain, a foreign config/manifest)
// rather than which tests run.
const PYTEST_DENIED_OPTIONS = new Set(['--config-file', '--rootdir']);
const GO_DENIED_OPTIONS = new Set(['-exec', '-toolexec', '-modfile', '-C', '-overlay']);
const CARGO_DENIED_OPTIONS = new Set(['--config', '-Z', '-C', '--manifest-path']);
const optionName = (arg) => arg.split('=')[0] ?? arg;
const isOption = (arg) => arg.startsWith('-') && arg !== '-';
function packageManagerOptionRejection(arg) {
    // A short cluster such as `-gy` could smuggle a denied flag past the exact-name table.
    if (/^-[A-Za-z]{2,}$/.test(arg))
        return 'disallowed_option';
    const name = optionName(arg);
    // `--config.registry=…` and `--@scope:registry=…` set the same config through a computed key.
    if (name.startsWith('--config.') || name.includes('registry'))
        return 'disallowed_option';
    return PACKAGE_MANAGER_DENIED_OPTIONS.has(name) ? 'disallowed_option' : null;
}
/** Walk package-manager-owned options up to the command word; `--filter`/`-F` select workspace packages. */
function packageManagerCommand(args, valueOptions) {
    let index = 0;
    while (index < args.length && isOption(args[index])) {
        const arg = args[index];
        if (arg === '--')
            return 'disallowed_subcommand';
        const rejection = packageManagerOptionRejection(arg);
        if (rejection)
            return rejection;
        index += valueOptions.has(arg) ? 2 : 1;
    }
    return index < args.length ? { index } : 'disallowed_subcommand';
}
function scriptAfterRun(args, start) {
    let index = start;
    while (index < args.length && isOption(args[index])) {
        const rejection = packageManagerOptionRejection(args[index]);
        if (rejection)
            return rejection;
        index += 1;
    }
    return SCRIPT_NAME.test(args[index] ?? '') ? null : 'disallowed_subcommand';
}
function npmBooleanName(name) {
    return name === '-ws' || name === '--ws' ? '--workspaces' : name.replace(/^--no-/, '--');
}
function npmBooleanValue(name, value) {
    return value === 'true' || value === 'false'
        || (name === '--workspaces' && value === 'null') || (name === '--color' && value === 'always');
}
/** Number of following tokens npm consumes, or null if the option is outside the supported grammar. */
function npmOptionArity(arg, next) {
    const name = optionName(arg);
    const inline = arg !== name;
    const arity = inline ? 0 : 1;
    const value = inline ? arg.slice(name.length + 1) : next;
    if (name === '--workspace' || name === '-w')
        return value && !value.startsWith('-') ? arity : null;
    if (name === '--loglevel')
        return NPM_LOG_LEVELS.has(value ?? '') ? arity : null;
    const booleanName = npmBooleanName(name);
    if (NPM_BOOLEAN_OPTIONS.has(booleanName)) {
        if (npmBooleanValue(booleanName, value))
            return arity;
        return inline ? null : 0;
    }
    return !inline && NPM_LOG_ALIASES.has(name) ? 0 : null;
}
function npmRejection(args) {
    // npm consumes options on both sides of the command word. Only accept options with known value syntax.
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--')
            break;
        if (!isOption(arg)) {
            positional.push(arg);
            continue;
        }
        const arity = npmOptionArity(arg, args[index + 1]);
        if (arity === null)
            return 'disallowed_option';
        index += arity;
    }
    const [command, script] = positional;
    if (command === 'test' || ((command === 'run' || command === 'run-script') && SCRIPT_NAME.test(script ?? '')))
        return null;
    return 'disallowed_subcommand';
}
function pnpmRejection(args) {
    const found = packageManagerCommand(args, new Set(['--filter', '-F']));
    if (typeof found === 'string')
        return found;
    const word = args[found.index];
    if (word === 'test' || VALIDATION_TEST_TOOLS.has(word))
        return null;
    if (word === 'run')
        return scriptAfterRun(args, found.index + 1);
    if (word === 'exec')
        return VALIDATION_TEST_TOOLS.has(args[found.index + 1] ?? '') ? null : 'disallowed_subcommand';
    if (PNPM_BUILTINS.has(word))
        return 'disallowed_subcommand';
    return SCRIPT_NAME.test(word) ? null : 'disallowed_subcommand';
}
function yarnRejection(args) {
    const found = packageManagerCommand(args, new Set());
    if (typeof found === 'string')
        return found;
    const word = args[found.index];
    if (word === 'test')
        return null;
    if (word === 'run')
        return scriptAfterRun(args, found.index + 1);
    if (YARN_BUILTINS.has(word))
        return 'disallowed_subcommand';
    return SCRIPT_NAME.test(word) ? null : 'disallowed_subcommand';
}
function npxRejection(args) {
    const tool = args[0] ?? '';
    if (isOption(tool))
        return 'disallowed_option';
    return VALIDATION_TEST_TOOLS.has(tool) ? null : 'disallowed_subcommand';
}
function pytestRejection(args) {
    for (const arg of args) {
        if (arg === '--')
            break;
        if (PYTEST_DENIED_OPTIONS.has(optionName(arg)))
            return 'disallowed_option';
        // `-p` loads a plugin module and `-c` swaps the ini file; either may sit inside a short cluster (`-xpfoo`).
        if (/^-[A-Za-z]*[pc]/.test(arg) && !arg.startsWith('--'))
            return 'disallowed_option';
    }
    return null;
}
function goTestRejection(args) {
    if (args[0] !== 'test')
        return 'disallowed_subcommand';
    for (const [index, arg] of args.entries()) {
        if (index === 0)
            continue;
        if (arg === '-args' || arg === '--args')
            break;
        const name = optionName(arg.replace(/^--/, '-'));
        if (GO_DENIED_OPTIONS.has(name))
            return 'disallowed_option';
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1];
        if (name === '-mod' && value === 'mod')
            return 'disallowed_option';
    }
    return null;
}
function cargoTestRejection(args) {
    if (args[0] !== 'test')
        return 'disallowed_subcommand';
    for (const arg of args.slice(1)) {
        if (arg === '--')
            break;
        if (CARGO_DENIED_OPTIONS.has(optionName(arg)) || /^-Z./.test(arg))
            return 'disallowed_option';
    }
    return null;
}
function nodeRejection(args) {
    if (nodeFlagViolation('node', args))
        return 'blocked_node_flag';
    return classifyNodeValidationInvocation('node', args).kind === 'invalid' ? 'invalid_node_invocation' : null;
}
const TOOL_RULES = {
    node: nodeRejection,
    npm: npmRejection,
    pnpm: pnpmRejection,
    yarn: yarnRejection,
    npx: npxRejection,
    pytest: pytestRejection,
    python: (args) => args[0] === '-m' && args[1] === 'pytest' ? pytestRejection(args.slice(2)) : 'disallowed_subcommand',
    python3: (args) => args[0] === '-m' && args[1] === 'pytest' ? pytestRejection(args.slice(2)) : 'disallowed_subcommand',
    go: goTestRejection,
    cargo: cargoTestRejection,
};
/** Bare executable names the sandbox resolves itself; a path would bypass that resolution. */
export const VALIDATION_EXECUTABLES = new Set(Object.keys(TOOL_RULES));
/** The single policy for Gene validation commands: null when allowed, otherwise the first reason it is not. */
export function validationCommandRejection(cmd) {
    const c = String(cmd || '').trim();
    if (!c)
        return 'empty';
    const sanitized = sanitizeExecutionCommand(c);
    if (sanitized.changed || sanitized.blocked)
        return 'credential';
    if (/`|\$\(/.test(c))
        return 'command_substitution';
    const unquoted = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    if (SHELL_METACHARS.test(unquoted))
        return 'shell_metacharacters';
    const tokens = tokenizeValidationCommand(c);
    if (!tokens)
        return 'unparseable';
    const invocation = splitValidationInvocation(tokens);
    if (invocation === 'disallowed_env')
        return invocation;
    if (!invocation)
        return 'unparseable';
    const rule = TOOL_RULES[invocation.executable];
    return rule ? rule(invocation.args) : 'unsupported_executable';
}
export function isValidationCommandAllowed(cmd) {
    return validationCommandRejection(cmd) === null;
}