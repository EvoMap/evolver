import { assetstore, events } from '@evomap/evolver-core';
import { type SkillExecution, type SynthesizeOptions } from './skill2gep.js';
export interface DiscoveredSkill {
    /** The skill's directory name (`<dir>/skills/<name>/`) — its canonical id, used for dedup. */
    name: string;
    /** Absolute path to the SKILL.md. */
    path: string;
    /** Raw SKILL.md content (read once at discovery; the caller parses it). */
    skillMd: string;
}
/**
 * Discover procedural skills under the given roots (B3b-i): each `<root>/skills/<name>/SKILL.md`. Pure enumeration
 * + read — it does NOT distill (that is the deliberate, invocation-bounded wiring of B3b-ii: a host has hundreds of
 * skills on disk, so we never auto-draft a gene from every file just for existing). Absent/unreadable roots and
 * unreadable skills are silently skipped (a daemon must not crash on a missing home dir). Deduped by absolute path;
 * sorted by `name` for a stable scan order.
 */
export declare function discoverSkills(roots: readonly string[]): DiscoveredSkill[];
export interface SkillDistillDeps {
    /** Asset store the gene (+ capsule) is written to. */
    store: assetstore.AssetStoreProvider;
    /** Review ledger the gene draft is quarantined in. Default co-located with the store. */
    review?: assetstore.ReviewLedger;
    /** Ingestor for the gene.distilled audit event. */
    ingestor: events.Ingestor;
}
export interface SkillDistillResult {
    geneId: string | null;
    /** True when the gene landed in the pool QUARANTINED (awaiting human review). */
    quarantined: boolean;
    capsuleId: string | null;
    /** Why no Capsule was emitted (forgery / coverage), if applicable. */
    capsuleDiagnostic: string | null;
    errors: string[];
}
/**
 * Distill a SKILL.md + its real execution into a pooled gene (+ capsule evidence) (B3a). The gene lands
 * QUARANTINED — same human-review gate (A2a/A2b) as every auto-draft, so a skill-distilled gene never enters a
 * live agent's context unapproved. A Capsule is persisted only when reverseDistill's red lines pass (real,
 * forgery-clear success whose trace covers Gene.validation); otherwise the gene is recorded alone with a
 * diagnostic. Idempotent on the gene (intake dedups by signals; quarantine is sticky). NEVER throws on a bad
 * skill — returns errors instead, so a daemon scanning many skills is not broken by one.
 */
export declare function recordSkillDistillation(skillMd: string, execution: SkillExecution, deps: SkillDistillDeps, opts?: SynthesizeOptions & {
    scenario?: string;
}): Promise<SkillDistillResult>;
/**
 * `evolver skill-distill --skill <SKILL.md|dir> [--execution <json|@file>] [--scenario <name>] [--strict]` (B3b-ii).
 *
 * The faithful v2 analog of v1's skill-run hook: the CALLER (a skill-run hook, or an operator) supplies the REAL
 * execution — session logs carry no skill-invocation marker, so an after-the-fact daemon cannot honestly attribute
 * a trace to a skill (verified against on-disk logs). Passing the execution in keeps the Capsule's evidence real.
 * With no `--execution`, only the (quarantined) gene is drafted — no Capsule, which is correct: no evidence, no
 * proof. Output reports the gene id, quarantine state, and either the capsule id or why it was withheld.
 */
export declare function runSkillDistill(argv: readonly string[], injected?: Partial<SkillDistillDeps>): Promise<number>;
/**
 * Render a gene back into SKILL.md text (B4) — the reverse of `parseSkillMd`. Sections use headings `parseSkillMd`
 * recognizes, so the round-trip recovers signals / validation / preconditions. `opts.name` preserves an existing
 * skill's identity on update; otherwise a readable name is derived. Pure — the proven-gate + file write live in
 * `runSkillMdUpdate`.
 */
export declare function geneToSkillMd(gene: Record<string, unknown>, opts?: {
    name?: string;
}): string;
/**
 * `evolver skill-md-update --gene <id> --skill <SKILL.md|dir> [--dry-run]` (B4).
 *
 * Write a PROVEN gene back into its SKILL.md — closing the skill2gep loop (SKILL.md → gene → proven → improved
 * SKILL.md). **Proven gate**: refuses unless the gene is human-APPROVED (`review --approve`) AND has ≥1 Capsule
 * (real execution evidence). An unproven/unapproved draft must NEVER overwrite a human's SKILL.md — that is exactly
 * the confident-hallucination the system guards against. On update, the existing SKILL.md's frontmatter `name` is
 * preserved (stable identity); `--dry-run` prints the rendered SKILL.md without writing.
 */
export declare function runSkillMdUpdate(argv: readonly string[], injected?: Partial<SkillDistillDeps>): Promise<number>;