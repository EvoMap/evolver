import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLUGIN_HOSTS, pluginHostNamed } from './pluginHosts.js';
import { installAgentPlugin } from './pluginInstall.js';
import { createPluginRuntime, PluginInstallError } from './pluginRuntime.js';
export const PLUGIN_USAGE = `Usage: evolver plugin list [--json]
       evolver plugin install [--host <host>] [--scope user|project] [--root <dir>]
                              [--profile <dsh-profile>] [--dry-run] [--json]

Hosts: claude-code, codex, grok, qoder, antigravity, opencode, dsh,
       cursor, workbuddy, mcp-generic
Default scope: user. dsh default profile: dsh-tui.
With no host, only a single discovered native host is selected; otherwise choose --host.
Cursor, WorkBuddy and generic MCP return manual_required without writing client config.
Dry-run performs no download, host command or config write and proves no installed state.
Installation uses EvoMap/evolver-agent-plugin and does not replace setup-hooks.
Exit codes: 0 verified install/already-installed/list/preview; 2 action required; 1 failure.
`;
function parsePluginArgs(argv) {
    const flags = { action: 'list', json: false, dryRun: false };
    let index = 0;
    if (argv[0] && !argv[0].startsWith('-')) {
        if (argv[0] !== 'list' && argv[0] !== 'install')
            throw new PluginInstallError('invalid_arguments', `Unknown plugin action. Use evolver plugin --help.`);
        flags.action = argv[0];
        index = 1;
    }
    const seen = new Set();
    for (; index < argv.length; index++) {
        const token = argv[index];
        if (token === '--help' || token === '-h') {
            flags.action = 'help';
            continue;
        }
        if (token === '--json' || token === '--dry-run') {
            if (seen.has(token))
                throw new PluginInstallError('invalid_arguments', 'A plugin option was repeated.');
            seen.add(token);
            if (token === '--json')
                flags.json = true;
            else
                flags.dryRun = true;
            continue;
        }
        const match = /^--(host|scope|root|profile)(?:=(.*))?$/.exec(token);
        if (!match)
            throw new PluginInstallError('invalid_arguments', 'Unknown plugin option. Use evolver plugin --help.');
        const key = match[1];
        if (seen.has(key))
            throw new PluginInstallError('invalid_arguments', `--${key} was repeated.`);
        seen.add(key);
        const value = match[2] ?? argv[++index];
        if (!value || !value.trim() || value.startsWith('-') || value.includes('\0'))
            throw new PluginInstallError('invalid_arguments', `--${key} requires a non-empty value.`);
        flags[key] = value;
    }
    if (flags.action === 'list' && (flags.host || flags.scope || flags.root || flags.profile || flags.dryRun)) {
        throw new PluginInstallError('invalid_arguments', 'plugin list accepts only --json; use plugin install for installation options.');
    }
    return flags;
}
function installOptions(flags, runtime) {
    let host = flags.host && pluginHostNamed(flags.host);
    if (flags.host && !host)
        throw new PluginInstallError('invalid_arguments', 'Unknown plugin host. Use evolver plugin list to see supported entries.');
    if (!host) {
        const found = PLUGIN_HOSTS.filter(candidate => candidate.kind !== 'manual' && candidate.command && runtime.available(candidate.command));
        if (found.length !== 1)
            throw new PluginInstallError('selection_required', found.length === 0
                ? 'No native plugin host was found on PATH. Choose --host explicitly; plugin list includes manual entries.'
                : `Multiple native hosts were found (${found.map(candidate => candidate.id).join(', ')}). Choose --host; no client configuration was changed.`);
        host = found[0];
    }
    const scope = flags.scope ?? 'user';
    if (scope !== 'user' && scope !== 'project')
        throw new PluginInstallError('invalid_arguments', '--scope must be user or project.');
    if (!host.scopes.includes(scope))
        throw new PluginInstallError('invalid_arguments', `${host.label} does not have a verified ${scope}-scope installer. Supported scopes: ${host.scopes.join(', ')}.`);
    if (flags.profile && host.id !== 'dsh')
        throw new PluginInstallError('invalid_arguments', '--profile is only supported for dsh; no host-specific argument was silently ignored.');
    const profile = flags.profile ?? 'dsh-tui';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))
        throw new PluginInstallError('invalid_arguments', '--profile must be a simple dsh profile name, not a path or command.');
    let root = resolve(runtime.cwd, flags.root ?? '.');
    if (!flags.dryRun && host.kind !== 'manual') {
        try {
            root = realpathSync(root);
            if (!statSync(root).isDirectory())
                throw new Error('not a directory');
        }
        catch {
            throw new PluginInstallError('invalid_arguments', '--root must identify an existing project/working directory.');
        }
    }
    return { host, scope: scope, root, profile, dryRun: flags.dryRun };
}
export async function runPluginCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? (text => { process.stdout.write(text); });
    const stderr = deps.stderr ?? (text => { process.stderr.write(text); });
    const runtime = deps.runtime ?? createPluginRuntime();
    let json = false;
    try {
        const flags = parsePluginArgs(argv);
        json = flags.json;
        if (flags.action === 'help') {
            stdout(PLUGIN_USAGE);
            return 0;
        }
        if (flags.action === 'list') {
            const hosts = PLUGIN_HOSTS.map(host => ({ id: host.id, label: host.label, mode: host.kind === 'manual' ? 'manual' : 'native', cli: host.command ?? null, cliFound: Boolean(host.command && runtime.available(host.command)), minimumVersion: host.minimumVersion ?? null, scopes: host.scopes, instructions: host.instructions }));
            stdout(json ? `${JSON.stringify({ ok: true, action: 'list', hosts })}\n` : `${hosts.map(host => `${host.id.padEnd(14)} ${host.mode.padEnd(7)} ${host.cliFound ? 'CLI found' : 'CLI not found / not required'}; scopes=${host.scopes.join('|')}`).join('\n')}\nCLI detection is not installation or version verification.\n`);
            return 0;
        }
        const result = await installAgentPlugin(runtime, installOptions(flags, runtime));
        if (json)
            stdout(`${JSON.stringify(result)}\n`);
        else {
            const lines = [`${result.host}: ${result.status}${result.version ? ` (${result.version})` : ''}`, ...(result.error ? [result.error] : []), ...result.commands.map(step => `${step.name}: ${JSON.stringify([step.command, ...step.args])}`), ...result.instructions];
            if (result.completed.length > 0 && !result.ok)
                lines.push('Rollback (inspect the host before applying):', ...result.rollback);
            (result.ok || result.status === 'manual_required' ? stdout : stderr)(`${lines.join('\n')}\n`);
        }
        return result.ok ? 0 : result.status === 'failed' || result.status === 'conflict' ? 1 : 2;
    }
    catch (error) {
        const status = error instanceof PluginInstallError ? error.status : 'failed';
        const message = error instanceof PluginInstallError ? error.message : 'Plugin operation failed; no verified installation was reported.';
        const text = json || argv.includes('--json') ? `${JSON.stringify({ ok: false, status, verified: false, error: message })}\n` : `${message}\n`;
        (json || argv.includes('--json') ? stdout : stderr)(text);
        return status === 'failed' || status === 'conflict' ? 1 : 2;
    }
}