import { events, ops, hooks, mailbox, hub as hubNs } from '@evomap/evolver-core';
import { readEvents, statusReport, listCycles, showCycle, listTriggers, buildNarrativeSnapshot, buildRetentionReport, dailyCapsuleCount } from './commands.js';
import { runGeneValue } from './geneValue.js';
import { assetstore, algo, signals, material as materialNs } from '@evomap/evolver-core';
import { loadPriceTable } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { makeInjectEmitter } from './autoexec.js';
import { listApprovedGenes, provenanceStoreForStore, reviewLedgerForStore } from './reviewFilter.js';
import { ADAPTERS, parseJsonlLines } from '@evomap/evolver-runtime-adapters';
import { draftGeneCandidate } from './distillPrimitives.js';
import { assessDraftAdmissionFromStore } from './distillAdmission.js';
import { parseRuntimeSessionSourcesWithDiagnostics } from './runtimeSessionSource.js';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, mkdirSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyImportV1Plan, planImportV1 } from './migrate/v1Import.js';
import { explicitRecipeHomes } from './recipe.js';
import { maybeAutoRestartProxyForSessionStart, sessionStartHookVerboseEnabled, dailyConnectionStatus, lifecyclePaths } from './lifecycle.js';
import { formatAntiGeneEvidenceAction, formatAntiGeneEvidenceSummary, summarizeAntiGeneEvidence } from './antiGeneEvidence.js';
import { buildRuntimeSessionMaterialSnapshot } from './materialSnapshot.js';
import { maybeEmitNonGitWorkspaceNotice } from './nonGitWorkspaceNotice.js';
import { asGeneCandidate, parseDistillOutput } from './autoDistillLlm.js';
import { runPromptRecallHook } from './promptRecallHook.js';
import { INGEST_CONSUMER_GROUP, recordSessionMaterial, resolveIngestDeps, toMaterialSourceAgent, } from './sessionIngest.js';
export { runSessionIngestTick, scanSessionDirs, } from './sessionIngest.js';
/** Minimal `--flag value` parser (last wins); bare positionals are ignored. */
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a && a.startsWith('--')) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                out[a.slice(2)] = next;
                i++;
            }
            else
                out[a.slice(2)] = '';
        }
    }
    return out;
}
const splitList = (v, sep) => (v ?? '').split(sep).map((s) => s.trim()).filter(Boolean);
/**
 * Operator identity for human-attributed AE events (the Ingestor requires actor.id when actor.kind=human).
 * Resolved from the environment so the audit spine records WHO taught the system; falls back to a stable
 * `cli` rather than throwing, so a manual command never fails purely for lack of an env var.
 */
function operatorActorId() {
    return process.env['EVOLVER_ACTOR_ID'] ?? process.env['USER'] ?? process.env['LOGNAME'] ?? 'cli';
}
export const PACKAGE = '@evomap/evolver-cli';
export function cliUsage() {
    return [
        'Usage: evolver <command> [options]',
        '',
        'Options:',
        '  -h, --help     Show this help',
        '  -v, --version  Show the installed version',
        '',
        'Proxy options (evolver proxy):',
        '  --home <dir>         Root for assets, store, settings, and traces',
        '  --evomap-home <dir>  Identity home for node_id/node_secret; defaults to --home',
        '  --store <path>       Mailbox store path',
        '  --settings <path>    Proxy settings file',
        '  --env-file <path>    Environment file',
        '',
        'Commands:',
        '  Daemon:      proxy, lifecycle, proxy-token, doctor, setup-hooks',
        '  Evolution:   run, cycle, autoexec, solidify, distill, review, thesis',
        '  Memory:      ingest, inject, recall, reuse, reuse-report, recall-verify-report',
        '               narrative, gene-value',
        '  Assets:      asset-log, asset-trust, asset-health, material, recipe, skill',
        '  Hub:         login, logout, phub, sync, publish, fetch, buy, orders, verify, atp',
        '  Operations:  status, daily, workflow status, cycles, trigger, value,',
        '               retention, replay, rebuild-views, issue-report',
        '  Tools:       dashboard, webui, trajectory-export, migrate',
        '  Advanced:    anti-gene-benchmark, anti-gene-rollout, reset-local-secret',
        '               skill-distill, skill-md-update',
        '',
        'Run evolver <command> --help for command-specific options.',
        '',
    ].join('\n');
}
const LOCAL_SECRET_STATE_KEYS = ['node_secret', 'node_secret_source', 'node_secret_version'];
const LOCAL_SECRET_ENV_VARS = [
    'EVOMAP_NODE_SECRET',
    'A2A_NODE_SECRET',
    'EVOMAP_NODE_SECRET_VERSION',
    'A2A_NODE_SECRET_VERSION',
];
function resolveLocalHome(env) {
    return env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir();
}
function resolveEvomapHome(env, homeDir) {
    const configured = env['EVOLVER_HOME'];
    return configured && configured.length > 0 ? configured : join(homeDir, '.evomap');
}
function resolveProxyStorePath(env, evomapHome) {
    const configured = env['EVOLVER_PROXY_STORE'];
    return configured && configured.length > 0 ? configured : join(evomapHome, 'proxy', 'mailbox.db');
}
function uniquePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const path of paths) {
        const key = resolve(path);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(path);
    }
    return out;
}
/**
 * Every directory the recipe credential layer might write a legacy node_secret/node_secret_version file into.
 * recipe.ts persists rotated legacy files to rotatePersistDir = recipeHomeCandidates(env)[0], which is the FIRST
 * of EVOMAP_DIR / EVOLVER_HOME / EVOMAP_HOME when any is set — so a secret can land under EVOMAP_DIR or EVOMAP_HOME,
 * not just EVOLVER_HOME / ~/.evomap. We union the explicit recipe homes (env-pure, shared with the writer to avoid
 * drift) with the reset's own resolved evomapHome and the ~/.evomap fallback so the reset wipes wherever a secret
 * could have been written; otherwise reset leaves a stale file the recipe path reads back on the next run (H3).
 * The ~/.evomap fallback is always included even when an explicit home is set, because the recipe path also reads
 * legacy files from it (recipeHomeCandidates' HOME/.evomap fallback) and the daemon's own ~/.evomap is canonical.
 */
