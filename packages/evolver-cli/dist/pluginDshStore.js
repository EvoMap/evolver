import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DSH_PLUGIN_SOURCE } from './pluginHosts.js';
import { checkedPluginCommand, objectOf, pluginHome, PluginInstallError, readPluginText } from './pluginRuntime.js';
const PNPM_MAJOR = /^pnpm@(\d+)\./;
function yamlScalar(text, key) {
    const value = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text)?.[1];
    return value?.replace(/^(["'])(.*)\1$/, '$2');
}
function recordedProfileStore(text) {
    let parsed;
    try {
        parsed = objectOf(JSON.parse(text));
    }
    catch {
        parsed = undefined;
    }
    const packageManager = parsed ? parsed['packageManager'] : yamlScalar(text, 'packageManager');
    const storeDir = parsed ? parsed['storeDir'] : yamlScalar(text, 'storeDir');
    return {
        pnpmMajor: typeof packageManager === 'string' ? PNPM_MAJOR.exec(packageManager)?.[1] : undefined,
        storeDir: typeof storeDir === 'string' && storeDir.trim() ? storeDir.trim() : undefined,
    };
}
function comparableStorePath(path, base, platform) {
    let absolute = resolve(base, path);
    try {
        absolute = realpathSync(absolute);
    }
    catch { /* A store that does not exist yet still has a comparable path. */ }
    const trimmed = absolute.length > 1 ? absolute.replace(/[\\/]+$/, '') : absolute;
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}
async function pathPnpmMajor(runtime, root) {
    if (!runtime.available('pnpm'))
        throw new PluginInstallError('host_missing', 'The dsh CLI installs plugins with the pnpm on PATH, and no pnpm was found. No dsh install command was run.');
    const { stdout } = await checkedPluginCommand(runtime, 'pnpm', ['--version'], root, 30_000);
    const major = /^(\d+)\.\d+\.\d+/.exec(stdout.trim())?.[1];
    if (!major)
        throw new PluginInstallError('unsupported_version', 'The pnpm on PATH reported an unrecognized version. No dsh install command was run.');
    return major;
}
async function pathPnpmStore(runtime, profileDir) {
    try {
        const { stdout } = await checkedPluginCommand(runtime, 'pnpm', ['store', 'path'], profileDir, 30_000);
        return stdout.trim().split(/\r?\n/).at(-1)?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function storeMismatch(options, recordedMajor, problem) {
    return new PluginInstallError('profile_store_mismatch', `dsh profile ${options.profile} ${problem} No dsh install command was run.`, [
        `This profile is managed by pnpm ${recordedMajor}. Do one of these:`,
        `- In dsh's own plugin screen, paste ${DSH_PLUGIN_SOURCE}`,
        `- Put pnpm ${recordedMajor} with the profile's store on PATH, then rerun: evolver plugin install --host dsh --profile ${options.profile}`,
        'Evolver does not reinstall the profile or edit its pnpm-workspace.yaml.',
    ]);
}
/**
 * The dsh CLI runs the pnpm on PATH, while the dsh app uses its bundled pnpm. A profile installed by another
 * pnpm major or into another store makes pnpm fail with ERR_PNPM_UNEXPECTED_STORE.
 */
export async function assertDshProfileStoreMatches(runtime, options) {
    const profileDir = join(pluginHome(runtime), '.dsh', 'profiles', options.profile);
    const modules = readPluginText(join(profileDir, 'node_modules', '.modules.yaml'));
    if (modules === undefined)
        return;
    const recorded = recordedProfileStore(modules);
    if (recorded.pnpmMajor === undefined)
        return;
    const onPath = await pathPnpmMajor(runtime, options.root);
    if (onPath !== recorded.pnpmMajor)
        throw storeMismatch(options, recorded.pnpmMajor, `is managed by pnpm ${recorded.pnpmMajor}, but the dsh CLI would use pnpm ${onPath} from PATH.`);
    if (recorded.storeDir === undefined)
        return;
    const pathStore = await pathPnpmStore(runtime, profileDir);
    if (pathStore === undefined)
        return;
    const base = join(profileDir, 'node_modules');
    if (comparableStorePath(recorded.storeDir, base, runtime.platform) !== comparableStorePath(pathStore, profileDir, runtime.platform)) {
        throw storeMismatch(options, recorded.pnpmMajor, `uses the pnpm store ${recorded.storeDir}, but the pnpm on PATH uses ${pathStore}.`);
    }
}