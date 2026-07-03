import { type algo } from '@evomap/evolver-core';
/** Max strategy steps kept from a skill (v1 parity: MAX_STRATEGY_STEPS). */
export declare const MAX_STRATEGY_STEPS = 28;
/** Structured view of a SKILL.md (the input to gene/capsule synthesis). */
export interface ParsedSkill {
    frontmatter: Record<string, string>;
    sections: Record<string, string>;
    name: string;
    description: string;
    signals_match: string[];
    strategy: string[];
    avoid: string[];
    validation: string[];
    preconditions: string[];
}
/**
 * Parse a SKILL.md into a structured intermediate — faithful port of v1 `parseSkillMd`. Pure. Section keywords are
 * matched against lower-cased headings and include CJK synonyms (skills authored in Chinese), though the signal
 * tokenizer keeps ASCII `[a-z0-9_]` only, so a CJK skill's signals come from its (English) frontmatter description.
 */
export declare function parseSkillMd(skillMd: string): ParsedSkill;
/** Whether a validation command is safe to run as a Gene.validation entry (faithful port of v1
 *  policyCheck.isValidationCommandAllowed): a `node …` command with no command substitution, no shell
 *  metacharacters (outside quoted strings), and no node eval flags (-e/--eval/--print/-p). */
export declare function isValidationCommandAllowed(cmd: string): boolean;
/** Infer a gene category from signals + description (v1 inferCategory): priority repair > innovate > optimize,
 *  substring match (catches inflections + underscore signal tokens like `log_error`). */
export declare function inferCategory(signals: readonly string[], description: string): string;
export interface SynthesizeOptions {
    strict?: boolean;
    skillName?: string;
    maxFiles?: number;
}
export interface SynthesizeResult {
    gene: algo.GeneCandidate | null;
    errors: string[];
}
/**
 * Assemble a draft GeneCandidate from a parsed skill + its execution trace (B2a — faithful port of v1
 * `synthesizeGene`'s Gene half, mapped onto v2 `GeneCandidate`; pool intake/dedup/asset_id is the caller's
 * `algo.intakeGene`). Signals merge skill + trace; strategy pads to ≥3 generic steps; validation keeps only the
 * allowed `node …` commands. STRICT mode + no allowed validation → refuse (errors, no gene); non-strict falls back
 * to `node --version` so Gene.validation is never empty (an empty validation would silently defeat the Capsule
 * coverage check in B2b). `avoid` / `_source` are dropped here (not on GeneCandidate) — re-added if the schema grows.
 */
export declare function synthesizeGene(parsed: ParsedSkill, execution: {
    signals?: readonly string[];
}, opts?: SynthesizeOptions): SynthesizeResult;
/** One real command run while the skill executed. */
export interface SkillTraceEntry {
    step?: number;
    cmd?: string;
    exit?: number;
    stdout_tail?: string;
}
/** The real execution evidence a skill invocation produced (the Capsule's ground truth). */
export interface SkillExecution {
    status?: 'success' | 'failed';
    score?: number;
    started_at?: string;
    trace?: readonly SkillTraceEntry[];
    blast_radius?: {
        files?: number;
        lines?: number;
    };
    trigger?: readonly string[];
    signals?: readonly string[];
    summary?: string;
    success_reason?: string;
    content_summary?: string;
}
/**
 * Forgery guard (v1 detectForgery) — RED LINE #1. A status=success Capsule with no real execution evidence is
 * refused outright: empty trace, zero blast radius, or no recorded exit code. The core defence against an agent
 * hallucinating a successful run to pad the registry. Non-success executions are honest, so not checked. Returns
 * the rejection reason, or null when clean.
 */
export declare function detectForgery(execution: SkillExecution): string | null;
/** A synthesized Capsule (faithful to v1's shape; schema-conform / persistence is B3's concern). */
export interface SkillCapsule {
    type: 'Capsule';
    id: string;
    gene: string;
    trigger: string[];
    summary: string;
    confidence: number;
    blast_radius: {
        files: number;
        lines: number;
    };
    outcome: {
        status: string;
        score: number;
    };
    success_reason: string | null;
    env_fingerprint: unknown;
    source_type: string;
    strategy: string[];
    content: string;
    execution_trace: {
        step: number;
        cmd: string;
        exit: number | null;
        stdout_tail: string;
    }[];
    schema_version: string;
}
export type AssembleResult = {
    ok: true;
    capsule: SkillCapsule;
} | {
    ok: false;
    reason: string;
    missing?: string[];
    cmd?: string;
};
/**
 * Assemble a Capsule from a gene + real execution evidence (v1 assembleCapsule) — RED LINE #2/#3. Every
 * `Gene.validation` command MUST appear in `execution.trace` (whitespace-normalized exact match) AND carry an
 * integer exit code; otherwise refuse → the caller degrades to Gene-only. No coverage = no Capsule.
 */
export declare function assembleCapsule(gene: algo.GeneCandidate, execution: SkillExecution, opts?: {
    scenario?: string;
}): AssembleResult;
export interface ReverseDistillResult {
    gene: algo.GeneCandidate | null;
    capsule: SkillCapsule | null;
    capsuleDiagnostic: {
        reason: string;
        detail?: string;
        missing?: string[];
        cmd?: string;
    } | null;
    errors: string[];
}
/**
 * Reverse-distill a parsed SKILL.md + its execution into GEP assets — the PURE core of v1 runOnSkillInvocation
 * (file read / persist / idempotency are B3's wiring). RED LINE: a Capsule is emitted ONLY when the execution is a
 * real, forgery-clear success AND its trace covers every Gene.validation; otherwise Gene-only + a diagnostic. The
 * human-review gate stays the caller's — a skill-distilled Gene is a draft like any other.
 */
export declare function reverseDistill(parsed: ParsedSkill, execution?: SkillExecution, opts?: SynthesizeOptions & {
    scenario?: string;
}): ReverseDistillResult;