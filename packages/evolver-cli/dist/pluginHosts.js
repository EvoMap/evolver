import { dirname, join } from 'node:path';
export const AGENT_PLUGIN_REPOSITORY = 'EvoMap/evolver-agent-plugin';
export const AGENT_PLUGIN_GIT_URL = `https://github.com/${AGENT_PLUGIN_REPOSITORY}.git`;
export const AGENT_PLUGIN_NAME = 'evolver-plugin';
export const AGENT_PLUGIN_RELEASE = 'release';
export const DSH_PLUGIN_SOURCE = `github:${AGENT_PLUGIN_REPOSITORY}#${AGENT_PLUGIN_RELEASE}&path:dist/dsh`;
export function agentPluginRepositoryMatches(value) {
    if (typeof value !== 'string')
        return false;
    const source = value.trim().toLowerCase().replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/\/$/, '').replace(/\.git$/, '');
    return source === AGENT_PLUGIN_GIT_URL.toLowerCase().replace(/\.git$/, '') || source === AGENT_PLUGIN_REPOSITORY.toLowerCase();
}
export const PLUGIN_HOSTS = [
    {
        id: 'claude-code', label: 'Claude Code', command: 'claude', minimumVersion: '2.1.286',
        kind: 'marketplace', management: 'plugin', marketplace: 'evolver-agent-plugin',
        scopes: ['user', 'project'], manifest: '.claude-plugin/plugin.json', entries: ['hooks/hooks.json', 'hooks/register.ts', 'bin/relay.mjs'],
        legacyNames: ['evolver', 'evolver-mods', 'evolver-agent-plugin'],
        instructions: ['Restart Claude Code. Installed hooks modules also require the host rollout flag; an installed plugin is not proof that recall is active.'],
    },
    {
        id: 'codex', label: 'Codex', command: 'codex', minimumVersion: '0.164.0', kind: 'marketplace', management: 'plugin', marketplace: 'evomap',
        scopes: ['user'], manifest: '.codex-plugin/plugin.json', entries: ['hooks/hooks.json', 'bin/hook.mjs'], legacyNames: ['evolver'],
        instructions: ['Open /hooks in Codex, review and trust the Evolver hooks, then start a new thread.'],
    },
    {
        id: 'grok', label: 'Grok CLI', command: 'grok', minimumVersion: '1.0.70',
        kind: 'marketplace', management: 'plugin', marketplace: 'evolver-agent-plugin', scopes: ['user'], manifest: '.grok-plugin/plugin.json', entries: ['hooks/hooks.json', 'bin/hook.mjs'],
        packedSubdir: 'dist/grok', requiresTrust: true, legacyNames: ['evolver', 'evolver-grok-plugin'],
        instructions: ['Restart Grok and review its hook trust settings. Recall reaches the first tool result; a turn without tools receives no strategy.'],
    },
    {
        id: 'qoder', label: 'Qoder CLI', command: 'qodercli', minimumVersion: '1.1.79',
        kind: 'marketplace', management: 'plugins', marketplace: 'evomap', scopes: ['user'], manifest: '.qoder-plugin/plugin.json', entries: ['hooks/hooks.json', 'bin/hook.mjs'],
        legacyNames: ['evolver', 'evolver-qoder-plugin'], instructions: ['Start a new Qoder session or run /plugins reload.'],
    },
    {
        id: 'antigravity', label: 'Antigravity', command: 'agy', kind: 'bundle', management: 'plugin',
        scopes: ['user'], manifest: 'plugin.json', entries: ['hooks.json', 'bin/hook.mjs'], legacyNames: ['evolver-antigravity-plugin'],
        instructions: ['Restart Antigravity. Its commands run from the installed plugin with node bin/command.mjs antigravity <command>.'],
    },
    {
        id: 'opencode', label: 'OpenCode', command: 'opencode', minimumVersion: '1.19.4', kind: 'bundle',
        scopes: ['user', 'project'], manifest: 'package.json', packageName: '@evomap/evolver-opencode', entries: ['server.mjs', 'tui.mjs'],
        legacyNames: ['evolver-opencode-plugin'],
        instructions: ['Restart OpenCode. Both the server entry in opencode.json and the TUI entry in tui.json must be registered.'],
    },
    {
        id: 'dsh', label: 'DeepSeek Harness', command: 'dsh', minimumVersion: '0.1.5', kind: 'profile',
        scopes: ['user'], manifest: 'package.json', packageName: '@evomap/dsh-evolver', entries: ['plugin.mjs'], legacyNames: ['@evomap/dsh-evolver'],
        instructions: ['Restart dsh. Installation applies only to the selected profile; repeat for other profiles. DSH Desktop requires its own bundled CLI/profile.'],
    },
    {
        id: 'zcode', label: 'ZCode', command: 'zcode', kind: 'bundle', management: 'plugins', marketplace: 'evolver-zcode-local',
        scopes: ['user'], platforms: ['win32', 'darwin'], manifest: '.zcode-plugin/plugin.json', entries: ['hooks/hooks.json', 'bin/hook.mjs'], legacyNames: [],
        instructions: [
            'Start a new ZCode session. ZCode CLI and Desktop share this installation; plugins and hooks must be enabled in ZCode.',
            'Evolver runs the CLI shipped with ZCode Desktop, or the standalone zcode.cjs named by ZCODE_CLI_PATH.',
        ],
    },
    {
        id: 'kimi', label: 'Kimi Code', command: 'kimi', kind: 'script', installer: 'scripts/install-kimi.mjs',
        scopes: ['user'], platforms: ['win32'], manifest: 'kimi.plugin.json', entries: ['bin/hook.mjs'], legacyNames: [],
        instructions: [
            'Close Kimi Code before installing or updating, then start a new CLI or Desktop session.',
            'KIMI_CODE_HOME selects the profile root; start Kimi with the same value.',
        ],
    },
    {
        id: 'stepcode', label: 'Step Code', command: 'step', kind: 'bundle', scopes: ['user'], platforms: ['win32'],
        manifest: 'package.json', packageName: '@evomap/stepcode-evolver', entries: ['plugin.mjs'], legacyNames: [],
        instructions: ['Start a new Step Code session. The adapter is a Windows draft for Step Code CLI 0.1.7; STEP_CODING_AGENT_DIR selects the profile.'],
    },
    {
        id: 'minimax', label: 'MiniMax Code', command: 'mcode', kind: 'script', installer: 'scripts/install-minimax.mjs',
        scopes: ['user'], manifest: '.minimax-plugin/plugin.json', entries: ['hooks/hooks.json', 'bin/hook.mjs'], legacyNames: [],
        instructions: [
            'Start a new MiniMax task. MINIMAX_DATA_DIR selects the data root; keep it the same for mcode.',
            'To pause the plugin: mcode plugin disable evolver-plugin@local --json',
        ],
    },
    {
        id: 'cursor', label: 'Cursor', command: 'cursor-agent', kind: 'manual', scopes: ['user'], entries: [],
        legacyNames: ['evolver-cursor-plugin'],
        instructions: [
            `In Cursor's plugin marketplace, add ${AGENT_PLUGIN_REPOSITORY} and install evolver-plugin.`,
            'Remove or disable the standalone Evolver plugin first to avoid duplicate recall and reports; keep its data.',
            'Reload the Cursor window and inspect Settings → Hooks. The current Cursor CLI has no verified plugin-install command.',
        ],
    },
    {
        id: 'workbuddy', label: 'WorkBuddy / CodeBuddy', command: 'codebuddy', kind: 'manual', scopes: ['user', 'project'], entries: [],
        legacyNames: ['evolver'],
        instructions: [
            'In WorkBuddy, if the standalone plugin is installed: /plugin uninstall evolver@evomap-workbuddy --keep-data (repeat with --scope project where applicable).',
            'Remove the old marketplace only after reviewing its other plugins: /plugin marketplace remove evomap-workbuddy',
            `/plugin marketplace add ${AGENT_PLUGIN_REPOSITORY}`,
            '/plugin install evolver-plugin@evomap-workbuddy',
            'Restart WorkBuddy. These are commands in its plugin UI, not a verified codebuddy shell subcommand.',
        ],
    },
    {
        id: 'mcp-generic', label: 'Generic MCP client', kind: 'manual', scopes: ['user'], entries: [], legacyNames: [],
        instructions: [
            `git clone --depth 1 --branch release ${AGENT_PLUGIN_GIT_URL}`,
            'In that checkout, run npm ci; the stdio server requires the MCP SDK.',
            'Register node <absolute-checkout>/bin/mcp.mjs mcp-generic using the selected client\'s own MCP configuration/CLI.',
            'The client must call recall/report/distill itself. Registration and agent-reported checks are not automatic hook integration.',
        ],
    },
];
export function pluginHostNamed(name) {
    const aliases = {
        claude: 'claude-code', codebuddy: 'workbuddy', 'deepseek-harness': 'dsh', mcp: 'mcp-generic', 'kimi-code': 'kimi', step: 'stepcode', mcode: 'minimax',
    };
    return PLUGIN_HOSTS.find(host => host.id === (aliases[name] ?? name));
}
function marketplaceInstallSteps({ host, scope, trust }, step) {
    const management = host.management;
    const selector = host.id === 'grok' ? AGENT_PLUGIN_NAME : `${AGENT_PLUGIN_NAME}@${host.marketplace}`;
    const install = host.id === 'codex'
        ? [management, 'add', selector, '--json']
        : [management, 'install', selector, ...(host.id === 'claude-code' ? ['--scope', scope, '--json'] : []), ...(host.requiresTrust && trust ? ['--trust'] : [])];
    return [step('marketplace', [management, 'marketplace', 'add', AGENT_PLUGIN_REPOSITORY]), step('install', install)];
}
function scriptInstallSteps(host, bundle, step) {
    const installer = { name: 'install', command: 'node', args: [join(dirname(bundle), host.installer), 'install'] };
    return host.id === 'minimax' ? [installer, step('enable', ['plugin', 'enable', `${AGENT_PLUGIN_NAME}@local`, '--json'])] : [installer];
}
export function pluginInstallSteps(options, bundle = '<release-checkout>/dist') {
    const { host, scope, profile } = options;
    const [command = '', ...prefix] = options.launcher;
    const step = (name, args) => ({ name, command, args: [...prefix, ...args] });
    if (host.kind === 'marketplace')
        return marketplaceInstallSteps(options, step);
    if (host.kind === 'script')
        return scriptInstallSteps(host, bundle, step);
    if (host.id === 'zcode') {
        return [
            step('marketplace', ['plugins', 'marketplace', 'add', join(bundle, 'zcode'), '--json']),
            step('install', ['plugins', 'install', `${AGENT_PLUGIN_NAME}@${host.marketplace}`, '--scope', scope, '--json']),
        ];
    }
    if (host.id === 'antigravity')
        return [step('install', ['plugin', 'install', `${bundle}/antigravity`])];
    if (host.id === 'opencode')
        return [step('install', ['plugin', `${bundle}/opencode`, ...(scope === 'user' ? ['-g'] : [])])];
    if (host.id === 'stepcode')
        return [step('install', ['install', join(bundle, 'stepcode')])];
    if (host.id === 'dsh')
        return [step('install', ['plugin', '--profile', profile, 'add', '-w', DSH_PLUGIN_SOURCE])];
    return [];
}
export function pluginRollbackInstructions(options, bundle = '<release-checkout>/dist') {
    const { host, scope, profile } = options;
    const cli = options.launcher.map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
    if (host.id === 'claude-code')
        return [`claude plugin uninstall ${AGENT_PLUGIN_NAME}@${host.marketplace} --scope ${scope} --keep-data`];
    if (host.id === 'codex')
        return [`codex plugin remove ${AGENT_PLUGIN_NAME}@${host.marketplace}`];
    if (host.id === 'grok')
        return ['grok plugin uninstall evolver-plugin --keep-data'];
    if (host.id === 'qoder')
        return ['qodercli plugins uninstall evolver-plugin@evomap --keep-data'];
    if (host.id === 'antigravity')
        return ['agy plugin uninstall evolver-plugin'];
    if (host.id === 'dsh')
        return [`dsh plugin --profile ${profile} remove @evomap/dsh-evolver`];
    if (host.id === 'opencode')
        return [`Remove only this plugin's ${bundle}/opencode/server.mjs and tui.mjs entries from opencode.json and tui.json; preserve neighboring configuration.`];
    if (host.id === 'zcode')
        return [`${cli} plugins uninstall ${AGENT_PLUGIN_NAME}@${host.marketplace} --scope ${scope}`];
    if (host.id === 'kimi')
        return [`node ${join(dirname(bundle), host.installer)} remove`];
    if (host.id === 'stepcode')
        return [`step remove ${join(bundle, 'stepcode')}`];
    if (host.id === 'minimax')
        return [`mcode plugin remove ${AGENT_PLUGIN_NAME}@local --json`];
    return [];
}
const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9@._/][A-Za-z0-9@._/-]*$/;
/**
 * The host's own removal command for an old plugin, keeping its data where the host has a flag for that.
 * Inventory values are host data, so a value that is not a plain argument never reaches a suggested command.
 */
export function standalonePluginRemoval(options, plugin) {
    const { host, profile } = options;
    const scope = plugin.scope ?? options.scope;
    if ([plugin.id, plugin.name, scope].some(value => !SHELL_SAFE_ARGUMENT.test(value))) {
        return `Remove the standalone Evolver plugin through ${host.label}'s own plugin manager, keeping its data; its inventory name is not a plain command argument, so no command is suggested.`;
    }
    if (host.id === 'claude-code')
        return `claude plugin uninstall ${plugin.id} --scope ${scope} --keep-data`;
    if (host.id === 'codex')
        return `codex plugin remove ${plugin.id}`;
    if (host.id === 'grok')
        return `grok plugin uninstall ${plugin.name} --keep-data`;
    if (host.id === 'qoder')
        return `qodercli plugins uninstall ${plugin.id} --scope ${scope} --keep-data`;
    if (host.id === 'antigravity')
        return `agy plugin uninstall ${plugin.name}`;
    if (host.id === 'dsh')
        return `dsh plugin --profile ${profile} remove ${plugin.name}`;
    return `Remove only the ${plugin.name} entries from the OpenCode opencode.json and tui.json; keep the rest of the configuration.`;
}