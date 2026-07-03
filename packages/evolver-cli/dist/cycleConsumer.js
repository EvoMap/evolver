import { dirname, join, resolve } from 'node:path';
import { assetstore, algo, events, exec, material as materialNs, personality, schema, signals, util } from '@evomap/evolver-core';
import { parseRuntimeSessionSources } from './runtimeSessionSource.js';
import { signalTokens } from './distillPrimitives.js';
import { readEvents, showCycle } from './commands.js';
const CYCLE_GROUP = 'cycle';
const DEFAULT_LIMIT = 5;
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg?.startsWith('--'))
            continue;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out[arg.slice(2)] = next;
            i++;
        }
        else {
            out[arg.slice(2)] = '';
        }
    }
    return out;
}
function parsePositiveInt(value, fallback) {
    if (value === undefined || value.trim() === '')
        return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
function parseRunner(value) {
    return value === 'codex' || value === 'cursor' ? value : 'claude';
}
function resolveMaterialCycleDeps(deps = {}) {
    const materialStore = deps.materialStore ?? new materialNs.MaterialStore({ path: events.materialStorePath() });
    const consumer = deps.consumer ?? new materialNs.ConsumerGroups({
        store: materialStore,
        path: join(dirname(events.materialStorePath()), 'cycle-consumer.json'),
    });
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const assetDir = store instanceof assetstore.LocalJsonlProvider ? store.baseDir : events.assetsDir();
    const provenance = deps.provenance ?? new assetstore.ProvenanceStore(assetDir);
    const review = deps.review ?? new assetstore.ReviewLedger(assetDir);
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    const personalityStore = deps.personality ?? new personality.PersonalityStore();
    const engine = deps.engine ?? new algo.CycleEngine({
        ingestor,
        selection: algo.makeGeneSelectionPoint(),
        store,
        now: () => Date.now(),
        personality: personalityStore,
    });
    return { materialStore, consumer, store, provenance, review, ingestor, engine, personality: personalityStore };
}
export function cycleIdForMaterial(materialId) {
    return `autoexec-material-${materialId}`;
}
function consumedEventExists(rootEvents, materialId) {
    return rootEvents.some((event) => {
        if (event.type !== 'cycle.consumed')
            return false;
        const payload = event.payload;
        return payload?.materialId === materialId;
    });
}
function terminalCycleFor(rootEvents, cycleId) {
    for (const event of rootEvents) {
        if (event.type !== 'cycle.solidified' && event.type !== 'cycle.failed' && event.type !== 'cycle.aborted')
            continue;
        const payload = event.payload;
        if (payload?.cycleId !== cycleId)
            continue;
        if (event.type === 'cycle.solidified')
            return { type: event.type, finalStage: 'solidified' };
        if (event.type === 'cycle.failed')
            return { type: event.type, finalStage: 'failed' };
        return { type: event.type, finalStage: 'aborted' };
    }
    return null;
}
function consumedPayloadFor(rootEvents, materialId) {
    for (const event of rootEvents) {
        if (event.type !== 'cycle.consumed')
            continue;
        const payload = event.payload;
        if (payload?.['materialId'] === materialId)
            return payload;
    }
    return null;
}
function inFlightCycleExists(rootEvents, cycleId) {
    let started = false;
    for (const event of rootEvents) {
        const payload = event.payload;
        if (payload?.cycleId !== cycleId)
            continue;
        if (event.type === 'cycle.solidified' || event.type === 'cycle.failed' || event.type === 'cycle.aborted')
            return false;
        if (event.type === 'cycle.started')
            started = true;
    }
    return started;
}
function failureConsumedPayload(payload) {
    return payload['action'] === 'fail'
        || payload['status'] === 'parse_failed'
        || payload['status'] === 'no_signals'
        || payload['status'] === 'refused'
        || payload['status'] === 'failed';
}
function statusForMaterial(material, rootEvents) {
    const consumed = consumedPayloadFor(rootEvents, material.materialId);
    if (consumed)
        return consumed['action'] === 'observe' || consumed['status'] === 'observed' ? 'observed' : 'consumed';
    const cycleId = cycleIdForMaterial(material.materialId);
    if (terminalCycleFor(rootEvents, cycleId))
        return 'terminal_missing_consumed';
    if (inFlightCycleExists(rootEvents, cycleId))
        return 'in_flight';
    return 'pending';
}
export function cycleLockPathForMaterial(materialStorePath, materialId) {
    const safeId = materialId.replace(/[^A-Za-z0-9_.-]+/g, '_');
    return `${materialStorePath}.cycle-${safeId}.lock`;
}
function tryAcquireCycleLock(lockPath) {
    try {
        util.acquireLock(lockPath, { maxTries: 3, waitMs: 1 });
        return true;
    }
    catch (error) {
        if (error instanceof util.LockTimeoutError)
            return false;
        throw error;
    }
}
function fallbackSignalTokens(sigs) {
    const out = new Set();
    for (const sig of sigs) {
        if (sig.strength === 'agent') {
            const token = sig.text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
            if (token)
                out.add(token);
        }
        else if (sig.strength === 'strong') {
            out.add(sig.kind);
        }
        if (out.size >= 8)
            break;
    }
    return [...out];
}
function materialSignals(material) {
    const sources = parseRuntimeSessionSources(material.sourcePath);
    const sigs = sources.flatMap((source) => signals.extractSignals(source.turns));
    const tokens = signalTokens(sigs);
    return {
        signals: tokens.length > 0 ? tokens : fallbackSignalTokens(sigs),
        sourceCount: sources.length,
    };
}
async function emitConsumed(ingestor, material, item, extra = {}) {
    await ingestor.ingest({
        type: 'cycle.consumed',
        human: {
            title: `material ${material.materialId} ${item.status}`,
            ...(item.reason ? { detail: item.reason } : {}),
            severity: item.action === 'fail' ? 'warn' : 'info',
        },
        payload: {
            materialId: material.materialId,
            sourceKind: material.sourceKind,
            kind: material.kind,
            sourcePath: material.sourcePath,
            action: item.action,
            status: item.status,
            ...(item.cycleId ? { cycleId: item.cycleId } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
            ...extra,
        },
        actor: { kind: 'machine' },
    });
}
function ackOne(consumer, material) {
    consumer.ack(CYCLE_GROUP, [material.materialId]);
}
async function processMaterial(material, opts, deps) {
    const cycleId = cycleIdForMaterial(material.materialId);
    const lockPath = cycleLockPathForMaterial(deps.materialStore.path, material.materialId);
    if (!tryAcquireCycleLock(lockPath)) {
        return {
            materialId: material.materialId,
            action: 'skip',
            status: 'already_running',
            cycleId,
            reason: 'cycle consumer lock is held',
        };
    }
    try {
        const rootEvents = deps.ingestor.readAll();
        if (consumedEventExists(rootEvents, material.materialId)) {
            const item = { materialId: material.materialId, action: 'skip', status: 'already_consumed', cycleId };
            ackOne(deps.consumer, material);
            return item;
        }
        const terminal = terminalCycleFor(rootEvents, cycleId);
        if (terminal) {
            const item = { materialId: material.materialId, action: 'skip', status: 'already_terminal', cycleId };
            await emitConsumed(deps.ingestor, material, item, { terminalEvent: terminal.type, finalStage: terminal.finalStage });
            ackOne(deps.consumer, material);
            return item;
        }
        if (inFlightCycleExists(rootEvents, cycleId)) {
            return {
                materialId: material.materialId,
                action: 'skip',
                status: 'already_running',
                cycleId,
                reason: 'cycle already started without terminal event',
            };
        }
        if (material.sourceKind === 'proxy_trace' || material.kind === 'llm_trace') {
            const item = { materialId: material.materialId, action: 'observe', status: 'observed' };
            await emitConsumed(deps.ingestor, material, item, { reason: 'proxy_trace is observation-only for cycle consumer' });
            ackOne(deps.consumer, material);
            return item;
        }
        let extracted;
        try {
            extracted = materialSignals(material);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const item = { materialId: material.materialId, action: 'fail', status: 'parse_failed', cycleId, reason };
            await emitConsumed(deps.ingestor, material, item);
            ackOne(deps.consumer, material);
            return item;
        }
        if (extracted.sourceCount === 0 || extracted.signals.length === 0) {
            const reason = extracted.sourceCount === 0 ? 'no parseable runtime session source' : 'no cycle-worthy session signals';
            const item = { materialId: material.materialId, action: 'fail', status: 'no_signals', cycleId, reason };
            await emitConsumed(deps.ingestor, material, item, { sourceCount: extracted.sourceCount, signalCount: extracted.signals.length });
            ackOne(deps.consumer, material);
            return item;
        }
        const repo = resolve(opts.repo);
        const task = {
            id: `material-${material.materialId}`,
            repo,
            target: opts.target ?? '.',
            expectedEffect: opts.expectedEffect ?? 'evolve from consumed session material',
            signals: extracted.signals,
        };
        const safety = {
            allowedRoots: [repo],
            runner: opts.runner ?? 'claude',
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...opts.safety,
        };
        const verdict = await exec.runAutoExecTask({
            engine: deps.engine,
            store: deps.store,
            provenance: deps.provenance,
            review: deps.review,
            personality: deps.personality,
            ...(opts.agent ? { agent: opts.agent } : {}),
            ...(opts.git ? { git: opts.git } : {}),
        }, task, safety);
        const item = {
            materialId: material.materialId,
            action: 'cycle',
            status: verdict.status,
            cycleId,
            ...(verdict.reason ? { reason: verdict.reason } : {}),
        };
        await emitConsumed(deps.ingestor, material, item, {
            finalStage: verdict.finalStage,
            signalCount: extracted.signals.length,
            signals: extracted.signals,
        });
        ackOne(deps.consumer, material);
        return item;
    }
    finally {
        util.releaseLock(lockPath);
    }
}
export async function runMaterialCycleConsumer(opts, injectedDeps = {}) {
    const deps = resolveMaterialCycleDeps(injectedDeps);
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const claimed = deps.consumer.claim(CYCLE_GROUP, limit);
    const items = [];
    for (const material of claimed) {
        items.push(await processMaterial(material, opts, deps));
    }
    return { claimed: claimed.length, processed: items.length, items };
}
async function recoverMaterialCycleAudit(material, deps) {
    const cycleId = cycleIdForMaterial(material.materialId);
    const lockPath = cycleLockPathForMaterial(deps.materialStore.path, material.materialId);
    if (!tryAcquireCycleLock(lockPath)) {
        return {
            materialId: material.materialId,
            action: 'skip',
            status: 'already_running',
            cycleId,
            reason: 'cycle consumer lock is held',
        };
    }
    try {
        const rootEvents = deps.ingestor.readAll();
        if (consumedEventExists(rootEvents, material.materialId)) {
            const item = { materialId: material.materialId, action: 'skip', status: 'already_consumed', cycleId };
            ackOne(deps.consumer, material);
            return item;
        }
        const terminal = terminalCycleFor(rootEvents, cycleId);
        if (terminal) {
            const item = { materialId: material.materialId, action: 'skip', status: 'already_terminal', cycleId };
            await emitConsumed(deps.ingestor, material, item, { terminalEvent: terminal.type, finalStage: terminal.finalStage });
            ackOne(deps.consumer, material);
            return item;
        }
        if (inFlightCycleExists(rootEvents, cycleId)) {
            return {
                materialId: material.materialId,
                action: 'skip',
                status: 'already_running',
                cycleId,
                reason: 'cycle already started without terminal event',
            };
        }
        return {
            materialId: material.materialId,
            action: 'skip',
            status: 'pending',
            cycleId,
            reason: 'cycle has not reached a terminal event',
        };
    }
    finally {
        util.releaseLock(lockPath);
    }
}
async function recoverMaterialCycleConsumer(opts = {}, injectedDeps = {}) {
    const deps = resolveMaterialCycleDeps(injectedDeps);
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const claimed = deps.consumer.claim(CYCLE_GROUP, limit);
    const items = [];
    for (const material of claimed) {
        items.push(await recoverMaterialCycleAudit(material, deps));
    }
    const recovered = items.filter((item) => item.status === 'already_terminal').length;
    const alreadyConsumed = items.filter((item) => item.status === 'already_consumed').length;
    return {
        ok: true,
        group: CYCLE_GROUP,
        claimed: claimed.length,
        recovered,
        alreadyConsumed,
        blocked: claimed.length - recovered - alreadyConsumed,
        items,
    };
}
function summarizeCycleConsumer(injectedDeps = {}) {
    const deps = resolveMaterialCycleDeps(injectedDeps);
    const rootEvents = deps.ingestor.readAll();
    const materials = deps.materialStore.readAll();
    const cursor = deps.consumer.position(CYCLE_GROUP);
    let pending = 0;
    let consumed = 0;
    let inFlight = 0;
    let failed = 0;
    let observed = 0;
    let recoverable = 0;
    let recoverLimit = null;
    const next = [];
    materials.forEach((material, index) => {
        const status = statusForMaterial(material, rootEvents);
        const consumedPayload = consumedPayloadFor(rootEvents, material.materialId);
        if (status === 'consumed' || status === 'observed')
            consumed += 1;
        if (status === 'observed')
            observed += 1;
        if (consumedPayload && failureConsumedPayload(consumedPayload))
            failed += 1;
        if (status === 'in_flight')
            inFlight += 1;
        if (status === 'pending' || status === 'terminal_missing_consumed')
            pending += 1;
        if (status === 'terminal_missing_consumed') {
            recoverable += 1;
            if (index >= cursor && recoverLimit === null)
                recoverLimit = index - cursor + 1;
        }
        if (index >= cursor && next.length < 5 && status !== 'consumed' && status !== 'observed') {
            next.push({
                materialId: material.materialId,
                sourceKind: material.sourceKind,
                kind: material.kind,
                capturedAt: material.capturedAt,
                status,
            });
        }
    });
    return {
        ok: true,
        group: CYCLE_GROUP,
        total: materials.length,
        cursor,
        pending,
        consumed,
        inFlight,
        failed,
        observed,
        recoverable,
        recoverLimit,
        next,
    };
}
function printResult(result) {
    if (result.claimed === 0) {
        process.stdout.write('cycle: no pending material\n');
        return;
    }
    for (const item of result.items) {
        const cycle = item.cycleId ? ` cycle=${item.cycleId}` : '';
        const reason = item.reason ? ' reason=details-redacted' : '';
        process.stdout.write(`cycle: material=${item.materialId} action=${item.action} status=${item.status}${cycle}${reason}\n`);
    }
}
function printStatus(summary) {
    process.stdout.write(`cycle status: group=${summary.group} total=${summary.total} cursor=${summary.cursor} pending=${summary.pending} consumed=${summary.consumed} inFlight=${summary.inFlight} failed=${summary.failed} observed=${summary.observed} recoverable=${summary.recoverable}\n`);
    if (summary.next.length === 0) {
        process.stdout.write('  next: none\n');
    }
    else {
        process.stdout.write('  next:\n');
        for (const item of summary.next) {
            process.stdout.write(`    ${item.materialId} sourceKind=${item.sourceKind} kind=${item.kind} capturedAt=${item.capturedAt} status=${item.status}\n`);
        }
    }
    if (summary.recoverLimit !== null) {
        process.stdout.write(`  recovery: run \`evolver cycle recover --limit ${summary.recoverLimit}\` to emit missing cycle.consumed without running an agent\n`);
    }
    else if (summary.recoverable > 0) {
        process.stdout.write('  recovery: terminal_missing_consumed exists before the current cursor; inspect cursor/root events before resetting\n');
    }
    if (summary.inFlight > 0) {
        process.stdout.write('  note: in_flight material is left untouched until a terminal cycle event appears\n');
    }
}
function printRecoverResult(result) {
    process.stdout.write(`cycle recover: group=${result.group} claimed=${result.claimed} recovered=${result.recovered} alreadyConsumed=${result.alreadyConsumed} blocked=${result.blocked}\n`);
    if (result.claimed === 0) {
        process.stdout.write('  items: none\n');
        return;
    }
    for (const item of result.items) {
        const cycle = item.cycleId ? ` cycle=${item.cycleId}` : '';
        const reason = item.reason ? ' reason=details-redacted' : '';
        process.stdout.write(`  material=${item.materialId} action=${item.action} status=${item.status}${cycle}${reason}\n`);
    }
}
function hasFailedItem(item) {
    return item.action === 'fail'
        || item.status === 'refused'
        || item.status === 'failed'
        || item.status === 'already_running';
}
function materialCycleExitCode(result) {
    return result.items.some(hasFailedItem) ? 1 : 0;
}
export async function runCycleCommand(argv, injectedDeps = {}) {
    if (argv[0] === 'show') {
        if (!argv[1]) {
            process.stderr.write('usage: evolver cycle show <id>\n');
            return 1;
        }
        for (const t of showCycle(readEvents(), argv[1]).timeline)
            process.stdout.write(`#${t.seq} ${t.type}  ${t.title}\n`);
        return 0;
    }
    if (argv[0] === 'status') {
        const flags = parseFlags(argv.slice(1));
        const summary = summarizeCycleConsumer(injectedDeps);
        if ('json' in flags)
            process.stdout.write(`${JSON.stringify(summary)}\n`);
        else
            printStatus(summary);
        return 0;
    }
    if (argv[0] === 'recover') {
        const flags = parseFlags(argv.slice(1));
        const result = await recoverMaterialCycleConsumer({
            limit: parsePositiveInt(flags['limit'], DEFAULT_LIMIT),
        }, injectedDeps);
        if ('json' in flags)
            process.stdout.write(`${JSON.stringify(result)}\n`);
        else
            printRecoverResult(result);
        return 0;
    }
    const flags = parseFlags(argv);
    const repo = flags['repo'];
    if (!repo) {
        process.stderr.write('usage: evolver cycle show <id> | evolver cycle status [--json] | evolver cycle recover [--limit N] [--json] | evolver cycle --repo <path> [--limit N] [--target <path>] [--expected-effect <text>] [--runner claude|codex|cursor]\n');
        return 1;
    }
    const result = await runMaterialCycleConsumer({
        repo,
        limit: parsePositiveInt(flags['limit'], DEFAULT_LIMIT),
        target: flags['target'] || '.',
        expectedEffect: flags['expected-effect'] || 'evolve from consumed session material',
        runner: parseRunner(flags['runner']),
    }, injectedDeps);
    printResult(result);
    return materialCycleExitCode(result);
}