function legacySecretHomes(env, evomapHome, homeDir) {
    return uniquePaths([
        ...explicitRecipeHomes(env),
        evomapHome,
        join(homeDir, '.evomap'),
    ]);
}
function legacySecretFiles(env, evomapHome, homeDir) {
    // Per-home order is secret-then-version; uniquePaths dedupes across homes that resolve to the same dir.
    return uniquePaths(legacySecretHomes(env, evomapHome, homeDir).flatMap((home) => [
        join(home, 'node_secret'),
        join(home, 'node_secret_version'),
    ]));
}
export function resetLocalSecret(opts = {}) {
    const env = opts.env ?? process.env;
    const homeDir = opts.homeDir ?? resolveLocalHome(env);
    const evomapHome = resolveEvomapHome(env, homeDir);
    const storePath = opts.storePath ?? resolveProxyStorePath(env, evomapHome);
    const clearedStateKeys = [];
    const storeFound = existsSync(storePath);
    if (storeFound) {
        const store = new mailbox.MailboxStore({ path: storePath });
        try {
            for (const key of LOCAL_SECRET_STATE_KEYS) {
                store.setState(key, '');
                clearedStateKeys.push(key);
            }
        }
        finally {
            store.close();
        }
    }
    const removedLegacyFiles = [];
    for (const file of legacySecretFiles(env, evomapHome, homeDir)) {
        if (!existsSync(file))
            continue;
        unlinkSync(file);
        removedLegacyFiles.push(file);
    }
    const envVarsSet = LOCAL_SECRET_ENV_VARS.filter((name) => {
        const value = env[name];
        return typeof value === 'string' && value.length > 0;
    });
    return {
        storePath,
        clearedStateKeys,
        storeFound,
        removedLegacyFiles,
        envVarsSet,
    };
}
export function formatResetLocalSecretResult(result) {
    const lines = [
        `cleared local proxy secret state: ${result.storePath}`,
        result.storeFound
            ? `cleared keys: ${result.clearedStateKeys.join(', ')}`
            : 'cleared keys: none; mailbox store not found',
    ];
    if (result.removedLegacyFiles.length > 0) {
        lines.push(`removed legacy files: ${result.removedLegacyFiles.join(', ')}`);
    }
    else {
        lines.push('removed legacy files: none found');
    }
    if (result.envVarsSet.length > 0) {
        lines.push(`env still set: ${result.envVarsSet.join(', ')}; unset or update these before restarting the proxy.`);
    }
    else {
        lines.push(`env reminder: unset or update ${LOCAL_SECRET_ENV_VARS.join(', ')} before restarting the proxy.`);
    }
    return `${lines.join('\n')}\n`;
}
export function runResetLocalSecret(argv, opts = {}) {
    if (argv[0] === '--help' || argv[0] === '-h') {
        process.stdout.write('用法: evolver reset-local-secret\n');
        return 0;
    }
    if (argv.length > 0) {
        process.stderr.write('用法: evolver reset-local-secret\n');
        return 1;
    }
    try {
        process.stdout.write(formatResetLocalSecretResult(resetLocalSecret(opts)));
        return 0;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`reset-local-secret failed: ${msg}\n`);
        return 1;
    }
}
/** rebuild-views: 删 MV → 从 root_events 全量重放重建 (军杰 §3.6). */
export function rebuildViews(opts = {}) {
    const ing = new events.Ingestor({ path: opts.eventsPath ?? events.rootEventsPath() });
    const replayer = new events.Replayer({ dir: opts.mvDir ?? events.mvDir(), projectors: events.DEFAULT_PROJECTORS });
    replayer.clear();
    replayer.rebuild(ing.readAll());
    return { rebuilt: events.DEFAULT_PROJECTORS.map((p) => p.name) };
}
function migrationErrorCode(error) {
    const structured = error;
    const code = typeof structured?.code === 'string' ? structured.code : '';
    if (code === 'LOCAL_ASSET_STORE_SNAPSHOT_CHANGED')
        return 'migration_target_changed';
    if (code === 'FROZEN_ASSET_ID_COLLISION')
        return 'migration_asset_id_collision';
    if (code === 'CORRUPT_LOCAL_ASSET_STORE')
        return 'migration_corrupt_target';
    if (code === 'LOCAL_ASSET_STORE_SNAPSHOT_LIMIT')
        return 'migration_target_limit';
    if (/^[a-z][a-z0-9_]{0,127}$/.test(code))
        return `migration_${code}`;
    const message = typeof structured?.message === 'string' ? structured.message : '';
    return /^[a-z][a-z0-9_]{0,127}$/.test(message) ? message : 'migration_failed';
}
function writeMigrationFailure(code, json) {
    process.stderr.write(json
        ? `${JSON.stringify({ ok: false, error: code })}\n`
        : `migrate: ${code}\n`);
}
/** migrate import-v1 | migrate env | migrate oauth — V1→V2 migration tools. */
export async function runMigrate(argv, deps = {}) {
    const usage = [
        'Usage:',
        '  evolver migrate import-v1 <v1dir> [outDir] [--workspace <path>] [--dry-run] [--json]',
        '  evolver migrate gep-sdk <v1dir> [outDir] [--workspace <path>] [--json]  # import-v1 --dry-run alias',
        '  evolver migrate --gep-sdk <v1dir> [outDir] [--workspace <path>] [--json]',
        '  evolver migrate env [--file <dotenv>] [--json] [--write-suggestions <path>] [--no-process-env]',
        '  evolver migrate oauth [--from <oauth_token.json>] [--to <token.json>] [--force] [--dry-run] [--json]',
        '',
    ].join('\n');
    if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
        process.stdout.write(usage);
        return 0;
    }
    if (argv[0] === 'env') {
        const { runMigrateEnvCommand } = await import('./migrate/envTranslate.js');
        return runMigrateEnvCommand(argv.slice(1));
    }
    if (argv[0] === 'oauth') {
        const { runMigrateOAuthCommand } = await import('./migrate/oauthImport.js');
        return runMigrateOAuthCommand(argv.slice(1));
    }
    const alias = argv[0] === 'gep-sdk' || argv[0] === '--gep-sdk';
    const migrationArgs = alias ? ['import-v1', ...argv.slice(1), '--dry-run'] : [...argv];
    if (migrationArgs[0] !== 'import-v1' || !migrationArgs[1] || migrationArgs[1].startsWith('--')) {
        process.stderr.write(usage);
        return 1;
    }
    let outDir;
    let workspace;
    let dryRun = false;
    let json = false;
    for (let index = 2; index < migrationArgs.length; index += 1) {
        const arg = migrationArgs[index] ?? '';
        if (arg === '--workspace') {
            const value = migrationArgs[index + 1];
            if (!value || value.startsWith('--')) {
                process.stderr.write(usage);
                return 1;
            }
            workspace = value;
            index += 1;
        }
        else if (arg.startsWith('--workspace=')) {
            workspace = arg.slice('--workspace='.length);
            if (!workspace) {
                process.stderr.write(usage);
                return 1;
            }
        }
        else if (arg === '--dry-run') {
            dryRun = true;
        }
        else if (arg === '--json') {
            json = true;
        }
        else if (arg.startsWith('--') || outDir !== undefined) {
            process.stderr.write(usage);
            return 1;
        }
        else {
            outDir = arg;
        }
    }
    const envFile = loadEnvFileFromEnv(process.env);
    if (envFile.error) {
        writeMigrationFailure('migration_env_file_load_failed', json);
        return 1;
    }
    const targetDir = outDir ?? events.evomapHome();
    const options = { ...deps, ...(workspace ? { workspace } : {}) };
    let plan;
    try {
        plan = await planImportV1(migrationArgs[1], targetDir, options);
    }
    catch (error) {
        writeMigrationFailure(migrationErrorCode(error), json);
        return 1;
    }
    let successOutput;
    try {
        if (dryRun) {
            if (json) {
                successOutput = `${JSON.stringify({ mode: 'dry-run', plan: plan.report })}\n`;
            }
            else {
                const assets = plan.report.assets;
                successOutput = (`Migration plan ${plan.report.planDigest}: Gene=${assets.Gene.candidates} `
                    + `Capsule=${assets.Capsule.candidates} Event=${assets.EvolutionEvent.candidates}; `
                    + `verified=${assets.Gene.verified + assets.Capsule.verified + assets.EvolutionEvent.verified} `
                    + `unverified=${assets.Gene.unverified + assets.Capsule.unverified + assets.EvolutionEvent.unverified}; `
                    + `mailbox=${plan.report.mailbox.candidates}; memory_graph=${plan.report.memoryGraph.disposition}\n`);
            }
        }
        else {
            const report = await applyImportV1Plan(plan, undefined, targetDir, options);
            successOutput = json
                ? `${JSON.stringify({ mode: 'apply', plan: plan.report, result: report })}\n`
                : `迁移完成: Gene=${report.imported.Gene} Capsule=${report.imported.Capsule} Event=${report.imported.EvolutionEvent} (冻结${report.frozen}[其中未验证${report.unverifiedFrozen}]/新算${report.recomputed}/去重${report.deduped}); sidecar=${report.sidecarExtensions}; mailbox 发现=${report.mailboxFound} 导入=${report.mailboxImported}; memory_graph 归档=${report.memoryGraphArchived} 可查询=${report.memoryGraphImported} 延后=${report.memoryGraphDeferred}\n`;
        }
    }
    catch (error) {
        try {
            plan.dispose();
        }
        catch { /* preserve the mapped primary failure */ }
        writeMigrationFailure(migrationErrorCode(error), json);
        return 1;
    }
    try {
        plan.dispose();
    }
    catch {
        writeMigrationFailure('migration_cleanup_failed', json);
        return 1;
    }
    process.stdout.write(successOutput);
    return 0;
}
/** One-line summary of an asset for `asset-log` (pure, testable). */
export function formatAssetLine(a) {
    const id = String(a.asset_id).replace(/^sha256:/, '').slice(0, 12);
    const o = a['outcome'];
    const desc = a.type === 'Gene' ? `category=${String(a['category'] ?? '?')}`
        : a.type === 'Capsule' ? `gene=${String(a['gene'] ?? '?')} ${String(a['summary'] ?? '')}`.trim()
            : a.type === 'EvolutionEvent' ? `intent=${String(a['intent'] ?? '?')} outcome=${String(o?.status ?? '?')}`
                : a.type === 'AntiGene' ? `trigger=${Array.isArray(a['trigger']) ? a['trigger'].map(String).join(',') : '?'} ${String(a['summary'] ?? '')}`.trim()
                    : '';
    return `${a.type.padEnd(15)} ${id}  ${desc}`.trimEnd();
}
const ASSET_CALL_ACTIONS = [
    'hub_search_hit', 'hub_search_miss',
    'asset_reuse', 'asset_reference',
    'asset_publish', 'asset_publish_skip',
    'asset_inject', 'asset_inject_shadow',
    'hub_review_submitted', 'hub_review_rejected', 'hub_review_failed',
];
function isAssetCallAction(value) {
    return ASSET_CALL_ACTIONS.includes(value);
}
/**
 * Preserve V2's asset-store listing as the default. V1's call audit is available
 * through the explicit `calls` mode so the two contracts do not overload an empty argv.
 */
export async function runAssetLog(argv, store, deps = {}) {
    const KINDS = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
    const CALL_FLAGS = ['--run', '--action', '--last', '--since', '--json'];
    const explicitCallMode = argv[0] === 'calls' || argv[0] === '--calls';
    const callMode = explicitCallMode || argv.some((arg) => CALL_FLAGS
        .some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
    const assetMode = !callMode && (argv.length === 0
        || argv[0] === 'assets'
        || argv[0] === '--assets'
        || KINDS.includes(argv[0] ?? '')
        || /^\d+$/.test(argv[0] ?? ''));
    if (assetMode)
        return runAssetList(argv.filter((arg) => arg !== 'assets' && arg !== '--assets'), store);
    if (!callMode)
        return assetLogUsage(`unknown asset-log mode: ${argv[0] ?? '(missing)'}`);
    const opts = {};
    let json = false;
    for (let i = explicitCallMode ? 1 : 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!explicitCallMode && KINDS.includes(arg ?? ''))
            continue;
        if (arg === '--json') {
            json = true;
            continue;
        }
        const parsed = assetLogFlagValue(argv, i, '--run');
        if (parsed) {
            opts.run_id = parsed.value;
            i += parsed.consumed;
            continue;
        }
        const action = assetLogFlagValue(argv, i, '--action');
        if (action) {
            if (!isAssetCallAction(action.value))
                return assetLogUsage(`invalid --action: ${action.value}`);
            opts.action = action.value;
            i += action.consumed;
            continue;
        }
        const last = assetLogFlagValue(argv, i, '--last');
        if (last) {
            if (!/^\d+$/.test(last.value) || Number(last.value) < 1)
                return assetLogUsage(`invalid --last: ${last.value}`);
            opts.last = Number(last.value);
            i += last.consumed;
            continue;
        }
        const since = assetLogFlagValue(argv, i, '--since');
        if (since) {
            if (!Number.isFinite(Date.parse(since.value)))
                return assetLogUsage(`invalid --since: ${since.value}`);
            opts.since = since.value;
            i += since.consumed;
            continue;
        }
        return assetLogUsage(`unknown asset-log argument: ${arg ?? '(missing)'}`);
    }
    const logPath = deps.logPath ?? events.assetCallLogPath();
    const callLog = deps.callLog ?? new hubNs.AssetCallLog(logPath);
    if (json) {
        process.stdout.write(`${JSON.stringify(callLog.read(opts), null, 2)}\n`);
        return 0;
    }
    const summary = callLog.summarize(opts);
    process.stdout.write('\n[Asset Call Log]\n');
    process.stdout.write(`  Total entries: ${summary.total_entries}\n`);
    process.stdout.write(`  Unique assets: ${summary.unique_assets}\n`);
    process.stdout.write(`  Unique runs:   ${summary.unique_runs}\n`);
    process.stdout.write('  By action:\n');
    for (const [action, count] of Object.entries(summary.by_action)) {
        process.stdout.write(`    ${action}: ${count}\n`);
    }
    if (summary.entries.length === 0) {
        process.stdout.write('\n  No entries found.\n\n');
        return 0;
    }
    process.stdout.write('\n  Recent entries:\n');
    for (const entry of summary.entries.slice(-10)) {
        const timestamp = entry.timestamp ? entry.timestamp.slice(0, 19) : '?';
        const asset = entry.asset_id ? `${entry.asset_id.slice(0, 20)}...` : '(none)';
        const signals = Array.isArray(entry.signals) ? entry.signals.slice(0, 3).join(', ') : '';
        process.stdout.write(`    [${timestamp}] ${entry.action || '?'}  asset=${asset}  score=${entry.score ?? '-'}  mode=${entry.mode ?? '-'}  signals=[${signals}]  run=${entry.run_id ?? '-'}\n`);
    }
    process.stdout.write('\n');
    return 0;
}
async function runAssetList(argv, store) {
    const KINDS = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
    let kind;
    let limit = 20;
    for (const a of argv) {
        if (KINDS.includes(a))
            kind = a;
        else if (/^\d+$/.test(a))
            limit = Number(a);
        else
            return assetLogUsage(`unknown asset list argument: ${a}`);
    }
    const s = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const assets = await s.list(kind, limit);
    if (assets.length === 0) {
        process.stdout.write('(no assets)\n');
        return 0;
    }
    for (const a of assets)
        process.stdout.write(formatAssetLine(a) + '\n');
    return 0;
}
function assetLogFlagValue(argv, index, flag) {
    const arg = argv[index];
    if (arg?.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1);
        return value ? { value, consumed: 0 } : null;
    }
    if (arg !== flag)
        return null;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? { value, consumed: 1 } : null;
}
function assetLogUsage(error) {
    process.stderr.write(`${error}\nusage: evolver asset-log [assets] [Gene|Capsule|EvolutionEvent|AntiGene] [limit] | evolver asset-log calls [--run <id>] [--action <action>] [--last <n>] [--since <iso>] [--json]\n`);
    return 1;
}
const DEFAULT_DISTILL_RESPONSE_FILE_MAX_BYTES = 1024 * 1024;
function responseFileArg(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg?.startsWith('--response-file='))
            return arg.slice('--response-file='.length);
        if (arg === '--response-file')
            return argv[index + 1] ?? '';
    }
    return undefined;
}
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function sameResponseFileIdentity(left, right) {
    const hasStableFileId = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
    if (hasStableFileId)
        return left.dev === right.dev && left.ino === right.ino;
    // Some filesystems do not expose dev/ino. Birth time + mode is the strongest portable fallback Node provides.
    return left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
}
function sameResponseFileSnapshot(left, right) {
    return sameResponseFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function readResponseFileDescriptor(fd, expectedSize) {
    const content = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
        const bytesRead = readSync(fd, content, offset, expectedSize - offset, offset);
        if (bytesRead === 0)
            throw new Error('response-file changed while being read (truncated)');
        offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, expectedSize) !== 0) {
        throw new Error('response-file changed while being read (grew beyond the validated size)');
    }
    return content.toString('utf8');
}
function candidateFromResponseFile(path, deps) {
    if (!path)
        throw new Error('response-file path is empty');
    const requestedRoot = resolve(deps.responseFileRoot ?? process.cwd());
    const root = realpathSync(requestedRoot);
    const requested = resolve(requestedRoot, path);
    if (!pathIsWithin(requestedRoot, requested))
        throw new Error('response-file is outside the allowed root');
    const beforeOpen = lstatSync(requested, { bigint: true });
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink())
        throw new Error('response-file must be a regular non-symlink file');
    const canonical = realpathSync(requested);
    if (!pathIsWithin(root, canonical))
        throw new Error('response-file resolves outside the allowed root');
    const configuredMax = deps.maxResponseFileBytes ?? DEFAULT_DISTILL_RESPONSE_FILE_MAX_BYTES;
    const maxBytes = Number.isSafeInteger(Math.floor(configuredMax)) && configuredMax > 0
        ? Math.floor(configuredMax)
        : DEFAULT_DISTILL_RESPONSE_FILE_MAX_BYTES;
    if (beforeOpen.size > BigInt(maxBytes))
        throw new Error(`response-file is too large (max ${maxBytes} bytes)`);
    deps.responseFileReadTestHook?.('before-open', canonical);
    const noFollow = process.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number'
        ? fsConstants.O_NOFOLLOW
        : 0;
    const fd = openSync(canonical, fsConstants.O_RDONLY | noFollow);
    let raw;
    try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile())
            throw new Error('response-file must be a regular file');
        if (!sameResponseFileSnapshot(beforeOpen, opened))
            throw new Error('response-file changed before it could be opened');
        if (opened.size > BigInt(maxBytes))
            throw new Error(`response-file is too large (max ${maxBytes} bytes)`);
        deps.responseFileReadTestHook?.('after-open', canonical);
        raw = readResponseFileDescriptor(fd, Number(opened.size));
        const afterRead = fstatSync(fd, { bigint: true });
        if (!sameResponseFileSnapshot(opened, afterRead))
            throw new Error('response-file changed while being read');
        const afterPath = lstatSync(requested, { bigint: true });
        if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameResponseFileSnapshot(afterRead, afterPath)) {
            throw new Error('response-file path changed while being read');
        }
        const canonicalAfterRead = realpathSync(requested);
        if (!pathIsWithin(root, canonicalAfterRead) || canonicalAfterRead !== canonical) {
            throw new Error('response-file path changed outside the allowed root');
        }
    }
    finally {
        closeSync(fd);
    }
    const candidate = asGeneCandidate(parseDistillOutput(raw));
    if (!candidate)
        throw new Error('response-file does not contain a valid Gene JSON object');
    return candidate;
}
/**
 * distill: gate a learned approach into the gene pool (ported v1 CLI verb). Runs the structural intake
 * (schema + dedup + asset_id) and, only if it passes, writes the gene to the store. The agent/runtime is
 * what discovers the strategy; this is the manual entry point that turns it into a pooled, selectable gene.
 * Usage: evolver distill --category <c> --signals <s1,s2> --strategy "<step1; step2>" [--summary <text>] [--id <id>]
 */
