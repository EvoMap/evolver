import type { VerificationContext } from './observedEvidence.js';
export declare class RecordedTreeMismatch extends Error {
}
/** All checkout and patch operations use our own config and index, even for a linked source worktree. */
export declare function createRecordedCheckout(context: VerificationContext, parent: string): Promise<string>;