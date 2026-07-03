import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adapterForPath, isCursorStateVscdbPath, parseCursorStateVscdb, } from '@evomap/evolver-runtime-adapters';
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
export function parseRuntimeSessionSources(path, readSource = (p) => readFileSync(p, 'utf8')) {
    const absPath = resolve(path);
    if (isCursorStateVscdbPath(absPath)) {
        return parseCursorStateVscdb(absPath)
            .map(cursorSourceFromSession)
            .filter((source) => source !== null);
    }
    const adapter = adapterForPath(absPath);
    if (!adapter)
        return [];
    return [{ agent: adapter.agent, label: adapter.agent, turns: adapter.parse(readSource(absPath)) }];
}