export async function runDistill(argv, store, deps = {}) {
    const f = parseFlags(argv);
    const responseFile = responseFileArg(argv);
    let candidate;
    if (responseFile !== undefined) {
        try {
            candidate = candidateFromResponseFile(responseFile, deps);
        }
        catch (error) {
            process.stderr.write(`[Distill] response-file error: ${error instanceof Error ? error.message : String(error)}\n`);
            return 2;
        }
    }
    else {
        candidate = {
            ...(f['id'] ? { id: f['id'] } : {}),
            category: f['category'] ?? 'innovate',
            signals_match: splitList(f['signals'], /,/),
            strategy: splitList(f['strategy'], /[;\n]/),
            ...(f['summary'] ? { summary: f['summary'] } : {}),
            // `evolver distill` is a human teaching the system a gene (actor.kind = human, see the audit below) →
            // `manual` per V1 #302 classifyProvenance.
            generation_meta: { source: 'manual' },
        };
    }
    if ((candidate.signals_match ?? []).length === 0 || (candidate.strategy ?? []).length === 0) {
        process.stderr.write('用法: evolver distill --category <c> --signals <s1,s2> --strategy "<step1; step2>" [--summary <t>]\n');
        return 1;
    }
    const s = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const existing = (await s.list('Gene', 1000)).map((g) => ({
        id: typeof g['id'] === 'string' ? String(g['id']) : undefined,
        signals_match: Array.isArray(g['signals_match']) ? g['signals_match'] : [],
    }));
    const r = algo.intakeGene(candidate, existing);
    // Emit nothing on rejection: only a gene that actually lands in the pool is a real "teach".
    if (!r.ok || !r.gene) {
        process.stderr.write(`distill 拒绝: ${r.errors.join('; ')}\n`);
        return 1;
    }
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    if (responseFile !== undefined) {
        // The gene is the commit point. Audit first (idempotently), quarantine second, then persist last so any
        // partial failure remains retryable and can never expose an unaudited machine-produced gene in the pool.
        const assetId = String(r.gene.asset_id);
        const alreadyAudited = ingestor.readAll().some((event) => event.type === 'gene.distilled'
            && String(event.payload?.['assetId'] ?? '') === assetId);
        if (!alreadyAudited) {
            await ingestor.ingest({
                type: 'gene.distilled',
                payload: { geneId: r.gene.id, assetId: r.gene.asset_id, source: 'cli-response-file' },
                human: { title: `LLM response-file distilled gene ${r.gene.id}`, severity: 'info' },
                actor: { kind: 'machine', id: 'cli-response-file' },
            });
        }
        reviewLedgerForStore(s).quarantineIfAbsent(assetId, 'LLM response-file distillation - review before use');
        await s.put(r.gene);
    }
    else {
        await s.put(r.gene);
        // AE (#91 item 1): a manual distill IS a human teaching the system a gene — record it on the audit spine.
        await ingestor.ingest({
            type: 'actor.human.teach',
            payload: { geneId: r.gene.id, assetId: r.gene.asset_id, category: r.gene.category },
            human: { title: `teach gene ${r.gene.id}`, severity: 'info' },
            actor: { kind: 'human', id: operatorActorId() },
        });
    }
    process.stdout.write(`distilled gene ${r.gene.id} (${String(r.gene.asset_id).slice(0, 19)}…) → pool\n`);
    return 0;
}
// LLM-proxy trace day-files (written by the proxy's JsonlTraceSink as `llm-trace-YYYYMMDD.jsonl`). The name
// pattern mirrors how runtime adapters detect() by path; a content sniff (event:'llm_turn') backstops renames.
const TRACE_FILE_RE = /(^|[/\\])llm-trace-[^/\\]*\.jsonl$/i;
/**
 * Ingest LLM-proxy trace records: print the economic/reliability signals extractTraceSignals mines from the
 * turn metadata, through the same preview shape the session path uses. `--distill` is EXCLUDED for trace
 * sources: a gene needs a strategy, and strategies are drafted from the agent's own narration — trace records
 * are metadata only (models/status/latency/usage, never text), so there is nothing real to draft steps from
 * and fabricating them would break the "real excerpts, not fabricated" rule of the session distill path.
 */
/** Print ONE trace file's signals. Sigs are precomputed so the printed count is exactly the count recorded in
 *  that file's material.batch_ready event (extractTraceSignals is threshold-based, so it is computed per file). */
function printTraceSignals(file, turnCount, sigs) {
    process.stdout.write(`ingest [llm-trace] ${file}: ${turnCount} llm_turn record(s) → ${sigs.length} signal(s)\n`);
    for (const s of sigs) {
        process.stdout.write(`  [${s.strength}/${s.kind}] ${s.text.replace(/\s+/g, ' ').trim().slice(0, 160)}\n`);
    }
}
/**
 * Is a Material for this EXACT file state already on the substrate? A Material's identity is its ULID, so `put`
 * cannot dedup across runs (each build mints a fresh id). Without this, a crash-retry — where a prior run put the
 * material but threw before the watermark advanced — would append a SECOND row for the unchanged file.
 *
 * The match is on (sourcePath, size, contentHash), NOT path+hash alone: contentHash is a PREFIX hash (first few KB),
 * so an append-grown trace day-file keeps the same prefix while `scanFile` correctly reports `changed: true`. Keying
 * on size too means a grown file is NOT mistaken for "already recorded" — it still earns a new material for its new
 * bytes — while a byte-identical retry of the same state is deduped (#100 bugbot).
 */
function materialExistsFor(store, sourcePath, wm) {
    if (wm.contentHash === undefined)
        return false;
    for (const m of store.iterate()) {
        if (m.sourcePath === sourcePath && m.watermark.size === wm.size && m.watermark.contentHash === wm.contentHash)
            return true;
    }
    return false;
}
/**
 * Record a proxy LLM-trace file as Material on the M1 substrate (#95). A trace is agent-agnostic gateway
 * telemetry, so it carries sourceKind=proxy_trace + kind=llm_trace and NO sourceAgent — the origin taxonomy
 * the closed runtime enum couldn't express. Idempotent by file watermark, same as the session path; both now
 * land on the ONE substrate the cycle daemon will later claim from, instead of the trace path bypassing it.
 */
