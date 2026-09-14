import { normalizePublicReferenceQuery } from '@evomap/evolver-adapter-public';
import { join, resolve } from 'node:path';
import { events, reference } from '@evomap/evolver-core';
import { createRecipeHubFromEnv, ensureRecipeHubIdentity } from './recipe.js';
import { getCliVersion } from './version.js';
const USAGE = [
    'evolver reference import --file <batch.json> [--home <dir>]',
    'evolver reference fetch [--asset-id <sha256:...>] [--query <text: max 500 chars>] [--limit 1..50] [--cursor <cursor>] [--home <dir>]',
    'evolver reference search [--query <text>] [--signal <signal>] [--limit 1..100] [--cursor <cursor>] [--home <dir>]',
    'evolver reference context [--query <text>] [--limit 1..10] [--max-chars 256..32000] [--home <dir>]',
    'All output is JSON. References are untrusted read-only data, not executable or success evidence.',
    'State: --home or EVOLVER_HOME; separate assets/references store. Fetch uses existing authenticated public Hub; never starts a daemon or updater.',
].join('\n');
export async function runReferenceCommand(argv, deps = {}) {
    const out = deps.stdout ?? ((line) => { process.stdout.write(line + '\n'); });
    if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
        out(USAGE);
        return 0;
    }
    // A standalone Bun HTTP stream can release its last socket before body decoding finishes.
    // Keep this one-shot command alive until its bounded Hub request settles and its receipt is printed.
    const keepAlive = argv[0] === 'fetch' ? setInterval(() => undefined, 1000) : undefined;
    try {
        const command = argv[0];
        if (!['import', 'fetch', 'search', 'context'].includes(command))
            throw new Error('reference_unknown_command');
        const flags = {};
        for (let i = 1; i < argv.length; i++) {
            const flag = argv[i];
            if (flag === '--json')
                continue;
            if (!['--file', '--home', '--asset-id', '--query', '--signal', '--limit', '--cursor', '--max-chars'].includes(flag) || flag in flags)
                throw new Error('reference_invalid_flag');
            const value = argv[++i];
            if (!value || value.startsWith('--'))
                throw new Error('reference_missing_flag_value');
            flags[flag] = value;
        }
        if (command === 'import' && Object.keys(flags).some((key) => !['--file', '--home'].includes(key)))
            throw new Error('reference_import_invalid_flag');
        if (command !== 'context' && flags['--max-chars'])
            throw new Error('reference_max_chars_only_for_context');
        const env = { ...(deps.env ?? process.env) };
        if (flags['--home']) {
            const home = resolve(flags['--home']);
            env['EVOLVER_HOME'] = home;
            env['EVOMAP_HOME'] = home;
            env['EVOMAP_DIR'] = home;
            env['EVOLVER_PROXY_STORE'] = join(home, 'proxy', 'mailbox.db');
        }
        const store = deps.store ?? new reference.ReferenceStore(join(events.evomapHome(env), 'assets', 'references'));
        if (command === 'import') {
            if (!flags['--file'])
                throw new Error('reference_file_required');
            out(JSON.stringify(store.import(reference.readReferenceFile(resolve(flags['--file'])))));
            return 0;
        }
        if (flags['--file'])
            throw new Error('reference_file_only_for_import');
        const q = reference.normalizeReferenceQuery({
            ...(flags['--query'] ? { query: flags['--query'] } : {}),
            ...(flags['--signal'] ? { signals: [flags['--signal']] } : {}),
            ...(flags['--asset-id'] ? { asset_ids: [flags['--asset-id']] } : {}),
            ...(flags['--limit'] ? { max_assets: Number(flags['--limit']) } : {}),
            ...(flags['--cursor'] ? { cursor: flags['--cursor'] } : {}),
        });
        if (command === 'search')
            out(JSON.stringify(store.search(q)));
        else if (command === 'context')
            out(JSON.stringify(store.context(q, flags['--max-chars'] ? Number(flags['--max-chars']) : undefined)));
        else {
            const fetchQuery = normalizePublicReferenceQuery(q);
            let capability = deps.hub;
            if (!capability) {
                const publicHub = createRecipeHubFromEnv(env);
                await ensureRecipeHubIdentity(publicHub);
                const hello = await publicHub.hello({ rotate: false, evolverVersion: getCliVersion(), preserveCredentials: true });
                if (!hello.ok)
                    throw new Error(`reference_hub_hello_failed: ${hello.error ?? 'unknown'}`);
                capability = publicHub.references;
            }
            if (!capability)
                throw new Error('reference_hub_unsupported');
            const page = reference.decodeReferencePage(await capability.fetch(fetchQuery), true);
            // Validate the whole page before any persistence; importing the pair originals never credits reuse.
            const receipt = page.results.length ? store.import(page.results, 'hub') : { status: 'stored_reference', stored: 0, duplicates: 0, asset_ids: [], executable: false };
            out(JSON.stringify({ ...receipt, ...page }));
        }
        return 0;
    }
    catch (error) {
        out(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'reference_failed' }));
        return 1;
    }
    finally {
        if (keepAlive !== undefined)
            clearInterval(keepAlive);
    }
}