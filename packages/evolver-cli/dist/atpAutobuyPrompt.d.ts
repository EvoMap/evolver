export type AutobuyPromptState = 'env_set' | 'non_tty' | 'ack_present' | 'eligible';
export interface AutobuyPromptResult {
    prompted: boolean;
    decision: 'yes' | 'no' | 'later' | null;
    reason: string;
}
interface TtyLike {
    isTTY?: boolean;
}
export interface AutobuyPromptReaderOptions {
    timeoutMs?: number;
}
type AskFn = (question: string, io: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
}, options?: AutobuyPromptReaderOptions) => Promise<string>;
export interface AutobuyPromptOptions {
    input?: (NodeJS.ReadableStream & TtyLike);
    output?: NodeJS.WritableStream;
    env?: NodeJS.ProcessEnv;
    ask?: AskFn;
    promptTimeoutMs?: number;
    consentPath?: string;
    now?: () => Date;
}
/**
 * Decide whether the prompt is eligible. Precedence (env_set > non_tty > ack_present > eligible) is read straight
 * off getAtpConsent's `source` so it stays bug-for-bug aligned with the runtime gate: a set env => source 'env'
 * regardless of any ack file, and an ack file (env unset) => source 'ack'. We classify env BEFORE TTY so a daemon
 * with the env already set reports 'env_set' (the actionable truth) rather than the generic 'non_tty'.
 */
export declare function classifyAutobuyPrompt(env: NodeJS.ProcessEnv, stdin: TtyLike | undefined, ackPath?: string): AutobuyPromptState;
/**
 * Default reader: a single readline question, settled exactly once. The 'close' handler covers EOF/Ctrl-D, and the
 * bounded timer covers open pseudo-TTYs where no operator ever types. Both fall through to '' -> the caller's safe
 * 'later' branch (no ack written, env untouched).
 */
export declare function defaultAsk(question: string, io: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
}, options?: AutobuyPromptReaderOptions): Promise<string>;
/**
 * Run the first-run auto-buyer prompt at most once per `evolver autoexec` invocation, BEFORE the resident loop
 * starts. A no-op (no I/O, no file) on every non-eligible branch. Callers should wrap in try/catch so a prompt
 * failure can never block the run — see runAutoExec.
 */
export declare function runAutobuyPrompt(opts?: AutobuyPromptOptions): Promise<AutobuyPromptResult>;
export {};