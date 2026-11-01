import { withOwnedPluginLock } from './pluginLock.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_PLUGIN_GIT_URL, AGENT_PLUGIN_NAME, AGENT_PLUGIN_REPOSITORY, AGENT_PLUGIN_RELEASE } from './pluginHosts.js';
import { agentPluginRepositoryMatches } from './pluginInspection.js';
import { assertPluginManagedPath, checkedPluginCommand, pluginHome, PluginInstallError, readPluginJson, readPluginText } from './pluginRuntime.js';
const RECEIPT = '.evolver-plugin-checkout.json';
export function validatePackedBundle(bundle, host) {
    const root = lstatSync(bundle);
    if (root.isSymbolicLink() || !root.isDirectory())
        throw new PluginInstallError('failed', 'The plugin bundle root is not an ordinary owned directory.');
    const manifest = readPluginJson(join(bundle, host.manifest));
    const expectedName = host.id === 'opencode' ? '@evomap/evolver-opencode' : AGENT_PLUGIN_NAME;
    if (readPluginText(join(bundle, '.evolver-packed'))?.trim() !== host.id || manifest?.['name'] !== expectedName || typeof manifest['version'] !== 'string') {
        throw new PluginInstallError('failed', `The release branch has no valid packed ${host.label} plugin. No host installation was attempted.`);
    }
    const repository = typeof manifest['repository'] === 'string' ? manifest['repository'] : manifest['repository']?.url;
    if (!agentPluginRepositoryMatches(repository))
        throw new PluginInstallError('failed', 'The packed plugin manifest identifies another repository.');
    const entries = host.id === 'opencode' ? ['server.mjs', 'tui.mjs'] : ['bin/hook.mjs', `hosts/${host.id}/profile.js`];
    if (entries.some(entry => readPluginText(join(bundle, entry)) === undefined))
        throw new PluginInstallError('failed', 'The packed plugin is missing an entry module.');
    const queue = [bundle];
    let count = 0;
    while (queue.length > 0) {
        const directory = queue.pop();
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (++count > 10_000 || entry.isSymbolicLink())
                throw new PluginInstallError('failed', 'The plugin bundle contains an unsafe link or exceeds the file limit.');
            if (entry.isDirectory())
                queue.push(join(directory, entry.name));
            else if (!entry.isFile())
                throw new PluginInstallError('failed', 'The plugin bundle contains a non-regular file.');
        }
    }
}
export async function ensureAgentPluginBundle(runtime, host) {
    if (host.kind !== 'bundle')
        throw new PluginInstallError('unsupported_capability', 'This host uses its native source installer, not the packed-checkout download path.');
    if (!runtime.available('git'))
        throw new PluginInstallError('host_missing', 'Git is required to fetch the packed plugin release.');
    const remote = await checkedPluginCommand(runtime, 'git', ['ls-remote', '--heads', AGENT_PLUGIN_GIT_URL, AGENT_PLUGIN_RELEASE], runtime.cwd, 30_000);
    const matches = remote.stdout.trim().split('\n').map(line => /^([a-f0-9]{40})\s+refs\/heads\/release$/.exec(line.trim())).filter(Boolean);
    if (matches.length !== 1)
        throw new PluginInstallError('failed', 'The plugin release branch did not resolve to one commit.');
    const commit = matches[0][1];
    const base = join(realpathSync(pluginHome(runtime)), '.evolver', 'plugins', 'evolver-agent-plugin');
    assertPluginManagedPath(base);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const lockPath = join(base, `${host.id}.lock`);
    return withOwnedPluginLock(lockPath, async () => {
        const checkout = join(base, commit, host.id);
        let stage;
        let stageIdentity;
        try {
            assertPluginManagedPath(checkout);
            if (existsSync(checkout)) {
                const receipt = readPluginJson(join(checkout, RECEIPT));
                if (receipt?.['repository'] !== AGENT_PLUGIN_REPOSITORY || receipt['commit'] !== commit || receipt['host'] !== host.id) {
                    throw new PluginInstallError('conflict', 'The plugin cache directory is not an owned, matching release checkout.');
                }
                validatePackedBundle(join(checkout, 'dist', host.id), host);
                return join(checkout, 'dist');
            }
            stage = mkdtempSync(join(base, `.${host.id}-`));
            const identity = lstatSync(stage);
            stageIdentity = { dev: identity.dev, ino: identity.ino };
            const source = join(stage, 'checkout');
            const noHooks = join(stage, 'no-hooks');
            mkdirSync(noHooks, { mode: 0o700 });
            await checkedPluginCommand(runtime, 'git', ['-c', `core.hooksPath=${noHooks}`, 'clone', '--depth', '1', '--branch', AGENT_PLUGIN_RELEASE, '--filter=blob:none', '--sparse', AGENT_PLUGIN_GIT_URL, source], runtime.cwd, 120_000);
            await checkedPluginCommand(runtime, 'git', ['-C', source, '-c', `core.hooksPath=${noHooks}`, 'sparse-checkout', 'set', `dist/${host.id}`], runtime.cwd, 120_000);
            const head = await checkedPluginCommand(runtime, 'git', ['-C', source, 'rev-parse', 'HEAD']);
            if (head.stdout.trim() !== commit)
                throw new PluginInstallError('failed', 'The plugin release changed while downloading. Retry to use a consistent release.');
            validatePackedBundle(join(source, 'dist', host.id), host);
            writeFileSync(join(source, RECEIPT), `${JSON.stringify({ repository: AGENT_PLUGIN_REPOSITORY, commit, host: host.id })}\n`, { flag: 'wx', mode: 0o600 });
            assertPluginManagedPath(checkout);
            if (existsSync(checkout))
                throw new PluginInstallError('conflict', 'The plugin cache destination appeared during the download; it was not overwritten.');
            mkdirSync(join(base, commit), { recursive: true, mode: 0o700 });
            renameSync(source, checkout);
            return join(checkout, 'dist');
        }
        finally {
            if (stage && stageIdentity && existsSync(stage)) {
                const current = lstatSync(stage);
                if (!current.isSymbolicLink() && current.dev === stageIdentity.dev && current.ino === stageIdentity.ino)
                    rmSync(stage, { recursive: true, force: true });
            }
        }
    });
}