import type { AssetRecord } from '../assetstore/provider.js';
import type { ReviewRecord } from '../assetstore/reviewLedger.js';
import type { CapsuleKind, EvolutionState, ReviewView, TimelineKind } from './assetEvolutionModel.js';
/** Every local Gene sharing one logical id, in store order; the last member is the current one. */
export interface Family {
    key: string;
    logicalId: string | null;
    members: AssetRecord[];
    title: string;
    category: string | null;
    origin: string;
    position: number;
}
/** Identifiers are matched, never shown as prose, so they pass unchanged or not at all. */
export declare function printableId(value: unknown): string | null;
export declare function boundedText(value: unknown, max: number): string | null;
export declare function familiesOf(genes: readonly AssetRecord[], provenance: ReadonlyMap<string, {
    source: string;
}>): Family[];
export declare function stateOf(record: ReviewRecord | undefined, trusted: boolean): EvolutionState;
export declare function reviewTimelineKind(record: ReviewRecord): TimelineKind;
export declare function reviewView(record: ReviewRecord): ReviewView;
export declare function memberOrigin(family: Family, member: AssetRecord, ordinal: number, reviewed: boolean, provenance: {
    source: string;
} | undefined): string;
export declare function capsuleKind(capsule: AssetRecord): CapsuleKind;
/** The logical id or content id a Capsule names as its Gene. */
export declare function capsuleGeneRef(capsule: AssetRecord): string | null;