async function recordTraceMaterial(absPath, signalCount, d) {
    const prev = d.watermarkStore.get(absPath);
    const scan = materialNs.scanFile(absPath, prev);
    if (prev && !scan.changed)
        return { recorded: false };
    const m = materialNs.buildMaterial({
        sourceKind: 'proxy_trace', // agent-agnostic — no sourceAgent (#95)
        sourcePath: absPath,
        kind: 'llm_trace',
        watermark: scan.watermark,
        consumerGroup: INGEST_CONSUMER_GROUP,
    });
    // Crash-retry idempotency (#100): reuse an already-recorded material for this unchanged file (see session path).
    const isNew = !materialExistsFor(d.materialStore, absPath, scan.watermark);
    if (isNew)
        await d.materialStore.put(m);
    await d.ingestor.ingest({
        // Same payload shape as the session path: one material per file (recordCount: 1) + signalCount, plus
        // sourceKind so a shared handler can tell a proxy trace from a runtime session (#100 bugbot).
        type: 'material.batch_ready',
        payload: { source: absPath, recordCount: 1, signalCount, sourceKind: 'proxy_trace' },
        human: { title: 'material 已落地: proxy llm-trace', severity: 'info' },
        actor: { kind: 'machine' },
    });
    // Watermark LAST — see recordSessionMaterial: a throw during ingest must leave the file re-ingestable (#100).
    d.watermarkStore.set(absPath, scan.watermark);
    return { recorded: isNew, materialId: m.materialId };
}
/**
 * Read + parse one or more trace JSONL files, record each as proxy_trace Material on the M1 substrate (#95,
 * idempotent by file watermark), and report their signals as a single batch.
 */
async function ingestTraceFiles(files, distill, deps) {
    const d = resolveIngestDeps(deps);
    // Phase 1 — read + parse EVERY file before any substrate write. A later read failure must not leave earlier
    // files already recorded as Material while the command exits 1 (partial side effect on a reported failure, #100).
    const perFile = [];
    for (const f of files) {
        try {
            perFile.push({ file: f, records: parseJsonlLines(readFileSync(f, 'utf8')) });
        }
        catch (e) {
            process.stderr.write(`ingest: cannot read ${f}: ${e instanceof Error ? e.message : String(e)}\n`);
            return 1; // no Material recorded yet — fail clean
        }
    }
    // Phase 2 — each trace FILE is its own Material AND its own signal set. extractTraceSignals is threshold-based
    // ACROSS a file's turns (e.g. ≥2 upstream 5xx, a slow-turn SHARE), so per-file is the honest unit: the cycle
    // later consumes one material = one file, and that file's event signalCount must equal what is extracted from
    // it alone. Merging files for one count would over/under-fire thresholds vs any single material (#100). One
    // file per material also keeps reporting and the event count in lockstep.
    let recorded = 0;
    for (const { file, records } of perFile) {
        const turns = records.filter((x) => x['event'] === 'llm_turn');
        const sigs = signals.extractTraceSignals(turns);
        const r = await recordTraceMaterial(file, sigs.length, d);
        if (r.recorded)
            recorded++;
        printTraceSignals(file, turns.length, sigs);
    }
    process.stdout.write(distill
        ? '\ningest: trace records are turn METADATA with no narration to draft a strategy from — --distill is ignored for trace sources. Nothing stored.\n'
        : '\n(trace preview — economic/reliability signals only; trace sources are excluded from --distill)\n');
    if (recorded)
        process.stdout.write(`  → recorded ${recorded} trace file(s) as proxy_trace material (material.batch_ready)\n`);
    return 0;
}
/**
 * ingest: read a REAL agent session log, parse it with the matching runtime adapter, and extract signals
 * (tool errors / explicit failures / difficulty wording) from it — the capture→signals half of the experience
 * loop. The adapter↔core composition lives HERE in the CLI on purpose: evolver-core must stay hub/adapter-
 * agnostic (it never imports runtime-adapters; it consumes turns via the structural SignalSourceTurn shape;
 * trace records reach it as plain parsed objects via the structural LlmTraceRecord shape).
 *
 * Sources:
 *   - agent session logs, detected by the runtime adapters' detect();
 *   - Cursor `state.vscdb`, read through the dedicated sqlite extractor instead of as text;
 *   - LLM-proxy trace JSONL (`llm-trace-*.jsonl` file, or a directory of day files), detected by name or by
 *     a content sniff for `event:'llm_turn'` records — closing the loop the proxy's trace-capture seam opened.
 *
 * Material substrate (M1, #91 item 2): a session log IS raw material — the first content the evolution loop
 *   ingests. Before signal extraction, `ingest` now records the session as a Material via MaterialStore and
 *   emits a `material.batch_ready` root_event so the append-only log (AE) is no longer bypassed. The file
 *   watermark cursor makes re-ingesting the SAME unchanged source idempotent (no duplicate material, no
 *   duplicate event) — this seats ingest on the substrate that previously had zero consumers, so when the
 *   daemon wires M1 up later there is ONE pipeline, not two. Trace sources land on the SAME substrate now
 *   (#95): a proxy llm-trace is agent-agnostic, so it records as sourceKind=proxy_trace / kind=llm_trace with
 *   no sourceAgent — the origin taxonomy the closed runtime enum previously couldn't express.
 *
 * Default / --dry-run: inspection only (print the signals; material is still recorded so the substrate sees it).
 * --distill: assemble a gene candidate from the session — signals_match from the strong signals, strategy from
 *   the agent's OWN substantive turns (real excerpts, not fabricated) — and intake it as an UNPROVEN draft.
 *   It is gated by `review` and pruned by the cycle's objective scoring, so a noisy auto-draft can't be trusted.
 *   Trace sources are excluded (metadata has no narration to distill — see reportTraceSignals).
 * Usage: evolver ingest <session-log | trace-file | trace-dir> [--dry-run | --distill]
 */
