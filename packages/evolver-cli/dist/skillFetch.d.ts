import { assetstore, type hub as hubNs } from '@evomap/evolver-core';
import type { ConnectPublicOptions, PublicHubCapability } from '@evomap/evolver-adapter-public';
export interface SkillFetchHub {
    search(query: assetstore.SearchQuery): Promise<assetstore.AssetRecord[]>;
    fetch(query: assetstore.SearchQuery): Promise<assetstore.AssetRecord[]>;
    fetchAssetById?(assetId: string): Promise<assetstore.AssetRecord | null>;
}
export interface SkillFetchDeps {
    hub?: SkillFetchHub;
    env?: NodeJS.ProcessEnv;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
}
export declare function runSkillCommand(argv: readonly string[], deps?: SkillFetchDeps): Promise<number>;