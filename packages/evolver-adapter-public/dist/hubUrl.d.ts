export declare const DEFAULT_PUBLIC_HUB_URL = "https://evomap.ai";
export type HubUrlEnv = Record<string, string | undefined>;
export declare function resolveConfiguredHubUrl(env: HubUrlEnv): string | undefined;
export declare function resolveHubUrl(env: HubUrlEnv): string;