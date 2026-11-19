import { ensureAgentPluginBundle } from './pluginBundle.js';
import { assertDshProfileStoreMatches } from './pluginDshStore.js';
import { AGENT_PLUGIN_NAME, AGENT_PLUGIN_REPOSITORY, pluginInstallSteps, pluginRollbackInstructions } from './pluginHosts.js';
import { inspectAgentPlugin, verifyPluginManifest } from './pluginInspection.js';
import { hostLauncher } from './pluginLauncher.js';
import { withPluginInstallLock } from './pluginLock.js';
import { checkedPluginCommand, checkPluginHostVersion, PluginInstallError } from './pluginRuntime.js';
import { ZCODE_LOCAL_PLUGIN, ZCODE_MIGRATION_PREVIEW, ZCODE_MIGRATION_PREVIEW_NOTE, zcodeKeptMarketplaceWarning, zcodeMigrationPending, zcodeMigrationReport, zcodeMigrationSteps } from './pluginZcodeMigration.js';
function trustInstruction(host) {
    return `${host.label} asks you to trust a plugin before it installs. Review ${AGENT_PLUGIN_REPOSITORY}, then rerun with --trust: evolver plugin install --host ${host.id} --trust`;
}
async function useReleaseCheckout(runtime, options, result) {
    const bundle = await ensureAgentPluginBundle(runtime, options.host);
    result.completed.push('download');
    result.commands = pluginInstallSteps(options, bundle);
    result.rollback = pluginRollbackInstructions(options, bundle);
    return bundle;
}
function assertNoConflicts(inspection) {
    if (inspection.conflicts.length > 0)
        throw new PluginInstallError('conflict', inspection.conflicts.join('\n'), inspection.migrations);
}
function dryRunResult(options, result, trustMissing) {
    const { host } = options;
    const zcode = host.id === 'zcode';
    const commands = zcode ? [...zcodeMigrationSteps(options, ZCODE_MIGRATION_PREVIEW), ...result.commands] : result.commands;
    const notes = [...(zcode ? [ZCODE_MIGRATION_PREVIEW_NOTE] : []), ...(trustMissing ? [trustInstruction(host)] : [])];
    return { ...result, ok: true, status: 'dry_run', commands, instructions: [...result.instructions, ...notes, 'Preview only: host version, registration, download and installation have not been executed.'] };
}
function alreadyInstalled(runtime, options, result, inspection) {
    if (!inspection.installed || zcodeMigrationPending(inspection.zcodeLocal))
        return undefined;
    const installedPath = verifyPluginManifest(runtime, options, inspection.installed);
    const warnings = zcodeKeptMarketplaceWarning(inspection.zcodeLocal);
    return { ...result, ok: true, status: 'already_installed', verified: true, version: inspection.installed.version, installedPath, commands: [], ...(warnings.length > 0 && { warnings }) };
}
function plannedCommands(options, inspection, install) {
    if (!zcodeMigrationPending(inspection.zcodeLocal))
        return install;
    return [...zcodeMigrationSteps(options, inspection.zcodeLocal), ...(inspection.installed ? [] : install)];
}
async function runPlannedCommands(runtime, options, result, inspection, bundle) {
    let installAnswer;
    for (const step of result.commands) {
        if (step.name === 'marketplace' && inspection.marketplacePresent)
            continue;
        const executed = await checkedPluginCommand(runtime, step.command, step.args, options.root, 120_000);
        result.completed.push(step.name);
        if (step.name === 'marketplace') {
            const registered = await inspectAgentPlugin(runtime, options, bundle);
            if (!registered.marketplacePresent || registered.conflicts.length > 0) {
                throw new PluginInstallError('conflict', 'The registered marketplace could not be confirmed as the unified plugin source. No plugin install was attempted.');
            }
        }
        else if (step.name === 'install') {
            try {
                installAnswer = JSON.parse(executed.stdout);
            }
            catch { /* Some native installers report human-readable progress; the final inventory is authoritative. */ }
        }
    }
    return installAnswer;
}
function failureNotes(completed) {
    if (completed.length === 0)
        return [];
    const removed = completed.includes('uninstall-local') ? `Only the ${ZCODE_LOCAL_PLUGIN} steps in completed removed anything; no other` : 'No existing';
    return [
        `Commands already completed: ${completed.join(', ')}. Inspect the selected host before retrying.`,
        `${removed} plugin, user data or marketplace was automatically removed. Use the rollback instructions only after checking the current host registration.`,
    ];
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
    if (options.dryRun)
        return dryRunResult(options, result, trustMissing);
    if (trustMissing) {
        return { ...result, status: 'trust_required', error: `${host.label} installs plugin hooks, MCP servers and skills only after you trust the plugin. No host command was run.`, instructions: [trustInstruction(host)] };
    }
    try {
        await checkPluginHostVersion(runtime, host, hostLauncher(runtime, host));
        let bundle = host.kind === 'script' ? await useReleaseCheckout(runtime, options, result) : undefined;
        let inspection = await inspectAgentPlugin(runtime, options, bundle);
        assertNoConflicts(inspection);
        const settled = alreadyInstalled(runtime, options, result, inspection);
        if (settled)
            return settled;
        return await withPluginInstallLock(runtime, options, async () => {
            inspection = await inspectAgentPlugin(runtime, options, bundle);
            assertNoConflicts(inspection);
            const settledInLock = alreadyInstalled(runtime, options, result, inspection);
            if (settledInLock)
                return settledInLock;
            if (host.id === 'dsh')
                await assertDshProfileStoreMatches(runtime, options);
            if (host.kind === 'bundle')
                bundle = await useReleaseCheckout(runtime, options, result);
            const local = inspection.zcodeLocal;
            result.commands = plannedCommands(options, inspection, result.commands);
            const installAnswer = await runPlannedCommands(runtime, options, result, inspection, bundle);
            inspection = await inspectAgentPlugin(runtime, options, bundle);
            assertNoConflicts(inspection);
            if (!inspection.installed)
                throw new PluginInstallError('failed', `The ${AGENT_PLUGIN_NAME} command completed, but the selected host/scope did not register it. Installation was not confirmed.`);
            const installedPath = verifyPluginManifest(runtime, options, inspection.installed, installAnswer);
            const warnings = zcodeKeptMarketplaceWarning(local);
            return {
                ...result, ok: true, status: result.completed.includes('install') ? 'installed' : 'already_installed', verified: true, version: inspection.installed.version, installedPath,
                ...zcodeMigrationReport(local, result.completed), ...(warnings.length > 0 && { warnings }),
            };
        });
    }
    catch (error) {
        return {
            ...result,
            status: error instanceof PluginInstallError ? error.status : 'failed',
            error: error instanceof PluginInstallError ? error.message : 'The plugin operation failed; no verified installation was reported.',
            instructions: [...result.instructions, ...migrationInstructions(error), ...failureNotes(result.completed)],
        };
    }
}