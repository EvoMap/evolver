import { wire } from '@evomap/evolver-core';
/** V1→V2 asset path / schema mapping — Refs #684 (R4 Asset-format, 5 sub-items). */
export const CURRENT_WIRE_SCHEMA_VERSION = wire.SCHEMA_VERSION;
export const V1_EVENT_SCHEMA_VERSION_EXAMPLE = '1.6.0';
/** Machine-readable mapping for the five issue rows. */
export const ASSET_FORMAT_MAP = [
    {
        id: 1,
        severity: 'major',
        v1: 'events.jsonl in the selected current store, or repository legacy assets/gep (EvolutionEvent plus ValidationReport rows; stored schema often 1.6.0)',
        v2: 'content-addressed EvolutionEvent JSONL; existing schema_version is preserved',
        migrate: `import-v1 injects ${CURRENT_WIRE_SCHEMA_VERSION} only when schema_version is missing; frozen hash mismatches remain untrusted; ValidationReport rows are validated, counted, and preserved in the V1 source`,
    },
    {
        id: 2,
        severity: 'cosmetic',
        v1: 'capsules.json(.l) in the selected current store, then repository legacy fallback',
        v2: 'LocalJsonlProvider Capsule stream + migration/v1_extensions.jsonl for non-schema fields',
        migrate: 'import-v1 combines the capsules envelope and JSONL overlay by id; JSONL wins',
    },
    {
        id: 3,
        severity: 'cosmetic',
        v1: 'candidates.jsonl in the selected current store, then repository legacy fallback',
        v2: 'material/candidates (selection input — not wire assets)',
        migrate: 'import-v1 skips candidates (report.candidatesSkipped=true); operators keep pool outside wire store',
    },
    {
        id: 4,
        severity: 'cosmetic',
        v1: 'failed_capsules.json',
        v2: 'no automatic wire mapping',
        migrate: 'not imported; preserve the V1 source for explicit operator recovery',
    },
    {
        id: 5,
        severity: 'cosmetic',
        v1: 'genes.json(.l) in the selected current store, then repository legacy fallback',
        v2: 'LocalJsonlProvider Gene JSONL (content-addressed)',
        migrate: 'import-v1 combines the genes envelope and JSONL overlay by id; JSONL wins',
    },
];
/** V1 path components used to select one current workspace plus the repository legacy fallback. */
export const V1_GEP_SOURCE_LAYOUT = {
    workspaceCurrent: ['workspace', '.evolver', 'gep'],
    rootCurrent: ['.evolver', 'gep'],
    legacy: ['assets', 'gep'],
};
export const V1_GEP_WIRE_SOURCES = {
    Gene: { envelope: { basename: 'genes.json', key: 'genes' }, jsonl: 'genes.jsonl' },
    Capsule: { envelope: { basename: 'capsules.json', key: 'capsules' }, jsonl: 'capsules.jsonl' },
    EvolutionEvent: { jsonl: 'events.jsonl' },
};