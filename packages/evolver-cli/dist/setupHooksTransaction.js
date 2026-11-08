import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { installerTransactionRoot, inspectInstallerTransactions, withInstallerTransaction, InstallerTransactionError, installerTransactionFromError, completeManagedInstallerTransaction, installInjection, uninstallInjection, } from '@evomap/evolver-mcp';
import { SETUP_LIFECYCLE_SCHEMA, SETUP_LIFECYCLE_PLAN_TTL_MS, SetupLifecycleError, } from './setupHooksLifecycle.js';
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function verificationContext(context) {
    return { ...context, installOptions: { ...context.installOptions, force: false } };
}
function verifyTarget(context, action, path, driver) {
    const checking = verificationContext(context);
    const result = driver.preview({ ...checking, installOptions: { ...checking.installOptions, ...(path ? { targetPath: path } : {}) } }, action);
    return result.ok && result.verified !== false && result.files.length === 0 && (result.backups?.length ?? 0) === 0;
}
export function executeSetupTransaction(context, confirmed, options, driver) {
    if (confirmed.runtime !== context.runtime || confirmed.scope !== context.scope) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan does not match runtime scope');
    }
    const { plan_id: id, ...base } = confirmed;
    if (hash(JSON.stringify(base)) !== id)
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan identity is invalid');
    if (driver.intent(context, confirmed.action) !== confirmed.intent_digest) {
        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle write intent changed; create a fresh plan');
    }
    const createdAt = new Date(confirmed.created_at);
    const expiresAt = new Date(confirmed.expires_at);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(expiresAt.getTime())
        || expiresAt.getTime() - createdAt.getTime() !== SETUP_LIFECYCLE_PLAN_TTL_MS) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan has invalid timestamps or lifetime');
    }
    const root = installerTransactionRoot(context.runtime, context.installOptions);
    const existing = inspectInstallerTransactions(root, id)[0];
    const now = (context.now ?? (() => new Date()))().getTime();
    if (!existing && createdAt.getTime() > now)
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan cannot start in the future');
    if (!existing && now > expiresAt.getTime()) {
        throw new SetupLifecycleError('PLAN_EXPIRED', 'confirmed lifecycle plan expired; create a fresh plan');
    }
    const selected = options.targetId;
    if (selected !== undefined && !confirmed.targets.some(target => target.target_id === selected)) {
        throw new SetupLifecycleError('PLAN_INVALID', 'selected lifecycle target is not in the confirmed plan');
    }
    const claimed = options.completedTargetIds ?? [];
    if (claimed.length && selected === undefined || new Set(claimed).size !== claimed.length
        || claimed.includes(selected ?? '') || claimed.some(id => !confirmed.targets.some(target => target.target_id === id))) {
        throw new SetupLifecycleError('PLAN_INVALID', 'completed lifecycle target set is invalid');
    }
    if (claimed.some(id => !existing?.completed_target_ids.includes(id))) {
        throw new SetupLifecycleError('PLAN_INVALID', 'completed target claims are not backed by the durable transaction');
    }
    const paths = new Map();
    let targets;
    if (!existing || confirmed.targets.every(target => target.disposition === 'already_satisfied')) {
        const current = driver.plan(context, confirmed.action, createdAt, expiresAt, paths);
        if (JSON.stringify(current) !== JSON.stringify(confirmed)) {
            throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target identity or ownership evidence changed; create a fresh plan');
        }
        const preview = driver.preview(context, confirmed.action);
        targets = confirmed.targets.map(target => {
            const path = paths.get(target.target_id);
            return { id: target.target_id, paths: path === undefined ? [] : [path, ...(preview.backups ?? []).filter(backup => resolve(backup) === `${path}.evolver-backup.json`)] };
        });
    }
    let session;
    const attempted = new Map();
    let transaction;
    let failure;
    let executionFailed = false;
    let activeTarget;
    try {
        withInstallerTransaction({ root, id, binding: confirmed.intent_digest, targets,
            metadata: { source: 'lifecycle', runtime: context.runtime, scope: context.scope, action: confirmed.action, plan: confirmed },
            validatePrepared: artifacts => {
                const current = driver.plan(context, confirmed.action, createdAt, expiresAt);
                if (JSON.stringify(current) !== JSON.stringify(confirmed)) {
                    throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target identity or ownership evidence changed; create a fresh plan');
                }
                for (const target of confirmed.targets.filter(target => target.disposition !== 'already_satisfied')) {
                    const captured = artifacts.filter(artifact => artifact.target === target.target_id);
                    const expected = hash(JSON.stringify(captured.map(artifact => hash(JSON.stringify([artifact.path, artifact.identity])))));
                    if (!captured.length || expected !== target.expected_identity) {
                        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target identity or ownership evidence changed; create a fresh plan');
                    }
                }
                const preparingAt = (context.now ?? (() => new Date()))().getTime();
                if (createdAt.getTime() > preparingAt)
                    throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan cannot start in the future');
                if (preparingAt > expiresAt.getTime())
                    throw new SetupLifecycleError('PLAN_EXPIRED', 'confirmed lifecycle plan expired; create a fresh plan');
                return true;
            },
        }, current => {
            session = current;
            const metadata = current.metadata;
            if (JSON.stringify(metadata.plan) !== JSON.stringify(confirmed))
                throw new SetupLifecycleError('PLAN_STALE', 'durable lifecycle plan metadata changed');
            if (claimed.some(id => !current.hasCompleted(id)))
                throw new SetupLifecycleError('PLAN_INVALID', 'completed target claims are not backed by the durable transaction');
            if (current.status.state === 'rollback_pending' || current.status.state === 'rolled_back' || current.status.state === 'released') {
                throw new InstallerTransactionError('TRANSACTION_PENDING', 'This transaction cannot resume installation; finish rollback or create a fresh plan', current.status);
            }
            if (current.status.state !== 'committed')
                current.armRollback();
            current.assertCurrent();
            const checkTarget = (path) => {
                const verify = () => verifyTarget(context, confirmed.action, path, driver);
                return confirmed.action === 'uninstall' ? current.verifyUninstall(verify) : verify();
            };
            const selectedTargets = selected === undefined ? confirmed.targets : confirmed.targets.filter(target => target.target_id === selected);
            for (const target of selectedTargets) {
                activeTarget = target.target_id;
                const path = current.targets.find(candidate => candidate.id === target.target_id)?.paths[0];
                const already = current.hasCompleted(target.target_id);
                const noOp = target.disposition === 'already_satisfied';
                if (already) {
                    // Identity receipts alone are not proof that the runtime still consumes this target (e.g. OpenCode precedence).
                    if (!checkTarget(path))
                        throw new SetupLifecycleError('PLAN_STALE', 'a completed lifecycle target is no longer verified');
                }
                else {
                    current.runTarget(target.target_id, () => {
                        if (noOp)
                            return;
                        const result = driver.apply(context, confirmed.action, path);
                        if (!result.ok)
                            throw new Error(result.error ?? 'Lifecycle installer failed');
                    }, () => checkTarget(path));
                }
                attempted.set(target.target_id, {
                    target_id: target.target_id,
                    outcome: already || noOp ? confirmed.action === 'uninstall' ? 'already_absent' : 'already_satisfied'
                        : confirmed.action === 'install' ? 'installed' : 'removed',
                    committed: !already && !noOp && current.wasChanged(target.target_id), verified: true,
                });
            }
            activeTarget = undefined;
            if (current.targets.every(target => current.hasCompleted(target.id))) {
                const verify = () => confirmed.action === 'install' ? driver.verify(verificationContext(context))
                    : confirmed.targets.every(target => checkTarget(current.targets.find(candidate => candidate.id === target.target_id)?.paths[0])) && checkTarget(undefined);
                if (current.status.state !== 'committed')
                    current.commit(verify);
                else if (!verify())
                    throw new SetupLifecycleError('PLAN_STALE', 'the committed lifecycle plan is no longer verified by the runtime');
            }
            transaction = current.status;
        });
    }
    catch (error) {
        executionFailed = true;
        failure = error;
        transaction = installerTransactionFromError(error) ?? session?.status;
        // Pre-write invalid plans retain the established CLI error envelope. Mutation failures return all rollback facts.
        if (!session || !session.rollbackOnError && error instanceof SetupLifecycleError)
            throw error;
    }
    const resultTargets = (selected === undefined ? confirmed.targets : confirmed.targets.filter(target => target.target_id === selected)).map(target => {
        const previous = attempted.get(target.target_id);
        if (!executionFailed)
            return previous;
        const blocked = transaction?.blocked_target_ids.includes(target.target_id) ?? true;
        return {
            target_id: target.target_id, outcome: 'failed',
            committed: blocked && (session?.wasChanged(target.target_id) ?? false), verified: false,
            rolled_back: transaction?.state === 'rolled_back' || transaction?.state === 'rollback_pending' && !blocked,
            ...(blocked ? { recovery: 'ROLLBACK_TRANSACTION' } : {}),
        };
    });
    const verified = !executionFailed && resultTargets.every(target => target.verified);
    return {
        schema: SETUP_LIFECYCLE_SCHEMA, action: confirmed.action, runtime: context.runtime, scope: context.scope,
        plan_id: id, generation: confirmed.generation, target_set_digest: confirmed.target_set_digest,
        complete: verified && (selected !== undefined || transaction?.state === 'committed'), verified, targets: resultTargets,
        ...(transaction ? { transaction } : {}),
        ...(executionFailed ? { failure: {
                code: failure instanceof InstallerTransactionError || failure instanceof SetupLifecycleError ? failure.code : 'WRITE_FAILED',
                ...(activeTarget ? { target_id: activeTarget } : {}),
                message: failure instanceof InstallerTransactionError || failure instanceof SetupLifecycleError ? failure.message
                    : `${context.runtime}/${context.scope} could not complete the confirmed target; inspect the configuration and ownership evidence before creating a fresh plan.`,
                recovery: transaction?.state === 'rollback_pending' ? 'ROLLBACK_TRANSACTION' : 'REFRESH_PLAN',
            } } : {}),
    };
}
export function inspectSetupTransactions(context, id) {
    return inspectInstallerTransactions(installerTransactionRoot(context.runtime, context.installOptions), id);
}
export function recoverSetupTransaction(context, id, recovery, driver, confirmedState) {
    const root = installerTransactionRoot(context.runtime, context.installOptions);
    if (recovery === 'rollback' || recovery === 'accept-current') {
        return withInstallerTransaction({ root, id }, transaction => {
            const metadata = transaction.metadata;
            if (metadata.runtime !== context.runtime || metadata.scope !== context.scope) {
                throw new InstallerTransactionError('TRANSACTION_INVALID', 'Transaction does not belong to this runtime scope');
            }
            return recovery === 'accept-current' ? transaction.acceptCurrent(confirmedState ?? '') : transaction.rollback();
        });
    }
    let plan;
    let installerResult;
    withInstallerTransaction({ root, id }, transaction => {
        const metadata = transaction.metadata;
        if (metadata.runtime !== context.runtime || metadata.scope !== context.scope) {
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Transaction does not belong to this runtime scope');
        }
        if (metadata.source === 'installer' && metadata.options && metadata.action) {
            const action = metadata.action;
            const options = metadata.options;
            const injectionPlan = metadata.plan;
            const preview = (verification) => action === 'install'
                ? installInjection(injectionPlan, { ...options, dryRun: true, ...(verification ? { force: false } : {}) })
                : uninstallInjection(context.runtime, { ...options, dryRun: true });
            completeManagedInstallerTransaction(transaction, context.runtime, action, action === 'install' ? injectionPlan.mode : 'uninstall', preview, targetPath => action === 'install' ? installInjection(injectionPlan, { ...options, targetPath })
                : uninstallInjection(context.runtime, { ...options, targetPath }));
            installerResult = transaction.status;
            return;
        }
        plan = metadata.plan;
        if (!plan)
            throw new InstallerTransactionError('TRANSACTION_INVALID', 'Resume requires durable installer intent');
    });
    return installerResult ?? executeSetupTransaction(context, plan, {}, driver);
}