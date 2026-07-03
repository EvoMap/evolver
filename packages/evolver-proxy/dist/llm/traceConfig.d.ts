export declare function traceDisabledByValue(value: string | undefined): boolean;
export interface TraceConfigStateStore {
    getState?(key: string): string | undefined;
}
export declare function traceCollectionEnabled(env?: NodeJS.ProcessEnv, store?: TraceConfigStateStore): boolean;
export declare function traceProfileAnalysisEnabled(env?: NodeJS.ProcessEnv, store?: TraceConfigStateStore): boolean;
export declare function traceHubPublicKey(env?: NodeJS.ProcessEnv, store?: TraceConfigStateStore): string | null;