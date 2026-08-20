import { prepareRecoveryChildStartGate, } from './recoveryChildStartGate.js';
export async function resolveRecoveryControllerAuthority(env, dependencies = {}) {
    const bootstrap = dependencies.acquireOwnerLease
        && dependencies.assertActivationDelegation
        && dependencies.prepareOwnerCapability
        ? undefined
        : await import('./bootstrap.js');
    const acquireOwnerLease = dependencies.acquireOwnerLease
        ?? bootstrap.acquireLifecycleBootstrapOwnerLease;
    const assertActivationDelegation = dependencies.assertActivationDelegation
        ?? bootstrap.assertActiveSupervisedLifecycleBootstrapDelegation;
    const prepareOwnerCapability = dependencies.prepareOwnerCapability
        ?? bootstrap.prepareRecoveryControllerLifecycleOwnerCapability;
    const prepareStartGate = dependencies.prepareStartGate ?? prepareRecoveryChildStartGate;
    try {
        const lease = acquireOwnerLease(env, { maxTries: 2, waitMs: 0 });
        return {
            kind: 'owned',
            assertAuthorized: () => { lease.assertOwned(); },
            prepareTarget: (childEnv) => {
                lease.assertOwned();
                const ownerCapability = prepareOwnerCapability(childEnv, lease.owner);
                const startGate = prepareStartGate(ownerCapability.env, 'proxy-target', lease.owner);
                return { ...ownerCapability, ...startGate };
            },
            prepareWorker: (childEnv) => {
                lease.assertOwned();
                return prepareStartGate(childEnv, 'windows-updater', lease.owner);
            },
            armProcess: (pid) => { lease.armProcess(pid); },
            disarmProcess: () => { lease.disarmProcess(); },
            retainProcess: () => { lease.retainProcess(); },
            release: () => { lease.release(); },
        };
    }
    catch (leaseError) {
        try {
            assertActivationDelegation(env);
        }
        catch (delegationError) {
            throw new AggregateError([leaseError, delegationError], 'self_update_recovery_controller_authority_unavailable');
        }
        return {
            kind: 'delegated',
            assertAuthorized: () => { assertActivationDelegation(env); },
            prepareTarget: (childEnv) => {
                assertActivationDelegation(env);
                return prepareStartGate(childEnv, 'proxy-target');
            },
            prepareWorker: () => {
                throw new Error('self_update_recovery_controller_owner_lease_required');
            },
            armProcess: () => {
                throw new Error('self_update_recovery_controller_delegated_guardian_unavailable');
            },
            disarmProcess: () => { },
            retainProcess: () => { },
            release: () => { },
        };
    }
}