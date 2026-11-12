import type { AssetRecord, AssetStoreProvider } from '../assetstore/provider.js';
import { type ObservedCheck } from '../verify/sandboxedValidation.js';
import { type ProjectProvenance } from './projectTerms.js';
import type { IrRejection } from './sessionGeneIr.js';
import { type PublishBindingReceipt, type PublishVerificationEvidence, type PublishVerificationRequest } from './publishBinding.js';
import { type GepCategory } from '../wire/index.js';
import type { ClientIdentity } from './clientIdentity.js';
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
    /** Content ids of the assets the session reused; kept on the Gene as lineage, malformed entries dropped. */
    reused_asset_ids?: unknown;
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
    hostObserved: boolean;
    hostObservedPassed: boolean;
    redactionBlocked: boolean;
    redactionReasons: ExecutionRedactionReason[];
}
interface NormalizedConversation {
    text: string;
    summary: string;
    userPrompt: string;
    projectNotes: string[];
    unknowns: string[];
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
export type QualityRejection = 'insufficient_reusable_signal' | 'not_portable' | 'too_project_specific' | 'answer_leak' | IrRejection;
export interface QualityGate {
    ok: boolean;
    score: number;
    threshold: number;
    reasons: string[];
    reason?: QualityRejection;
    /** The words the rejection is about, for the person to move into project notes or drop. */
    terms?: string[];
    /** Where in the IR an `ir_invalid` or `ref_unresolved` rejection points. */
    field?: string;
    metrics?: Record<string, number>;
}
export interface ConversationDistillOptions {
    persist?: boolean;
    /** The host agent and plugin that asked, sealed into the Capsule's env_fingerprint; never part of the input digest. */
    client?: ClientIdentity;
    store?: AssetStoreProvider;
    /**
     * 仅由受信任的宿主验证器注入。HTTP/MCP 请求体中的 execution 不能替代此证据。
     */
    verifiedExecution?: ConversationDistillVerifiedExecution;
    /** 宿主 durable ledger 登记必须先于资产持久化；不得从请求体传入。 */
    registerPublishReceipt?: (receipt: PublishBindingReceipt, bundle: readonly AssetRecord[]) => void | Promise<void>;
    /** 受信任适配器在验证前声明的 Gene 策略；进入 request digest 与最终资产。 */
    genePolicy?: ConversationGenePolicy;
    /** Host-only binding for the exact replay plan, never taken from the request body. */
    validationPlanDigest?: string;
    onObservedValidationPlan?: (checks: readonly ObservedCheck[]) => void;
    /**
     * Host-only, for a background publication: the Gene that was tried and verified. A re-derived Gene that differs (the
     * distiller changed since) is refused before anything is stored, so only the Gene that earned its promotion is sent.
     */
    expectedGeneAssetId?: string;
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
/** What the gate checks a Gene against: the text an agent elsewhere would follow, and what this project declared. */
export interface PortabilityCheck {
    surface: readonly string[];
    /** Exact contracts: checked for this machine's paths only. */
    verbatim?: readonly string[];
    provenance: ProjectProvenance;
    /** An IR passed its structural checks already; only the free-form input still earns its admission by score. */
    structural: boolean;
}
export declare function evaluateGate(input: ConversationDistillInput, normalized: NormalizedConversation, check: PortabilityCheck, alsoPublished?: readonly string[]): QualityGate;
export declare function normalizeConversationInput(input: ConversationDistillInput): NormalizedConversation;
/** Binds what will be published: a session IR is compiled first, exactly as distillation compiles it. */
export declare function createConversationVerificationRequest(input: ConversationDistillInput, validation: readonly string[], runtime: string, nonce: string, policy?: ConversationGenePolicy, validationPlanDigest?: string): PublishVerificationRequest;
export declare function distillConversation(request: ConversationDistillInput, requestOpts?: ConversationDistillOptions): Promise<ConversationDistillResult>;
export {};