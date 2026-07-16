import { bootstrap } from '@evomap/evolver-core';
export declare const ANTI_ABUSE_SCHEMA_VERSION = "anti_abuse.v1";
export declare const ANTI_ABUSE_REDACTION_VERSION = "anti_abuse_redaction.v1";
export declare const DEFAULT_ANTI_ABUSE_TTL_DAYS = 90;
export declare const MAX_INTEGRITY_FILE_BYTES: number;
export type AntiAbuseTelemetryMode = 'heartbeat' | 'off';
export interface AntiAbuseTelemetryOptions {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    envFingerprint?: bootstrap.EnvFingerprint;
    now?: Date | string;
    packageRoot?: string;
    proxyPortConfigured?: boolean;
    salt?: string;
    saltId?: string | null;
    source?: string;
    nodeId?: string;
    evolverVersion?: string;
    taskMeta?: Record<string, unknown>;
    workspaceId?: string;
    workspaceIdResolver?: () => string | null;
}
export interface IntegrityHashes {
    package_json_hash: string | null;
    cli_entry_hash: string | null;
    lockfile_hashes: Record<string, string>;
}
export declare function antiAbuseTelemetryMode(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): AntiAbuseTelemetryMode;
export declare function hmacPseudonym(value: unknown, opts?: {
    salt?: string;
    purpose?: string;
}): string | null;
export declare function antiAbuseEnvFingerprintKey(fp: bootstrap.EnvFingerprint): string;
export declare function resolveAdapterPackageRoot(startDir?: string): string;
export declare function resolveWorkspaceRoot(startDir?: string): string;
export declare function resolveCliPackageRoot(packageRoot?: string, workspaceRoot?: string): string | null;
export declare function collectIntegrityHashes(packageRoot?: string): IntegrityHashes;
export declare function buildHeartbeatAntiAbuseTelemetry(opts?: AntiAbuseTelemetryOptions): Record<string, unknown>;