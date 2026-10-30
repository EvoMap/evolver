import type { AssetRecord, AssetStoreProvider } from '../assetstore/provider.js';
import { type PublishBindingReceipt, type PublishVerificationEvidence, type PublishVerificationRequest } from './publishBinding.js';
import { type GepCategory } from '../wire/index.js';
import { EXECUTION_REDACTION_POLICY_VERSION, type ExecutionRedactionReason } from '../verify/executionRedaction.js';
export interface ConversationDistillInput {
    title?: unknown;
    name?: unknown;
    summary?: unknown;
    user_prompt?: unknown;
    userPrompt?: unknown;
    assistant_summary?: unknown;
    assistantSummary?: unknown;
    transcript?: unknown;
    conversation?: unknown;
    signals?: unknown;
    preconditions?: unknown;
    strategy?: unknown;
    steps?: unknown;
    artifacts?: unknown;
    outputs?: unknown;
    files?: unknown;
    validation?: unknown;
    verification?: unknown;
    execution?: unknown;
    blast_radius?: unknown;
    platform?: unknown;
    host?: unknown;
    model?: unknown;
    thread_id?: unknown;
    threadId?: unknown;
    session_id?: unknown;
    sessionId?: unknown;
    min_score?: unknown;
    minScore?: unknown;
    persist?: unknown;
    /** Facts that hold only in this project (files, fields, quirks). Kept on the local Capsule, never published. */
    project_notes?: unknown;
    /** Absolute directory of the project the conversation ran in; only its fingerprint is kept, on the local Capsule. */
    project_dir?: unknown;
    /** The answer the conversation ended with: its values must not reach the reusable Gene. */
    final_answer?: unknown;
    cost_tokens?: unknown;
    [k: string]: unknown;
}
interface NormalizedExecution {
    status: 'success' | 'failed';
    trace: Array<{
        command: string;
        exit: number;
        summary?: string;
    }>;
    validation: string[];
    blast_radius: {
        files: number;
        lines: number;
    };
    untrustedStatusClaim: boolean;
    redactionBlocked: boolean;
    redactionReasons: ExecutionRedactionReason[];
}
interface NormalizedConversation {
    text: string;
    summary: string;
    userPrompt: string;
    projectNotes: string[];
    answerValues: string[];
    signals: string[];
    preconditions: string[];
    strategy: string[];
    artifacts: string[];
    execution: NormalizedExecution;
    platform: string;
    model: string;
    source_thread: string;
}
export interface QualityGate {
    ok: boolean;
    score: number;
    threshold: number;
    reasons: string[];
    reason?: string;
}
export interface ConversationDistillOptions {
    persist?: boolean;
    store?: AssetStoreProvider;
    /**
     * 仅由受信任的宿主验证器注入。HTTP/MCP 请求体中的 execution 不能替代此证据。
     */
    verifiedExecution?: ConversationDistillVerifiedExecution;
    /** 宿主 durable ledger 登记必须先于资产持久化；不得从请求体传入。 */
    registerPublishReceipt?: (receipt: PublishBindingReceipt, bundle: readonly AssetRecord[]) => void | Promise<void>;
    /** 受信任适配器在验证前声明的 Gene 策略；进入 request digest 与最终资产。 */
    genePolicy?: ConversationGenePolicy;
    publishSanitizeEnv?: Record<string, string | undefined>;
    publishSignal?: AbortSignal;
}
export interface ConversationGenePolicy {
    category?: GepCategory;
    constraints?: {
        max_files?: number;
        forbidden_paths?: readonly string[];
    };
}
export interface ConversationDistillVerifiedExecution {
    trace: ReadonlyArray<{
        command: string;
        exit: number;
        summary?: string;
    }>;
    validation?: readonly string[];
    blast_radius?: {
        files?: number;
        lines?: number;
    };
    binding?: PublishVerificationEvidence;
}
export type ConversationDistillResult = {
    ok: false;
    status: 'skipped';
    reason: string;
    quality?: QualityGate;
    signals?: string[];
} | ({
    ok: true;
    status: 'stored' | 'draft';
    distill_id: string;
    quality: QualityGate;
    signals: string[];
    gene: AssetRecord;
    capsule: AssetRecord;
    execution_redaction: {
        policy_version: typeof EXECUTION_REDACTION_POLICY_VERSION;
        blocked: boolean;
        reasons: ExecutionRedactionReason[];
    };
} & ({
    publishable: true;
    event: AssetRecord;
    publish_receipt: PublishBindingReceipt;
} | {
    publishable: false;
    event?: AssetRecord;
    publish_receipt?: PublishBindingReceipt;
}));
export declare function inferSignals(text: string, providedSignals?: unknown): string[];
export declare function evaluateGate(input: ConversationDistillInput, normalized: NormalizedConversation): QualityGate;
export declare function answerValues(finalAnswer: string, prompt: string): string[];
export declare function projectSpecificTerms(texts: readonly string[], patterns?: RegExp[]): string[];
export declare function normalizeConversationInput(input: ConversationDistillInput): NormalizedConversation;
export declare function createConversationVerificationRequest(input: ConversationDistillInput, validation: readonly string[], runtime: string, nonce: string, policy?: ConversationGenePolicy): PublishVerificationRequest;
export declare function distillConversation(input: ConversationDistillInput, opts?: ConversationDistillOptions): Promise<ConversationDistillResult>;
export {};