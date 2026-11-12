import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { events, material as materialNs, ops, signals, util } from '@evomap/evolver-core';
import { isCursorStateVscdbPath } from '@evomap/evolver-runtime-adapters';
import { emitSessionRecall } from './autoRecall.js';
import { waitContextDelivery } from './contextDelivery.js';
import { buildRuntimeSessionMaterialSnapshot } from './materialSnapshot.js';
import { isRuntimeSessionSourcePath, parseRuntimeSessionSourcesWithDiagnostics, } from './runtimeSessionSource.js';
const builtInObservationSink = events.Ingestor.isBuiltInObservationSink;
const builtInDeliveryRecovery = events.Ingestor.prototype.recoverContextDeliveries;
/** Wire-form `task_domain:` tokens embedded in session text (case-insensitive match; resolver fail-closes). */
const TASK_DOMAIN_TOKEN_RE = /\btask_domain:[A-Za-z0-9][A-Za-z0-9-]{0,63}\b/gi;
/**
 * Stamp a resolved canonical task domain onto each source when turn/signal text carries exactly one
 * valid `task_domain:` token. Never invents domains; absent/ambiguous/invalid → leave field unset.
 * Additive only — does not mutate parse diagnostics or turn content.
 */
export function stampResolvedTaskDomain(sources) {
    return sources.map((source) => {
        const tokens = [];
        for (const turn of source.turns) {
            const text = `${turn.text ?? ''}\n${turn.errorMessage ?? ''}\n${turn.toolResult ?? ''}`;
            for (const match of text.matchAll(TASK_DOMAIN_TOKEN_RE)) {
                tokens.push(match[0].toLowerCase());
            }
        }
        const resolution = signals.resolveTaskDomainSignals(tokens);
        if (resolution.status !== 'resolved')
            return source;
        if (source.taskDomain === resolution.slug)
            return source;
        return { ...source, taskDomain: resolution.slug };
    });
}
/** Material consumer group shared by ingestion and the downstream cycle consumer. */
export const INGEST_CONSUMER_GROUP = 'cycle';
/** Resolve context ownership before any recovery/index I/O. Physical aliases
 * alone are insufficient: protected audit namespaces retain the exact logical
 * name, so a separately supplied writer must also keep that name unchanged. */
