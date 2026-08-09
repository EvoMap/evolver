import { assetstore, hub } from '@evomap/evolver-core';
export type PromptRecallMode = 'off' | 'shadow' | 'enforce';
/** The hook sees a raw user prompt, so reject oversized payloads instead of retaining a partial JSON document. */
export declare const MAX_PROMPT_RECALL_STDIN_BYTES: number;
export declare const MAX_PROMPT_RECALL_LOCAL_FILE_BYTES: number;
export declare const MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES: number;
type HookInputReader = () => string | undefined | Promise<string | undefined>;
export interface PromptRecallHookDeps {
    store?: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    provenance?: assetstore.ProvenanceStore;
    callLog?: Pick<hub.AssetCallLog, 'append'>;
    env?: NodeJS.ProcessEnv;
    readHookInput?: HookInputReader;
    stdout?: (text: string) => void;
    selectionTimeoutMs?: number;
}
export declare function promptRecallMode(env?: NodeJS.ProcessEnv): PromptRecallMode;
/**
 * Shared Claude Code/Codex UserPromptSubmit entrypoint. It is intentionally local-only and fail-open: no Hub
 * query, no transcript read, no prompt persistence, and exactly one JSON object on stdout for every outcome.
 */
export declare function runPromptRecallHook(argv: readonly string[], deps?: PromptRecallHookDeps): Promise<number>;
export {};