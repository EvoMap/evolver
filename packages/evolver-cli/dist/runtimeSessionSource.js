import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { adapterForPath, isCursorStateVscdbPath, parseJsonlLinesWithStats, parseCursorStateVscdb, stripUtf8Bom, } from '@evomap/evolver-runtime-adapters';
const EMPTY_DIAGNOSTICS = { rowsScanned: 0, rowsRead: 0, invalidJson: 0 };
function canonicalNativeSessionSource(path, agent, nativeSessionHome) {
    const runtimeRoot = agent === 'claude-code'
        ? join(nativeSessionHome, '.claude', 'projects')
        : agent === 'cursor' ? join(nativeSessionHome, '.cursor', 'projects') : undefined;
    if (!runtimeRoot)
        return path;
    try {
        const canonicalRoot = realpathSync(runtimeRoot);
        const canonicalPath = realpathSync(path);
        const child = relative(canonicalRoot, canonicalPath);
        return child !== '' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
            && child !== '..' && !isAbsolute(child) ? canonicalPath : undefined;
    }
    catch {
        return undefined;
    }
}
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
export function parseRuntimeSessionSourcesWithDiagnostics(path, readSource = (p) => readFileSync(p, 'utf8'), nativeSessionHome = homedir()) {
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
    const canonicalResumeSource = adapter.resumeIdentityFromSource
        ? canonicalNativeSessionSource(absPath, adapter.agent, nativeSessionHome)
        : undefined;
    const raw = readSource(canonicalResumeSource ?? absPath);
    const nativeResumeIdentity = adapter.resumeIdentityFromSource && canonicalResumeSource
        ? adapter.resumeIdentityFromSource(canonicalResumeSource, raw)
        : undefined;
    if (adapter.resumeIdentityFromSource) {
        const sessionId = nativeResumeIdentity?.sessionId.trim();
        return {
            sources: [{
                    agent: adapter.agent,
                    label: sessionId ? `${adapter.agent}:${sessionId}` : adapter.agent,
                    ...(sessionId ? { sessionId } : {}),
                    ...(sessionId ? { resumeIdentityProvenance: 'canonical_native_transcript' } : {}),
                    turns: adapter.parse(raw),
                }],
            diagnostics: diagnosticsForRuntimeSource(raw),
        };
    }
    const pathSessionId = adapter.sessionIdFromPath?.(absPath)?.trim();
    const parsedSessions = adapter.parseSessions?.(raw)
        ?? (adapter.parseSession ? [adapter.parseSession(raw)] : []);
    const sources = parsedSessions.length > 0
        ? parsedSessions.map((session, index) => {
            const sessionId = pathSessionId ?? session.sessionId?.trim();
            return {
                agent: adapter.agent,
                label: sessionId
                    ? `${adapter.agent}:${sessionId}`
                    : parsedSessions.length > 1 ? `${adapter.agent}:${index + 1}` : adapter.agent,
                ...(sessionId ? { sessionId } : {}),
                turns: session.turns,
            };
        })
        : [{
                agent: adapter.agent,
                label: pathSessionId ? `${adapter.agent}:${pathSessionId}` : adapter.agent,
                ...(pathSessionId ? { sessionId: pathSessionId } : {}),
                turns: adapter.parse(raw),
            }];
    return {
        sources,
        diagnostics: diagnosticsForRuntimeSource(raw),
    };
}
export function parseRuntimeSessionSources(path, readSource = (p) => readFileSync(p, 'utf8'), nativeSessionHome = homedir()) {
    return parseRuntimeSessionSourcesWithDiagnostics(path, readSource, nativeSessionHome).sources;
}