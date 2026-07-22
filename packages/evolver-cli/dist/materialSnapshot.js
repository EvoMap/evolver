import { existsSync } from 'node:fs';
import { hub, schema } from '@evomap/evolver-core';
import { summarizeSessionEvidence, } from '@evomap/evolver-runtime-adapters';
import { parseRuntimeSessionSources } from './runtimeSessionSource.js';
export const MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA = 'evolver.material.runtime_session_snapshot.v1';
const DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS = 24 * 1024;
const SNAPSHOT_AGENT_MAX_CHARS = 64;
const SNAPSHOT_IDENTITY_MAX_CHARS = 256;
const SNAPSHOT_SOURCE_MAX_COUNT = 32;
const SNAPSHOT_TURN_MAX_COUNT = 256;
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
function snapshotIdentity(value, maxChars) {
    return hub.redactString(value).replace(/\s+/g, ' ').trim().slice(0, maxChars);
}
function appendEvidenceAggregate(aggregate, summary) {
    const coverageCounts = aggregate
        ? { ...aggregate.coverageCounts }
        : { complete: 0, partial: 0, empty: 0 };
    coverageCounts[summary.coverage] += 1;
    const counts = {};
    for (const key of EVIDENCE_COUNT_KEYS) {
        counts[key] = (aggregate?.counts[key] ?? 0) + summary.counts[key];
    }
    const gapCodes = [];
    if (coverageCounts.empty > 0)
        gapCodes.push('empty_session');
    if (counts.missingToolResults > 0)
        gapCodes.push('missing_tool_result');
    if (counts.unmatchedToolResults > 0)
        gapCodes.push('unmatched_tool_result');
    return {
        sourceCount: (aggregate?.sourceCount ?? 0) + 1,
        coverageCounts,
        counts,
        gapCodes,
    };
}
const EVIDENCE_COUNT_KEYS = [
    'nonMetaTurns',
    'toolCalls',
    'toolResults',
    'matchedToolResults',
    'missingToolResults',
    'unmatchedToolResults',
    'failedToolResults',
];
const EVIDENCE_GAP_CODES = new Set([
    'empty_session',
    'missing_tool_result',
    'unmatched_tool_result',
]);
function evidenceSummaryFromSnapshot(value) {
    if (!isRecord(value) || !isRecord(value['counts']) || !Array.isArray(value['gapCodes']))
        return null;
    const coverage = value['coverage'];
    if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'empty')
        return null;
    const counts = {};
    for (const key of EVIDENCE_COUNT_KEYS) {
        const count = value['counts'][key];
        if (!Number.isSafeInteger(count) || count < 0)
            return null;
        counts[key] = count;
    }
    const gapCodes = value['gapCodes'];
    if (!gapCodes.every((gap) => (typeof gap === 'string' && EVIDENCE_GAP_CODES.has(gap))))
        return null;
    if (new Set(gapCodes).size !== gapCodes.length
        || counts.toolCalls + counts.toolResults > counts.nonMetaTurns
        || counts.matchedToolResults > counts.toolCalls
        || counts.matchedToolResults > counts.toolResults
        || counts.missingToolResults !== counts.toolCalls - counts.matchedToolResults
        || counts.unmatchedToolResults !== counts.toolResults - counts.matchedToolResults
        || counts.failedToolResults > counts.toolResults)
        return null;
    const expectedGaps = [];
    if (counts.nonMetaTurns === 0)
        expectedGaps.push('empty_session');
    else {
        if (counts.missingToolResults > 0)
            expectedGaps.push('missing_tool_result');
        if (counts.unmatchedToolResults > 0)
            expectedGaps.push('unmatched_tool_result');
    }
    const expectedCoverage = counts.nonMetaTurns === 0
        ? 'empty'
        : expectedGaps.length > 0 ? 'partial' : 'complete';
    if (coverage !== expectedCoverage
        || gapCodes.length !== expectedGaps.length
        || gapCodes.some((gap, index) => gap !== expectedGaps[index]))
        return null;
    return { coverage, counts, gapCodes: [...gapCodes] };
}
function evidenceAggregateFromSnapshot(value) {
    if (!isRecord(value)
        || !Number.isSafeInteger(value['sourceCount'])
        || value['sourceCount'] <= 0
        || !isRecord(value['coverageCounts'])
        || !isRecord(value['counts'])
        || !Array.isArray(value['gapCodes']))
        return null;
    const sourceCount = value['sourceCount'];
    const coverageCounts = {};
    for (const coverage of ['complete', 'partial', 'empty']) {
        const count = value['coverageCounts'][coverage];
        if (!Number.isSafeInteger(count) || count < 0)
            return null;
        coverageCounts[coverage] = count;
    }
    if (coverageCounts.complete + coverageCounts.partial + coverageCounts.empty !== sourceCount)
        return null;
    const counts = {};
    for (const key of EVIDENCE_COUNT_KEYS) {
        const count = value['counts'][key];
        if (!Number.isSafeInteger(count) || count < 0)
            return null;
        counts[key] = count;
    }
    const gapCodes = value['gapCodes'];
    if (!gapCodes.every((gap) => (typeof gap === 'string' && EVIDENCE_GAP_CODES.has(gap))) || new Set(gapCodes).size !== gapCodes.length
        || counts.toolCalls + counts.toolResults > counts.nonMetaTurns
        || counts.matchedToolResults > counts.toolCalls
        || counts.matchedToolResults > counts.toolResults
        || counts.missingToolResults !== counts.toolCalls - counts.matchedToolResults
        || counts.unmatchedToolResults !== counts.toolResults - counts.matchedToolResults
        || counts.failedToolResults > counts.toolResults)
        return null;
    const nonEmptySourceCount = coverageCounts.complete + coverageCounts.partial;
    const structuralGapCount = counts.missingToolResults + counts.unmatchedToolResults;
    if (counts.nonMetaTurns < nonEmptySourceCount
        || (coverageCounts.empty === sourceCount && counts.nonMetaTurns !== 0)
        || (coverageCounts.partial > 0) !== (structuralGapCount > 0)
        || structuralGapCount < coverageCounts.partial)
        return null;
    const expectedGaps = [];
    if (coverageCounts.empty > 0)
        expectedGaps.push('empty_session');
    if (counts.missingToolResults > 0)
        expectedGaps.push('missing_tool_result');
    if (counts.unmatchedToolResults > 0)
        expectedGaps.push('unmatched_tool_result');
    if (gapCodes.length !== expectedGaps.length
        || gapCodes.some((gap, index) => gap !== expectedGaps[index]))
        return null;
    return { sourceCount, coverageCounts, counts, gapCodes: [...gapCodes] };
}
export function buildRuntimeSessionMaterialSnapshot(sources, maxChars = DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS) {
    const safeMaxChars = Number.isFinite(maxChars)
        ? Math.max(0, Math.min(Math.trunc(maxChars), DEFAULT_MATERIAL_SNAPSHOT_MAX_CHARS))
        : 0;
    let remaining = safeMaxChars;
    let truncated = false;
    let retainedTurnCount = 0;
    let omittedEvidenceAggregate;
    const snapshotSources = [];
    for (const source of sources) {
        const evidenceSummary = summarizeSessionEvidence({ turns: source.turns });
        if (snapshotSources.length >= SNAPSHOT_SOURCE_MAX_COUNT) {
            omittedEvidenceAggregate = appendEvidenceAggregate(omittedEvidenceAggregate, evidenceSummary);
            truncated = true;
            continue;
        }
        const turns = [];
        for (const turn of source.turns) {
            if (retainedTurnCount >= SNAPSHOT_TURN_MAX_COUNT) {
                truncated = true;
                break;
            }
            const rawText = snapshotTurnText(turn);
            const trimmed = trimText(rawText, remaining);
            remaining -= trimmed.used;
            truncated = truncated || trimmed.truncated;
            if (trimmed.text.length > 0) {
                retainedTurnCount += 1;
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
        const safeSessionId = source.sessionId
            ? snapshotIdentity(source.sessionId, SNAPSHOT_IDENTITY_MAX_CHARS)
            : '';
        snapshotSources.push({
            agent: snapshotIdentity(source.agent, SNAPSHOT_AGENT_MAX_CHARS) || 'unknown',
            label: snapshotIdentity(source.label, SNAPSHOT_IDENTITY_MAX_CHARS) || 'unknown',
            ...(safeSessionId ? { sessionId: safeSessionId } : {}),
            evidenceSummary,
            turns,
        });
    }
    const snapshot = {
        schema: MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA,
        sourceKind: 'runtime_session',
        kind: 'session_log',
        sources: snapshotSources,
        sourceCount: sources.length,
        omittedSourceCount: omittedEvidenceAggregate?.sourceCount ?? 0,
        ...(omittedEvidenceAggregate ? { omittedEvidenceAggregate } : {}),
        truncated: truncated || omittedEvidenceAggregate !== undefined,
        maxChars: safeMaxChars,
    };
    // Source and turn caps make this loop constant-bounded even for very large Cursor databases.
    while (!fitsInline(snapshot) && snapshot.sources.length > 0) {
        let sourceWithTurns = snapshot.sources.length - 1;
        while (sourceWithTurns >= 0 && snapshot.sources[sourceWithTurns]?.turns.length === 0) {
            sourceWithTurns -= 1;
        }
        if (sourceWithTurns >= 0)
            snapshot.sources[sourceWithTurns].turns.pop();
        else {
            const omitted = snapshot.sources.pop();
            snapshot.omittedEvidenceAggregate = appendEvidenceAggregate(snapshot.omittedEvidenceAggregate, omitted.evidenceSummary);
            snapshot.omittedSourceCount += 1;
        }
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
export function runtimeSessionEvidenceSummariesFromMaterialPayload(payload) {
    if (!isRecord(payload))
        return null;
    if (payload['schema'] !== MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA)
        return null;
    if (payload['sourceKind'] !== 'runtime_session' || payload['kind'] !== 'session_log')
        return null;
    const sources = Array.isArray(payload['sources']) ? payload['sources'] : [];
    const hasCountMetadata = payload['sourceCount'] !== undefined || payload['omittedSourceCount'] !== undefined;
    const sourceCount = hasCountMetadata ? payload['sourceCount'] : sources.length;
    const omittedSourceCount = hasCountMetadata ? payload['omittedSourceCount'] : 0;
    if (!Number.isSafeInteger(sourceCount)
        || sourceCount < sources.length
        || !Number.isSafeInteger(omittedSourceCount)
        || omittedSourceCount < 0
        || omittedSourceCount !== sourceCount - sources.length)
        return null;
    const omittedEvidenceAggregate = payload['omittedEvidenceAggregate'] === undefined
        ? undefined
        : evidenceAggregateFromSnapshot(payload['omittedEvidenceAggregate']);
    if (omittedSourceCount > 0) {
        if (!omittedEvidenceAggregate || omittedEvidenceAggregate.sourceCount !== omittedSourceCount)
            return null;
    }
    else if (payload['omittedEvidenceAggregate'] !== undefined)
        return null;
    const summaries = sources.flatMap((source) => {
        if (!isRecord(source)
            || typeof source['agent'] !== 'string'
            || !source['agent'].trim()
            || typeof source['label'] !== 'string'
            || !source['label'].trim())
            return [];
        const summary = evidenceSummaryFromSnapshot(source['evidenceSummary']);
        if (!summary)
            return [];
        const sessionId = typeof source['sessionId'] === 'string' && source['sessionId'].trim()
            ? source['sessionId']
            : undefined;
        return [{
                agent: source['agent'],
                label: source['label'],
                ...(sessionId ? { sessionId } : {}),
                evidenceSummary: summary,
            }];
    });
    if (hasCountMetadata && summaries.length !== sources.length)
        return null;
    return {
        sourceCount: sourceCount,
        omittedSourceCount: omittedSourceCount,
        summaries,
        ...(omittedEvidenceAggregate ? { omittedEvidenceAggregate } : {}),
    };
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