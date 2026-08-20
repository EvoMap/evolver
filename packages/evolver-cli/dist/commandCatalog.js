export const COMMAND_GROUP_ORDER = [
    'Daemon',
    'Evolution',
    'Memory',
    'Assets',
    'Hub',
    'Operations',
    'Tools',
    'Advanced',
];
export const SYNC_COMMAND_NAMES = [
    'status', 'cycles', 'trigger', 'value', 'narrative', 'retention', 'gene-value', 'replay', 'rebuild-views',
    'reset-local-secret',
];
const SYNC_COMMAND_NAME_SET = new Set(SYNC_COMMAND_NAMES);
export function isSyncCommandName(value) {
    return SYNC_COMMAND_NAME_SET.has(value);
}
export const COMMAND_GROUPS = {
    proxy: 'Daemon',
    lifecycle: 'Daemon',
    'proxy-token': 'Daemon',
    doctor: 'Daemon',
    'setup-hooks': 'Daemon',
    run: 'Evolution',
    cycle: 'Evolution',
    autoexec: 'Evolution',
    solidify: 'Evolution',
    distill: 'Evolution',
    review: 'Evolution',
    thesis: 'Evolution',
    ingest: 'Memory',
    inject: 'Memory',
    recall: 'Memory',
    reuse: 'Memory',
    'reuse-report': 'Memory',
    'recall-verify-report': 'Memory',
    narrative: 'Memory',
    'gene-value': 'Memory',
    'memory-graph': 'Memory',
    'asset-log': 'Assets',
    'asset-trust': 'Assets',
    'asset-health': 'Assets',
    'asset-repair': 'Assets',
    material: 'Assets',
    recipe: 'Assets',
    skill: 'Assets',
    login: 'Hub',
    logout: 'Hub',
    phub: 'Hub',
    sync: 'Hub',
    publish: 'Hub',
    fetch: 'Hub',
    buy: 'Hub',
    orders: 'Hub',
    verify: 'Hub',
    atp: 'Hub',
    status: 'Operations',
    daily: 'Operations',
    workflow: 'Operations',
    cycles: 'Operations',
    trigger: 'Operations',
    value: 'Operations',
    retention: 'Operations',
    replay: 'Operations',
    'rebuild-views': 'Operations',
    'issue-report': 'Operations',
    dashboard: 'Tools',
    webui: 'Tools',
    'trajectory-export': 'Tools',
    migrate: 'Tools',
    exec: 'Tools',
    'anti-gene-benchmark': 'Advanced',
    'anti-gene-rollout': 'Advanced',
    'model-compatibility-replay': 'Advanced',
    'reset-local-secret': 'Advanced',
    'skill-distill': 'Advanced',
    'skill-md-update': 'Advanced',
};
const COMMAND_HELP_LABELS = {
    workflow: 'workflow status',
    'skill-distill': 'skill-distill (legacy; prefer `evolver recipe build`)',
};
const COMMAND_HELP_LABEL_COLUMN = 15;
export const COMMAND_HELP_MAX_WIDTH = 100;
export function commandsInGroup(group) {
    return Object.keys(COMMAND_GROUPS).filter((command) => COMMAND_GROUPS[command] === group);
}
export function commandHelpLabel(command) {
    return COMMAND_HELP_LABELS[command] ?? command;
}
function wrapEntries(entries, firstPrefix, continuationPrefix) {
    const lines = [];
    let current = firstPrefix;
    let hasEntry = false;
    entries.forEach((entry, index) => {
        const separator = index === entries.length - 1 ? '' : ',';
        const candidate = hasEntry ? `${current} ${entry}${separator}` : `${current}${entry}${separator}`;
        if (hasEntry && candidate.length > COMMAND_HELP_MAX_WIDTH) {
            lines.push(current);
            current = `${continuationPrefix}${entry}${separator}`;
            return;
        }
        current = candidate;
        hasEntry = true;
    });
    if (hasEntry)
        lines.push(current);
    return lines;
}
export function renderCommandGroups() {
    const continuationPrefix = ' '.repeat(COMMAND_HELP_LABEL_COLUMN);
    return COMMAND_GROUP_ORDER.flatMap((group) => {
        const commands = commandsInGroup(group);
        if (commands.length === 0)
            return [];
        const firstPrefix = `  ${group}:`.padEnd(COMMAND_HELP_LABEL_COLUMN, ' ');
        return wrapEntries(commands.map(commandHelpLabel), firstPrefix, continuationPrefix);
    });
}