import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { events, material as materialNs, signals } from '@evomap/evolver-core';
import { isCursorStateVscdbPath } from '@evomap/evolver-runtime-adapters';
import { emitSessionRecall } from './autoRecall.js';
import { buildRuntimeSessionMaterialSnapshot } from './materialSnapshot.js';
import { isRuntimeSessionSourcePath, parseRuntimeSessionSourcesWithDiagnostics, } from './runtimeSessionSource.js';
/** Material consumer group shared by ingestion and the downstream cycle consumer. */
export const INGEST_CONSUMER_GROUP = 'cycle';
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
/** Record all new or changed runtime sessions as material for the auto-distill loop. */
export async function runSessionIngestTick(dirs, deps = {}) {
    const resolvedDeps = resolveIngestDeps(deps);
    let recorded = 0;
    const sourceAgents = new Set();
    const signalKinds = new Set();
    const signalStrengths = new Set();
    let invalidJsonRows = 0;
    let parseFailures = 0;
    const autoRecallOn = process.env['EVOLVER_AUTO_RECALL'] === '1';
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
            const parsedSources = parsed.sources;
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
            if (autoRecallOn && parsedSources.length === 1 && !parsedSources[0].sessionId) {
                const turns = parsedSources[0].turns
                    .filter((turn) => !turn.isMeta)
                    .map((turn) => ({ role: turn.role, text: turn.text }));
                await emitSessionRecall(file, turns, { ingestor: resolvedDeps.ingestor });
            }
        }
        catch {
            // Individual session files are best-effort and must not stop the daemon scan.
        }
    }
    return {
        recorded,
        sourceAgents: sortedStrings(sourceAgents),
        signalKinds: sortedStrings(signalKinds),
        signalStrengths: sortedStrings(signalStrengths),
        ...(invalidJsonRows > 0 ? { invalidJsonRows } : {}),
        ...(parseFailures > 0 ? { parseFailures } : {}),
    };
}