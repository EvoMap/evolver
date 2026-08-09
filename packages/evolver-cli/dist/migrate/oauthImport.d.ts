import type { hub } from '@evomap/evolver-core';
import { type PublicAuthPathOptions } from '../login.js';
type OAuthMigrateStatus = 'migrated' | 'dry_run' | 'skipped_existing' | 'source_missing' | 'invalid_source' | 'refused';
export interface OAuthMigrateReport {
    status: OAuthMigrateStatus;
    fromPath: string;
    toPath: string;
    /** Field presence only — never raw secrets. */
    sourceFields: {
        hasAccessToken: boolean;
        hasRefreshToken: boolean;
        hasExpires: boolean;
        hasDevice: boolean;
        shape: 'v2-credential' | 'oauth2-snake' | 'nested' | 'unknown';
    };
    /** True when access token is past expiresAt (refresh may still work). */
    accessExpired?: boolean;
    message: string;
}
export interface OAuthMigrateOptions {
    fromPath?: string;
    toPath?: string;
    force?: boolean;
    dryRun?: boolean;
    json?: boolean;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    /** Test seam for deterministic source replacement races. */
    sourceReadTestHook?: (stage: 'before-open' | 'after-open' | 'after-read', path: string) => void;
    /** Test seam for security metadata changes between snapshot and trust inspection. */
    beforeSourceTrustTestHook?: (path: string) => void;
    /** Test seam for a destination created immediately before no-clobber publish. */
    beforeSaveTestHook?: (path: string) => void;
    /** Test seam that avoids creating a real soft machine id. */
    deviceFingerprint?: string;
}
/** Normalize expires fields: ms epoch preferred; accept seconds epoch or expires_in relative. */
export declare function normalizeExpiresAt(raw: Record<string, unknown>, nowMs: number): number | undefined;
export interface ParsedV1OAuth {
    cred: hub.Credential & {
        token: string;
    };
    shape: OAuthMigrateReport['sourceFields']['shape'];
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    hasExpires: boolean;
    hasDevice: boolean;
}
/**
 * Parse a V1 (or already-V2) OAuth JSON object into a V2 hub.Credential.
 * Accepts snake_case OAuth2, nested token objects, and V2 credential shape.
 */
export declare function parseV1OAuthJson(raw: unknown, nowMs?: number): ParsedV1OAuth;
export declare function defaultV1OAuthPath(opts?: PublicAuthPathOptions): string;
/**
 * Convert V1 ~/.evomap/oauth_token.json into V2 token.json via CredentialStore.
 * Never prints secret values. Fail-closed on unsafe paths / missing tokens.
 */
export declare function migrateV1OAuth(options?: OAuthMigrateOptions): OAuthMigrateReport;
export declare function runMigrateOAuthCommand(argv: readonly string[], io?: {
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    env?: NodeJS.ProcessEnv;
}): Promise<number>;
export {};