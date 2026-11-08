import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planInjection } from './injection.js';
import { withInstallerTransaction, InstallerTransactionError } from './installerTransaction.js';
import { sharedFileTransactionActive, withSharedFileCommitObserver } from './sharedFileCommit.js';
import { assertInstallerSyncCallback, assertInstallerSyncScopeActive, runInstallerSyncCallback } from './installerSync.js';
const preservedBridgeVerification = new WeakMap();
/** Only an adapter's successful owned-target check can attest this allowed transform; warnings are not proof. */
export function attestPreservedBridgeVerification(result, ownedVerified, bridgePreserved) {
    preservedBridgeVerification.delete(result);
    if (ownedVerified && bridgePreserved && result.verified === false)
        preservedBridgeVerification.set(result, JSON.stringify(result));
    return result;
}
let implicitPreflight = false;
export function implicitInstallerPreflightActive() { return implicitPreflight; }
function implicitPreview(run) {
    assertInstallerSyncCallback(run);
    const previous = implicitPreflight;
    implicitPreflight = true;
    try {
        return runInstallerSyncCallback(run);
    }
    finally {
        implicitPreflight = previous;
    }
}
export function installerTransactionRoot(runtime, options) {
    const home = options.homeDir ?? homedir();
    let project = resolve(options.configRoot);
    try {
        project = realpathSync(project);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const scope = runtime === 'antigravity' || options.scope === 'user' ? 'user'
        : `project-${createHash('sha256').update(project).digest('hex')}`;
    // Recovery material can contain shared-config secrets. Keep it out of version-controlled/shared projects.
    return join(home, '.evolver', 'setup-transactions', scope);
}
export function installerArtifactTargets(preview) {
    const configs = [...new Set([...preview.files, ...(preview.backups ?? []).map(path => path.replace(/\.evolver-backup\.json$/, ''))])];
    return configs.map(path => ({
        id: createHash('sha256').update(path).digest('hex').slice(0, 32),
        paths: [path, ...(preview.backups ?? []).filter(backup => backup === `${path}.evolver-backup.json`)],
    }));
}
/** Reuse adapter preflight, merge and ownership checks; only the commit/compensation protocol is shared. */
export function runManagedInstallerTransaction(runtime, options, action, preview, apply, injectionPlan) {
    assertInstallerSyncScopeActive();
    if (runtime === 'cursor' && options.scope === 'user')
        throw new InstallerTransactionError('TRANSACTION_INVALID', 'Cursor rules support project scope only; no user configuration was written');
    assertInstallerSyncCallback(preview);
    assertInstallerSyncCallback(apply);
    if (options.dryRun || sharedFileTransactionActive())
        return runInstallerSyncCallback(() => apply(options.targetPath));
    const planned = implicitPreview(() => preview());
    if (!planned.ok)
        return planned;
    const targets = installerArtifactTargets(planned);
    if (!targets.length) {
        // Apply non-file effects (e.g. user-directory privacy) but refuse surprise file mutations after a no-op plan.
        const result = withSharedFileCommitObserver(() => {
            throw new InstallerTransactionError('TRANSACTION_CONFLICT', 'Installer no-op changed; create a fresh plan');
        }, () => apply(options.targetPath));
        const checked = implicitPreview(() => preview(true));
        const warnings = [...new Set([...(result.warnings ?? []), ...(checked.warnings ?? [])])];
        return { ...result, verified: result.ok && result.verified !== false && checked.ok
                && installerArtifactTargets(checked).length === 0 && checked.verified !== false,
            ...(warnings.length ? { warnings } : {}) };
    }
    const id = createHash('sha256').update(randomUUID()).digest('hex');
    return withInstallerTransaction({
        root: installerTransactionRoot(runtime, options), id, binding: createHash('sha256').update(JSON.stringify([runtime, action, options])).digest('hex'),
        targets, metadata: { runtime, scope: runtime === 'antigravity' ? 'user' : options.scope ?? 'project', action, source: 'installer',
            options: { ...options, configRoot: resolve(options.configRoot), homeDir: resolve(options.homeDir ?? homedir()),
                ...(options.opencodeConfig ? { opencodeConfig: resolve(options.opencodeConfig) } : {}),
                ...(options.opencodeConfigDir ? { opencodeConfigDir: resolve(options.opencodeConfigDir) } : {}) },
            ...(action === 'install' ? { plan: injectionPlan ?? planInjection(runtime, options.server) } : {}) },
    }, transaction => completeManagedInstallerTransaction(transaction, runtime, action, planned.mode, preview, apply));
}
export function completeManagedInstallerTransaction(transaction, runtime, action, mode, preview, apply) {
    assertInstallerSyncCallback(preview);
    assertInstallerSyncCallback(apply);
    const results = [];
    for (const target of transaction.targets) {
        if (transaction.hasCompleted(target.id)) {
            transaction.assertCurrent();
            continue;
        }
        let applied;
        results.push(transaction.runTarget(target.id, () => {
            const result = runInstallerSyncCallback(() => apply(target.paths[0]));
            if (!result.ok)
                throw new Error(result.error ?? 'Installer failed');
            applied = result;
            return result;
        }, () => {
            if (applied?.verified)
                return true;
            const pending = implicitPreview(() => preview(true));
            return pending.ok && !installerArtifactTargets(pending).some(candidate => candidate.paths[0] === target.paths[0]);
        }));
    }
    let after;
    transaction.commit(() => {
        const verify = () => {
            after = implicitPreview(() => preview(true));
            return after.ok && installerArtifactTargets(after).length === 0
                && (after.verified !== false || action === 'install' && (runtime === 'claude-code' || runtime === 'codex')
                    && preservedBridgeVerification.get(after) === JSON.stringify(after));
        };
        return action === 'uninstall' ? transaction.verifyUninstall(verify) : verify();
    });
    const warnings = [...new Set([...results.flatMap(result => result.warnings ?? []), ...(after?.warnings ?? [])])];
    return {
        ok: true, runtime, mode, files: results.flatMap(result => result.files),
        backups: [...new Set([...results.flatMap(result => result.backups ?? []), ...transaction.retainedPaths])], verified: after?.verified !== false,
        ...(results.length > 0 && results.every(result => result.alreadyInstalled) ? { alreadyInstalled: true } : {}),
        ...(warnings.length ? { warnings } : {}),
        transaction: transaction.status,
    };
}