import { assetstore, events, ops } from '@evomap/evolver-core';
import { type NormalizedTurn } from '@evomap/evolver-runtime-adapters';
export interface RecallCliDeps {
    store?: Pick<assetstore.AssetStoreProvider, 'get' | 'list'>;
    readFile?: (path: string) => string;
    /** Test seam: parse a transcript file's content into turns. Default uses the runtime-adapter for the path. */
    parseTranscript?: (path: string, content: string) => NormalizedTurn[];
    /** Test seam: read root_events (for --from-inject). Default reads the real root_events log. */
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    log?: (line: string) => void;
    err?: (line: string) => void;
}
/** Claude Code names a transcript `<session_id>.jsonl`, so the basename (minus extension) is the session id used to
 *  match the inject event that produced THIS session (#205). Other runtimes' names simply won't match any stamped
 *  sessionId, and the caller falls back to the most-recent inject — safe, never wrong, just less precise. */
export declare function sessionIdFromTranscript(p: string): string | undefined;
/** Pick the `value.inject` event for this run: the latest (max seq) one STAMPED with `sessionId` when that matches
 *  the transcript's session (#205 precise tie), else the latest inject overall (back-compat for un-stamped events
 *  and runtimes with no session id). Returns undefined when there is no inject event at all. */
export declare function pickInjectEvent(evts: readonly events.ReportEvent[], sessionId?: string): events.ReportEvent | undefined;
export declare function geneIdsOf(e: events.ReportEvent | undefined): string[];
export declare function geneFromAsset(a: assetstore.AssetRecord): ops.GeneRecallInput;
export declare function resolveGene(store: Pick<assetstore.AssetStoreProvider, 'get' | 'list'>, id: string): Promise<assetstore.AssetRecord | null>;
export declare function runRecall(argv: readonly string[], deps?: RecallCliDeps): Promise<number>;
/** Registry-shaped handler (argv -> exit code). */
export declare const runRecallCommand: (argv: string[]) => Promise<number>;