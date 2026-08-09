/** V1→V2 asset path / schema mapping — Refs #684 (R4 Asset-format, 5 sub-items). */
export declare const CURRENT_WIRE_SCHEMA_VERSION: "1.12.1";
export declare const V1_EVENT_SCHEMA_VERSION_EXAMPLE: "1.6.0";
/** Machine-readable mapping for the five issue rows. */
export declare const ASSET_FORMAT_MAP: readonly [{
    readonly id: 1;
    readonly severity: "major";
    readonly v1: "events.jsonl in the selected current store, or repository legacy assets/gep (EvolutionEvent plus ValidationReport rows; stored schema often 1.6.0)";
    readonly v2: "content-addressed EvolutionEvent JSONL; existing schema_version is preserved";
    readonly migrate: "import-v1 injects 1.12.1 only when schema_version is missing; frozen hash mismatches remain untrusted; ValidationReport rows are validated, counted, and preserved in the V1 source";
}, {
    readonly id: 2;
    readonly severity: "cosmetic";
    readonly v1: "capsules.json(.l) in the selected current store, then repository legacy fallback";
    readonly v2: "LocalJsonlProvider Capsule stream + migration/v1_extensions.jsonl for non-schema fields";
    readonly migrate: "import-v1 combines the capsules envelope and JSONL overlay by id; JSONL wins";
}, {
    readonly id: 3;
    readonly severity: "cosmetic";
    readonly v1: "candidates.jsonl in the selected current store, then repository legacy fallback";
    readonly v2: "material/candidates (selection input — not wire assets)";
    readonly migrate: "import-v1 skips candidates (report.candidatesSkipped=true); operators keep pool outside wire store";
}, {
    readonly id: 4;
    readonly severity: "cosmetic";
    readonly v1: "failed_capsules.json";
    readonly v2: "no automatic wire mapping";
    readonly migrate: "not imported; preserve the V1 source for explicit operator recovery";
}, {
    readonly id: 5;
    readonly severity: "cosmetic";
    readonly v1: "genes.json(.l) in the selected current store, then repository legacy fallback";
    readonly v2: "LocalJsonlProvider Gene JSONL (content-addressed)";
    readonly migrate: "import-v1 combines the genes envelope and JSONL overlay by id; JSONL wins";
}];
/** V1 path components used to select one current workspace plus the repository legacy fallback. */
export declare const V1_GEP_SOURCE_LAYOUT: {
    readonly workspaceCurrent: readonly ["workspace", ".evolver", "gep"];
    readonly rootCurrent: readonly [".evolver", "gep"];
    readonly legacy: readonly ["assets", "gep"];
};
export declare const V1_GEP_WIRE_SOURCES: {
    readonly Gene: {
        readonly envelope: {
            readonly basename: "genes.json";
            readonly key: "genes";
        };
        readonly jsonl: "genes.jsonl";
    };
    readonly Capsule: {
        readonly envelope: {
            readonly basename: "capsules.json";
            readonly key: "capsules";
        };
        readonly jsonl: "capsules.jsonl";
    };
    readonly EvolutionEvent: {
        readonly jsonl: "events.jsonl";
    };
};
export type AssetFormatMapEntry = (typeof ASSET_FORMAT_MAP)[number];