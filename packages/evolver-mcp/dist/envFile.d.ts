export interface EnvFileLoadResult {
    loaded: boolean;
    path?: string;
    keys: string[];
    error?: string;
}
export declare function expandHomePath(path: string): string;
export declare function parseEnvFile(raw: string): Record<string, string>;
export declare function loadEnvFile(path: string, env?: Record<string, string | undefined>): EnvFileLoadResult;
export declare function loadEnvFileFromEnv(env?: Record<string, string | undefined>): EnvFileLoadResult;
export declare function loadEnvFileFromEnvOrThrow(env?: Record<string, string | undefined>): EnvFileLoadResult;