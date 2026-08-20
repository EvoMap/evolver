/**
 * 资产 wire 层. SSOT = @evomap/gep-sdk/schemas/*.schema.json (D19).
 * 字段一律 snake_case 锁定 (asset_id 跨实现契约); 本仓不发明 wire 字段, 只镜像 + 重导出工具.
 */
import type { GeneRoutingHint, GeneToolPolicy, GenerationMeta, GeneClaim, GeneScope, GeneRuntimeProfile, GeneVerifierProfile } from './geneHints.js';
export { SCHEMA_VERSION, canonicalize, computeAssetId, verifyAssetId } from '@evomap/gep-sdk';
export type GepCategory = typeof import('@evomap/gep-sdk').GEP_GENE_CATEGORIES[number];
export type OutcomeStatus = typeof import('@evomap/gep-sdk').GEP_OUTCOME_STATUSES[number];
export type SourceType = typeof import('@evomap/gep-sdk').GEP_SOURCE_TYPES[number];
export type RiskLevel = typeof import('@evomap/gep-sdk').GEP_RISK_LEVELS[number];
export type CapsuleVisibility = typeof import('@evomap/gep-sdk').GEP_CAPSULE_VISIBILITIES[number];
export type CapsuleCostTier = typeof import('@evomap/gep-sdk').GEP_CAPSULE_COST_TIERS[number];
export interface CapsuleAuthor {
    handle: string;
    evox_install_id: string;
}
/** Gene = 基因型/方法论 (gene.schema.json). */
export interface Gene {
    type: 'Gene';
    schema_version: string;
    id: string;
    category: GepCategory;
    signals_match: string[];
    preconditions?: string[];
    strategy: string[];
    constraints: {
        max_files: number;
        forbidden_paths: string[];
    };
    validation: string[];
    summary?: string;
    epigenetic_marks?: string[];
    learning_history?: unknown[];
    anti_patterns?: unknown[];
    routing_hint?: GeneRoutingHint | null;
    tool_policy?: GeneToolPolicy | null;
    generation_meta?: GenerationMeta | null;
    model_name?: string;
    claims?: GeneClaim[] | null;
    scope?: GeneScope | null;
    runtime_profile?: GeneRuntimeProfile | null;
    verifier_profile?: GeneVerifierProfile | null;
    asset_id: string;
}
/** Capsule = 表现型/纯进化产物 (capsule.schema.json). */
export interface Capsule {
    type: 'Capsule';
    schema_version: string;
    id: string;
    trigger: string[];
    gene: string;
    summary: string;
    confidence: number;
    blast_radius: {
        files: number;
        lines: number;
    };
    outcome: {
        status: OutcomeStatus;
        score: number;
    };
    resolution_status?: 'pending' | 'suppressed_observationally' | 'resolved_by_evidence' | 'regressed' | 'inconclusive';
    proof_of_work?: unknown;
    visibility?: CapsuleVisibility | null;
    scope?: string[] | null;
    cost_tier?: CapsuleCostTier | null;
    pack_of?: string[] | null;
    author?: CapsuleAuthor | null;
    execution_trace?: unknown[];
    trigger_context?: unknown;
    asset_id: string;
    [k: string]: unknown;
}
/** EvolutionEvent = 世代记录 (evolution-event.schema.json). outcome 真值在此 (硬化 A4). */
export interface EvolutionEvent {
    type: 'EvolutionEvent';
    schema_version: string;
    id: string;
    parent?: string | null;
    intent: GepCategory;
    signals: string[];
    genes_used: string[];
    mutation_id: string;
    blast_radius: {
        files: number;
        lines: number;
    };
    outcome: {
        status: OutcomeStatus;
        score: number;
    };
    capsule_id?: string | null;
    source_type: SourceType;
    asset_id: string;
    [k: string]: unknown;
}
/** Mutation = 变异 (瞬态, mutation.schema.json). */
export interface Mutation {
    type: 'Mutation';
    id: string;
    category: GepCategory;
    trigger_signals: string[];
    target: string;
    expected_effect: string;
    risk_level: RiskLevel;
}
export { validateWire, validateWireDeep, wireSchemaIssues, schemaProperties, type WireValidation, type WireSchemaIssue, } from './schemaGate.js';
export { ROUTING_TIERS, REASONING_LEVELS, TOOL_POLICY_SEVERITIES, GENERATION_SOURCES, CLAIM_KINDS, ENV_CLASSES, VERIFIER_DECISIONS, GENE_HINT_FIELDS, normalizeRoutingHint, normalizeToolPolicy, normalizeGenerationMeta, normalizeClaims, normalizeGeneScope, normalizeRuntimeProfile, normalizeVerifierProfile, stripGeneHints, type RoutingTier, type ReasoningLevel, type ToolPolicySeverity, type GenerationSource, type ClaimKind, type EnvClass, type VerifierDecision, type GeneRoutingHint, type GeneToolPolicy, type GeneGenerationHeuristics, type GenerationMeta, type GeneClaim, type GeneScope, type GeneRuntimeProfile, type GeneVerifierProfile, } from './geneHints.js';