import { accessSync, constants, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { assetstore, algo, events, exec, material as materialNs, personality, schema, signals, util, verify } from '@evomap/evolver-core';
import { materialHasRuntimeSessionSnapshot, materialSourceAvailable, runtimeSessionSourcesForMaterial } from './materialSnapshot.js';
import { signalTokens } from './distillPrimitives.js';
import { readEvents, showCycle } from './commands.js';
import { RUNTIME_CAPABILITY_MATRIX, runtimeCapabilities } from './runtimeCapabilities.js';
import { LocalMemoryGraph, resolveLocalMemoryUserIdentity } from './localMemoryGraph.js';
const CYCLE_GROUP = 'cycle';
const DEFAULT_LIMIT = 5;
const DEFAULT_WATCH_IDLE_MS = 1000;
const DEFAULT_WATCH_MAX_IDLE_MS = 30_000;
const DEFAULT_WATCH_BACKOFF = 2;
const CYCLE_USAGE = 'usage: evolver cycle capabilities [--json] | evolver cycle show <id> | evolver cycle status [--json] | evolver cycle recover [--limit N] [--json] | evolver cycle watch --repo <path> [--idle-ms N] [--max-idle N] [--state-file <path>] [--validation-cmd <cmd>] [--timeout-ms N] [--json] | evolver cycle --repo <path> [--limit N] [--target <path>] [--expected-effect <text>] [--runner claude|codex|cursor|gemini] [--validation-cmd <cmd>] [--timeout-ms N]\n';
const WATCH_USAGE = 'usage: evolver cycle watch --repo <path> [--limit N] [--idle-ms N] [--max-idle-ms N] [--max-idle N] [--max-iterations N] [--state-file <path>] [--target <path>] [--expected-effect <text>] [--runner claude|codex|cursor|gemini] [--validation-cmd <cmd>] [--timeout-ms N] [--json]\n';
class CycleWatchStateWriteError extends Error {
    constructor() {
        super('cycle watch state file write failed');
        this.name = 'CycleWatchStateWriteError';
    }
}
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
function parseRepeatedFlag(argv, name) {
    const values = [];
    const flag = `--${name}`;
    const flagEquals = `${flag}=`;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg?.startsWith(flagEquals)) {
            const value = arg.slice(flagEquals.length);
            if (value.trim() === '')
                return null;
            values.push(value);
            continue;
        }
        if (arg !== flag)
            continue;
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--') || value.trim() === '')
            return null;
        values.push(value);
        i++;
    }
    return values;
}
function makeCycleValidationHook(validationCmds, fallback, runSandboxedValidation = verify.runSandboxedValidation) {
    if (validationCmds.length === 0)
        return fallback;
    let warnedNoIsolation = false;
    return (task) => {
        const fallbackHook = fallback?.(task);
        return async (mutation, decision, cwd) => {
            const fallbackResult = fallbackHook ? await fallbackHook(mutation, decision, cwd) : null;
            if (fallbackResult && !fallbackResult.passed)
                return fallbackResult;
            const result = await runSandboxedValidation(task.validationCmds ?? validationCmds, cwd);
            if (!result.isolated && !warnedNoIsolation) {
                warnedNoIsolation = true;
                process.stdout.write('  warning: validation runs WITHOUT network/FS isolation on this platform; non-namespace hardening still applies.\n');
            }
            return { passed: result.passed, score: result.score };
        };
    };
}
function parsePositiveInt(value, fallback) {
    if (value === undefined || value.trim() === '')
        return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
function parseRequiredPositiveIntFlag(flags, name) {
    if (!(name in flags))
        return undefined;
    const value = flags[name] ?? '';
    if (value.trim() === '')
        return null;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}
function parseRunner(value) {
    if (value === undefined || value === 'claude')
        return { ok: true, runner: 'claude' };
    if (value.trim() === '')
        return { ok: false, error: 'runner value is required (supported: claude, codex, cursor, gemini)' };
    if (value === 'codex' || value === 'cursor' || value === 'gemini')
        return { ok: true, runner: value };
    if (value === 'antigravity' || value === 'kimi' || value === 'kiro' || value === 'opencode') {
        const capability = RUNTIME_CAPABILITY_MATRIX[value].execute;
        return { ok: false, error: `runner '${value}' execute capability is ${capability.status}: ${capability.evidence}` };
    }
    return { ok: false, error: `unknown runner '${value}' (supported: claude, codex, cursor, gemini)` };
}
function resolveMaterialRunner(material, requestedRunner) {
    const sourceAgent = material.sourceAgent;
    let runner;
    switch (sourceAgent) {
        case 'claude-code':
            runner = 'claude';
            break;
        case 'codex':
        case 'cursor':
        case 'gemini':
            runner = sourceAgent;
            break;
        case 'antigravity':
        case 'kimi': {
            const capability = RUNTIME_CAPABILITY_MATRIX[sourceAgent].execute;
            return {
                ok: false,
                error: `sourceAgent '${sourceAgent}' execute capability is ${capability.status}: ${capability.evidence}`,
            };
        }
        case 'kiro':
        case 'opencode':
        case 'generic-chat':
            return { ok: false, error: `sourceAgent '${sourceAgent}' has no supported cycle runner` };
        default:
            return { ok: false, error: 'runtime_session material has no supported sourceAgent' };
    }
    if (requestedRunner !== undefined && requestedRunner !== runner) {
        return {
            ok: false,
            error: `explicit runner '${requestedRunner}' does not match sourceAgent '${sourceAgent}' runner '${runner}'`,
        };
    }
    return { ok: true, runner };
}
function printRuntimeCapabilities() {
    for (const entry of runtimeCapabilities()) {
        const values = ['ingest', 'inject', 'execute', 'verify', 'resume']
            .map((capability) => `${capability}=${entry[capability].status}`)
            .join(' ');
        process.stdout.write(`${entry.runtime}: ${values}\n`);
    }
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
    const memoryGraphDir = join(events.evomapHome(), 'evolution');
    const memoryGraph = deps.memoryGraph ?? new LocalMemoryGraph({
        dir: memoryGraphDir,
        ...resolveLocalMemoryUserIdentity(memoryGraphDir),
    });
    const engine = deps.engine ?? new algo.CycleEngine({
        ingestor,
        selection: algo.makeGeneSelectionPoint(),
        store,
        now: () => Date.now(),
        personality: personalityStore,
    });
    return { materialStore, consumer, store, provenance, review, ingestor, engine, personality: personalityStore, memoryGraph };
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
    const sources = runtimeSessionSourcesForMaterial(material);
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
        const runner = resolveMaterialRunner(material, opts.runner);
        if (!runner.ok) {
            const item = {
                materialId: material.materialId,
                action: 'fail',
                status: 'refused',
                cycleId,
                reason: runner.error,
            };
            await emitConsumed(deps.ingestor, material, item);
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
            ...(opts.validationCmds ? { validationCmds: opts.validationCmds } : {}),
        };
        const safety = {
            allowedRoots: [repo],
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...opts.safety,
            runner: runner.runner,
            ...(opts.signal ? { signal: opts.signal } : {}),
        };
        const verdict = await exec.runAutoExecTask({
            engine: deps.engine,
            store: deps.store,
            provenance: deps.provenance,
            review: deps.review,
            personality: deps.personality,
            memoryGraph: deps.memoryGraph,
            ...(opts.validate ? { validate: opts.validate } : {}),
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
            runner: runner.runner,
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
        if (opts.signal?.aborted)
            break;
        items.push(await processMaterial(material, opts, deps));
    }
    return { claimed: claimed.length, processed: items.length, items };
}
function defaultSleep(ms, signal) {
    return new Promise((resolveSleep) => {
        if (signal?.aborted) {
            resolveSleep();
            return;
        }
        const timer = setTimeout(finish, ms);
        function finish() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolveSleep();
        }
        signal?.addEventListener('abort', finish, { once: true });
    });
}
function watchResult(deps, stopped, counters) {
    return {
        ok: true,
        group: 'cycle.watch',
        ...counters,
        cursor: deps.consumer.position(CYCLE_GROUP),
        stopped,
    };
}
function positiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function hasCycleWatchProgress(result, cursorBefore, cursorAfter) {
    if (cursorAfter > cursorBefore)
        return true;
    return result.items.some((item) => (item.action === 'cycle'
        || item.action === 'observe'
        || item.action === 'fail'
        || item.status === 'already_terminal'));
}
function watchFailedItemCount(items) {
    return items.filter((item) => item.action === 'fail' || item.status === 'refused' || item.status === 'failed').length;
}
export async function runMaterialCycleWatch(opts, injectedDeps = {}, hooks = {}) {
    const deps = resolveMaterialCycleDeps(injectedDeps);
    const sleep = injectedDeps.sleep ?? defaultSleep;
    const idleBase = Math.floor(positiveNumber(opts.idleMs, DEFAULT_WATCH_IDLE_MS));
    const idleMax = Math.floor(Math.max(idleBase, positiveNumber(opts.maxIdleMs, DEFAULT_WATCH_MAX_IDLE_MS)));
    const backoff = Math.max(1, positiveNumber(opts.backoffMultiplier, DEFAULT_WATCH_BACKOFF));
    const maxIdle = opts.maxIdle !== undefined && opts.maxIdle > 0 ? Math.floor(opts.maxIdle) : undefined;
    const maxIterations = opts.maxIterations !== undefined && opts.maxIterations > 0 ? Math.floor(opts.maxIterations) : undefined;
    let nextDelayMs = idleBase;
    let iterations = 0;
    let idleIterations = 0;
    let totalClaimed = 0;
    let totalProcessed = 0;
    let totalFailedItems = 0;
    for (;;) {
        if (opts.signal?.aborted) {
            return watchResult(deps, 'cancelled', {
                iterations,
                claimed: totalClaimed,
                processed: totalProcessed,
                idleIterations,
                failedItems: totalFailedItems,
            });
        }
        iterations += 1;
        const cursorBefore = deps.consumer.position(CYCLE_GROUP);
        const result = await runMaterialCycleConsumer(opts, deps);
        const cursorAfter = deps.consumer.position(CYCLE_GROUP);
        const progress = hasCycleWatchProgress(result, cursorBefore, cursorAfter);
        const idle = !progress;
        const iteration = {
            ok: true,
            group: 'cycle.watch',
            iteration: iterations,
            claimed: result.claimed,
            processed: result.processed,
            cursor: cursorAfter,
            idle,
            nextDelayMs: idle ? nextDelayMs : 0,
            items: result.items,
        };
        totalClaimed += result.claimed;
        totalProcessed += result.processed;
        totalFailedItems += watchFailedItemCount(result.items);
        hooks.onIteration?.(iteration);
        if (idle)
            idleIterations += 1;
        else {
            idleIterations = 0;
            nextDelayMs = idleBase;
        }
        const stopped = opts.signal?.aborted
            ? 'cancelled'
            : maxIterations !== undefined && iterations >= maxIterations
                ? 'max_iterations'
                : maxIdle !== undefined && idleIterations >= maxIdle
                    ? 'max_idle'
                    : null;
        if (stopped) {
            return watchResult(deps, stopped, {
                iterations,
                claimed: totalClaimed,
                processed: totalProcessed,
                idleIterations,
                failedItems: totalFailedItems,
            });
        }
        if (idle) {
            await sleep(nextDelayMs, opts.signal);
            nextDelayMs = Math.min(idleMax, Math.max(idleBase, Math.ceil(nextDelayMs * backoff)));
        }
    }
}
function createProcessCancellation() {
    const controller = new AbortController();
    let code = 1;
    const interrupt = () => { code = 130; controller.abort(); };
    const terminate = () => { code = 143; controller.abort(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    return {
        signal: controller.signal,
        exitCode: () => code,
        dispose: () => {
            process.removeListener('SIGINT', interrupt);
            process.removeListener('SIGTERM', terminate);
        },
    };
}
function combineSignals(primary, secondary) {
    return secondary ? AbortSignal.any([primary, secondary]) : primary;
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
            const sourceAvailable = materialSourceAvailable(material);
            const hasSnapshot = materialHasRuntimeSessionSnapshot(material);
            next.push({
                materialId: material.materialId,
                sourceKind: material.sourceKind,
                kind: material.kind,
                capturedAt: material.capturedAt,
                status,
                sourceAvailable,
                hasSnapshot,
                recoverable: material.sourceKind === 'runtime_session' && (sourceAvailable || hasSnapshot),
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
function printWatchIteration(iteration) {
    process.stdout.write(`cycle watch: iteration=${iteration.iteration} claimed=${iteration.claimed} processed=${iteration.processed} cursor=${iteration.cursor} idle=${iteration.idle} nextDelayMs=${iteration.nextDelayMs}\n`);
    for (const item of iteration.items) {
        const cycle = item.cycleId ? ` cycle=${item.cycleId}` : '';
        const reason = item.reason ? ' reason=details-redacted' : '';
        process.stdout.write(`  material=${item.materialId} action=${item.action} status=${item.status}${cycle}${reason}\n`);
    }
}
function printWatchResult(result) {
    process.stdout.write(`cycle watch stopped: reason=${result.stopped} iterations=${result.iterations} claimed=${result.claimed} processed=${result.processed} idleIterations=${result.idleIterations} failedItems=${result.failedItems} cursor=${result.cursor}\n`);
}
function redactedCycleItem(item) {
    return item.reason ? { ...item, reason: 'details-redacted' } : item;
}
function redactedWatchIteration(iteration) {
    return { ...iteration, items: iteration.items.map(redactedCycleItem) };
}
function prepareWatchStateFile(path) {
    const trimmed = path?.trim();
    if (!trimmed)
        return null;
    try {
        const stat = lstatSync(trimmed);
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        accessSync(trimmed, constants.W_OK);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            return null;
    }
    try {
        mkdirSync(dirname(trimmed), { recursive: true, mode: 0o700 });
        return probeWatchStateFile(trimmed) ? trimmed : null;
    }
    catch {
        return null;
    }
}
function writeWatchStateFile(path, state) {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
}
function probeWatchStateFile(path) {
    const dir = dirname(path);
    const base = basename(path);
    const probe = join(dir, `.${base}.${process.pid}.probe`);
    const renamed = `${probe}.renamed`;
    try {
        writeFileSync(probe, '', { encoding: 'utf8', mode: 0o600 });
        renameSync(probe, renamed);
        unlinkSync(renamed);
        return true;
    }
    catch {
        try {
            unlinkSync(probe);
        }
        catch { /* best effort */ }
        try {
            unlinkSync(renamed);
        }
        catch { /* best effort */ }
        return false;
    }
}
function tryWriteWatchStateFile(path, state, writer = writeWatchStateFile) {
    try {
        writer(path, state);
        return true;
    }
    catch {
        return false;
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
    if (argv[0] === 'capabilities') {
        const flags = parseFlags(argv.slice(1));
        if ('json' in flags)
            process.stdout.write(`${JSON.stringify(runtimeCapabilities())}\n`);
        else
            printRuntimeCapabilities();
        return 0;
    }
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
    if (argv[0] === 'watch') {
        const flags = parseFlags(argv.slice(1));
        const runner = parseRunner(flags['runner']);
        if (!runner.ok) {
            process.stderr.write(`${runner.error}\n`);
            return 1;
        }
        const validationCmds = parseRepeatedFlag(argv.slice(1), 'validation-cmd');
        const repo = flags['repo'];
        if (!repo) {
            process.stderr.write(WATCH_USAGE);
            return 1;
        }
        if (validationCmds === null) {
            process.stderr.write(WATCH_USAGE);
            return 1;
        }
        const validate = makeCycleValidationHook(validationCmds, injectedDeps.validate, injectedDeps.runSandboxedValidation);
        const maxIdle = parseRequiredPositiveIntFlag(flags, 'max-idle');
        const maxIterations = parseRequiredPositiveIntFlag(flags, 'max-iterations');
        const timeoutMs = parseRequiredPositiveIntFlag(flags, 'timeout-ms');
        if (maxIdle === null || maxIterations === null || timeoutMs === null) {
            process.stderr.write(WATCH_USAGE);
            return 1;
        }
        const stateFile = prepareWatchStateFile(flags['state-file']);
        if ('state-file' in flags && !stateFile) {
            process.stderr.write(WATCH_USAGE);
            return 1;
        }
        const json = 'json' in flags;
        let stateClaimed = 0;
        let stateProcessed = 0;
        let stateIdleIterations = 0;
        let stateFailedItems = 0;
        let lastIteration;
        const writeState = injectedDeps.watchStateWriter ?? writeWatchStateFile;
        const cancellation = createProcessCancellation();
        const signal = combineSignals(cancellation.signal, injectedDeps.safety?.signal);
        let result;
        try {
            result = await runMaterialCycleWatch({
                repo,
                limit: parsePositiveInt(flags['limit'], DEFAULT_LIMIT),
                target: flags['target'] || '.',
                expectedEffect: flags['expected-effect'] || 'evolve from consumed session material',
                ...('runner' in flags ? { runner: runner.runner } : {}),
                signal,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(validationCmds.length > 0 ? { validationCmds } : {}),
                ...(validate ? { validate } : {}),
                safety: { ...injectedDeps.safety, signal },
                ...(injectedDeps.agent ? { agent: injectedDeps.agent } : {}),
                ...(injectedDeps.git ? { git: injectedDeps.git } : {}),
                idleMs: parsePositiveInt(flags['idle-ms'], DEFAULT_WATCH_IDLE_MS),
                maxIdleMs: parsePositiveInt(flags['max-idle-ms'], DEFAULT_WATCH_MAX_IDLE_MS),
                ...(maxIdle !== undefined ? { maxIdle } : {}),
                ...(maxIterations !== undefined ? { maxIterations } : {}),
            }, injectedDeps, {
                onIteration: (iteration) => {
                    const safeIteration = redactedWatchIteration(iteration);
                    if (json)
                        process.stdout.write(`${JSON.stringify(safeIteration)}\n`);
                    else
                        printWatchIteration(iteration);
                    stateClaimed += iteration.claimed;
                    stateProcessed += iteration.processed;
                    stateFailedItems += watchFailedItemCount(iteration.items);
                    stateIdleIterations = iteration.idle ? stateIdleIterations + 1 : 0;
                    lastIteration = safeIteration;
                    if (stateFile && !tryWriteWatchStateFile(stateFile, {
                        ok: true,
                        group: 'cycle.watch.state',
                        updatedAt: new Date().toISOString(),
                        running: true,
                        iteration: iteration.iteration,
                        cursor: iteration.cursor,
                        claimed: stateClaimed,
                        processed: stateProcessed,
                        idleIterations: stateIdleIterations,
                        failedItems: stateFailedItems,
                        lastIteration: safeIteration,
                    }, writeState)) {
                        throw new CycleWatchStateWriteError();
                    }
                },
            });
        }
        catch (error) {
            if (!(error instanceof CycleWatchStateWriteError))
                throw error;
            if (stateFile) {
                tryWriteWatchStateFile(stateFile, {
                    ok: true,
                    group: 'cycle.watch.state',
                    updatedAt: new Date().toISOString(),
                    running: false,
                    iteration: lastIteration?.iteration ?? 0,
                    cursor: lastIteration?.cursor ?? 0,
                    claimed: stateClaimed,
                    processed: stateProcessed,
                    idleIterations: stateIdleIterations,
                    failedItems: stateFailedItems,
                    ...(lastIteration ? { lastIteration } : {}),
                    stopped: 'state_write_failed',
                }, writeState);
            }
            process.stderr.write('cycle watch failed: state_write_failed\n');
            return 1;
        }
        finally {
            cancellation.dispose();
        }
        const finalState = {
            ok: true,
            group: 'cycle.watch.state',
            updatedAt: new Date().toISOString(),
            running: false,
            iteration: result.iterations,
            cursor: result.cursor,
            claimed: result.claimed,
            processed: result.processed,
            idleIterations: result.idleIterations,
            failedItems: result.failedItems,
            ...(lastIteration ? { lastIteration } : {}),
            stopped: result.stopped,
        };
        if (stateFile && !tryWriteWatchStateFile(stateFile, finalState, writeState)) {
            tryWriteWatchStateFile(stateFile, {
                ...finalState,
                updatedAt: new Date().toISOString(),
                stopped: 'state_write_failed',
            }, writeState);
            process.stderr.write('cycle watch failed: state_write_failed\n');
            return 1;
        }
        if (json)
            process.stdout.write(`${JSON.stringify(result)}\n`);
        else
            printWatchResult(result);
        return result.stopped === 'cancelled' ? cancellation.exitCode() : 0;
    }
    const flags = parseFlags(argv);
    const runner = parseRunner(flags['runner']);
    if (!runner.ok) {
        process.stderr.write(`${runner.error}\n`);
        return 1;
    }
    const validationCmds = parseRepeatedFlag(argv, 'validation-cmd');
    const repo = flags['repo'];
    if (!repo) {
        process.stderr.write(CYCLE_USAGE);
        return 1;
    }
    if (validationCmds === null) {
        process.stderr.write(CYCLE_USAGE);
        return 1;
    }
    const timeoutMs = parseRequiredPositiveIntFlag(flags, 'timeout-ms');
    if (timeoutMs === null) {
        process.stderr.write(CYCLE_USAGE);
        return 1;
    }
    const validate = makeCycleValidationHook(validationCmds, injectedDeps.validate, injectedDeps.runSandboxedValidation);
    const cancellation = createProcessCancellation();
    const signal = combineSignals(cancellation.signal, injectedDeps.safety?.signal);
    let result;
    try {
        result = await runMaterialCycleConsumer({
            repo,
            limit: parsePositiveInt(flags['limit'], DEFAULT_LIMIT),
            target: flags['target'] || '.',
            expectedEffect: flags['expected-effect'] || 'evolve from consumed session material',
            ...('runner' in flags ? { runner: runner.runner } : {}),
            signal,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(validationCmds.length > 0 ? { validationCmds } : {}),
            ...(validate ? { validate } : {}),
            safety: { ...injectedDeps.safety, signal },
            ...(injectedDeps.agent ? { agent: injectedDeps.agent } : {}),
            ...(injectedDeps.git ? { git: injectedDeps.git } : {}),
        }, injectedDeps);
    }
    finally {
        cancellation.dispose();
    }
    printResult(result);
    return signal.aborted ? cancellation.exitCode() : materialCycleExitCode(result);
}