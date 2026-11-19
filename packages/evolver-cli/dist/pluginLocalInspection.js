import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AGENT_PLUGIN_NAME } from './pluginHosts.js';
import { checkedPluginCommand, objectOf, pluginHome, pluginJson, PluginInstallError, readPluginJson } from './pluginRuntime.js';
const DISABLED = 'The plugin is installed but disabled. Enable it explicitly in the host rather than installing another copy.';
function installedRecord(version, path, enabled, raw) {
    if (typeof version !== 'string' || typeof path !== 'string' || !isAbsolute(path))
        return undefined;
    return { id: AGENT_PLUGIN_NAME, name: AGENT_PLUGIN_NAME, version, enabled, path, raw };
}
/** Kimi and MiniMax are installed by the release checkout's own installer, whose `status` is the registration record. */
export async function inspectScriptPlugin(runtime, options, bundle) {
    const { host } = options;
    const { stdout } = await checkedPluginCommand(runtime, 'node', [join(dirname(bundle), host.installer), 'status'], options.root);
    const status = objectOf(pluginJson(stdout, `${host.label} installer status`));
    if (typeof status?.['installed'] !== 'boolean')
        throw new PluginInstallError('unsupported_capability', `${host.label} installer status has an unsupported shape; no installed state can be inferred.`);
    const installed = status['installed'] ? installedRecord(status['version'], status['path'], status['enabled'] !== false, status) : undefined;
    if (status['installed'] && !installed)
        throw new PluginInstallError('unsupported_capability', `${host.label} installer status reports an installation without its version and path.`);
    return { installed, marketplacePresent: false, conflicts: installed && !installed.enabled ? [DISABLED] : [], migrations: [] };
}
function stepAgentDir(runtime) {
    const configured = runtime.env['STEP_CODING_AGENT_DIR'];
    if (configured === undefined)
        return join(pluginHome(runtime), '.stepcode', 'agent');
    if (!isAbsolute(configured))
        throw new PluginInstallError('invalid_arguments', 'STEP_CODING_AGENT_DIR must be an absolute directory, as Step Code requires.');
    return configured;
}
/** Step Code lists installed extension packages in its agent settings; local sources are folder paths. */
export function inspectStepCodePlugin(runtime, options) {
    const agentDir = stepAgentDir(runtime);
    const packages = readPluginJson(join(agentDir, 'settings.json'))?.['packages'] ?? [];
    if (!Array.isArray(packages))
        throw new PluginInstallError('unsupported_capability', 'Step Code settings list packages in an unsupported shape; no installed state can be inferred.');
    const ours = packages.flatMap(entry => {
        const source = typeof entry === 'string' ? entry : objectOf(entry)?.['source'];
        if (typeof source !== 'string' || /^(?:npm|git|https?):/.test(source))
            return [];
        const path = resolve(agentDir, source);
        const manifest = readPluginJson(join(path, 'package.json'));
        return manifest && manifest['name'] === options.host.packageName ? [installedRecord(manifest['version'], path, true, manifest)] : [];
    }).filter(plugin => plugin !== undefined);
    const conflicts = ours.length > 1 ? ['Multiple Step Code Evolver packages are installed; remove all but one with step remove <path>.'] : [];
    return { installed: ours[0], marketplacePresent: false, conflicts, migrations: [] };
}