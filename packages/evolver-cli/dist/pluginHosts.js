export const AGENT_PLUGIN_REPOSITORY = 'EvoMap/evolver-agent-plugin';
export const AGENT_PLUGIN_GIT_URL = `https://github.com/${AGENT_PLUGIN_REPOSITORY}.git`;
export const AGENT_PLUGIN_NAME = 'evolver-plugin';
export const AGENT_PLUGIN_RELEASE = 'release';
export const PLUGIN_HOSTS = [
    {
        id: 'claude-code', label: 'Claude Code', command: 'claude', minimumVersion: '2.1.286',
        kind: 'marketplace', management: 'plugin', marketplace: 'evolver-agent-plugin',
        scopes: ['user', 'project'], manifest: '.claude-plugin/plugin.json',
        legacyNames: ['evolver', 'evolver-mods', 'evolver-agent-plugin'],
        instructions: ['Restart Claude Code. Installed hooks modules also require the host rollout flag; an installed plugin is not proof that recall is active.'],
    },
    {
        id: 'codex', label: 'Codex', command: 'codex', kind: 'marketplace', management: 'plugin', marketplace: 'evomap',
        scopes: ['user'], manifest: '.codex-plugin/plugin.json', legacyNames: ['evolver'],
        instructions: ['Open /hooks in Codex, review and trust the Evolver hooks, then start a new thread.'],
    },
    {
        id: 'grok', label: 'Grok CLI', command: 'grok', minimumVersion: '1.0.70',
        kind: 'marketplace', management: 'plugin', marketplace: 'evomap', scopes: ['user'], manifest: '.grok-plugin/plugin.json',
        legacyNames: ['evolver', 'evolver-grok-plugin'],
        instructions: ['Restart Grok and review its hook trust settings. Recall reaches the first tool result; a turn without tools receives no strategy.'],
    },
    {
        id: 'qoder', label: 'Qoder CLI', command: 'qodercli', minimumVersion: '1.1.79',
        kind: 'marketplace', management: 'plugins', marketplace: 'evomap', scopes: ['user'], manifest: '.qoder-plugin/plugin.json',
        legacyNames: ['evolver', 'evolver-qoder-plugin'], instructions: ['Start a new Qoder session or run /plugins reload.'],
    },
    {
        id: 'antigravity', label: 'Antigravity', command: 'agy', kind: 'bundle', management: 'plugin',
        scopes: ['user'], manifest: 'plugin.json', legacyNames: ['evolver-antigravity-plugin'],
        instructions: ['Restart Antigravity. Its commands run from the installed plugin with node bin/command.mjs antigravity <command>.'],
    },
    {
        id: 'opencode', label: 'OpenCode', command: 'opencode', minimumVersion: '1.19.4', kind: 'bundle',
        scopes: ['user', 'project'], manifest: 'package.json', legacyNames: ['evolver-opencode-plugin'],
        instructions: ['Restart OpenCode. Both the server entry in opencode.json and the TUI entry in tui.json must be registered.'],
    },
    {
        id: 'dsh', label: 'DeepSeek Harness', command: 'dsh', minimumVersion: '0.1.5', kind: 'profile',
        scopes: ['user'], manifest: 'package.json', legacyNames: ['@evomap/dsh-evolver'],
        instructions: ['Restart dsh. Installation applies only to the selected profile; repeat for other profiles. DSH Desktop requires its own bundled CLI/profile.'],
    },
    {
        id: 'cursor', label: 'Cursor', command: 'cursor-agent', kind: 'manual', scopes: ['user'],
        legacyNames: ['evolver-cursor-plugin'],
        instructions: [
            `In Cursor's plugin marketplace, add ${AGENT_PLUGIN_REPOSITORY} and install evolver-plugin.`,
            'Remove or disable the standalone Evolver plugin first to avoid duplicate recall and reports; keep its data.',
            'Reload the Cursor window and inspect Settings → Hooks. The current Cursor CLI has no verified plugin-install command.',
        ],
    },
    {
        id: 'workbuddy', label: 'WorkBuddy / CodeBuddy', command: 'codebuddy', kind: 'manual', scopes: ['user', 'project'],
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
        id: 'mcp-generic', label: 'Generic MCP client', kind: 'manual', scopes: ['user'], legacyNames: [],
        instructions: [
            `git clone --depth 1 --branch release ${AGENT_PLUGIN_GIT_URL}`,
            'In that checkout, run npm ci; the stdio server requires the MCP SDK.',
            'Register node <absolute-checkout>/bin/mcp.mjs mcp-generic using the selected client\'s own MCP configuration/CLI.',
            'The client must call recall/report/distill itself. Registration and agent-reported checks are not automatic hook integration.',
        ],
    },
];
export function pluginHostNamed(name) {
    const aliases = { claude: 'claude-code', codebuddy: 'workbuddy', 'deepseek-harness': 'dsh', mcp: 'mcp-generic' };
    return PLUGIN_HOSTS.find(host => host.id === (aliases[name] ?? name));
}
export function pluginInstallSteps(options, bundle = '<release-checkout>/dist') {
    const { host, scope, profile } = options;
    const command = host.command ?? '';
    if (host.kind === 'marketplace') {
        const management = host.management;
        const selector = host.id === 'grok' ? AGENT_PLUGIN_NAME : `${AGENT_PLUGIN_NAME}@${host.marketplace}`;
        const add = [management, 'marketplace', 'add', AGENT_PLUGIN_REPOSITORY];
        const install = host.id === 'codex'
            ? [management, 'add', selector, '--json']
            : [management, 'install', selector, ...(host.id === 'claude-code' ? ['--scope', scope, '--json'] : [])];
        return [
            { name: 'marketplace', command, args: add },
            { name: 'install', command, args: install },
        ];
    }
    if (host.id === 'antigravity')
        return [{ name: 'install', command, args: ['plugin', 'install', `${bundle}/antigravity`] }];
    if (host.id === 'opencode')
        return [{ name: 'install', command, args: ['plugin', `${bundle}/opencode`, ...(scope === 'user' ? ['-g'] : [])] }];
    if (host.id === 'dsh')
        return [{
                name: 'install', command, args: ['plugin', '--profile', profile, 'add', '-w', `github:${AGENT_PLUGIN_REPOSITORY}#${AGENT_PLUGIN_RELEASE}&path:dist/dsh`],
            }];
    return [];
}
export function pluginRollbackInstructions(options, bundle) {
    const { host, scope, profile } = options;
    if (host.id === 'claude-code')
        return [`claude plugin uninstall ${AGENT_PLUGIN_NAME}@${host.marketplace} --scope ${scope} --keep-data`];
    if (host.id === 'codex')
        return [`codex plugin remove ${AGENT_PLUGIN_NAME}@${host.marketplace}`];
    if (host.id === 'grok')
        return ['grok plugin uninstall evolver-plugin'];
    if (host.id === 'qoder')
        return ['qodercli plugins uninstall evolver-plugin@evomap'];
    if (host.id === 'antigravity')
        return ['agy plugin uninstall evolver-plugin'];
    if (host.id === 'dsh')
        return [`dsh plugin --profile ${profile} remove @evomap/dsh-evolver`];
    if (host.id === 'opencode')
        return [`Remove only this plugin's ${bundle ?? '<installed-bundle>'}/opencode/server.mjs and tui.mjs entries from opencode.json and tui.json; preserve neighboring configuration.`];
    return [];
}