// `deps` (the M1 material substrate, #94) and `review` (the quarantine sidecar, #89) are independent injection
// seams that both default to the live ~/.evomap home; tests inject either in isolation. `deps` stays 3rd to match
// the rest of the ingest call sites; `review` is 4th.
export async function runIngest(argv, store, deps = {}, review) {
    const distill = argv.includes('--distill');
    const path = argv.find((a) => !a.startsWith('--'));
    if (!path) {
        process.stderr.write('用法: evolver ingest <session-log | trace-file | trace-dir> [--dry-run | --distill]\n');
        return 1;
    }
    // Trace source, by name: a llm-trace-*.jsonl file, or a directory scanned for the proxy's day files.
    let isDir = false;
    try {
        isDir = statSync(resolve(path)).isDirectory();
    }
    catch { /* missing path → handled by the reads below */ }
    if (isDir) {
        const files = readdirSync(resolve(path)).filter((f) => TRACE_FILE_RE.test(f)).sort().map((f) => join(resolve(path), f));
        if (files.length === 0) {
            process.stderr.write(`ingest: no llm-trace-*.jsonl files in directory: ${path}\n`);
            return 1;
        }
        return ingestTraceFiles(files, distill, deps);
    }
    if (TRACE_FILE_RE.test(path))
        return ingestTraceFiles([resolve(path)], distill, deps);
    let parsedSources;
    let parseDiagnostics;
    try {
        const parsed = parseRuntimeSessionSourcesWithDiagnostics(path, undefined, deps.nativeSessionHome);
        parsedSources = parsed.sources;
        parseDiagnostics = parsed.diagnostics;
    }
    catch (e) {
        process.stderr.write(`ingest: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    if (parsedSources.length === 0) {
        // Content sniff: a renamed/copied trace file still carries event:'llm_turn' records.
        try {
            if (parseJsonlLines(readFileSync(resolve(path), 'utf8')).some((r) => r['event'] === 'llm_turn')) {
                return ingestTraceFiles([resolve(path)], distill, deps); // record as proxy_trace material too (#95)
            }
        }
        catch { /* unreadable → fall through to the unrecognized error */ }
        process.stderr.write(`ingest: unrecognized session-log format: ${path} (supported: ${ADAPTERS.map((a) => a.agent).join(', ')}, llm-trace)\n`);
        return 1;
    }
    const sourceSignalPairs = parsedSources.map((source) => ({ source, sigs: signals.extractSignals(source.turns) }));
    if (parseDiagnostics && parseDiagnostics.invalidJson > 0) {
        process.stderr.write(`ingest: skipped ${parseDiagnostics.invalidJson} invalid JSONL row(s) in ${path}\n`);
    }
    for (const { source, sigs } of sourceSignalPairs) {
        process.stdout.write(`ingest [${source.label}] ${path}: ${source.turns.length} turn(s) → ${sigs.length} signal(s)\n`);
        for (const s of sigs) {
            const tool = s.toolName ? ` ${s.toolName}` : '';
            const text = s.text.replace(/\s+/g, ' ').trim().slice(0, 120);
            process.stdout.write(`  [${s.strength}/${s.kind}]${tool} ${text}\n`);
        }
    }
    // Re-seat on the M1 material substrate (#91 item 2): record the session as Material (idempotent by file
    // watermark) and emit a material.batch_ready root_event. Signal extraction now consumes from a path that
    // has first landed the material — the same one pipeline the cycle daemon will later claim from.
    const sourceAgent = toMaterialSourceAgent(parsedSources[0].agent);
    if (sourceAgent) {
        const d = resolveIngestDeps(deps);
        const signalCount = sourceSignalPairs.reduce((sum, pair) => sum + pair.sigs.length, 0);
        const snapshot = buildRuntimeSessionMaterialSnapshot(parsedSources);
        const r = await recordSessionMaterial(sourceAgent, resolve(path), signalCount, d, parsedSources.length, snapshot, parseDiagnostics);
        if (r.recorded)
            process.stdout.write(`  → recorded as material ${r.materialId} (material.batch_ready)\n`);
        else
            process.stdout.write('  → source unchanged since last ingest — no new material recorded\n');
    }
    if (!distill) {
        process.stdout.write('\n(preview only — pass --distill to draft an UNPROVEN gene candidate for review)\n');
        return 0;
    }
    // --distill: assemble + intake UNPROVEN draft genes per runtime session (shared draft logic — see distillPrimitives).
    const s = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const accepted = [];
    const acceptedSignals = [];
    let candidateCount = 0;
    let admissionSkipped = 0;
    let lastAdmissionSkipReason = '';
    for (const { source, sigs } of sourceSignalPairs) {
        const candidate = draftGeneCandidate(source.turns, sigs, source.agent);
        if (!candidate)
            continue;
        candidateCount += 1;
        // Same value/novelty gate as the live distillObserver (#562): without it, a bulk ingest over session
        // history floods the human review queue with thin / near-duplicate drafts (118 in one run). A non-admit
        // is a deliberate skip — the rest of the batch still distills; intake below stays the structural gate.
        const { admission, existing } = await assessDraftAdmissionFromStore(s, candidate, acceptedSignals);
        if (!admission.admit) {
            admissionSkipped += 1;
            lastAdmissionSkipReason = admission.reason ?? '';
            process.stdout.write(`\ningest --distill skipped [${source.label}]: ${admission.reason}\n`);
            continue;
        }
        const r = algo.intakeGene(candidate, existing);
        if (!r.ok || !r.gene) {
            process.stderr.write(`\ningest --distill rejected: ${r.errors.join('; ')}\n`);
            return 1;
        }
        accepted.push({ source, candidate, gene: r.gene });
        acceptedSignals.push({ id: r.gene.id, signals_match: r.gene.signals_match });
    }
    if (accepted.length === 0) {
        if (candidateCount > 0 && admissionSkipped === candidateCount) {
            const reason = lastAdmissionSkipReason ? ` Last skip reason: ${lastAdmissionSkipReason}.` : '';
            process.stdout.write(`\ningest: all ${candidateCount} draft candidate(s) skipped by admission gate.${reason} Nothing stored.\n`);
            return 0;
        }
        process.stdout.write('\ningest: not enough to distill — need ≥1 strong signal and ≥1 substantive assistant step. Nothing stored.\n');
        return 0;
    }
    const reviewDir = s instanceof assetstore.LocalJsonlProvider ? s.baseDir : events.assetsDir();
    const rev = review ?? new assetstore.ReviewLedger(reviewDir);
    const { ingestor } = resolveIngestDeps(deps);
    for (const { source, candidate, gene } of accepted) {
        // Quarantine the draft: its auto-extracted strategy must not be embedded into a real autonomous run until a
        // human approves it (`evolver review --approve <id>`). The gate lives in makeTrustedGeneResolver (#45+review).
        // Co-locate the sidecar with the RESOLVED store so an injected store quarantines in its own dir (not the real
        // ~/.evomap), keeping gate and gene together.
        const assetId = String(gene.asset_id);
        // Sticky human decision: re-distilling the same session yields the same asset_id; a fresh quarantine must not
        // last-write-win over a human approve/reject. quarantineIfAbsent does the read-and-append as ONE reload-aware
        // op (no caller-side check→act gap that a concurrent `review --approve` could slip through), and the ledger's
        // precedence resolution makes a human decision beat a quarantine regardless of append order — so even a racing
        // quarantine line cannot withhold an already-approved gene. Quarantine BEFORE persisting (asset_id is known from
        // intake): a crash between the two writes leaves at worst a harmless orphan record, never an ungated gene.
        rev.quarantineIfAbsent(assetId);
        await s.put(gene);
        // AE (#91 item 1): auto-distill mints a quarantined draft — record it on the audit spine.
        await ingestor.ingest({
            type: 'gene.distilled',
            payload: { geneId: gene.id, assetId: gene.asset_id, category: gene.category, source: 'ingest', ...(source.sessionId ? { sessionId: source.sessionId } : {}) },
            human: { title: `distilled gene ${gene.id}`, severity: 'info' },
            actor: { kind: 'machine', id: 'ingest' },
        });
        const state = rev.get(assetId)?.state ?? 'quarantined';
        process.stdout.write(`\n✎ drafted UNPROVEN gene ${gene.id} (${assetId.slice(0, 19)}…) — ${state}\n`);
        process.stdout.write(`  signals_match: ${candidate.signals_match.join(', ')}\n`);
        process.stdout.write(`  strategy: ${candidate.strategy.length} step(s) drafted from the session's own turns\n`);
        if (state === 'quarantined')
            process.stdout.write('  → approve with `evolver review --approve <id>` before it can influence a run; the cycle prunes it if it does not help.\n');
        else
            process.stdout.write(`  → already reviewed (${state}); the prior human decision stands.\n`);
    }
    return 0;
}
/** Health label for a gene from its learning view (curation hint, not a hard gate). */
export function reviewStatus(v) {
    if (v.total < 3)
        return 'unproven';
    if (v.successRate >= 0.6)
        return 'healthy';
    if (v.successRate < 0.4)
        return 'weak';
    return 'mixed';
}
/** Auto-promote eligibility of a quarantined (probation) gene, shown beside the health label so "[healthy] but
 *  never promotes" is not confusing (#306). Uses the SAME predicate as auto-promote (probationWouldPromote), so a
 *  single failure reads as blocked here exactly as it blocks promotion. */
export function promoteHint(v) {
    if (algo.probationWouldPromote(v))
        return 'ready';
    if (v.failed > 0)
        return `blocked(${v.failed} fail)`;
    return `needs ${Math.max(1, algo.DEFAULT_PROMOTE_MIN_SUCCESS - v.success)} more`;
}
function stringArrayField(value) {
    return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}
function optionalStringField(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function antiGeneReviewState(rev, assetId) {
    return rev.get(assetId)?.state ?? 'unreviewed';
}
function antiGeneReviewLine(asset, rev) {
    const assetId = String(asset.asset_id);
    const id = optionalStringField(asset['id']) ?? assetId;
    const state = antiGeneReviewState(rev, assetId);
    const severity = optionalStringField(asset['severity']) ?? '-';
    const trigger = stringArrayField(asset['trigger']).slice(0, 6).join(',') || '-';
    const avoid = stringArrayField(asset['avoid']).slice(0, 2).join(' | ') || '-';
    const summary = summarizeAntiGeneEvidence(asset);
    const evidence = `${formatAntiGeneEvidenceSummary(summary)} ${formatAntiGeneEvidenceAction(summary, state)}`;
    const next = state === 'quarantined' || state === 'unreviewed'
        ? summary.strength === 'weak'
            ? `next: reject/defer, or override with evolver review --approve ${id} --allow-weak-evidence <reason>`
            : `next: approve after manual guardrail review with evolver review --approve ${id} <reason> | reject with evolver review --reject ${id} <reason>`
        : state === 'approved'
            ? 'next: approved guardrail can be injected when signals match'
            : state === 'rejected'
                ? 'next: rejected guardrail is withheld from warning injection'
                : 'next: approved by default';
    return `${id.padEnd(28)} {${state}} severity=${severity} trigger=${trigger} avoid=${avoid} ${evidence} ${next}`;
}
async function listReviewVisibleAntiGenes(store, rev) {
    const byAssetId = new Map();
    for (const asset of await store.list('AntiGene', 10_000))
        byAssetId.set(String(asset.asset_id), asset);
    for (const record of rev.records()) {
        if (byAssetId.has(record.assetId))
            continue;
        const asset = await store.get(record.assetId);
        if (asset?.type === 'AntiGene')
            byAssetId.set(record.assetId, asset);
    }
    return [...byAssetId.values()];
}
async function findReviewVisibleAntiGene(store, rev, target) {
    if (target.startsWith('sha256:')) {
        const direct = await store.get(target);
        if (direct?.type === 'AntiGene')
            return direct;
    }
    const antiGenes = await listReviewVisibleAntiGenes(store, rev);
    return antiGenes.find((x) => String(x['id']) === target || String(x.asset_id) === target) ?? null;
}
async function runAntiGeneReview(store, rev) {
    const antiGenes = await listReviewVisibleAntiGenes(store, rev);
    if (antiGenes.length === 0) {
        process.stdout.write('(no anti-genes)\n');
        return 0;
    }
    const counts = { approved: 0, quarantined: 0, rejected: 0, unreviewed: 0 };
    for (const asset of antiGenes) {
        const state = antiGeneReviewState(rev, String(asset.asset_id));
        counts[state] += 1;
    }
    process.stdout.write(`anti-gene review queue: ${antiGenes.length} AntiGene asset(s); approved=${counts.approved} quarantined=${counts.quarantined} rejected=${counts.rejected} unreviewed=${counts.unreviewed}\n`);
    for (const asset of antiGenes)
        process.stdout.write(`${antiGeneReviewLine(asset, rev)}\n`);
    return 0;
}
/**
 * review: curate the gene pool. Default is a read-only listing (derived learning view + the review-state of each
 * gene); `--approve`/`--reject <id>` is the audited human act that lifts an auto-distilled draft out of (or
 * confirms it out of) quarantine. Approval is what lets a distilled gene's strategy be embedded into a real run
 * (the gate lives in makeTrustedGeneResolver, #45+review). The id may be a logical id or an asset_id.
 * Usage: evolver review [limit] | evolver review --approve <id> [--allow-weak-evidence] [reason…] | evolver review --reject <id> [reason…]
 */
export async function runReview(argv, store, review, deps = {}) {
    const s = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    // Co-locate the review sidecar with the resolved store (an injected store reads/writes its OWN review.jsonl).
    const reviewDir = s instanceof assetstore.LocalJsonlProvider ? s.baseDir : events.assetsDir();
    const rev = review ?? new assetstore.ReviewLedger(reviewDir);
    // Audited approve/reject: resolve the gene (by logical id or asset_id) to its asset_id and record the act.
    const verb = argv.includes('--approve') ? 'approve' : argv.includes('--reject') ? 'reject' : null;
    if (verb) {
        const allowWeakEvidence = argv.includes('--allow-weak-evidence');
        const flagIdx = argv.indexOf(verb === 'approve' ? '--approve' : '--reject');
        const target = argv[flagIdx + 1];
        if (!target || target.startsWith('--')) {
            const approveExtra = verb === 'approve' ? ' [--allow-weak-evidence]' : '';
            process.stderr.write(`用法: evolver review --${verb} <id>${approveExtra} [reason…]\n`);
            return 1;
        }
        // An asset_id resolves directly via store.get, so a reviewable asset past the bounded list() window is still
        // reachable; a logical id falls back to a scan. AntiGene shares this ledger before warning injection.
        let g = target.startsWith('sha256:') ? await s.get(target) : null;
        if (g && g.type !== 'Gene' && g.type !== 'AntiGene')
            g = null;
        if (!g) {
            const genes = await s.list('Gene', 1000);
            g = genes.find((x) => String(x['id']) === target || String(x.asset_id) === target) ?? null;
        }
        if (!g)
            g = await findReviewVisibleAntiGene(s, rev, target);
        if (!g) {
            process.stderr.write(`review --${verb}: no reviewable asset matches ${target}\n`);
            return 1;
        }
        const assetId = String(g.asset_id);
        const geneId = typeof g['id'] === 'string' ? String(g['id']) : assetId;
        const assetType = g.type;
        const evidence = assetType === 'AntiGene' ? summarizeAntiGeneEvidence(g) : null;
        const explicitlyApproved = rev.isExplicitlyApproved(assetId);
        if (verb === 'approve' && assetType === 'AntiGene' && evidence?.strength === 'weak' && !explicitlyApproved && !allowWeakEvidence) {
            process.stderr.write(`review --approve: AntiGene ${geneId} has weak evidence (${evidence.weakReasons.join('+')}); use --allow-weak-evidence only after manual verification or reject/defer it.\n`);
            return 1;
        }
        const by = operatorActorId();
        const reason = argv.slice(flagIdx + 2).filter((a) => !a.startsWith('--')).join(' ') || `${verb}d via CLI`;
        if (verb === 'approve')
            rev.approve(assetId, by, reason);
        else
            rev.reject(assetId, by, reason);
        const { ingestor } = resolveIngestDeps(deps);
        await ingestor.ingest({
            type: verb === 'approve' ? 'actor.human.review.approve' : 'actor.human.review.reject',
            payload: {
                geneId,
                assetId,
                assetType,
                reason,
                ...(evidence
                    ? {
                        evidenceQuality: evidence.strength,
                        weakReasons: evidence.weakReasons,
                        failureCount: evidence.failureCount,
                        sourceClusterCount: evidence.sourceClusterCount,
                        evidenceCapsuleCount: evidence.evidenceCapsuleCount,
                    }
                    : {}),
            },
            human: { title: `${verb} ${assetType} ${geneId}`, severity: 'info' },
            actor: { kind: 'human', id: by },
        });
        process.stdout.write(`${verb === 'approve' ? 'approved' : 'rejected'} ${assetType} ${geneId} (${assetId.slice(0, 19)}...) by ${by}: ${reason}\n`);
        return 0;
    }
    if (argv.includes('--anti-gene'))
        return runAntiGeneReview(s, rev);
    const limit = argv.find((a) => /^\d+$/.test(a)) ? Number(argv.find((a) => /^\d+$/.test(a))) : 50;
    // Auto-drafted visibility (#117-A tail): flag which quarantined genes the distillObserver auto-drafted
    // (gene.distilled with source=distill-observer) vs cycle/manual, and count those awaiting human review — the
    // signal #113's digest surfaces ("N auto-drafted genes waiting for you"). Counted over ALL such events, so the
    // total is accurate regardless of the display limit.
    const { ingestor } = resolveIngestDeps(deps);
    const autoDrafted = new Set(ingestor.readAll()
        .filter((e) => e.type === 'gene.distilled' && e.payload?.['source'] === 'distill-observer')
        .map((e) => String(e.payload?.['assetId'] ?? ''))
        .filter(Boolean));
    const autoPending = [...autoDrafted].filter((a) => rev.get(a)?.state === 'quarantined').length;
    const genes = await s.list('Gene', limit);
    if (genes.length === 0)
        process.stdout.write('(no genes)\n'); // no early return: the auto-pending footer below is
    for (const g of genes) { // computed from the full event set, so it must print
        const id = typeof g['id'] === 'string' ? String(g['id']) : String(g.asset_id);
        const view = await assetstore.aggregateLearningHistory(s, id);
        const cat = String(g['category'] ?? '?');
        const rate = view.total > 0 ? `${Math.round(view.successRate * 100)}%` : '-';
        const state = rev.get(String(g.asset_id))?.state ?? 'eligible'; // no record → eligible by default
        const auto = autoDrafted.has(String(g.asset_id)) ? ' ✎auto-drafted' : '';
        // For a gene on probation, show its AUTO-PROMOTE eligibility next to the success-rate health label — they are
        // different lenses that can disagree (#306 trial): a gene can read [healthy] by success-rate yet never auto-
        // promote because it has a failure. Route through the SAME predicate auto-promote uses so they never diverge.
        const promote = state === 'quarantined' ? ` promote:${promoteHint(view)}` : '';
        process.stdout.write(`${id.padEnd(28)} ${cat.padEnd(10)} total=${view.total} succ=${rate} [${reviewStatus(view)}] {${state}}${promote}${auto}\n`);
    }
    if (autoPending > 0)
        process.stdout.write(`\n${autoPending} auto-drafted gene(s) awaiting review — approve with \`evolver review --approve <id>\`\n`);
    const antiGenePending = (await listReviewVisibleAntiGenes(s, rev)).filter((asset) => rev.get(String(asset.asset_id))?.state === 'quarantined').length;
    if (antiGenePending > 0)
        process.stdout.write(`\n${antiGenePending} anti-gene(s) awaiting review - inspect with \`evolver review --anti-gene\`\n`);
    return 0;
}
/**
 * `evolver value [--window 7d|30d|all]`: the pull-only, zero-intrusion answer to "is evolver worth it". Reads the
 * proxy trace day-files (route savings) + root_events (reuse / inject) off disk, derives the value ledger through
 * the SAME core aggregation every surface uses (ops.loadValueSummary — no re-implementation here), and prints the
 * three-section report. measured and estimated savings are shown on separate lines (never merged). With no ledger
 * data it prints guidance, not an empty table. This is a THIN command: all aggregation lives in core ops.
 */
export function runValue(argv, deps = {}) {
    const f = parseFlags(argv);
    const windowSpec = f['window'];
    const now = deps.now ? deps.now() : Date.now();
    const traces = ops.readTraceRecords(deps.tracesDir ?? events.tracesDir());
    const evts = readEvents(deps.eventsPath ?? events.rootEventsPath());
    const prices = deps.prices ?? loadPriceTable();
    const window = ops.windowFromSpec(windowSpec, now);
    const summary = ops.loadValueSummary({ traces, events: evts, prices }, window);
    process.stdout.write(ops.formatValueReport(summary, windowSpec) + '\n');
    return 0;
}
export function formatNarrativeSnapshot(snapshot) {
    const lines = [
        `narrative: total=${snapshot.totalEvents} included=${snapshot.includedEvents} cycles=${snapshot.cycles} reflections=${snapshot.reflections} success=${snapshot.outcomes.success} failed=${snapshot.outcomes.failed} inert=${snapshot.outcomes.inert} unknown=${snapshot.outcomes.unknown}`,
    ];
    if (snapshot.entries.length === 0) {
        lines.push('  entries: none');
        return `${lines.join('\n')}\n`;
    }
    lines.push('  entries:');
    for (const entry of snapshot.entries) {
        const cycle = entry.cycleId ? ` cycle=${entry.cycleId}` : '';
        const outcome = entry.outcome ? ` outcome=${entry.outcome}` : '';
        const action = entry.action ? ` action=${entry.action}` : '';
        const gene = entry.geneId ? ` gene=${entry.geneId}` : '';
        const score = typeof entry.score === 'number' ? ` score=${entry.score}` : '';
        lines.push(`    #${entry.seq} ${entry.ts} ${entry.type}${cycle}${outcome}${action}${gene}${score} - ${entry.title}`);
        if (entry.summary)
            lines.push(`      ${entry.summary}`);
    }
    return `${lines.join('\n')}\n`;
}
export function runNarrative(argv, deps = {}) {
    const f = parseFlags(argv);
    const limit = parsePositiveInt(f['limit']);
    const snapshot = buildNarrativeSnapshot(readEvents(deps.eventsPath), { ...(limit !== undefined ? { limit } : {}) });
    if ('json' in f) {
        process.stdout.write(`${JSON.stringify({ ok: true, group: 'narrative', ...snapshot })}\n`);
    }
    else {
        process.stdout.write(formatNarrativeSnapshot(snapshot));
    }
    return 0;
}
function formatRootEventArchive(result) {
    if (result.mode === 'preview') {
        return `retention archive-root: mode=preview active=${result.activeRecords} keep=${result.keepEvents} wouldArchive=${result.wouldArchive} retained=${result.retainedRecords} archiveId=${result.archiveId ?? '-'}\n`;
    }
    return `retention archive-root: mode=write activeBefore=${result.activeRecordsBefore} keep=${result.keepEvents} archived=${result.archivedRecords} retained=${result.retainedRecords} archiveId=${result.archiveId ?? '-'} reused=${result.reusedSegment}\n`;
}
function formatMaterialArchive(result) {
    if (result.mode === 'preview') {
        return `retention archive-material: mode=preview active=${result.activeRecords} archive=${result.archiveRecords} history=${result.historyRecords} keep=${result.keepRecords} minCursor=${result.minCursor} wouldArchive=${result.wouldArchive} retained=${result.retainedRecords} archiveId=${result.archiveId ?? '-'}\n`;
    }
    return `retention archive-material: mode=write activeBefore=${result.activeRecordsBefore} archived=${result.archivedRecords} archive=${result.archiveRecords} history=${result.historyRecords} keep=${result.keepRecords} minCursor=${result.minCursor} retained=${result.retainedRecords} recoveredOverlap=${result.recoveredOverlap} archiveId=${result.archiveId ?? '-'}\n`;
}
function archiveFailureCode(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code ?? '')
        : '';
    if (code === 'ROOT_EVENT_ARCHIVE_INVALID_LOG')
        return 'root_event_archive_invalid_log';
    if (code === 'ROOT_EVENT_ARCHIVE_INVALID_ARCHIVE')
        return 'root_event_archive_invalid_archive';
    if (code === 'ROOT_EVENT_HISTORY_GAP')
        return 'root_event_archive_history_gap';
    if (code === 'ROOT_EVENT_ARCHIVE_SEGMENT_CONFLICT')
        return 'root_event_archive_conflict';
    if (code === 'LOCK_TIMEOUT')
        return 'root_event_archive_locked';
    return 'root_event_archive_failed';
}
function materialArchiveFailureCode(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code ?? '')
        : '';
    if (code === 'MATERIAL_ARCHIVE_INVALID_LOG')
        return 'material_archive_invalid_log';
    if (code === 'MATERIAL_ARCHIVE_INVALID_ARCHIVE')
        return 'material_archive_invalid_archive';
    if (code === 'MATERIAL_ARCHIVE_RANGE_INVALID')
        return 'material_archive_range_invalid';
    if (code === 'MATERIAL_ARCHIVE_SEGMENT_CONFLICT')
        return 'material_archive_conflict';
    if (code === 'MATERIAL_ARCHIVE_CURSOR_INVALID')
        return 'material_archive_cursor_invalid';
    if (code === 'LOCK_TIMEOUT')
        return 'material_archive_locked';
    return 'material_archive_failed';
}
function parseRootArchiveArgs(argv) {
    const parsed = { help: false, json: false, write: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help')
            parsed.help = true;
        else if (arg === '--json')
            parsed.json = true;
        else if (arg === '--write')
            parsed.write = true;
        else if (arg === '--keep-events') {
            const value = argv[index + 1];
            const keepEvents = parsePositiveInt(value);
            if (value === undefined || value.startsWith('--') || keepEvents === undefined) {
                parsed.error = 'invalid_keep_events';
                return parsed;
            }
            parsed.keepEvents = keepEvents;
            index += 1;
        }
        else {
            parsed.error = 'invalid_arguments';
            return parsed;
        }
    }
    return parsed;
}
function runRootEventArchive(argv, deps) {
    const parsed = parseRootArchiveArgs(argv);
    if (parsed.help) {
        process.stdout.write('usage: evolver retention archive-root [--keep-events N] [--write] [--json]\n');
        return 0;
    }
    if (parsed.error !== undefined) {
        process.stderr.write(`retention archive-root: ${parsed.error}\n`);
        return 2;
    }
    const options = {
        path: deps.rootEventsPath ?? events.rootEventsPath(),
        ...(parsed.keepEvents !== undefined ? { keepEvents: parsed.keepEvents } : {}),
    };
    try {
        const result = parsed.write
            ? events.archiveRootEvents(options)
            : events.planRootEventArchive(options);
        if (parsed.json)
            process.stdout.write(`${JSON.stringify({ ok: true, group: 'retention.archive_root', ...result })}\n`);
        else
            process.stdout.write(formatRootEventArchive(result));
        return 0;
    }
    catch (error) {
        process.stderr.write(`retention archive-root: ${archiveFailureCode(error)}\n`);
        return 1;
    }
}
function parseMaterialArchiveArgs(argv) {
    const parsed = { help: false, json: false, write: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help')
            parsed.help = true;
        else if (arg === '--json')
            parsed.json = true;
        else if (arg === '--write')
            parsed.write = true;
        else if (arg === '--keep-records') {
            const value = argv[index + 1];
            const keepRecords = parsePositiveInt(value);
            if (value === undefined || value.startsWith('--') || keepRecords === undefined) {
                parsed.error = 'invalid_keep_records';
                return parsed;
            }
            parsed.keepRecords = keepRecords;
            index += 1;
        }
        else {
            parsed.error = 'invalid_arguments';
            return parsed;
        }
    }
    return parsed;
}
function runMaterialArchive(argv, deps) {
    const parsed = parseMaterialArchiveArgs(argv);
    if (parsed.help) {
        process.stdout.write('usage: evolver retention archive-material [--keep-records N] [--write] [--json]\n');
        return 0;
    }
    if (parsed.error !== undefined) {
        process.stderr.write(`retention archive-material: ${parsed.error}\n`);
        return 2;
    }
    const path = deps.materialStorePath ?? events.materialStorePath();
    const cursorPaths = deps.materialCursorPaths
        ?? (deps.materialCursorPath !== undefined
            ? [deps.materialCursorPath]
            : [join(dirname(path), 'cycle-consumer.json'), join(dirname(path), 'distill-consumer.json')]);
    const options = {
        path,
        cursorPaths,
        ...(parsed.keepRecords !== undefined ? { keepRecords: parsed.keepRecords } : {}),
    };
    try {
        const result = parsed.write
            ? materialNs.archiveMaterialStore(options)
            : materialNs.planMaterialArchive(options);
        if (parsed.json) {
            process.stdout.write(`${JSON.stringify({ ok: true, group: 'retention.archive_material', ...result })}\n`);
        }
        else {
            process.stdout.write(formatMaterialArchive(result));
        }
        return 0;
    }
    catch (error) {
        process.stderr.write(`retention archive-material: ${materialArchiveFailureCode(error)}\n`);
        return 1;
    }
}
export function formatRetentionReport(report) {
    const lines = [
        `retention: mode=${report.mode} prune=${report.destructivePruneSupported ? 'enabled' : 'disabled'} generatedAt=${report.generatedAt}`,
        `  root_events: state=${report.rootEvents.state} records=${report.rootEvents.records} bytes=${report.rootEvents.bytes} invalid=${report.rootEvents.invalidLines} archiveSegments=${report.rootEvents.archiveSegments} archiveRecords=${report.rootEvents.archiveRecords} archiveBytes=${report.rootEvents.archiveBytes} archiveInvalid=${report.rootEvents.archiveInvalidLines} historyRecords=${report.rootEvents.historyRecords} historyConflicts=${report.rootEvents.historyConflicts} historyGaps=${report.rootEvents.historyGaps} historyIntegrityErrors=${report.rootEvents.historyIntegrityErrors} firstSeq=${report.rootEvents.firstSeq ?? '-'} lastSeq=${report.rootEvents.lastSeq ?? '-'} protectTail=${report.rootEvents.protectTailEvents}`,
        `  material: state=${report.material.state} records=${report.material.records} bytes=${report.material.bytes} invalid=${report.material.invalidLines} archiveSegments=${report.material.archiveSegments} archiveRecords=${report.material.archiveRecords} archiveBytes=${report.material.archiveBytes} archiveInvalid=${report.material.archiveInvalidLines} historyRecords=${report.material.historyRecords} cursorCount=${report.material.cursorCount} minCursor=${report.material.minCursor} cursor=${report.material.cursor} effectiveCursor=${report.material.effectiveCursor} cursorValid=${report.material.cursorValid} cursorInRange=${report.material.cursorInRange} consumedPrefix=${report.material.consumedPrefix} pending=${report.material.pending} archiveSafe=${report.material.archiveRotationSafe}`,
    ];
    if (report.warnings.length > 0) {
        lines.push('  warnings:');
        for (const warning of report.warnings)
            lines.push(`    ${warning}`);
    }
    else {
        lines.push('  warnings: none');
    }
    lines.push('  next:');
    for (const action of report.nextActions)
        lines.push(`    ${action}`);
    return `${lines.join('\n')}\n`;
}
export function runRetention(argv, deps = {}) {
    if (argv[0] === 'archive-root')
        return runRootEventArchive(argv.slice(1), deps);
    if (argv[0] === 'archive-material')
        return runMaterialArchive(argv.slice(1), deps);
    const f = parseFlags(argv);
    const report = buildRetentionReport({
        rootEventsPath: deps.rootEventsPath,
        materialStorePath: deps.materialStorePath,
        materialCursorPath: deps.materialCursorPath,
        materialCursorPaths: deps.materialCursorPaths,
        now: deps.now,
        maxRootEvents: parsePositiveInt(f['max-root-events']),
        maxRootBytes: parsePositiveInt(f['max-root-bytes']),
        maxMaterialRecords: parsePositiveInt(f['max-material-records']),
        maxMaterialBytes: parsePositiveInt(f['max-material-bytes']),
    });
    if ('json' in f)
        process.stdout.write(`${JSON.stringify({ ok: true, group: 'retention', ...report })}\n`);
    else
        process.stdout.write(formatRetentionReport(report));
    return 0;
}
function parsePositiveInt(value) {
    if (value === undefined || value.trim() === '')
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
/** A compact one-line rendering of a gene for SessionStart injection (id + a short hint). Deterministic. */
export function formatGeneInjectionLine(g) {
    const id = typeof g['id'] === 'string' ? String(g['id']) : String(g.asset_id);
    const cat = String(g['category'] ?? '');
    const summary = String(g['summary'] ?? '').replace(/\s+/g, ' ').trim();
    const hint = summary || (Array.isArray(g['signals_match']) ? g['signals_match'].slice(0, 4).join(', ') : '');
    return `- ${id}${cat ? ` [${cat}]` : ''}${hint ? `: ${hint.slice(0, 160)}` : ''}`;
}
/** Read the SessionStart hook's stdin payload, bounded so it can NEVER hang the agent's critical path: skipped on a
 *  TTY (a manual run), and capped by a short timeout so a runtime that leaves stdin open without sending EOF still
 *  proceeds. Resolves to '' when nothing is available. Only called when the hook opts in (--hook-stdin). */
function readStdinBounded(timeoutMs = 500) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        if (stdin.isTTY) {
            resolve('');
            return;
        }
        let data = '';
        let settled = false;
        const finish = (v) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stdin.removeListener('data', onData);
            stdin.removeListener('end', onEnd);
            stdin.removeListener('error', onErr);
            try {
                stdin.pause();
            }
            catch { /* already closed */ }
            resolve(v);
        };
        const onData = (c) => { data += c.toString(); };
        const onEnd = () => finish(data);
        const onErr = () => finish('');
        const timer = setTimeout(() => finish(data), timeoutMs);
        timer.unref?.(); // never keep the process alive for this read
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        stdin.on('end', onEnd);
        stdin.on('error', onErr);
        try {
            stdin.resume();
        }
        catch {
            finish('');
        }
    });
}
/** Extract `session_id` from the SessionStart hook payload (Claude Code delivers JSON on stdin). Best-effort: any
 *  read/parse error is swallowed (the injection must never fail for a missing session id), and a runtime that
 *  exposes no per-session id simply yields undefined. */
