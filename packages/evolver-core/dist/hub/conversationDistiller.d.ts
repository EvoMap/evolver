import type { AssetRecord, AssetStoreProvider } from '../assetstore/provider.js';
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
}
interface NormalizedConversation {
    text: string;
    summary: string;
    signals: string[];
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
}
export type ConversationDistillResult = {
    ok: false;
    status: 'skipped';
    reason: string;
    quality?: QualityGate;
    signals?: string[];
} | {
    ok: true;
    status: 'stored' | 'draft';
    distill_id: string;
    quality: QualityGate;
    signals: string[];
    gene: AssetRecord;
    capsule: AssetRecord;
};
export declare function inferSignals(text: string, providedSignals?: unknown): string[];
export declare function evaluateGate(input: ConversationDistillInput, normalized: NormalizedConversation): QualityGate;
export declare function normalizeConversationInput(input: ConversationDistillInput): NormalizedConversation;
export declare function distillConversation(input: ConversationDistillInput, opts?: ConversationDistillOptions): Promise<ConversationDistillResult>;
export {};