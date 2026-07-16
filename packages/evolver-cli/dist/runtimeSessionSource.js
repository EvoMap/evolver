import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adapterForPath, isCursorStateVscdbPath, parseJsonlLinesWithStats, parseCursorStateVscdb, stripUtf8Bom, } from '@evomap/evolver-runtime-adapters';
const EMPTY_DIAGNOSTICS = { rowsScanned: 0, rowsRead: 0, invalidJson: 0 };
export function isRuntimeSessionSourcePath(path) {
    return isCursorStateVscdbPath(path) || adapterForPath(path) !== undefined;
}
function cursorSourceFromSession(session, index) {
    if (session.turns.length === 0)
        return null;
    const sessionId = session.sessionId?.trim();
    return {
        agent: 'cursor',
        label: sessionId ? `cursor-vscdb:${sessionId}` : `cursor-vscdb:${index + 1}`,
        ...(sessionId ? { sessionId } : {}),
        turns: session.turns,
    };
}
function diagnosticsForRuntimeSource(raw) {
    const trimmed = stripUtf8Bom(raw).trim();
    if (!trimmed)
        return { ...EMPTY_DIAGNOSTICS };
    try {
        JSON.parse(trimmed);
        return { rowsScanned: 1, rowsRead: 1, invalidJson: 0 };
    }
    catch {
        return parseJsonlLinesWithStats(raw).stats;
    }
}
export function parseRuntimeSessionSourcesWithDiagnostics(path, readSource = (p) => readFileSync(p, 'utf8')) {
    const absPath = resolve(path);
    if (isCursorStateVscdbPath(absPath)) {
        const sources = parseCursorStateVscdb(absPath)
            .map(cursorSourceFromSession)
            .filter((source) => source !== null);
        return { sources, diagnostics: { ...EMPTY_DIAGNOSTICS } };
    }
    const adapter = adapterForPath(absPath);
    if (!adapter)
        return { sources: [], diagnostics: { ...EMPTY_DIAGNOSTICS } };
    const raw = readSource(absPath);
    const sessionId = adapter.sessionIdFromPath?.(absPath)?.trim();
    return {
        sources: [{
                agent: adapter.agent,
                label: sessionId ? `${adapter.agent}:${sessionId}` : adapter.agent,
                ...(sessionId ? { sessionId } : {}),
                turns: adapter.parse(raw),
            }],
        diagnostics: diagnosticsForRuntimeSource(raw),
    };
}
export function parseRuntimeSessionSources(path, readSource = (p) => readFileSync(p, 'utf8')) {
    return parseRuntimeSessionSourcesWithDiagnostics(path, readSource).sources;
}