import { exec } from '@evomap/evolver-core';
import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
export class PluginInstallError extends Error {
    status;
    instructions;
    constructor(status, message, instructions = []) {
        super(message);
        this.status = status;
        this.instructions = instructions;
        this.name = 'PluginInstallError';
    }
}
export function pluginHome(runtime) {
    return runtime.env[runtime.platform === 'win32' ? 'USERPROFILE' : 'HOME']?.trim() || homedir();
}
export function pluginExecutableAvailable(command, env, platform) {
    if (platform === 'win32') {
        const resolved = exec.resolveSpawnCommand(command, [], env, platform);
        return resolved.cmd !== command && executableFile(resolved.cmd, platform);
    }
    const paths = isAbsolute(command) ? [command] : (env['PATH'] ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command));
    return paths.some(path => executableFile(path, platform));
}
function executableFile(path, platform) {
    try {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function resolvePluginSpawn(command, args, env, platform, standalone = Boolean(process.versions.bun)) {
    const resolved = exec.resolveSpawnCommand(command, args, env, platform);
    if (standalone && platform === 'win32' && resolved.cmd === process.execPath && resolved.args.length > args.length) {
        const node = exec.resolveSpawnCommand('node', [], env, platform);
        if (node.cmd === 'node' || !executableFile(node.cmd, platform))
            throw new PluginInstallError('host_missing', 'The selected host uses an npm launcher. Standalone Evolver requires a real Node.js executable on PATH to run it; it cannot run that script as the Evolver binary.');
        return { cmd: node.cmd, args: resolved.args };
    }
    return resolved;
}
export function createPluginRuntime(overrides = {}) {
    const env = overrides.env ?? process.env;
    const platform = overrides.platform ?? process.platform;
    const cwd = overrides.cwd ?? process.cwd();
    return {
        env, platform, cwd,
        available: command => pluginExecutableAvailable(command, env, platform),
        run: (command, args, workdir = cwd, timeoutMs = 120_000) => {
            const spawn = resolvePluginSpawn(command, args, env, platform);
            return exec.spawnCapture(spawn.cmd, spawn.args, {
                cwd: workdir, env, timeoutMs, input: '', maxOutputBytes: 1_048_576, resolvePlatform: platform,
            });
        },
        ...overrides,
    };
}
export async function checkedPluginCommand(runtime, command, args, cwd = runtime.cwd, timeoutMs) {
    let result;
    try {
        result = await runtime.run(command, args, cwd, timeoutMs);
    }
    catch (error) {
        if (error instanceof PluginInstallError)
            throw error;
        const missing = error?.code === 'ENOENT';
        throw new PluginInstallError(missing ? 'host_missing' : 'failed', `${command}: ${missing ? 'executable not found' : 'could not start the command'}.`);
    }
    if (result.termination !== 'exit')
        throw new PluginInstallError('failed', `${command}: command ${result.termination}; installation was not confirmed.`);
    if (result.code !== 0)
        throw new PluginInstallError('failed', `${command}: ${args[0] ?? 'command'} exited ${result.code ?? 'without an exit code'}; inspect the host's installation output before retrying.`);
    if (result.stdoutTruncated)
        throw new PluginInstallError('failed', `${command}: output exceeded the verification limit; installation was not confirmed.`);
    return result;
}
export function pluginJson(text, label) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new PluginInstallError('unsupported_capability', `${label} did not return valid JSON; no installed state can be inferred.`);
    }
}
export function objectOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
export function readPluginText(path, maxBytes = 1_048_576) {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > maxBytes)
            throw new PluginInstallError('failed', 'An installation/configuration file is not a bounded regular file.');
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        if (error instanceof PluginInstallError)
            throw error;
        throw new PluginInstallError('failed', 'An installation/configuration file could not be read.');
    }
}
export function readPluginJson(path) {
    const text = readPluginText(path);
    if (text === undefined)
        return undefined;
    const parsed = objectOf(pluginJson(text, 'Installation/configuration file'));
    if (!parsed)
        throw new PluginInstallError('failed', 'An installation/configuration file is not a JSON object.');
    return parsed;
}
function parsedPluginVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match)
        return undefined;
    const prerelease = match[4]?.split('.') ?? [];
    const build = match[5]?.split('.') ?? [];
    if (prerelease.some(part => !part || (/^\d+$/.test(part) && /^0\d/.test(part))) || build.some(part => !part))
        return undefined;
    return { core: [match[1], match[2], match[3]], prerelease };
}
function compareVersionNumber(left, right) {
    return left.length !== right.length ? left.length - right.length : left === right ? 0 : left > right ? 1 : -1;
}
export function pluginVersionAtLeast(current, minimum) {
    const a = parsedPluginVersion(current), b = parsedPluginVersion(minimum);
    if (!a || !b)
        return false;
    for (let index = 0; index < 3; index++) {
        const difference = compareVersionNumber(a.core[index], b.core[index]);
        if (difference !== 0)
            return difference > 0;
    }
    if (a.prerelease.length === 0)
        return true;
    if (b.prerelease.length === 0)
        return false;
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const left = a.prerelease[index], right = b.prerelease[index];
        if (left === undefined)
            return false;
        if (right === undefined)
            return true;
        if (left === right)
            continue;
        const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric)
            return compareVersionNumber(left, right) > 0;
        if (leftNumeric !== rightNumeric)
            return !leftNumeric;
        return left > right;
    }
    return true;
}
export async function checkPluginHostVersion(runtime, host) {
    if (!host.command || !runtime.available(host.command))
        throw new PluginInstallError('host_missing', `${host.label} CLI (${host.command ?? 'none'}) was not found on PATH.`);
    if (!host.minimumVersion)
        return;
    const { stdout } = await checkedPluginCommand(runtime, host.command, ['--version']);
    const version = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(stdout.trim())?.[1];
    if (!version || !pluginVersionAtLeast(version, host.minimumVersion)) {
        throw new PluginInstallError('unsupported_version', `${host.label} requires ${host.minimumVersion}+; ${version ?? 'an unknown version'} was observed. Upgrade the host CLI before installing.`);
    }
}
/** Only installer-owned descendants are written; a symlink may not redirect the cache or lock. */
export function assertPluginManagedPath(path) {
    let current = resolve(path);
    for (;;) {
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink())
                throw new PluginInstallError('conflict', 'The plugin cache/lock path contains a symbolic link; no installation files were written.');
            if (!stat.isDirectory())
                throw new PluginInstallError('conflict', 'The plugin cache parent is not a directory.');
        }
        catch (error) {
            if (error instanceof PluginInstallError)
                throw error;
            if (error?.code !== 'ENOENT')
                throw new PluginInstallError('failed', 'The plugin cache parent could not be inspected safely.');
        }
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}