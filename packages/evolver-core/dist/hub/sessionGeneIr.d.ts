import type { GepCategory } from '../wire/index.js';
export declare const SESSION_GENE_IR_VERSION = "session-gene-ir-v1";
type GeneKind = 'fix' | 'change' | 'investigate' | 'configure' | 'refactor';
export type IrRejection = 'ir_invalid' | 'ref_unresolved' | 'contract_not_verbatim' | 'repair_missing';
export interface RecordLine {
    kind: string;
    text: string;
    exit?: number;
    failed?: boolean;
}
interface Cited {
    refs: string[];
}
interface FailureRepair extends Cited {
    signal: string;
    cause: string;
    response: string;
    verification: string;
}
interface CanonicalContract extends Cited {
    kind: 'command' | 'api' | 'config';
    applies_when: string;
    exemplar: string;
}
export interface SessionGeneIr {
    title: string;
    capability_summary: string;
    kind: GeneKind;
    scope: {
        signals: string[];
        use_when: string[];
        do_not_use_when: string[];
    };
    preconditions: string[];
    procedure: Array<Cited & {
        action: string;
    }>;
    failure_repairs: FailureRepair[];
    canonical_contracts: CanonicalContract[];
    project_notes: string[];
    unknowns: string[];
    portability: {
        class: 'portable' | 'project_bound';
        bound_identifiers: string[];
    };
}
export type IrCheck = {
    ok: true;
    ir: SessionGeneIr;
} | {
    ok: false;
    reason: IrRejection;
    field: string;
};
export interface CompiledSessionGene {
    title: string;
    summary: string;
    signals: string[];
    preconditions: string[];
    strategy: string[];
    category: GepCategory;
    anti_patterns: Array<{
        at: string;
        mode: string;
        reason_class: string;
        learning_signals: string[];
    }>;
    epigenetic_marks: string[];
    project_notes: string[];
    unknowns: string[];
    trimmed_strategy_lines: number;
}
export declare function recordLinesOf(value: unknown): RecordLine[];
/** The IR the plugin sent, normalized, or why it cannot become a Gene. */
export declare function checkSessionGeneIr(raw: unknown, record: readonly RecordLine[], projectRoot?: string): IrCheck;
export declare function compileSessionGene(ir: SessionGeneIr): CompiledSessionGene;
/** What a portable Gene must state without this project's names: everything an agent elsewhere reads and follows. */
export declare function portableSurface(ir: SessionGeneIr): string[];
export declare function irQualityMetrics(ir: SessionGeneIr, compiled: CompiledSessionGene): Record<string, number>;
/** A Gene its distiller declared usable only inside the project it came from. */
export declare function isProjectBoundGene(gene: Readonly<Record<string, unknown>>): boolean;
export {};