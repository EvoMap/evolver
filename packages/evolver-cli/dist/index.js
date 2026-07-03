import { events, ops, hooks, mailbox } from '@evomap/evolver-core';
import { readEvents, statusReport, listCycles, showCycle, listTriggers, buildNarrativeSnapshot, buildRetentionReport } from './commands.js';
import { runGeneValue } from './geneValue.js';
import { assetstore, algo, signals, material as materialNs } from '@evomap/evolver-core';
import { loadPriceTable } from '@evomap/evolver-adapter-public';
import { makeInjectEmitter } from './autoexec.js';
import { listApprovedGenes, provenanceStoreForStore, reviewLedgerForStore } from './reviewFilter.js';
import { ADAPTERS, parseJsonlLines } from '@evomap/evolver-runtime-adapters';
import { draftGeneCandidate } from './distillPrimitives.js';
import { emitSessionRecall } from './autoRecall.js';
import { isRuntimeSessionSourcePath, parseRuntimeSessionSources } from './runtimeSessionSource.js';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { importV1 } from './migrate/v1Import.js';
import { explicitRecipeHomes } from './recipe.js';
import { maybeAutoRestartProxyForSessionStart, sessionStartHookVerboseEnabled } from './lifecycle.js';
/**
 * Material consumer group for ingest: the cycle is the downstream that claims material → signals. Kept in
 * one place so the recorded Material and any future cycle consumer agree on the group name.
 */
