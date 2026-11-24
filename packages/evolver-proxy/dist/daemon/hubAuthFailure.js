import { randomUUID } from 'node:crypto';
import { legacyAuthFailureCheck } from '@evomap/evolver-adapter-public';
export const HUB_AUTH_STATUS_STATE_KEY = 'hub:auth_status';
export const HUB_AUTH_FAILED = 'auth_failed';
const HUB_AUTH_FAILURE_REVISION = 'hub:auth_failure_revision';
const RECOVERY_STATE_KEYS = [
    HUB_AUTH_FAILURE_REVISION, HUB_AUTH_STATUS_STATE_KEY, 'node_id', 'node_secret', 'node_secret_version', 'node_secret_source',
];
// Compare under the same writer lock as the eventual recovery write.
export function captureHubAuthRecoveryState(store) {
    const snapshot = store.writeStateTransaction(() => RECOVERY_STATE_KEYS.map((key) => store.getState(key)));
    return () => RECOVERY_STATE_KEYS.every((key, index) => store.getState(key) === snapshot[index]);
}
export function isSupersededHubAuthFailure(error) {
    try {
        return legacyAuthFailureCheck(error)?.() ?? false;
    }
    catch {
        return false;
    }
}
export function recordHubAuthFailure(store, error, message) {
    return writeForCurrentHubAuthFailure(store, error, () => {
        store.setState(HUB_AUTH_FAILURE_REVISION, randomUUID());
        store.setState(HUB_AUTH_STATUS_STATE_KEY, HUB_AUTH_FAILED);
        store.setState('sync:last_error', message);
    });
}
export function writeForCurrentHubAuthFailure(store, error, write) {
    const isSuperseded = legacyAuthFailureCheck(error);
    return store.writeStateTransaction(() => {
        if (isSuperseded?.())
            return false;
        write();
        return true;
    });
}