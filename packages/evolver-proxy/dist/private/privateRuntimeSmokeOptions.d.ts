export interface PrivateRuntimeSmokeOptions {
    env: Record<string, string | undefined>;
    run: boolean;
    runSearch: boolean;
    runReuseResult: boolean;
    runPublish: boolean;
}
export interface PrivateRuntimeSmokeResolveDeps {
    configRoot?: string;
    exists?: (path: string) => boolean;
    readConfigFile?: (path: string) => string;
    readEnvFile?: (path: string) => string;
    statMode?: (path: string) => number | undefined;
}
export declare function resolvePrivateRuntimeSmokeOptions(sourceEnv?: Record<string, string | undefined>, readEnvFileOrDeps?: ((path: string) => string) | PrivateRuntimeSmokeResolveDeps): PrivateRuntimeSmokeOptions;