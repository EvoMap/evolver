import { assetstore, events, material as materialNs, schema } from '@evomap/evolver-core';
declare const GROUP = "material.package_gene";
type PackageBlocker = 'usage' | 'material_not_found' | 'unsupported_material' | 'source_unavailable' | 'draft_unavailable' | 'gene_intake_rejected' | 'missing_capsule_evidence' | 'gene_not_found' | 'capsule_not_found' | 'capsule_gene_mismatch' | 'publish_bundle_invalid' | 'publish_bundle_blocked' | 'cycle_not_solidified' | 'write_failed';
interface MaterialPackageOptions {
    materialId: string;
    write: boolean;
    json: boolean;
}
export interface MaterialGenePackageDeps {
    materialStore?: materialNs.MaterialStore;
    store?: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    readSource?: (path: string) => string;
    env?: NodeJS.ProcessEnv;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
}
interface PackageAssetSummary {
    assetId: string;
    id?: string;
    type: 'Gene' | 'Capsule';
}
type PackageReviewState = 'quarantined' | 'approved' | 'rejected' | 'default_approved' | 'unproven_preview';
interface MaterialGenePackageResult {
    ok: boolean;
    group: typeof GROUP;
    mode: 'preview' | 'write';
    materialId?: string;
    sourceKind?: schema.Material['sourceKind'];
    kind?: schema.Material['kind'];
    publishable: boolean;
    blockers: PackageBlocker[];
    gene?: PackageAssetSummary & {
        reviewState?: PackageReviewState;
        written?: boolean;
    };
    capsule?: PackageAssetSummary & {
        outcomeStatus?: string;
    };
    publishCommand?: string;
    sourceCount?: number;
    signalCount?: number;
    message?: string;
}
type MaterialGenePackageBuildResult = {
    result: MaterialGenePackageResult;
    code: number;
};
export declare function buildMaterialGenePackage(opts: MaterialPackageOptions, deps?: MaterialGenePackageDeps): Promise<MaterialGenePackageBuildResult>;
export declare function runMaterialCommand(argv: readonly string[], deps?: MaterialGenePackageDeps): Promise<number>;
export {};