const INGEST_CONSUMER_GROUP = 'cycle';
function resolveIngestDeps(deps) {
    return {
        materialStore: deps.materialStore ?? new materialNs.MaterialStore({ path: events.materialStorePath() }),
        watermarkStore: deps.watermarkStore ?? new materialNs.WatermarkStore(events.materialWatermarkPath()),
        ingestor: deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() }),
    };
}
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
/** migrate import-v1 <v1dir> [outDir]: v1→v2 只读迁移(异步, 由 cli.ts 调). */
export async function runMigrate(argv) {
    if (argv[0] !== 'import-v1' || !argv[1]) {
        process.stderr.write('用法: evolver migrate import-v1 <v1dir> [outDir]\n');
        return 1;
    }
    const outDir = argv[2] ?? process.cwd();
    const store = new assetstore.LocalJsonlProvider(`${outDir}/assets`);
    const rep = await importV1(argv[1], store, outDir);
    process.stdout.write(`迁移完成: Gene=${rep.imported.Gene} Capsule=${rep.imported.Capsule} Event=${rep.imported.EvolutionEvent} (冻结${rep.frozen}/新算${rep.recomputed}/去重${rep.deduped}); sidecar=${rep.sidecarExtensions}; memory_graph 归档=${rep.memoryGraphArchived}\n`);
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
/** asset-log [Gene|Capsule|EvolutionEvent|AntiGene] [limit]: list recent local assets (observability; ported v1 CLI verb). */
export async function runAssetLog(argv, store) {
    const KINDS = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
    let kind;
    let limit = 20;
    for (const a of argv) {
        if (KINDS.includes(a))
            kind = a;
        else if (/^\d+$/.test(a))
            limit = Number(a);
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
/**
 * distill: gate a learned approach into the gene pool (ported v1 CLI verb). Runs the structural intake
 * (schema + dedup + asset_id) and, only if it passes, writes the gene to the store. The agent/runtime is
 * what discovers the strategy; this is the manual entry point that turns it into a pooled, selectable gene.
 * Usage: evolver distill --category <c> --signals <s1,s2> --strategy "<step1; step2>" [--summary <text>] [--id <id>]
 */
export async function runDistill(argv, store, deps = {}) {
    const f = parseFlags(argv);
    const candidate = {
        ...(f['id'] ? { id: f['id'] } : {}),
        category: f['category'] ?? 'innovate',
        signals_match: splitList(f['signals'], /,/),
        strategy: splitList(f['strategy'], /[;\n]/),
        ...(f['summary'] ? { summary: f['summary'] } : {}),
    };
    if (candidate.signals_match.length === 0 || candidate.strategy.length === 0) {
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
    await s.put(r.gene);
    // AE (#91 item 1): a manual distill IS a human teaching the system a gene — record it on the audit spine.
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    await ingestor.ingest({
        type: 'actor.human.teach',
        payload: { geneId: r.gene.id, assetId: r.gene.asset_id, category: r.gene.category },
        human: { title: `teach gene ${r.gene.id}`, severity: 'info' },
        actor: { kind: 'human', id: operatorActorId() },
    });
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
/** The runtime agents Material.sourceAgent can represent (closed enum on the schema). */
const MATERIAL_SOURCE_AGENTS = new Set(['claude-code', 'codex', 'cursor', 'gemini', 'kimi', 'kiro', 'opencode', 'generic-chat']);
/** Narrow an adapter's free-string agent to the Material source enum (undefined → not recordable). */
function toMaterialSourceAgent(agent) {
    return MATERIAL_SOURCE_AGENTS.has(agent) ? agent : undefined;
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
 * Record a session log as Material on the M1 substrate (idempotent by file watermark), then emit a
 * `material.batch_ready` root_event so the AE is not bypassed. Re-ingesting the same UNCHANGED file records
 * no new material and emits no event (scanFile reports `changed: false` against the persisted cursor).
 * Returns whether new material landed + its materialId so the caller can report it.
 */
async function recordSessionMaterial(sourceAgent, absPath, signalCount, d, recordCount = 1) {
    const prev = d.watermarkStore.get(absPath);
    const scan = materialNs.scanFile(absPath, prev);
    // Unchanged source already recorded once → idempotent skip (no duplicate material, no duplicate event).
    if (prev && !scan.changed)
        return { recorded: false };
    const m = materialNs.buildMaterial({
        sourceAgent,
        sourceKind: 'runtime_session',
        sourcePath: absPath,
        kind: 'session_log',
        watermark: scan.watermark,
        consumerGroup: INGEST_CONSUMER_GROUP,
    });
    // Crash-retry idempotency (#100): if a prior run already put this file's material but threw before the
    // watermark advanced, don't append a duplicate row — reuse it and only (re-)emit the lost event below.
    const isNew = !materialExistsFor(d.materialStore, absPath, scan.watermark);
    if (isNew)
        await d.materialStore.put(m);
    await d.ingestor.ingest({
        type: 'material.batch_ready',
        payload: { source: absPath, recordCount, signalCount },
        human: { title: `material 已落地: ${sourceAgent} session`, severity: 'info' },
        actor: { kind: 'machine' },
    });
    // Watermark LAST — only after BOTH the put and its batch_ready event succeed. If ingest throws, the watermark
    // stays unset so a re-run re-emits the event; the content check above keeps that retry from duplicating the row.
    d.watermarkStore.set(absPath, scan.watermark);
    return { recorded: isNew, materialId: m.materialId };
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
 * Recursively enumerate recognized runtime-session sources under the given dirs — the daemon's auto-distill
 * producer source (#106). This includes text session files handled by runtime adapters (`*.jsonl` and Gemini
 * `*.json`) plus Cursor's sqlite `state.vscdb`. A missing/permission-denied dir is silently skipped (a daemon
 * must not crash on an absent home dir).
 */
export function scanSessionDirs(dirs) {
    const out = [];
    for (const dir of dirs) {
        let entries;
        try {
            entries = readdirSync(resolve(dir), { recursive: true });
        }
        catch {
            continue;
        } // dir absent / unreadable → skip
        for (const e of entries) {
            const file = join(resolve(dir), e);
            if (isRuntimeSessionSourcePath(file))
                out.push(file);
        }
    }
    return out;
}
function sortedStrings(values) {
    return [...new Set([...values].map(String).filter(Boolean))].sort();
}
/**
 * One producer tick for the auto-distill loop (#106 slice 1): scan `dirs` for session logs and record any
 * NEW/CHANGED file as `runtime_session` Material via the injected (bus) Ingestor — which emits
 * `material.batch_ready`, the event the distillObserver claims off. Idempotent per file (watermark cursor), so
 * re-scanning an unchanged tree records nothing. Pure producer: it does NOT distill (the observer does). Returns
 * how many files landed new material. Inject `deps.ingestor = new Ingestor({ sink: bus })` so the event reaches
 * the daemon's ObserverBus; defaults to live paths otherwise.
 */
export async function runSessionIngestTick(dirs, deps = {}) {
    const d = resolveIngestDeps(deps);
    let recorded = 0;
    const sourceAgents = new Set();
    const signalKinds = new Set();
    const signalStrengths = new Set();
    // #274 auto-recall (default OFF): observe which injected genes were actually used, from the transcript, so the
    // experience loop is fed by observation instead of a self-reported tool call agents skip. Best-effort + idempotent
    // (one value.recall set per session); off → zero extra work. auto-OBSERVE only — it never quarantines.
    const autoRecallOn = process.env['EVOLVER_AUTO_RECALL'] === '1';
    for (const file of scanSessionDirs(dirs)) {
        try {
            const parsedSources = parseRuntimeSessionSources(file);
            const agent = parsedSources[0] ? toMaterialSourceAgent(parsedSources[0].agent) : undefined;
            if (parsedSources.length === 0 || !agent)
                continue; // not a recognized, schema-recordable runtime-session source
            const sigsBySource = parsedSources.map((source) => signals.extractSignals(source.turns));
            const r = await recordSessionMaterial(agent, file, sigsBySource.reduce((sum, sigs) => sum + sigs.length, 0), d, parsedSources.length);
            if (r.recorded) {
                recorded += 1;
                sourceAgents.add(agent);
                for (const sigs of sigsBySource) {
                    for (const sig of sigs) {
                        signalKinds.add(sig.kind);
                        signalStrengths.add(sig.strength);
                    }
                }
            }
            if (autoRecallOn && parsedSources.length === 1 && !parsedSources[0].sessionId) {
                // Drop meta turns (heartbeats/empty) before judging, same as `evolver recall` — counting them would skew overlap.
                const turns = parsedSources[0].turns.filter((t) => !t.isMeta).map((t) => ({ role: t.role, text: t.text }));
                await emitSessionRecall(file, turns, { ingestor: d.ingestor });
            }
        }
        catch { /* unreadable / unparseable file → skip, never break the scan */ }
    }
    return {
        recorded,
        sourceAgents: sortedStrings(sourceAgents),
        signalKinds: sortedStrings(signalKinds),
        signalStrengths: sortedStrings(signalStrengths),
    };
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
    try {
        parsedSources = parseRuntimeSessionSources(path);
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
        const r = await recordSessionMaterial(sourceAgent, resolve(path), signalCount, d, parsedSources.length);
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
    let existing = (await s.list('Gene', 1000)).map((g) => ({
        id: typeof g['id'] === 'string' ? String(g['id']) : undefined,
        signals_match: Array.isArray(g['signals_match']) ? g['signals_match'] : [],
    }));
    for (const { source, sigs } of sourceSignalPairs) {
        const candidate = draftGeneCandidate(source.turns, sigs, source.agent);
        if (!candidate)
            continue;
        const r = algo.intakeGene(candidate, existing);
        if (!r.ok || !r.gene) {
            process.stderr.write(`\ningest --distill rejected: ${r.errors.join('; ')}\n`);
            return 1;
        }
        accepted.push({ source, candidate, gene: r.gene });
        existing = [...existing, { id: r.gene.id, signals_match: r.gene.signals_match }];
    }
    if (accepted.length === 0) {
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
function countField(value) {
    return Array.isArray(value) ? String(value.length) : '0';
}
function numberField(value) {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}
function antiGeneReviewLine(asset, rev) {
    const assetId = String(asset.asset_id);
    const id = optionalStringField(asset['id']) ?? assetId;
    const state = rev.get(assetId)?.state ?? 'approved';
    const severity = optionalStringField(asset['severity']) ?? '-';
    const trigger = stringArrayField(asset['trigger']).slice(0, 6).join(',') || '-';
    const avoid = stringArrayField(asset['avoid']).slice(0, 2).join(' | ') || '-';
    const evidence = `failures=${numberField(asset['failure_count'])} clusters=${countField(asset['source_clusters'])} evidence=${countField(asset['evidence_capsules'])}`;
    const next = state === 'quarantined'
        ? `next: evolver review --approve ${id} <reason> | evolver review --reject ${id} <reason>`
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
    const counts = { approved: 0, quarantined: 0, rejected: 0 };
    for (const asset of antiGenes) {
        const state = rev.get(String(asset.asset_id))?.state ?? 'approved';
        counts[state] += 1;
    }
    process.stdout.write(`anti-gene review queue: ${antiGenes.length} AntiGene asset(s); approved=${counts.approved} quarantined=${counts.quarantined} rejected=${counts.rejected}\n`);
    for (const asset of antiGenes)
        process.stdout.write(`${antiGeneReviewLine(asset, rev)}\n`);
    return 0;
}
/**
 * review: curate the gene pool. Default is a read-only listing (derived learning view + the review-state of each
 * gene); `--approve`/`--reject <id>` is the audited human act that lifts an auto-distilled draft out of (or
 * confirms it out of) quarantine. Approval is what lets a distilled gene's strategy be embedded into a real run
 * (the gate lives in makeTrustedGeneResolver, #45+review). The id may be a logical id or an asset_id.
 * Usage: evolver review [limit] | evolver review --approve <id> [reason…] | evolver review --reject <id> [reason…]
 */
export async function runReview(argv, store, review, deps = {}) {
    const s = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    // Co-locate the review sidecar with the resolved store (an injected store reads/writes its OWN review.jsonl).
    const reviewDir = s instanceof assetstore.LocalJsonlProvider ? s.baseDir : events.assetsDir();
    const rev = review ?? new assetstore.ReviewLedger(reviewDir);
    // Audited approve/reject: resolve the gene (by logical id or asset_id) to its asset_id and record the act.
    const verb = argv.includes('--approve') ? 'approve' : argv.includes('--reject') ? 'reject' : null;
    if (verb) {
        const flagIdx = argv.indexOf(verb === 'approve' ? '--approve' : '--reject');
        const target = argv[flagIdx + 1];
        if (!target || target.startsWith('--')) {
            process.stderr.write(`用法: evolver review --${verb} <id> [reason…]\n`);
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
        const by = operatorActorId();
        const reason = argv.slice(flagIdx + 2).filter((a) => !a.startsWith('--')).join(' ') || `${verb}d via CLI`;
        if (verb === 'approve')
            rev.approve(assetId, by, reason);
        else
            rev.reject(assetId, by, reason);
        const { ingestor } = resolveIngestDeps(deps);
        await ingestor.ingest({
            type: verb === 'approve' ? 'actor.human.review.approve' : 'actor.human.review.reject',
            payload: { geneId, assetId, assetType, reason },
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
export function formatRetentionReport(report) {
    const lines = [
        `retention: mode=${report.mode} prune=${report.destructivePruneSupported ? 'enabled' : 'disabled'} generatedAt=${report.generatedAt}`,
        `  root_events: state=${report.rootEvents.state} records=${report.rootEvents.records} bytes=${report.rootEvents.bytes} invalid=${report.rootEvents.invalidLines} firstSeq=${report.rootEvents.firstSeq ?? '-'} lastSeq=${report.rootEvents.lastSeq ?? '-'} protectTail=${report.rootEvents.protectTailEvents}`,
        `  material: state=${report.material.state} records=${report.material.records} bytes=${report.material.bytes} invalid=${report.material.invalidLines} cursor=${report.material.cursor} effectiveCursor=${report.material.effectiveCursor} cursorValid=${report.material.cursorValid} cursorInRange=${report.material.cursorInRange} consumedPrefix=${report.material.consumedPrefix} pending=${report.material.pending}`,
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
    const f = parseFlags(argv);
    const report = buildRetentionReport({
        rootEventsPath: deps.rootEventsPath,
        materialStorePath: deps.materialStorePath,
        materialCursorPath: deps.materialCursorPath,
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
    if (sub !== 'session-start') {
        process.stderr.write('用法: evolver inject session-start\n');
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
export function runCli(argv) {
    const cmd = argv[0];
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
            process.stderr.write('用法: evolver [--version|-v] <status|cycles|cycle show <id>|cycle status [--json]|cycle recover [--limit N] [--json]|trigger|value [--window 7d|30d|all]|narrative [--limit N] [--json]|retention [--json]|trajectory-export [--input <trace-file-or-dir>] [--output <jsonl>]|gene-value [--gene <id>] [--json]|inject session-start|lifecycle <start|stop|restart|status|check|watch|install-service>|phub <init|doctor|status>|replay|rebuild-views|reset-local-secret|asset-log [kind] [limit]|distill ...|review [limit]|recipe build|reuse ...|publish ...|skill-distill --skill <path> [--execution <json|@file>]|skill-md-update --gene <id> --skill <path> [--dry-run]|autoexec [home]|setup-hooks [--runtime] [--root] [--uninstall]|buy|orders|verify|atp|recall <transcript> (--gene <id> ...|--from-inject)>\n');
            return cmd === undefined ? 0 : 1;
    }
}