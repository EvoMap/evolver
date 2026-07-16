import { existsSync } from 'node:fs';
import { hub, schema } from '@evomap/evolver-core';
import { parseRuntimeSessionSources } from './runtimeSessionSource.js';
export const MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA = 'evolver.material.runtime_session_snapshot.v1';
const DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS = 24 * 1024;
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function trimText(value, remaining) {
    if (remaining <= 0)
        return { text: '', used: 0, truncated: value.length > 0 };
    const redacted = hub.redactString(value).replace(/\s+/g, ' ').trim();
    if (redacted.length <= remaining)
        return { text: redacted, used: redacted.length, truncated: false };
    return { text: redacted.slice(0, remaining), used: remaining, truncated: true };
}
function snapshotTurnText(turn) {
    return turn.text || turn.errorMessage || turn.toolResult || '';
}
function fitsInline(snapshot) {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= schema.MATERIAL_PAYLOAD_INLINE_MAX_BYTES;
}
export function buildRuntimeSessionMaterialSnapshot(sources, maxChars = DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS) {
    const safeMaxChars = Math.max(0, Math.min(maxChars, DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS));
    let remaining = safeMaxChars;
    let truncated = false;
    const snapshotSources = [];
    for (const source of sources) {
        const turns = [];
        for (const turn of source.turns) {
            const rawText = snapshotTurnText(turn);
            const trimmed = trimText(rawText, remaining);
            remaining -= trimmed.used;
            truncated = truncated || trimmed.truncated;
            if (trimmed.text.length > 0) {
                turns.push({
                    role: turn.role,
                    text: trimmed.text,
                    ...(turn.isMeta ? { isMeta: true } : {}),
                    ...(turn.toolName ? { toolName: hub.redactString(turn.toolName).slice(0, 120) } : {}),
                    ...(turn.errorMessage && trimmed.text ? { errorMessage: trimmed.text } : {}),
                });
            }
            if (remaining <= 0) {
                truncated = true;
                break;
            }
        }
        snapshotSources.push({
            agent: source.agent,
            label: source.label,
            ...(source.sessionId ? { sessionId: source.sessionId } : {}),
            turns,
        });
        if (remaining <= 0)
            break;
    }
    const snapshot = {
        schema: MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA,
        sourceKind: 'runtime_session',
        kind: 'session_log',
        sources: snapshotSources,
        truncated,
        maxChars: safeMaxChars,
    };
    while (!fitsInline(snapshot) && snapshot.sources.length > 0) {
        const lastSource = snapshot.sources[snapshot.sources.length - 1];
        if (lastSource.turns.length > 0)
            lastSource.turns.pop();
        else
            snapshot.sources.pop();
        snapshot.truncated = true;
    }
    return snapshot;
}
function sourceFromSnapshot(value) {
    if (!isRecord(value))
        return null;
    const agent = typeof value['agent'] === 'string' ? value['agent'] : '';
    const label = typeof value['label'] === 'string' ? value['label'] : '';
    const turnsRaw = Array.isArray(value['turns']) ? value['turns'] : [];
    if (!agent || !label)
        return null;
    const turns = turnsRaw
        .map((turn) => {
        if (!isRecord(turn))
            return null;
        const role = turn['role'];
        const text = turn['text'];
        if ((role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') || typeof text !== 'string')
            return null;
        const toolName = typeof turn['toolName'] === 'string' && turn['toolName'].trim() ? turn['toolName'] : undefined;
        const errorMessage = typeof turn['errorMessage'] === 'string' && turn['errorMessage'].trim() ? turn['errorMessage'] : undefined;
        return {
            role,
            text,
            isMeta: turn['isMeta'] === true,
            ...(toolName ? { toolName } : {}),
            ...(errorMessage ? { errorMessage } : {}),
        };
    })
        .filter((turn) => turn !== null);
    if (turns.length === 0)
        return null;
    const sessionId = typeof value['sessionId'] === 'string' && value['sessionId'].trim() ? value['sessionId'] : undefined;
    return {
        agent,
        label,
        ...(sessionId ? { sessionId } : {}),
        turns,
    };
}
export function runtimeSessionSourcesFromMaterialPayload(payload) {
    if (!isRecord(payload))
        return [];
    if (payload['schema'] !== MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA)
        return [];
    if (payload['sourceKind'] !== 'runtime_session' || payload['kind'] !== 'session_log')
        return [];
    const sources = Array.isArray(payload['sources']) ? payload['sources'] : [];
    return sources
        .map(sourceFromSnapshot)
        .filter((source) => source !== null);
}
export function materialHasRuntimeSessionSnapshot(material) {
    return runtimeSessionSourcesFromMaterialPayload(material.payload).length > 0;
}
export function materialSourceAvailable(material) {
    return existsSync(material.sourcePath);
}
export function runtimeSessionSourcesForMaterial(material, readSource) {
    let sourceError;
    try {
        const sources = parseRuntimeSessionSources(material.sourcePath, readSource);
        const sourcesWithTurns = sources.filter((source) => source.turns.length > 0);
        if (sourcesWithTurns.length > 0)
            return sourcesWithTurns;
    }
    catch (error) {
        sourceError = error;
    }
    const snapshotSources = runtimeSessionSourcesFromMaterialPayload(material.payload);
    if (snapshotSources.length > 0)
        return snapshotSources;
    if (sourceError)
        throw sourceError;
    return [];
}