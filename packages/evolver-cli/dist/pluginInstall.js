import { ensureAgentPluginBundle } from './pluginBundle.js';
import { assertDshProfileStoreMatches } from './pluginDshStore.js';
import { AGENT_PLUGIN_NAME, AGENT_PLUGIN_REPOSITORY, pluginInstallSteps, pluginRollbackInstructions } from './pluginHosts.js';
import { inspectAgentPlugin, verifyPluginManifest } from './pluginInspection.js';
import { withPluginInstallLock } from './pluginLock.js';
import { checkedPluginCommand, checkPluginHostVersion, PluginInstallError } from './pluginRuntime.js';
function trustInstruction(host) {
    return `${host.label} asks you to trust a plugin before it installs. Review ${AGENT_PLUGIN_REPOSITORY}, then rerun with --trust: evolver plugin install --host ${host.id} --trust`;
}
function assertNoConflicts(inspection) {
    if (inspection.conflicts.length > 0)
        throw new PluginInstallError('conflict', inspection.conflicts.join('\n'), inspection.migrations);
}
function migrationInstructions(error) {
    if (!(error instanceof PluginInstallError) || error.instructions.length === 0)
        return [];
    if (error.status !== 'conflict')
        return [...error.instructions];
    return ['To migrate, run this yourself after checking the old plugin and its data (Evolver never runs it):', ...error.instructions];
}
export async function installAgentPlugin(runtime, options) {
    const { host } = options;
    const result = {
        ok: false, status: 'failed', host: host.id, scope: options.scope, verified: false, requiresTrust: Boolean(host.requiresTrust), repository: AGENT_PLUGIN_REPOSITORY,
        commands: pluginInstallSteps(options), completed: [], instructions: [...host.instructions], rollback: pluginRollbackInstructions(options),
        ...(host.id === 'dsh' && { profile: options.profile }),
    };
    if (host.kind === 'manual') {
        const instructions = options.scope === 'project' && host.id === 'workbuddy'
            ? result.instructions.map(line => line === '/plugin install evolver-plugin@evomap-workbuddy' ? `${line} --scope project` : line)
            : result.instructions;
        return { ...result, status: 'manual_required', instructions: [...instructions, `Requested scope: ${options.scope}. No client configuration was changed.`] };
    }
    const trustMissing = host.requiresTrust && !options.trust;
    if (options.dryRun) {
        return { ...result, ok: true, status: 'dry_run', instructions: [...result.instructions, ...(trustMissing ? [trustInstruction(host)] : []), 'Preview only: host version, registration, download and installation have not been executed.'] };
    }
    if (trustMissing) {
        return { ...result, status: 'trust_required', error: `${host.label} installs plugin hooks, MCP servers and skills only after you trust the plugin. No host command was run.`, instructions: [trustInstruction(host)] };
    }
    try {
        await checkPluginHostVersion(runtime, host);
        let inspection = await inspectAgentPlugin(runtime, options);
        assertNoConflicts(inspection);
        if (inspection.installed) {
            const installedPath = verifyPluginManifest(runtime, options, inspection.installed);
            return { ...result, ok: true, status: 'already_installed', verified: true, version: inspection.installed.version, installedPath, commands: [] };
        }
        return await withPluginInstallLock(runtime, options, async () => {
            inspection = await inspectAgentPlugin(runtime, options);
            assertNoConflicts(inspection);
            if (inspection.installed) {
                const installedPath = verifyPluginManifest(runtime, options, inspection.installed);
                return { ...result, ok: true, status: 'already_installed', verified: true, version: inspection.installed.version, installedPath, commands: [] };
            }
            if (host.id === 'dsh')
                await assertDshProfileStoreMatches(runtime, options);
            let bundle;
            if (host.kind === 'bundle') {
                bundle = await ensureAgentPluginBundle(runtime, host);
                result.completed.push('download');
                result.commands = pluginInstallSteps(options, bundle);
                result.rollback = pluginRollbackInstructions(options, bundle);
            }
            let installAnswer;
            for (const step of result.commands) {
                if (step.name === 'marketplace' && inspection.marketplacePresent)
                    continue;
                const executed = await checkedPluginCommand(runtime, step.command, step.args, options.root, 120_000);
                result.completed.push(step.name);
                if (step.name === 'marketplace') {
                    inspection = await inspectAgentPlugin(runtime, options);
                    if (!inspection.marketplacePresent || inspection.conflicts.length > 0) {
                        throw new PluginInstallError('conflict', 'The registered marketplace could not be confirmed as the unified plugin source. No plugin install was attempted.');
                    }
                }
                else {
                    try {
                        installAnswer = JSON.parse(executed.stdout);
                    }
                    catch { /* Some native installers report human-readable progress; the final inventory is authoritative. */ }
                }
            }
            inspection = await inspectAgentPlugin(runtime, options);
            assertNoConflicts(inspection);
            if (!inspection.installed)
                throw new PluginInstallError('failed', `The ${AGENT_PLUGIN_NAME} command completed, but the selected host/scope did not register it. Installation was not confirmed.`);
            const installedPath = verifyPluginManifest(runtime, options, inspection.installed, installAnswer);
            return { ...result, ok: true, status: 'installed', verified: true, version: inspection.installed.version, installedPath };
        });
    }
    catch (error) {
        return {
            ...result,
            status: error instanceof PluginInstallError ? error.status : 'failed',
            error: error instanceof PluginInstallError ? error.message : 'The plugin operation failed; no verified installation was reported.',
            instructions: [...result.instructions, ...migrationInstructions(error), ...(result.completed.length > 0 ? [
                    `Commands already completed: ${result.completed.join(', ')}. Inspect the selected host before retrying.`,
                    'No existing plugin, user data or marketplace was automatically removed. Use the rollback instructions only after checking the current host registration.',
                ] : [])],
        };
    }
}