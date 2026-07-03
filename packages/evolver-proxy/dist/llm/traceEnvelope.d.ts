interface HubKeyEnvelope {
    algorithm: 'rsa-oaep-sha256';
    key_id: string;
    wrapped_key: string;
}
export interface HubTraceUsageSummary {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
export interface HubTracePlaintextSummary {
    event: 'llm_trace_plaintext_summary';
    payload_schema: 'llm_turn_summary';
    ts: string;
    route: string | null;
    provider: string | null;
    wire_api: string | null;
    original_model: string | null;
    chosen_model: string | null;
    tier: string | null;
    reason: string | null;
    fallback: string | null;
    router_enabled: boolean | null;
    upstream_mode: string | null;
    status: number | null;
    stream: boolean | null;
    ttfb_ms: number | null;
    latency_ms: number | null;
    usage?: HubTraceUsageSummary;
}
export interface HubDecryptableTraceEnvelope {
    schema_version: 1;
    event: 'llm_trace_envelope';
    encrypted: true;
    payload_schema: 'prism_trace_row';
    algorithm: 'aes-256-gcm';
    key_id: string;
    secret_version?: number;
    producer_generation?: string;
    producer_version?: string;
    producer_component?: string;
    iv: string;
    tag: string;
    ciphertext: string;
    hub_key_envelope?: HubKeyEnvelope;
    plaintext_summary?: HubTracePlaintextSummary;
    payload_complete?: false;
    payload_incomplete_reason?: string;
    hub_uploadable?: false;
    hub_upload_blocked_reason?: string;
    hub_upload_size_bytes?: number;
    hub_upload_max_bytes?: number;
}
export interface TraceMaterializationOptions {
    nodeSecretVersion?: unknown;
    nodeSecret?: unknown;
    hubPublicKey?: unknown;
    profileAnalysisEnabled?: unknown;
    producerGeneration?: string;
    producerVersion?: string;
    producerComponent?: string;
}
type TraceMaterialization = {
    ok: true;
    record: unknown;
} | {
    ok: false;
    reason: 'hub_public_key_missing' | 'hub_key_wrap_failed' | 'trace_encrypt_failed';
    error?: string;
};
export declare function traceUploadMaxBytes(env?: NodeJS.ProcessEnv): number;
export declare function materializeTraceForStorage(record: unknown, env?: NodeJS.ProcessEnv, opts?: TraceMaterializationOptions): TraceMaterialization;
export declare function decryptHubTraceEnvelope(envelope: HubDecryptableTraceEnvelope, privateKey: string): unknown;
export {};