import { isManagedPackedBundle } from './pluginBundle.js';
import { AGENT_PLUGIN_NAME, ZCODE_LOCAL_MARKETPLACE } from './pluginHosts.js';
import { objectOf } from './pluginRuntime.js';
export const ZCODE_LOCAL_PLUGIN = `${AGENT_PLUGIN_NAME}@${ZCODE_LOCAL_MARKETPLACE}`;
function ownsLocalMarketplace(runtime, host, record) {
    const source = objectOf(record['source']);
    const folder = source?.['source'] === 'directory' ? source['path'] : undefined;
    return typeof folder === 'string' && isManagedPackedBundle(runtime, host, folder);
}
export function zcodeLocalInstall(runtime, host, pluginIds, markets) {
    const installed = pluginIds.includes(ZCODE_LOCAL_PLUGIN);
    const market = markets.find(record => record['name'] === ZCODE_LOCAL_MARKETPLACE);
    if (!installed && !market)
        return undefined;
    const marketplace = market && (ownsLocalMarketplace(runtime, host, market) ? { removeMarketplace: ZCODE_LOCAL_MARKETPLACE } : { keptMarketplace: ZCODE_LOCAL_MARKETPLACE });
    return { ...(installed && { uninstall: ZCODE_LOCAL_PLUGIN }), ...marketplace };
}
export const zcodeMigrationPending = (local) => Boolean(local?.uninstall || local?.removeMarketplace);
export function zcodeMigrationSteps(options, local) {
    const [command = '', ...prefix] = options.launcher;
    const step = (name, args) => ({ name, command, args: [...prefix, ...args] });
    return [
        ...(local.uninstall ? [step('uninstall-local', ['plugins', 'uninstall', local.uninstall, '--scope', options.scope, '--keep-data', '--force', '--json'])] : []),
        ...(local.removeMarketplace ? [step('remove-local-marketplace', ['plugins', 'marketplace', 'remove', local.removeMarketplace, '--json'])] : []),
    ];
}
export const ZCODE_MIGRATION_PREVIEW = { uninstall: ZCODE_LOCAL_PLUGIN, removeMarketplace: ZCODE_LOCAL_MARKETPLACE };
export const ZCODE_MIGRATION_PREVIEW_NOTE = `uninstall-local and remove-local-marketplace run only when ${ZCODE_LOCAL_PLUGIN} is installed or its marketplace points into Evolver's release cache.`;
export function zcodeMigrationReport(local, completed) {
    const migrated = {
        ...(completed.includes('uninstall-local') && { uninstalled: local?.uninstall }),
        ...(completed.includes('remove-local-marketplace') && { removedMarketplace: local?.removeMarketplace }),
    };
    return Object.keys(migrated).length > 0 ? { migrated } : {};
}
export function zcodeKeptMarketplaceWarning(local) {
    if (!local?.keptMarketplace)
        return [];
    return [`Marketplace ${local.keptMarketplace} points at a folder Evolver does not manage, so it stays registered. Do not install ${AGENT_PLUGIN_NAME} from it as well: both copies would run the same hooks.`];
}