export interface ProxySettingsRecord {
    url: string;
    token: string;
    pid: number;
    started_at: string;
    version?: string;
}
export interface PublishProxySettingsOptions {
    settingsPath?: string;
    homeDir?: string;
    env?: Record<string, string | undefined>;
    record: ProxySettingsRecord;
}
export declare function defaultProxySettingsPath(homeDir?: string): string;
export declare function resolveProxySettingsPath(env?: Record<string, string | undefined>, homeDir?: string): string;
export declare function publishProxySettings(options: PublishProxySettingsOptions): boolean;
export declare function proxySettingsMatch(settingsPath: string, record: ProxySettingsRecord): boolean;