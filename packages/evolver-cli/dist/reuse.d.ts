import { assetstore, hub as hubNs } from '@evomap/evolver-core';
import type { ConnectPublicOptions, PublicHelloOptions, PublicHubCapability } from '@evomap/evolver-adapter-public';
declare const REUSE_CONTRACT = "reuse.v1";
export type ReuseStatus = 'ok' | 'dry_run' | 'invalid_arg' | 'missing_id' | 'unsupported' | 'not_found' | 'unauthorized' | 'unavailable' | 'network' | 'rate_limited' | 'integrity_failed' | 'internal_error';
/** The stable reuse.v1 machine contract printed to stdout on success AND failure. Field set is locked by the
 *  consumer (evox-desktop `evolverReuseEnvelope`, #1008): { ok, contract, status, reason, message }. */
export interface ReuseEnvelope {
    ok: boolean;
    contract: typeof REUSE_CONTRACT;
    status: ReuseStatus;
    reason: string;
    message: string;
}
/** Minimal hub surface this command needs: a single fetch-by-id, plus an optional trust-establishing hello
 *  (PublicHubCapability satisfies both; a bare fetcher in tests may omit hello). */
type AssetByIdFetcher = {
    fetchAssetById(assetId: string): Promise<assetstore.AssetRecord | null>;
    hello?(opts: PublicHelloOptions): Promise<unknown>;
};
type PrivateReuseProxy = {
    fetchAsset(args: {
        assetId: string;
        expectedHubMode: 'private';
    }): Promise<unknown>;
};
export interface ReuseCliDeps {
    store?: assetstore.AssetStoreProvider;
    assetsDir?: string;
    hub?: AssetByIdFetcher;
    callLog?: {
        append(entry: hubNs.AssetCallEntry): void;
        assetCostIndex?(): Record<string, number>;
    };
    env?: NodeJS.ProcessEnv;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
    /** Test seam for private-mode proxy discovery. */
    resolveProxyClient?: (env: NodeJS.ProcessEnv) => PrivateReuseProxy | undefined;
}
interface ReuseOptions {
    id: string;
    mode: 'direct' | 'reference';
    runId?: string;
}
type ParseResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
    status?: ReuseStatus;
};
export declare function runReuseCommand(argv: readonly string[], deps?: ReuseCliDeps): Promise<number>;
export declare function parseReuseArgs(argv: readonly string[]): ParseResult<ReuseOptions>;
export {};