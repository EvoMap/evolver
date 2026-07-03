import { assetstore, hub as hubNs } from '@evomap/evolver-core';
import type { ConnectPublicOptions, PublicHubCapability } from '@evomap/evolver-adapter-public';
declare const REUSE_CONTRACT = "reuse.v1";
export type ReuseStatus = 'ok' | 'dry_run' | 'invalid_arg' | 'missing_id' | 'unsupported' | 'not_found' | 'unauthorized' | 'unavailable' | 'network' | 'internal_error';
/** The stable reuse.v1 machine contract printed to stdout on success AND failure. Field set is locked by the
 *  consumer (evox-desktop `evolverReuseEnvelope`, #1008): { ok, contract, status, reason, message }. */
export interface ReuseEnvelope {
    ok: boolean;
    contract: typeof REUSE_CONTRACT;
    status: ReuseStatus;
    reason: string;
    message: string;
}
/** Minimal hub surface this command needs: the reuse pull is a single fetch-by-id. PublicHubCapability satisfies it. */
type AssetByIdFetcher = {
    fetchAssetById(assetId: string): Promise<assetstore.AssetRecord | null>;
};
export interface ReuseCliDeps {
    store?: assetstore.AssetStoreProvider;
    assetsDir?: string;
    hub?: AssetByIdFetcher;
    callLog?: {
        append(entry: hubNs.AssetCallEntry): void;
    };
    env?: NodeJS.ProcessEnv;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
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