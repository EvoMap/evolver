import { assetstore, skill, type hub as hubNs } from '@evomap/evolver-core';
import type { ConnectPublicOptions, PublicHubCapability } from '@evomap/evolver-adapter-public';
type RequiredSkillRef = skill.RequiredSkillRef;
type Result<T> = skill.Result<T>;
export interface SkillFetchHub {
    search(query: assetstore.SearchQuery): Promise<assetstore.AssetRecord[]>;
    fetch(query: assetstore.SearchQuery): Promise<assetstore.AssetRecord[]>;
    fetchAssetById?(assetId: string): Promise<assetstore.AssetRecord | null>;
}
export interface SkillFetchDeps {
    hub?: SkillFetchHub;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
    /** Fetches a required skill's files, and the commit they come from, from its git repository; the network boundary of an install. */
    fetchSkillFiles?: (ref: RequiredSkillRef) => Result<skill.FetchedSkill> | Promise<Result<skill.FetchedSkill>>;
}
export declare function runSkillCommand(argv: readonly string[], deps?: SkillFetchDeps): Promise<number>;
export {};