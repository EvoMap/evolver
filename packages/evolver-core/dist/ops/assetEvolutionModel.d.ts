import type { AssetRecord } from '../assetstore/provider.js';
import type { ReviewRecord, ReviewState } from '../assetstore/reviewLedger.js';
export declare const ASSET_EVOLUTION_SCHEMA = "evolver.asset-evolution.v1";
export type EvolutionState = 'trial' | 'approved' | 'eligible' | 'rejected' | 'paused' | 'removed' | 'untrusted';
export type ReuseOutcome = 'success' | 'failed' | 'mismatched' | 'stale' | 'unsafe';
export type EvidenceTier = 'L1' | 'L2' | 'L3' | 'none';
export type ReuseStage = 'immediate' | 'retention' | 'correction';
export type TimelineKind = 'born' | 'trial' | 'approved' | 'rejected' | 'paused' | 'removed' | 'reused' | 'reuse_failed' | 'derived';
type EdgeKind = 'same_family' | 'reused_in_distillation' | 'reverified' | 'observed_reuse';
type EdgeEvidence = 'logical_id' | 'generation_meta.reused_asset_ids' | 'capsule.content.source_asset_ids' | 'capsule.reused_asset_id';
export type CapsuleKind = 'distilled' | 'observed_reuse' | 'host_verified' | 'reverified' | 'cycle' | 'other';
/** A root event as the read model needs it; payloads are untrusted and parsed field by field. */
export interface EvolutionRootEvent {
    type: string;
    ts: string;
    eventId?: string;
    payload?: Record<string, unknown>;
}
export interface AssetEvolutionSources {
    assets: boolean;
    review: boolean;
    rootEvents: boolean;
    /** A read or a list hit its cap: lists are partial, and an asset's absence proves nothing. */
    truncated: boolean;
}
/** Everything the projection joins, already read by the caller. `reviewHistory` is in append order. */
export interface AssetEvolutionInput {
    now: number;
    genes: readonly AssetRecord[];
    capsules: readonly AssetRecord[];
    reviewHistory: readonly ReviewRecord[];
    provenance: ReadonlyMap<string, {
        trusted: boolean;
        source: string;
    }>;
    events: readonly EvolutionRootEvent[];
    sources: AssetEvolutionSources;
}
export interface ReuseStats {
    success: number;
    failed: number;
    lastAt: string | null;
    hosts: string[];
}
export interface DeliveryStats {
    count: number;
    lastAt: string | null;
    entrypoints?: Record<string, number>;
}
export interface AssetSummary {
    assetId: string;
    logicalId: string | null;
    type: string;
    title: string;
    category: string | null;
    origin: string;
    state: EvolutionState;
    versions: number;
    reuse: ReuseStats;
    applications: {
        success: number;
        failed: number;
        inert: number;
        observed: number;
    };
    deliveries: DeliveryStats;
    promotion: {
        successes: number;
        needed: number;
        blockedBy: number;
    } | null;
    parents: number;
    children: number;
    bornAt: string | null;
    lastActivityAt: string | null;
}
export interface NetworkAssetReuse {
    assetId: string;
    reuse: ReuseStats;
}
export interface TimelineEntry {
    at: string;
    kind: TimelineKind;
    assetId: string;
    logicalId: string | null;
    title: string | null;
    by: string | null;
    reason: string | null;
    outcome: ReuseOutcome | null;
    host: string | null;
    tier: EvidenceTier | null;
    stage: ReuseStage | null;
    related: string[];
}
export interface AssetEvolutionOverview {
    generatedAt: string;
    sources: AssetEvolutionSources;
    totals: {
        families: number;
        assets: number;
        states: Record<EvolutionState, number>;
        reuse: {
            success: number;
            failed: number;
            localAssets: number;
            networkAssets: number;
            hosts: string[];
        };
        deliveries: number;
        derived: number;
    };
    loop: {
        lastDeliveryAt: string | null;
        lastReuseAt: string | null;
        deliveriesSinceLastReuse: number;
    };
    assets: AssetSummary[];
    network: NetworkAssetReuse[];
    timeline: TimelineEntry[];
}
export interface ReviewView {
    state: ReviewState;
    at: string;
    by: string | null;
    reason: string | null;
}
export interface LineageEdge {
    from: string;
    to: string;
    kind: EdgeKind;
    evidence: EdgeEvidence;
}
export interface AssetDossier {
    /** Which ledgers this read reached; a counter from an unreachable ledger is unknown, not zero. */
    sources: AssetEvolutionSources;
    asset: AssetSummary | null;
    network: NetworkAssetReuse | null;
    members: Array<{
        assetId: string;
        ordinal: number;
        origin: string;
        current: boolean;
        review: ReviewView | null;
    }>;
    edges: LineageEdge[];
    related: Array<{
        assetId: string;
        logicalId: string | null;
        title: string | null;
        relation: 'parent' | 'child';
    }>;
    capsules: Array<{
        assetId: string;
        id: string;
        kind: CapsuleKind;
        outcome: 'success' | 'failed';
        score: number;
        summary: string;
    }>;
    reuses: Array<{
        at: string;
        outcome: ReuseOutcome;
        host: string | null;
        tier: EvidenceTier | null;
        stage: ReuseStage | null;
        taskId: string | null;
        cycleId: string | null;
    }>;
    deliveries: DeliveryStats;
    review: ReviewView[];
    timeline: TimelineEntry[];
}
export {};