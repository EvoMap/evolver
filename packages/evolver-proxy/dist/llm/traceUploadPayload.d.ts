import type { HubDecryptableTraceEnvelope } from './traceEnvelope.js';
export declare const PROXY_TRACE_UPLOAD_SCHEMA = "prism_trace_row.v1";
export interface ProxyTraceUploadPayload {
    schema: typeof PROXY_TRACE_UPLOAD_SCHEMA;
    encrypted: true;
    trace: HubDecryptableTraceEnvelope;
    node_secret_version?: number;
    secret_version?: number;
    producer_generation?: string;
    producer_version?: string;
    producer_component?: string;
}
export declare function buildProxyTraceUploadPayload(record: HubDecryptableTraceEnvelope): ProxyTraceUploadPayload;
export declare function proxyTraceUploadPayloadSizeBytes(record: HubDecryptableTraceEnvelope): number;