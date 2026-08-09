import { assetstore } from '@evomap/evolver-core';
export interface ThesisTaskSpec {
    id: string;
    signals: string[];
    category?: string;
    target?: string;
    expectedEffect?: string;
    summary?: string;
    confidence?: number;
}
export interface ThesisSuite {
    name: string;
    /** Verifier commands run in the worktree after each attempt; their all-pass decides `passed`. */
    validation?: string[];
    tasks: ThesisTaskSpec[];
}
type CycleExecute = (mutation: never, decision: {
    selectedGeneId?: string | null;
}) => Promise<{
    outcome: {
        status: 'success' | 'failed';
        score: number;
    };
}> | {
    outcome: {
        status: 'success' | 'failed';
        score: number;
    };
};
export interface ThesisCommandDeps {
    /** evolver-arm store (the learned-gene pool). Default: the live asset store. */
    pool?: assetstore.AssetStoreProvider;
    /** Inject a deterministic agent for tests / a dry simulation. Default: makeSafeExecute against `--repo` (live). */
    execute?: CycleExecute;
    now?: () => number;
}
/**
 * `evolver thesis --suite <file> [--repo <allowlisted>] [--runner gemini] [--min-samples N] [--min-delta D] [--interleave] [--json]`.
 * Runs the controlled A/B and prints baseline-vs-evolver pass rates + the verdict. A LIVE run needs `--repo` (the
 * single allowlisted root the agent may touch); tests inject `deps.execute` instead.
 */
export declare function runThesisCommand(argv: readonly string[], deps?: ThesisCommandDeps): Promise<number>;
export {};