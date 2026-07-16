import type { SignalSourceTurn } from '../signals/extractor.js';
export interface ConversationSnifferTurn extends SignalSourceTurn {
    role?: string;
}
export interface ConversationCapabilityHit {
    id: string;
    title: string;
    summary: string;
    signals: string[];
    evidence: string[];
    score: number;
    reasons: string[];
    toolCalls: string[];
}
export interface ConversationSnifferOptions {
    maxHits?: number;
}
export declare function sniffConversationCapabilities(turns: readonly ConversationSnifferTurn[], opts?: ConversationSnifferOptions): ConversationCapabilityHit[];