export function resolveContextObservationWriter(ingestor, contextIngestor = ingestor) {
    // Reject structural adapters before reading their path or callback properties.
    if (!builtInObservationSink(contextIngestor))
        return undefined;
    try {
        if (Object.getOwnPropertyDescriptor(contextIngestor, 'recoverContextDeliveries') !== undefined
            || contextIngestor.recoverContextDeliveries !== builtInDeliveryRecovery)
            return undefined;
        const contextPath = contextIngestor.path;
        if (contextPath !== ingestor.path
            || util.canonicalEventPath(contextPath) !== util.canonicalEventPath(ingestor.path))
            return undefined;
        return contextIngestor;
    }
    catch {
        return undefined;
    }
}
async function recoverSessionDeliveries(ingestor) {
    // Legacy injected sinks have no local durable recovery capability to report.
    if (!ingestor.recoverContextDeliveries)
        return undefined;
    const actual = Promise.resolve()
        .then(() => ingestor.recoverContextDeliveries({ deadlineAt: Date.now() + 150 }))
        .then(journal => ({ journal }), () => ({ failed: true }));
    const outcome = await waitContextDelivery(actual, 170);
    // Report the original wait deadline, but do not let a synchronous root writer
    // starve the native cleanup still owned by this exact recovery operation.
    if (!outcome)
        await actual;
    if (!outcome)
        return { status: 'unknown', reason: 'deadline' };
    if ('failed' in outcome || !outcome.journal)
        return { status: 'unknown', reason: 'recovery_failed' };
    const journal = { ...outcome.journal, reasons: { ...outcome.journal.reasons } };
    // Busy includes unavailable/corrupt journals. Unknown output/projection rows
    // remain unknown even when the separate material/index pass succeeds.
    const status = journal.busy !== false || journal.outputUnknown !== 0 || journal.projectionUnknown !== 0
        ? 'unknown' : journal.confirmedPending === 0 ? 'complete' : journal.confirmedPending > 0 ? 'pending' : 'unknown';
    return { status, journal };
}
export function resolveIngestDeps(deps) {
    return {
        materialStore: deps.materialStore ?? new materialNs.MaterialStore({ path: events.materialStorePath() }),
        watermarkStore: deps.watermarkStore ?? new materialNs.WatermarkStore(events.materialWatermarkPath()),
        ingestor: deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() }),
    };
}
const MATERIAL_SOURCE_AGENTS = new Set([
    'claude-code',
    'codex',
    'cursor',
    'gemini',
    'antigravity',
    'kimi',
    'workbuddy',
    'dsh',
    'grok',
    'kiro',
    'opencode',
    'generic-chat',
]);
export function toMaterialSourceAgent(agent) {
    return MATERIAL_SOURCE_AGENTS.has(agent) ? agent : undefined;
}
function materialExistsFor(store, sourcePath, watermark) {
    if (watermark.contentHash === undefined)
        return false;
    for (const material of store.iterate()) {
        if (material.sourcePath === sourcePath
            && material.watermark.size === watermark.size
            && material.watermark.contentHash === watermark.contentHash)
            return true;
    }
    return false;
}
export async function recordSessionMaterial(sourceAgent, absPath, signalCount, deps, recordCount = 1, payload, diagnostics) {
    const previous = deps.watermarkStore.get(absPath);
    const scan = materialNs.scanFile(absPath, previous);
    if (previous && !scan.changed)
        return { recorded: false, emitted: false };
    const material = materialNs.buildMaterial({
        sourceAgent,
        sourceKind: 'runtime_session',
        sourcePath: absPath,
        kind: 'session_log',
        watermark: scan.watermark,
        consumerGroup: INGEST_CONSUMER_GROUP,
        ...(payload ? { payload } : {}),
    });
    const isNew = !materialExistsFor(deps.materialStore, absPath, scan.watermark);
    if (isNew)
        await deps.materialStore.put(material);
    const parseDiagnostics = diagnostics && diagnostics.invalidJson > 0
        ? { rowsScanned: diagnostics.rowsScanned, rowsRead: diagnostics.rowsRead, invalidJson: diagnostics.invalidJson }
        : undefined;
    await deps.ingestor.ingest({
        type: 'material.batch_ready',
        payload: { source: absPath, recordCount, signalCount, ...(parseDiagnostics ? { parseDiagnostics } : {}) },
        human: {
            title: `material 已落地: ${sourceAgent} session`,
            ...(parseDiagnostics ? { detail: `skipped ${parseDiagnostics.invalidJson} invalid JSONL row(s)` } : {}),
            severity: 'info',
        },
        actor: { kind: 'machine' },
    });
    deps.watermarkStore.set(absPath, scan.watermark);
    return { recorded: isNew, emitted: true, materialId: material.materialId };
}
/** Recursively enumerate recognized runtime-session sources, skipping inaccessible directories. */
export function scanSessionDirs(dirs) {
    const out = [];
    for (const dir of dirs) {
        let entries;
        try {
            entries = readdirSync(resolve(dir), { recursive: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const file = join(resolve(dir), entry);
            if (isRuntimeSessionSourcePath(file))
                out.push(file);
        }
    }
    return out;
}
function sortedStrings(values) {
    return [...new Set([...values].map(String).filter(Boolean))].sort();
}
// A completed material/observation write must not be replayed to recover index
// cleanup. Keep the actual tick owner until close succeeds, including across
// later calls for other sessions sharing this event log.
const MAX_SESSION_INGEST_INDEXES = 64;
const ownedSessionIndexes = new Map();
function finishSessionIndexCleanup(path) {
    const owned = ownedSessionIndexes.get(path);
    if (!owned)
        return 'ready';
    if (owned.active)
        return 'busy';
    try {
        owned.index.close();
        ownedSessionIndexes.delete(path);
        return 'ready';
    }
    catch {
        return 'unavailable';
    }
}
/** Record all new or changed runtime sessions as material for the auto-distill loop. */
export async function runSessionIngestTick(dirs, deps = {}) {
    const resolvedDeps = resolveIngestDeps(deps);
    const contextIngestor = resolveContextObservationWriter(resolvedDeps.ingestor, deps.contextIngestor);
    let contextDeliveryRecovery = contextIngestor
        ? await recoverSessionDeliveries(contextIngestor) : undefined;
    if (contextIngestor) {
        // A failed/late protected RPC can outlive its client wait. The existing
        // ordered status RPC joins the service's turn before deciding root admission.
        const journal = contextDeliveryRecovery?.journal ?? events.Ingestor.contextDeliveryStatus(contextIngestor.path);
        // Preserve the admission snapshot without upgrading a late or failed recovery.
        if (contextDeliveryRecovery && contextDeliveryRecovery.journal === undefined) {
            contextDeliveryRecovery = { ...contextDeliveryRecovery, journal };
        }
        if (journal.confirmedPending > 0 || journal.reasons.cleanup_pending)
            return {
                recorded: 0, sourceAgents: [], signalKinds: [], signalStrengths: [],
                ...(contextDeliveryRecovery ? { contextDeliveryRecovery } : {}),
                ...(process.env['EVOLVER_AUTO_RECALL'] === '1' ? { contextObservationIndex: {
                        status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'busy',
                    } } : {}),
            };
    }
    let recorded = 0;
    const sourceAgents = new Set();
    const signalKinds = new Set();
    const signalStrengths = new Set();
    let invalidJsonRows = 0;
    let parseFailures = 0;
    const autoRecallOn = process.env['EVOLVER_AUTO_RECALL'] === '1';
    let contextIndex;
    let ownedContextIndex;
    let contextIndexPath;
    let contextObservationIndex;
    // The legacy lexical rail keeps its historical input, but loads it lazily once per tick, not per session.
    let legacyEvents;
    const readLegacyEvents = () => legacyEvents ??= events.readEvents(contextIngestor.path);
    // The lexical reader is cached only until an observation attempt. A durable
    // intent and the real writer own ambiguous outcomes; the tick must never
    // substitute a wrapper that cannot prove the writer has stopped.
    if (autoRecallOn) {
        if (!contextIngestor) {
            // Material collection may use an injected sink, but product auto-recall
            // must report that its writer cannot prove terminal, durable ownership.
            contextObservationIndex = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'unsupported_sink' };
        }
        else
            try {
                contextIndexPath = util.canonicalEventPath(contextIngestor.path);
                const cleanup = finishSessionIndexCleanup(contextIndexPath);
                if (cleanup === 'ready' && ownedSessionIndexes.size >= MAX_SESSION_INGEST_INDEXES) {
                    // Old logs may never tick again. Retry only their retained cleanup, at
                    // most 64 owners, and stop as soon as one slot is genuinely released.
                    // finishSessionIndexCleanup leaves active and still-failing owners owned.
                    for (const retainedPath of [...ownedSessionIndexes.keys()]) {
                        finishSessionIndexCleanup(retainedPath);
                        if (ownedSessionIndexes.size < MAX_SESSION_INGEST_INDEXES)
                            break;
                    }
                }
                if (cleanup !== 'ready' || ownedSessionIndexes.size >= MAX_SESSION_INGEST_INDEXES) {
                    contextObservationIndex = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0,
                        reason: cleanup === 'busy' ? 'busy' : 'unavailable' };
                }
                else {
                    contextIndex = new ops.GeneContextObservationIndex(contextIndexPath);
                    ownedContextIndex = { index: contextIndex, active: true };
                    ownedSessionIndexes.set(contextIndexPath, ownedContextIndex);
                    contextObservationIndex = contextIndex.beginTick(deps.contextIndexMaxBytes);
                }
            }
            catch {
                // Keep the independently registered cleanup owner, but never dispatch an
                // observation through an index whose tick was not successfully started.
                contextIndex = undefined;
                contextObservationIndex = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'unavailable' };
            }
    }
    try {
        for (const file of scanSessionDirs(dirs)) {
            let parsed;
            try {
                parsed = parseRuntimeSessionSourcesWithDiagnostics(file, undefined, deps.nativeSessionHome);
            }
            catch {
                if (isCursorStateVscdbPath(file))
                    parseFailures += 1;
                continue;
            }
            try {
                const parsedSources = stampResolvedTaskDomain(parsed.sources);
                const agent = parsedSources[0] ? toMaterialSourceAgent(parsedSources[0].agent) : undefined;
                if (parsedSources.length === 0 || !agent)
                    continue;
                const signalsBySource = parsedSources.map((source) => signals.extractSignals(source.turns));
                const snapshot = buildRuntimeSessionMaterialSnapshot(parsedSources);
                const result = await recordSessionMaterial(agent, file, signalsBySource.reduce((sum, sourceSignals) => sum + sourceSignals.length, 0), resolvedDeps, parsedSources.length, snapshot, parsed.diagnostics);
                if (result.emitted)
                    invalidJsonRows += parsed.diagnostics.invalidJson;
                if (result.recorded) {
                    recorded += 1;
                    sourceAgents.add(agent);
                    for (const sourceSignals of signalsBySource) {
                        for (const signal of sourceSignals) {
                            signalKinds.add(signal.kind);
                            signalStrengths.add(signal.strength);
                        }
                    }
                }
                if (autoRecallOn && contextIndex)
                    for (const source of parsedSources) {
                        if (!source.sessionId && parsedSources.length !== 1)
                            continue;
                        const turns = source.turns
                            .filter((turn) => !turn.isMeta)
                            .map((turn) => ({ role: turn.role, text: turn.text }));
                        try {
                            await emitSessionRecall(file, turns, { ingestor: contextIngestor, contextIndex, readEvents: readLegacyEvents,
                                ...(source.sessionId ? { sessionId: source.sessionId, contextOnly: true } : {}) });
                        }
                        finally {
                            // A committed append can precede a later index or journal exception.
                            // The next session must read authoritative history even on failure.
                            legacyEvents = undefined;
                        }
                    }
            }
            catch {
                // Individual session files are best-effort and must not stop the daemon scan.
            }
        }
    }
    finally {
        try {
            if (contextIndex)
                contextObservationIndex = contextIndex.currentProgress;
        }
        catch {
            contextObservationIndex = { status: 'unknown', bytesRead: 0, indexedThroughSeq: 0, reason: 'unavailable' };
        }
        if (ownedContextIndex && contextIndexPath) {
            ownedContextIndex.active = false;
            if (finishSessionIndexCleanup(contextIndexPath) !== 'ready') {
                contextObservationIndex = { ...contextObservationIndex,
                    status: 'unknown', bytesRead: contextObservationIndex?.bytesRead ?? 0,
                    indexedThroughSeq: contextObservationIndex?.indexedThroughSeq ?? 0, reason: 'unavailable' };
            }
        }
    }
    return {
        recorded,
        ...(contextObservationIndex ? { contextObservationIndex } : {}),
        ...(contextDeliveryRecovery ? { contextDeliveryRecovery } : {}),
        sourceAgents: sortedStrings(sourceAgents),
        signalKinds: sortedStrings(signalKinds),
        signalStrengths: sortedStrings(signalStrengths),
        ...(invalidJsonRows > 0 ? { invalidJsonRows } : {}),
        ...(parseFailures > 0 ? { parseFailures } : {}),
    };
}