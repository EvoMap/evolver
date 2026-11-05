import type * as assetstore from '@evomap/evolver-core/prompt-recall';
export type PromptRecallMode = 'off' | 'shadow' | 'enforce';
/** Reject oversized prompt payloads rather than retaining partial private JSON. */
export declare const MAX_PROMPT_RECALL_STDIN_BYTES: number;
export declare const MAX_PROMPT_RECALL_LOCAL_FILE_BYTES: number;
export declare const MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES: number;
/** Called after hook settlement; diagnostics cannot spend the admission budget. */
export declare function writeContextReadDiagnostic(report: assetstore.ContextReadDiagnosticReport): void;
/** Bound caller latency while the original continuation retains actual operation ownership. */
export declare function waitContextDelivery<T>(promise: Promise<T>, timeoutMs?: number): Promise<T | undefined>;
export declare function promptRecallMode(env?: NodeJS.ProcessEnv): PromptRecallMode;
/** Rebind section offsets/digest to the actual prompt, including wrappers; never slice an assembled body. */
export declare function wrapGeneContext(context: assetstore.AssembledGeneContext, prefix: string, suffix: string): assetstore.AssembledGeneContext;
/** Only the transport's own pre-dispatch refusal proves no bytes were submitted. */
export declare function hookStdoutNotSubmitted(error: unknown): boolean;
/** A successful callback means stdout_written, not host_received. One attempt only, even on EPIPE. */
export declare function writeHookStdout(text: string, options?: {
    destroyOnTimeout?: boolean;
    onSettled?: (written: boolean) => void;
}): Promise<void>;