import type { HubQuestion } from './capability.js';
export declare const QUESTION_INTERVAL_MS: number;
export declare const URGENT_QUESTION_INTERVAL_MS: number;
export declare const EXPLORATION_QUESTION_INTERVAL_MS: number;
export declare const MAX_QUESTIONS_PER_CYCLE = 3;
export declare const MAX_URGENT_QUESTIONS = 2;
export declare const URGENT_QUESTION_RUNTIME_WIRING_STATUS: {
    readonly status: "deferred";
    readonly reason: "urgent_question_runtime_wiring_not_connected";
};
export interface QuestionGeneratorState {
    lastAskedAt?: string | null;
    lastUrgentAt?: string | null;
    lastExploreAt?: string | null;
    recentQuestions?: readonly string[];
}
export interface RecentEvolutionEventLike {
    genes_used?: readonly string[];
    genesUsed?: readonly string[];
}
export interface GenerateQuestionsInput {
    signals?: readonly string[];
    recentEvents?: readonly RecentEvolutionEventLike[];
    sessionTranscript?: string;
    memorySnippet?: string;
    state?: QuestionGeneratorState;
    now?: number;
    env?: Record<string, string | undefined>;
    explorationEnabled?: boolean;
}
export interface GenerateUrgentQuestionsInput {
    validationFailed?: boolean;
    validationErrors?: string;
    geneId?: string;
    lowConfidence?: boolean;
    confidenceScore?: number;
    intent?: string;
    llmReviewRejected?: boolean;
    llmReviewReason?: string;
    zeroBlastRadius?: boolean;
    hadSignals?: boolean;
    signals?: readonly string[];
    taskCompletionFailed?: boolean;
    taskTitle?: string;
    taskSignals?: string;
    state?: QuestionGeneratorState;
    now?: number;
}
export interface GeneratedQuestion extends HubQuestion {
    priority: number;
}
export interface QuestionGenerationResult {
    questions: HubQuestion[];
    state: QuestionGeneratorState;
    changed: boolean;
}
export declare function extractTopicKeywords(transcript: string | undefined, memory: string | undefined, max?: number): string[];
export declare function generateQuestions(input?: GenerateQuestionsInput): QuestionGenerationResult;
export declare function generateUrgentQuestions(input?: GenerateUrgentQuestionsInput): QuestionGenerationResult;