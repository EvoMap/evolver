import type { GeneReadSnapshot } from './boundedSnapshot.js';
import type { AssetRecord } from './provider.js';
import type { ReviewRecord } from './reviewLedger.js';
export declare const SUPERSEDED = "superseded";
/** A complete Gene from `gene build`, kept exactly as authored: deep-valid, with the content id it claims. */
export declare function authoredGene(raw: unknown): AssetRecord;
/** The Capsule distilled with that Gene, bound to it by content id or logical id. */
export declare function authoredCapsule(raw: unknown, gene: AssetRecord): AssetRecord;
/** An AntiGene from `gene distill` for a failed fragment: a guardrail with its content id, never steps to follow. */
export declare function authoredAntiGene(raw: unknown): AssetRecord;
export type ExperienceKind = 'Gene' | 'AntiGene';
/** What the experience library shows for a Gene, or for an AntiGene: its guardrails stand where steps would be. */
export declare function experienceFields(asset: Readonly<Record<string, unknown>>): {
    kind: ExperienceKind;
    title: string;
    conditions: string[];
    steps: string[];
    signals: string[];
};
export declare function supersedesOf(gene: Readonly<Record<string, unknown>>): string | null;
export declare function experienceTitle(gene: Readonly<Record<string, unknown>>): string;
/** The Gene an approval withholds from recall, when the approved Gene names a predecessor still in use. */
export declare function supersededTarget(gene: AssetRecord, snapshot: GeneReadSnapshot): string | null;
export declare function supersededReview(assetId: string, at: string): ReviewRecord;
/** Which approved Gene replaced each Gene: the one whose approval wrote the `superseded` record, in the same operation. */
export declare function supersededBy(snapshot: GeneReadSnapshot, assetId: string): string | null;