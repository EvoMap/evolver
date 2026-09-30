export declare const JEV_DECISION_SCHEMA_VERSION: "evolver-v2.jev-decision-shadow.v1";
export interface DecisionCapabilityInput {
    state: string;
    options: Record<string, string>;
}
export interface JevDecisionEvidence {
    schemaVersion: typeof JEV_DECISION_SCHEMA_VERSION;
    provider: 'jev';
    model: string;
    endpoint: string;
    status: 'ok' | 'fallback';
    advisoryOnly: true;
    deterministicAuthority: true;
    /** Binds options and the bounded state submitted (or prepared for a fallback), not the omitted suffix. */
    inputDigest: string;
    choice?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    latencyMs?: number;
    fallbackReason?: string;
}
export interface JevDecisionCapabilityOptions {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
export declare class JevDecisionCapability {
    private readonly enabled;
    private readonly baseUrl;
    private readonly model;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options?: JevDecisionCapabilityOptions);
    static fromEnvironment(env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): JevDecisionCapability;
    evaluate(input: DecisionCapabilityInput): Promise<JevDecisionEvidence>;
}