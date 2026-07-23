import type { hub } from '@evomap/evolver-core';
import { type AccountAssetListOptions, type AccountAssetListResult } from '@evomap/evolver-adapter-public';
export interface PrivateAccountAssetHub {
    listAccountAssets(opts: AccountAssetListOptions): Promise<AccountAssetListResult>;
}
interface PrivateCompatibilityResponse {
    status: number;
    json(): Promise<unknown>;
}
export type PrivateCompatibilityFetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
}) => Promise<PrivateCompatibilityResponse>;
interface PrivateAccountAssetCompatibilityOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    senderId: () => string | undefined;
    env: Record<string, string | undefined>;
    fetchFn?: PrivateCompatibilityFetch;
}
/**
 * Older official private adapters predate account inventory listing. Keep the
 * compatibility wire at the private composition edge, and never replace a
 * future adapter's native implementation.
 */
export declare function withPrivateAccountAssetCompatibility<T extends object>(hubCapability: T, opts: PrivateAccountAssetCompatibilityOptions): T & PrivateAccountAssetHub;
export {};