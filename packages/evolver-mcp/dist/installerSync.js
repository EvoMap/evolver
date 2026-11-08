import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
const callbackScopes = new AsyncLocalStorage();
export function assertInstallerSyncScopeActive() {
    if (callbackScopes.getStore()?.active === false)
        throw new TypeError('Installer transaction callback scope has expired');
}
/** Scope exit revokes library writes inherited by queued async work; it is not a sandbox for caller code. */
export function runInstallerSyncCallback(callback) {
    assertInstallerSyncScopeActive();
    assertInstallerSyncCallback(callback);
    const scope = { active: true };
    return callbackScopes.run(scope, () => {
        try {
            return installerSyncResult(callback());
        }
        finally {
            scope.active = false;
        }
    });
}
export function assertInstallerSyncCallback(callback) {
    if (typeof callback !== 'function' || types.isAsyncFunction(callback) || types.isGeneratorFunction(callback)
        || ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]']
            .includes(Object.prototype.toString.call(callback))) {
        throw new TypeError('Installer transaction callbacks must be synchronous');
    }
}
export function installerSyncResult(result) {
    if (types.isGeneratorObject(result))
        throw new TypeError('Installer transaction callbacks must not return a generator');
    if (types.isPromise(result)) {
        // Reject unsupported work without leaving its eventual rejection unobserved.
        Promise.prototype.then.call(result, undefined, () => { });
        throw new TypeError('Installer transaction callbacks must not return a Promise');
    }
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof result.then === 'function') {
        throw new TypeError('Installer transaction callbacks must not return a thenable');
    }
    return result;
}