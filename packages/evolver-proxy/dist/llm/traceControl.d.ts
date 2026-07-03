interface TraceControlStore {
    setState(key: string, value: string): void;
}
interface TraceControlLogger {
    log?: (line: string) => void;
    warn?: (line: string) => void;
}
interface TraceControlResult {
    ack: true;
    applied: boolean;
}
export declare const DEFAULT_TRACE_CONFIG_SIGNING_PUBLIC_KEY: string;
export declare function canonicalTraceConfigPayload(payload?: Record<string, unknown>): string;
export declare function verifyTraceConfigSignature(payload: unknown, env?: NodeJS.ProcessEnv): boolean;
export declare function applyTraceCollectionConfig(payload: unknown, store: TraceControlStore, env?: NodeJS.ProcessEnv, logger?: TraceControlLogger): TraceControlResult;
export {};