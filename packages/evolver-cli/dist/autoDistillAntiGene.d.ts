import { assetstore, events } from '@evomap/evolver-core';
import { type LlmDistillRunner } from './autoDistillLlm.js';
export type AutoDistillAntiGeneMode = 'off' | 'shadow' | 'enforce';
interface AntiGeneCandidate {
    id?: string;
    summary: string;
    trigger: string[];
    avoid: string[];
    rationale?: string;
    severity?: 'low' | 'medium' | 'high';
    evidence_capsules?: string[];
    source_clusters?: string[];
}
interface AntiGeneAsset extends assetstore.AssetRecord {
    type: 'AntiGene';
    schema_version: string;
    id: string;
    summary: string;
    trigger: string[];
    avoid: string[];
    source_clusters: string[];
    evidence_capsules: string[];
    failure_count: number;
    asset_id: string;
    rationale?: string;
    severity?: 'low' | 'medium' | 'high';
}
export type AutoDistillAntiGeneResult = {
    ok: true;
    mode: 'enforce';
    antiGene: AntiGeneAsset;
    dataHash: string;
    stored: boolean;
} | {
    ok: false;
    mode: AutoDistillAntiGeneMode;
    reason: string;
    dataHash?: string;
    candidate?: AntiGeneCandidate;
};
export interface AutoDistillAntiGeneOptions {
    mode?: AutoDistillAntiGeneMode;
    env?: NodeJS.ProcessEnv;
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    statePath?: string;
    cwd?: string;
    now?: () => number;
    runner?: LlmDistillRunner;
    minFailures?: number;
    triggerOverlapMin?: number;
    maxClusters?: number;
}
export interface AutoDistillAntiGeneWiring {
    enabled: boolean;
    mode: AutoDistillAntiGeneMode;
    reason?: 'off';
    tick: () => Promise<AutoDistillAntiGeneResult>;
}
export declare function autoDistillAntiGene(options: AutoDistillAntiGeneOptions): Promise<AutoDistillAntiGeneResult>;
export declare function resolveAutoDistillAntiGene(env: NodeJS.ProcessEnv, opts: Omit<AutoDistillAntiGeneOptions, 'env' | 'mode'>): AutoDistillAntiGeneWiring;
export {};