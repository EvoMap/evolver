import { util } from '@evomap/evolver-core';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertPluginManagedPath, pluginHome, PluginInstallError } from './pluginRuntime.js';
export async function withOwnedPluginLock(path, work) {
    let owner;
    try {
        owner = util.acquireLock(path, { maxTries: 1, waitMs: 0 });
    }
    catch {
        throw new PluginInstallError('conflict', 'Another installation/download for this target is in progress, or its lock is unsafe. Retry after inspecting that operation.');
    }
    let result;
    let error;
    let failed = false;
    try {
        result = await work();
    }
    catch (caught) {
        error = caught;
        failed = true;
    }
    let released = false;
    try {
        released = util.releaseLock(path, owner).released;
    }
    catch { /* Report cleanup separately without replacing the original operation's evidence. */ }
    if (!released) {
        const prior = error instanceof PluginInstallError ? `${error.message} ` : '';
        throw new PluginInstallError('failed', `${prior}The owned installation/download lock could not be released; inspect it before retrying.`);
    }
    if (failed)
        throw error;
    return result;
}
export function withPluginInstallLock(runtime, options, work) {
    let projectRoot = '';
    if (options.scope === 'project') {
        try {
            projectRoot = realpathSync(resolve(runtime.cwd, options.root));
        }
        catch {
            throw new PluginInstallError('invalid_arguments', 'The project root could not be resolved before acquiring an installation lock.');
        }
    }
    const folder = join(realpathSync(pluginHome(runtime)), '.evolver', 'plugins', 'install-locks');
    assertPluginManagedPath(folder);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(JSON.stringify([options.host.id, options.scope, projectRoot, options.profile])).digest('hex').slice(0, 24);
    return withOwnedPluginLock(join(folder, `${key}.lock`), work);
}