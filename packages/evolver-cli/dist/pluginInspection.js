import { resolveOpenCodeConfig } from '@evomap/evolver-mcp';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PLUGIN_GIT_URL, AGENT_PLUGIN_NAME, AGENT_PLUGIN_REPOSITORY } from './pluginHosts.js';
import { checkedPluginCommand, objectOf, pluginHome, pluginJson, pluginVersionAtLeast, PluginInstallError, readPluginJson, readPluginText } from './pluginRuntime.js';
function listRecords(value, key, label) {
    const list = Array.isArray(value) ? value : objectOf(value)?.[key];
    if (!Array.isArray(list) || list.some(record => !objectOf(record))) {
        throw new PluginInstallError('unsupported_capability', `${label} has an unsupported list shape; no installed state can be inferred.`);
    }
    return list;
}
const stringOf = (value) => typeof value === 'string' && value.length > 0 ? value : undefined;
export function installedPluginsFromJson(value, host) {
    const records = listRecords(value, host.id === 'codex' ? 'installed' : 'plugins', `${host.label} plugin list`);
    return records.filter(record => record['installed'] !== false).map(raw => {
        const id = stringOf(raw['id']) ?? stringOf(raw['pluginId']) ?? stringOf(raw['name']);
        const name = stringOf(raw['name']) ?? id?.split('@')[0];
        if (!id || !name)
            throw new PluginInstallError('unsupported_capability', `${host.label} plugin list has an unnamed entry.`);
        return {
            id, name, version: stringOf(raw['version']) ?? '', enabled: raw['enabled'] !== false,
            scope: stringOf(raw['scope']), path: stringOf(raw['installPath']) ?? stringOf(raw['installedPath']) ?? stringOf(raw['path']), raw,
        };
    });
}
export function agentPluginRepositoryMatches(value) {
    if (typeof value !== 'string')
        return false;
    const source = value.trim().toLowerCase().replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/\/$/, '').replace(/\.git$/, '');
    return source === AGENT_PLUGIN_GIT_URL.toLowerCase().replace(/\.git$/, '') || source === AGENT_PLUGIN_REPOSITORY.toLowerCase();
}
function packageRepositoryOf(value) {
    return typeof value === 'string' ? value : objectOf(value)?.['url'];
}
function repositoryOf(record) {
    return record['repo'] ?? objectOf(record['marketplaceSource'])?.['source']
        ?? objectOf(record['source'])?.['url'] ?? (typeof record['source'] === 'string' ? record['source'] : undefined);
}
async function marketplaceMatches(runtime, record) {
    if (agentPluginRepositoryMatches(repositoryOf(record)))
        return true;
    const root = stringOf(record['root']) ?? stringOf(record['installLocation']);
    if (!root)
        return false;
    try {
        const { stdout } = await checkedPluginCommand(runtime, 'git', ['-C', root, 'remote', 'get-url', 'origin']);
        return agentPluginRepositoryMatches(stdout.trim());
    }
    catch {
        return false;
    }
}
function hasEvolutionHook(value) {
    if (Array.isArray(value))
        return value.some(hasEvolutionHook);
    const object = objectOf(value);
    if (!object)
        return false;
    if (typeof object['command'] === 'string' && /(?:\bevolver\b|cli\.[cm]?js).*?\binject\s+(?:session-start|prompt-recall)\b/.test(object['command']))
        return true;
    return Object.values(object).some(hasEvolutionHook);
}
function oldHookConflicts(runtime, options) {
    const { host, root } = options;
    const home = pluginHome(runtime);
    const roots = host.id === 'claude-code'
        ? [runtime.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'), join(root, '.claude')]
        : host.id === 'codex' ? [runtime.env['CODEX_HOME'] ?? join(home, '.codex'), join(root, '.codex')] : [];
    const conflicts = [];
    for (const directory of new Set(roots)) {
        for (const file of ['settings.json', 'settings.local.json', 'hooks.json']) {
            const config = readPluginJson(join(directory, file));
            if (config && config['disableAllHooks'] !== true && hasEvolutionHook(config['hooks'] ?? config)) {
                conflicts.push(`An existing ${host.label} Evolver evolution hook is registered. Review/remove only that old hook before enabling the plugin; product MCP entries and unrelated hooks must remain.`);
            }
        }
    }
    return conflicts;
}
function hasForeignInstalledScope(plugin, scope) {
    return Boolean(plugin.scope && plugin.scope !== scope && !(scope === 'user' && plugin.scope === 'global'));
}
async function inspectMarketplacePlugin(runtime, options) {
    const { host, scope } = options;
    const management = host.management;
    const pluginResult = await checkedPluginCommand(runtime, host.command, [management, 'list', '--json'], options.root);
    const plugins = installedPluginsFromJson(pluginJson(pluginResult.stdout, `${host.label} plugin list`), host);
    const marketResult = await checkedPluginCommand(runtime, host.command, [management, 'marketplace', 'list', '--json'], options.root);
    const markets = listRecords(pluginJson(marketResult.stdout, `${host.label} marketplace list`), 'marketplaces', `${host.label} marketplace list`);
    const market = markets.find(record => record['name'] === host.marketplace);
    const conflicts = oldHookConflicts(runtime, options);
    if (market && !await marketplaceMatches(runtime, market))
        conflicts.push(`Marketplace ${host.marketplace} belongs to another source. Review its plugins before replacing it with ${AGENT_PLUGIN_REPOSITORY}.`);
    for (const plugin of plugins) {
        if (host.legacyNames.includes(plugin.name) && plugin.enabled)
            conflicts.push(`The standalone ${plugin.name} plugin is enabled. Disable/remove it using ${host.label}, keeping its data, before installing ${AGENT_PLUGIN_NAME}.`);
        if (plugin.name === AGENT_PLUGIN_NAME && plugin.id !== `${AGENT_PLUGIN_NAME}@${host.marketplace}` && !(host.id === 'grok' && plugin.id === AGENT_PLUGIN_NAME))
            conflicts.push('An Evolver plugin from another marketplace is registered; review that installation before continuing.');
    }
    const installed = plugins.find(plugin => (plugin.id === `${AGENT_PLUGIN_NAME}@${host.marketplace}` || (host.id === 'grok' && plugin.id === AGENT_PLUGIN_NAME)) && (host.id !== 'claude-code' || plugin.scope === scope));
    if (installed && host.id !== 'claude-code' && hasForeignInstalledScope(installed, scope))
        conflicts.push('The host registered this plugin in another scope; it cannot confirm the requested installation scope.');
    if (installed && !installed.enabled)
        conflicts.push('The plugin is installed but disabled. Enable it explicitly in the host rather than installing another copy.');
    if (installed && host.id === 'codex' && !agentPluginRepositoryMatches(repositoryOf(installed.raw)))
        conflicts.push('The installed plugin source does not match the unified Evolver plugin repository.');
    return { installed, marketplacePresent: Boolean(market), conflicts };
}
export function verifyPluginManifest(runtime, options, plugin, installAnswer) {
    const { host } = options;
    if (!pluginVersionAtLeast(plugin.version, plugin.version))
        throw new PluginInstallError('failed', 'The installed plugin has no verifiable version.');
    const answer = objectOf(installAnswer);
    const path = plugin.path ?? stringOf(answer?.['installedPath']) ?? stringOf(answer?.['installPath'])
        ?? (host.id === 'codex' ? join(runtime.env['CODEX_HOME'] ?? join(pluginHome(runtime), '.codex'), 'plugins', 'cache', host.marketplace, AGENT_PLUGIN_NAME, plugin.version) : undefined);
    if (!path || !host.manifest)
        throw new PluginInstallError('failed', 'The host did not identify a verifiable installed plugin directory.');
    const manifest = readPluginJson(join(path, host.manifest));
    const expectedName = host.id === 'opencode' ? '@evomap/evolver-opencode' : host.id === 'dsh' ? '@evomap/dsh-evolver' : AGENT_PLUGIN_NAME;
    if (!manifest || manifest['name'] !== expectedName || manifest['version'] !== plugin.version) {
        throw new PluginInstallError('failed', 'The host registration and installed plugin manifest do not agree; installation was not confirmed.');
    }
    const repository = packageRepositoryOf(manifest?.['repository']);
    if (!agentPluginRepositoryMatches(repository))
        throw new PluginInstallError('conflict', 'The installed plugin manifest does not identify the unified Evolver plugin source.');
    if (readPluginText(join(path, '.evolver-packed'))?.trim() !== host.id)
        throw new PluginInstallError('failed', 'The installed plugin is not the packed artifact for the selected host.');
    const entries = host.id === 'opencode' ? ['server.mjs', 'tui.mjs'] : host.id === 'dsh' ? ['plugin.mjs'] : host.id === 'antigravity' ? ['hooks.json', 'bin/hook.mjs'] : host.id === 'claude-code' ? ['hooks/hooks.json', 'hooks/register.ts', 'bin/relay.mjs'] : ['hooks/hooks.json', 'bin/hook.mjs'];
    if (entries.some(entry => !existsSync(join(path, entry))))
        throw new PluginInstallError('failed', 'The installed plugin is missing its hook/plugin entry files.');
    return path;
}
function pluginEntries(config) {
    const entries = config?.['plugin'] ?? config?.['plugins'] ?? [];
    if (!Array.isArray(entries))
        throw new PluginInstallError('unsupported_capability', 'OpenCode plugin configuration is not a supported array.');
    return entries.map(entry => {
        const value = Array.isArray(entry) ? entry[0] : entry;
        if (typeof value !== 'string')
            throw new PluginInstallError('unsupported_capability', 'OpenCode has an unsupported plugin entry.');
        return value;
    });
}
function entryPath(entry, root) {
    try {
        return entry.startsWith('file:') ? fileURLToPath(entry) : resolve(root, entry);
    }
    catch {
        return '';
    }
}
export function inspectOpenCodePlugin(runtime, options) {
    if (runtime.env['OPENCODE_CONFIG_CONTENT']?.trim() || (options.scope === 'project' && runtime.env['OPENCODE_DISABLE_PROJECT_CONFIG'] === '1')) {
        throw new PluginInstallError('unsupported_capability', 'OpenCode has an inline/disabled project configuration layer that this plugin installer cannot verify. No host install was attempted.');
    }
    const resolution = resolveOpenCodeConfig({ configRoot: options.root, scope: options.scope, homeDir: pluginHome(runtime), xdgConfigHome: runtime.env['XDG_CONFIG_HOME'], opencodeConfig: runtime.env['OPENCODE_CONFIG'], opencodeConfigDir: runtime.env['OPENCODE_CONFIG_DIR'] });
    const root = dirname(resolution.configPath);
    const serverEntries = pluginEntries(readPluginJson(resolution.configPath));
    const tuiFile = existsSync(join(root, 'tui.jsonc')) ? join(root, 'tui.jsonc') : join(root, 'tui.json');
    const tuiEntries = pluginEntries(readPluginJson(tuiFile));
    const conflicts = [];
    const pairs = [];
    for (const entry of [...serverEntries, ...tuiEntries]) {
        if (options.host.legacyNames.some(name => entry.includes(name)))
            conflicts.push('The standalone OpenCode Evolver package is registered; remove only its entries, keeping its data.');
    }
    if (existsSync(join(options.root, '.opencode', 'plugins', 'evolver.js')))
        conflicts.push('A legacy .opencode/plugins/evolver.js is present; inspect/disable it before continuing.');
    for (const entry of serverEntries) {
        const server = entryPath(entry, root);
        if (!server.endsWith('/server.mjs') && !server.endsWith('\\server.mjs'))
            continue;
        const manifest = readPluginJson(join(dirname(server), 'package.json'));
        if (manifest?.['name'] !== '@evomap/evolver-opencode')
            continue;
        const tui = tuiEntries.map(value => entryPath(value, root)).find(value => value === join(dirname(server), 'tui.mjs'));
        if (!tui)
            conflicts.push('Only the OpenCode server plugin is registered; reconcile its TUI entry before retrying.');
        else
            pairs.push({ server, tui });
    }
    if (pairs.length > 1)
        conflicts.push('Multiple OpenCode Evolver plugin installations are registered.');
    for (const entry of tuiEntries) {
        const tui = entryPath(entry, root);
        if (!tui.endsWith('/tui.mjs') && !tui.endsWith('\\tui.mjs'))
            continue;
        if (readPluginJson(join(dirname(tui), 'package.json'))?.['name'] === '@evomap/evolver-opencode' && !pairs.some(pair => pair.tui === tui)) {
            conflicts.push('Only the OpenCode TUI plugin is registered; reconcile its server entry before retrying.');
        }
    }
    for (const entry of [...serverEntries, ...tuiEntries]) {
        if (entry.includes('@evomap/evolver-opencode'))
            conflicts.push('An OpenCode Evolver package specifier is already registered. Resolve its source/path before installing another copy.');
    }
    const pair = pairs[0];
    const path = pair && dirname(pair.server);
    const manifest = path && readPluginJson(join(path, 'package.json'));
    const installed = manifest && typeof manifest['version'] === 'string' ? { id: AGENT_PLUGIN_NAME, name: AGENT_PLUGIN_NAME, version: manifest['version'], enabled: true, path, raw: manifest } : undefined;
    return { installed, marketplacePresent: false, conflicts };
}
function inspectDshPlugin(runtime, options) {
    const profileDir = join(pluginHome(runtime), '.dsh', 'profiles', options.profile);
    const project = readPluginJson(join(profileDir, 'package.json'));
    const dependency = objectOf(project?.['dependencies'])?.['@evomap/dsh-evolver'];
    const path = join(profileDir, 'node_modules', '@evomap', 'dsh-evolver');
    const manifest = readPluginJson(join(path, 'package.json'));
    const conflicts = [];
    if (dependency !== undefined && (typeof dependency !== 'string' || !dependency.includes(`github:${AGENT_PLUGIN_REPOSITORY}#release&path:dist/dsh`))) {
        conflicts.push(`Profile ${options.profile} contains the standalone or differently sourced @evomap/dsh-evolver. Remove that package in this profile first; keep its state.`);
    }
    const repository = packageRepositoryOf(manifest?.['repository']);
    if (manifest && !agentPluginRepositoryMatches(repository))
        conflicts.push('The installed dsh package does not belong to the unified plugin repository.');
    const installed = manifest && dependency !== undefined && typeof manifest['version'] === 'string'
        ? { id: AGENT_PLUGIN_NAME, name: AGENT_PLUGIN_NAME, version: manifest['version'], enabled: true, path, raw: manifest } : undefined;
    return { installed, marketplacePresent: false, conflicts };
}
export async function inspectAgentPlugin(runtime, options) {
    if (options.host.kind === 'marketplace')
        return inspectMarketplacePlugin(runtime, options);
    if (options.host.id === 'opencode')
        return inspectOpenCodePlugin(runtime, options);
    if (options.host.id === 'dsh')
        return inspectDshPlugin(runtime, options);
    const result = await checkedPluginCommand(runtime, options.host.command, ['plugin', 'list', '--json'], options.root);
    const plugins = installedPluginsFromJson(pluginJson(result.stdout, 'Antigravity plugin list'), options.host);
    const installed = plugins.find(plugin => plugin.name === AGENT_PLUGIN_NAME);
    const conflicts = plugins.filter(plugin => options.host.legacyNames.includes(plugin.name) && plugin.enabled).map(plugin => `Standalone ${plugin.name} is enabled; disable/remove it and keep its data before continuing.`);
    if (installed && hasForeignInstalledScope(installed, options.scope))
        conflicts.push('The host registered this plugin in another scope; it cannot confirm the requested installation scope.');
    if (installed && !installed.enabled)
        conflicts.push('The plugin is installed but disabled. Enable it explicitly in the host rather than installing another copy.');
    return { marketplacePresent: false, installed, conflicts };
}