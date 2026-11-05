import * as recall from '@evomap/evolver-core/prompt-recall';
import { type ProtectedAuditSessionNoticeOptions } from './protectedAuditStatus.js';
type HookInputReader = (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
export interface PromptRecallHookDeps {
    store?: recall.AssetStoreProvider;
    review?: recall.ReviewLedger;
    provenance?: recall.ProvenanceStore;
    callLog?: Pick<recall.AssetCallLog, 'append'> & Partial<Pick<recall.AssetCallLog, 'appendBounded'>>;
    env?: NodeJS.ProcessEnv;
    /** Cooperative input reader; late results are discarded after the same 250ms stdin budget. */
    readHookInput?: HookInputReader;
    stdout?: (text: string) => void | Promise<void>;
    stdoutWithSettlement?: (text: string, onSettled: (written: boolean) => void) => Promise<void>;
    /** CLI lifecycle notification after the single stdout write; not host/model acknowledgement. */
    onOutputWritten?: () => void;
    /** External delivery writers must own preparation, projection and terminal release. */
    ingestor?: Pick<recall.Ingestor, 'prepareContextDelivery'> & Partial<Pick<recall.Ingestor, 'prepareContextDeliveryAsync' | 'recoverContextDeliveries'>>;
    selectionTimeoutMs?: number;
    /** Test seam for the protected audit probe and its per-session notice state. */
    protectedAuditNotice?: ProtectedAuditSessionNoticeOptions;
}
/**
 * Shared Claude Code/Codex UserPromptSubmit entrypoint. It is intentionally local-only and fail-open: no Hub
 * query, no transcript read, no prompt persistence, and exactly one JSON object on stdout for every outcome.
 */
export declare function runPromptRecallHook(argv: readonly string[], deps?: PromptRecallHookDeps): Promise<number>;
export {};