async function readHookSessionId(read) {
    try {
        const raw = read ? read() : await readStdinBounded();
        if (!raw || !raw.trim())
            return undefined;
        const obj = JSON.parse(raw);
        return typeof obj.session_id === 'string' && obj.session_id.length > 0 ? obj.session_id : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * `evolver inject session-start`: the SessionStart hook entrypoint (the command every installer registers).
 * It selects the eligible local genes, composes the SessionStart injection WITH the value recap (#113) through
 * core's `composeSessionStartWithRecap`, prints only a quiet memory hint when at least one approved gene actually
 * lands in the prompt, AND — this is #123 — wires the inject emission seam so a `value.inject` root_event is
 * appended carrying the genes that ACTUALLY landed in the prompt (post budget-trim). That feeds the ledger's source=inject rail with real data, attribution-only:
 * the event has NO savings number (the genes are recorded for outcome attribution, never scored).
 *
 * The outcome is NOT observable here — at SessionStart the session has not run yet — so the event records the
 * injected genes only; outcome stays absent for a possible later attribution pass.
 *
 * Best-effort by construction: the emit promise is awaited so the event is durable before the command returns,
 * but emitInject swallows every error, so a sink failure can never break or block the attribution path.
 */
export async function runInject(argv, deps = {}) {
    const sub = argv[0];
    if (sub === 'prompt-recall') {
        return runPromptRecallHook(argv.slice(1), {
            ...(deps.store ? { store: deps.store } : {}),
            ...(deps.review ? { review: deps.review } : {}),
            ...(deps.provenance ? { provenance: deps.provenance } : {}),
            ...(deps.readHookInput ? { readHookInput: deps.readHookInput } : {}),
        });
    }
    if (sub !== 'session-start') {
        process.stderr.write('用法: evolver inject session-start | evolver inject prompt-recall --hook-stdin\n');
        return sub === undefined ? 0 : 1;
    }
    const fromHookStdin = argv.includes('--hook-stdin');
    if (fromHookStdin) {
        try {
            await (deps.ensureProxyAutostart ?? (() => maybeAutoRestartProxyForSessionStart()))();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (sessionStartHookVerboseEnabled(process.env)) {
                process.stderr.write(`[evolver-session-start] proxy auto-restart failed: ${msg}\n`);
            }
        }
        maybeEmitNonGitWorkspaceNotice(deps.nonGitNotice);
    }
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: deps.eventsPath ?? events.rootEventsPath() });
    const review = deps.review ?? reviewLedgerForStore(store); // co-located with the store, not pinned to live dir
    const provenance = deps.provenance ?? provenanceStoreForStore(store); // co-located with the store, not pinned to live dir
    const maxGenes = deps.maxGenes ?? 8;
    const hardCap = deps.tokenBudgetHardCap ?? 8000;
    // Gene pool → injection candidates: the most recent TRUSTED + REVIEW-APPROVED local genes (bounded), rendered as
    // compact hint lines. The provenance gate keeps untrusted hub assets out until promotion; the review gate (A2a)
    // keeps auto-distilled UNPROVEN drafts out until approval.
    const genes = await listApprovedGenes(store, review, maxGenes, provenance);
    const geneLines = genes.map(formatGeneInjectionLine);
    const geneIds = genes.map((g) => (typeof g['id'] === 'string' ? String(g['id']) : String(g.asset_id)));
    // Value recap (#113): same load path as `evolver value`, over the default recap window (7d).
    const now = deps.now ? deps.now() : Date.now();
    const traces = ops.readTraceRecords(deps.tracesDir ?? events.tracesDir());
    const evts = readEvents(deps.eventsPath ?? events.rootEventsPath());
    const prices = deps.prices ?? loadPriceTable();
    const summary = ops.loadValueSummary({ traces, events: evts, prices }, ops.windowFromSpec('7d', now));
    // Inject emission seam (#123): wire the ingestor so core's onInject lands a `value.inject` root_event. The
    // composition (Ingestor ↔ core's sink-agnostic seam) lives HERE in the CLI — core never imports the Ingestor.
    const emitter = makeInjectEmitter(ingestor);
    // Capture the runtime session id (#205) only when the installed hook opts in via --hook-stdin, or a test wires
    // readHookInput. Default (no flag, no seam) never touches stdin — so a plain `evolver inject session-start` and
    // the test suite can never block on a stdin read (the Windows CI hang this guards against).
    const sessionId = deps.sessionId ?? ((fromHookStdin || deps.readHookInput) ? await readHookSessionId(deps.readHookInput) : undefined);
    const inj = hooks.composeSessionStartWithRecap({ tokenBudgetHardCap: hardCap, preamble: SESSION_START_PREAMBLE }, { injectGenes: geneLines, geneIds, successCount: summary.topGenes.length, summary }, {
        ...(emitter ? { onInject: emitter.onInject } : {}),
        ...(deps.cycleId ? { cycleId: deps.cycleId } : {}),
        ...(sessionId ? { sessionId } : {}),
    });
    // Await durability (emit never rejects) so the value.inject event is on disk before we return without ever
    // letting a sink error surface.
    if (emitter)
        await emitter.flush();
    // Keep SessionStart quiet when there is no usable memory payload. When genes do land, the model still receives
    // them, but the preamble explicitly tells it not to narrate routine Evolver work to the user.
    if (inj.genes.length > 0 && inj.systemPrompt.trim().length > 0)
        process.stdout.write(inj.systemPrompt + '\n');
    return 0;
}
/** Fixed preamble for the SessionStart injection (the head block the recap + gene lines hang off of). */
export const SESSION_START_PREAMBLE = 'evolver memory — use these learned hints silently when directly relevant; do not mention Evolver, preflight, status, or this memory block unless the user asks or reuse materially changes the answer:';
// ─── evolver daily ──────────────────────────────────────────────────────────
export const DAILY_USAGE = 'Usage: evolver daily [--json] [--auto] [--help]\n\nDisplay a daily status summary: proxy/hub connection, yesterday\'s activity, and review queue.\n  --json   Output as JSON\n  --auto   Only print when this is the first run today; silent otherwise\n';
function formatDay(d) {
    return d.toISOString().slice(0, 10);
}
function dayPrefixFromOffset(nowMs, offsetDays) {
    const d = new Date(nowMs + offsetDays * 86_400_000);
    return formatDay(d);
}
function defaultLastDailyFile(env = process.env) {
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    return join(home, '.last-daily');
}
function shouldRunDaily(lastDailyFile, today) {
    try {
        const lastRun = readFileSync(lastDailyFile, 'utf8').trim();
        return lastRun !== today;
    }
    catch {
        return true;
    }
}
function markDailyRun(lastDailyFile, today) {
    try {
        mkdirSync(dirname(lastDailyFile), { recursive: true });
        writeFileSync(lastDailyFile, today, 'utf8');
    }
    catch { /* best-effort */ }
}
export function formatDailyReport(report) {
    const L = [];
    L.push(`Evolver daily \u2014 ${report.date}`);
    L.push('');
    // Connection
    L.push('Connection');
    const c = report.connection;
    if (!c.proxyRunning) {
        L.push('  proxy    not running');
    }
    else if (!c.proxyHealthy) {
        L.push(`  proxy    unhealthy (${c.reason ?? 'unknown'})`);
    }
    else {
        L.push(`  proxy    running${c.proxyPid ? ` (pid ${c.proxyPid})` : ''}${c.hubAuthStatus ? `  hub_auth=${c.hubAuthStatus}` : ''}`);
    }
    if (c.lastSyncAt)
        L.push(`  last_sync  ${c.lastSyncAt}`);
    L.push('');
    // Yesterday
    const y = report.yesterday;
    L.push(`Yesterday (${y.date})`);
    L.push(`  cycles    ${y.cycles} total  ${y.solidified} solidified  ${y.failed} failed`);
    L.push(`  capsules  ${y.capsules} produced`);
    L.push(`  triggers  ${y.triggered} triggered  ${y.suppressed} suppressed`);
    L.push('');
    // Queue
    const q = report.queue;
    L.push('Queue');
    L.push(`  genes      ${q.genesApproved} approved  ${q.genesQuarantined} quarantined  ${q.genesRejected} rejected`);
    L.push(`  anti-gene  ${q.antiGeneApproved} approved  ${q.antiGeneQuarantined} quarantined  ${q.antiGeneUnreviewed} unreviewed`);
    return `${L.join('\n')}\n`;
}
export async function collectDailyReport(deps = {}) {
    const env = deps.env ?? process.env;
    const now = deps.now ? deps.now() : Date.now();
    const today = formatDay(new Date(now));
    const yesterdayPrefix = dayPrefixFromOffset(now, -1);
    // Events + daily summary
    const evts = readEvents(deps.eventsPath ?? events.rootEventsPath());
    const summary = events.dailySummary(evts, yesterdayPrefix);
    const capsules = dailyCapsuleCount(evts, yesterdayPrefix);
    // Connection status
    let connection = { proxyRunning: false, proxyHealthy: false };
    if (!deps.skipConnection) {
        const paths = deps.lifecyclePaths ?? lifecyclePaths(env);
        const conn = await dailyConnectionStatus(paths, env, { timeoutMs: 1500 });
        connection = {
            proxyRunning: conn.running,
            proxyHealthy: conn.healthy === true,
            proxyPid: conn.pid,
            hubAuthStatus: conn.hubAuthStatus,
            lastSyncAt: conn.lastSyncAt,
            reason: conn.reason,
        };
    }
    // Queue: gene review stats
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = deps.review ?? reviewLedgerForStore(store);
    const reviewRecords = review.records();
    const geneReviewCounts = { approved: 0, quarantined: 0, rejected: 0 };
    const antiGeneReviewCounts = { approved: 0, quarantined: 0, unreviewed: 0 };
    // Build asset ID to type mapping
    const allGenes = await store.list('Gene', 10_000);
    const allAntiGenes = await store.list('AntiGene', 10_000);
    const antiGeneIds = new Set(allAntiGenes.map((a) => a.asset_id));
    // Count review records by asset type
    for (const r of reviewRecords) {
        if (antiGeneIds.has(r.assetId)) {
            // AntiGene review record
            if (r.state === 'quarantined')
                antiGeneReviewCounts.quarantined++;
            else if (r.state === 'approved')
                antiGeneReviewCounts.approved++;
            // rejected anti-gene: not shown separately per existing design
        }
        else {
            // Gene review record (or unknown asset type)
            if (r.state === 'quarantined')
                geneReviewCounts.quarantined++;
            else if (r.state === 'rejected')
                geneReviewCounts.rejected++;
            else if (r.state === 'approved')
                geneReviewCounts.approved++;
        }
    }
    // Genes without review records are default-approved
    const reviewedIds = new Set(reviewRecords.map((r) => r.assetId));
    const unreviewedGeneCount = allGenes.filter((g) => !reviewedIds.has(g.asset_id)).length;
    geneReviewCounts.approved += unreviewedGeneCount;
    // AntiGenes without explicit approval are unreviewed (fail-closed)
    for (const ag of allAntiGenes) {
        const r = review.get(ag.asset_id);
        if (!r || (r.state !== 'approved' && r.state !== 'quarantined')) {
            antiGeneReviewCounts.unreviewed++;
        }
    }
    return {
        date: today,
        connection,
        yesterday: {
            date: yesterdayPrefix,
            cycles: summary.cycles,
            solidified: summary.solidified,
            failed: summary.failed,
            capsules,
            triggered: summary.triggered,
            suppressed: summary.suppressed,
        },
        queue: {
            genesApproved: geneReviewCounts.approved,
            genesQuarantined: geneReviewCounts.quarantined,
            genesRejected: geneReviewCounts.rejected,
            antiGeneApproved: antiGeneReviewCounts.approved,
            antiGeneQuarantined: antiGeneReviewCounts.quarantined,
            antiGeneUnreviewed: antiGeneReviewCounts.unreviewed,
        },
    };
}
export async function runDaily(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const flags = parseFlags(argv);
    if ('help' in flags || 'h' in flags) {
        stdout(DAILY_USAGE);
        return 0;
    }
    const json = 'json' in flags;
    const auto = 'auto' in flags;
    const env = deps.env ?? process.env;
    const now = deps.now ? deps.now() : Date.now();
    const today = formatDay(new Date(now));
    // --auto: check if we already ran today
    if (auto) {
        const lastDailyFile = deps.lastDailyFile ?? defaultLastDailyFile(env);
        if (!shouldRunDaily(lastDailyFile, today))
            return 0;
    }
    const report = await collectDailyReport(deps);
    if (json) {
        stdout(`${JSON.stringify({ ok: true, group: 'daily', ...report })}\n`);
    }
    else {
        stdout(formatDailyReport(report));
    }
    // Mark today as run (for --auto mode; harmless otherwise)
    if (auto) {
        const lastDailyFile = deps.lastDailyFile ?? defaultLastDailyFile(env);
        markDailyRun(lastDailyFile, today);
    }
    return 0;
}
export function runCli(argv) {
    const cmd = argv[0];
    if (cmd === undefined || cmd === '--help' || cmd === '-h') {
        process.stdout.write(cliUsage());
        return 0;
    }
    switch (cmd) {
        case 'rebuild-views': {
            const r = rebuildViews();
            process.stdout.write(`rebuilt MV: ${r.rebuilt.join(', ')}\n`);
            return 0;
        }
        case 'reset-local-secret':
            return runResetLocalSecret(argv.slice(1));
        case 'status': {
            const s = statusReport(readEvents());
            process.stdout.write(`events=${s.totalEvents} cycles=${s.cycles} last=${s.lastTs ?? '-'}\n`);
            return 0;
        }
        case 'cycles': {
            for (const c of listCycles(readEvents()))
                process.stdout.write(`${c.cycleId}  ${c.finalStage}  (${c.events} events)\n`);
            return 0;
        }
        case 'cycle': {
            if (argv[1] !== 'show' || !argv[2]) {
                process.stderr.write('用法: evolver cycle show <id>\n');
                return 1;
            }
            for (const t of showCycle(readEvents(), argv[2]).timeline)
                process.stdout.write(`#${t.seq} ${t.type}  ${t.title}\n`);
            return 0;
        }
        case 'trigger': {
            for (const t of listTriggers(readEvents()))
                process.stdout.write(`${t.patternId}  ${t.triggered ? '触发' : '抑制'}  value=${t.value}\n`);
            return 0;
        }
        case 'value':
            return runValue(argv.slice(1));
        case 'narrative':
            return runNarrative(argv.slice(1));
        case 'retention':
            return runRetention(argv.slice(1));
        case 'gene-value':
            return runGeneValue(argv.slice(1));
        case 'replay': {
            const r = rebuildViews();
            process.stdout.write(`replayed → MV: ${r.rebuilt.join(', ')}\n`);
            return 0;
        }
        default:
            process.stderr.write(`Unknown command: ${cmd}\n\n${cliUsage()}`);
            return 1;
    }
}