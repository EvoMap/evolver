// skill2gep B3a/B3b — the wiring that turns a SKILL.md + its execution into a POOLED (quarantined) gene + capsule.
// skill2gep.ts stays pure (parse / synthesize / capsule contracts); this layer owns the side effects: skill-dir
// discovery (B3b-i), gene intake (structural + dedup + asset_id via algo.intakeGene), the human-review gate
// (ReviewLedger.quarantineIfAbsent — a skill-distilled gene is a draft like any other, withheld until approved),
// the gene.distilled audit event, and persisting the capsule evidence. The session→execution-trace extraction that
// turns a discovered skill into a Capsule-bearing distillation is B3b-ii (a separate slice).
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { assetstore, algo, events } from '@evomap/evolver-core';
import { parseSkillMd, reverseDistill, } from './skill2gep.js';
import { reviewLedgerForStore } from './reviewFilter.js';
/**
 * Discover procedural skills under the given roots (B3b-i): each `<root>/skills/<name>/SKILL.md`. Pure enumeration
 * + read — it does NOT distill (that is the deliberate, invocation-bounded wiring of B3b-ii: a host has hundreds of
 * skills on disk, so we never auto-draft a gene from every file just for existing). Absent/unreadable roots and
 * unreadable skills are silently skipped (a daemon must not crash on a missing home dir). Deduped by absolute path;
 * sorted by `name` for a stable scan order.
 */
export function discoverSkills(roots) {
    const byPath = new Map();
    for (const root of roots) {
        const skillsRoot = join(resolve(root), 'skills');
        let entries;
        try {
            entries = readdirSync(skillsRoot);
        }
        catch {
            continue;
        } // no skills/ under this root → skip
        for (const name of entries) {
            const mdPath = join(skillsRoot, name, 'SKILL.md');
            try {
                if (!statSync(mdPath).isFile())
                    continue; // a `skills/<name>` that is not a skill dir → skip
                if (byPath.has(mdPath))
                    continue;
                byPath.set(mdPath, { name, path: mdPath, skillMd: readFileSync(mdPath, 'utf8') });
            }
            catch { /* not a dir / no SKILL.md / unreadable → skip */ }
        }
    }
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Distill a SKILL.md + its real execution into a pooled gene (+ capsule evidence) (B3a). The gene lands
 * QUARANTINED — same human-review gate (A2a/A2b) as every auto-draft, so a skill-distilled gene never enters a
 * live agent's context unapproved. A Capsule is persisted only when reverseDistill's red lines pass (real,
 * forgery-clear success whose trace covers Gene.validation); otherwise the gene is recorded alone with a
 * diagnostic. Idempotent on the gene (intake dedups by signals; quarantine is sticky). NEVER throws on a bad
 * skill — returns errors instead, so a daemon scanning many skills is not broken by one.
 */
export async function recordSkillDistillation(skillMd, execution, deps, opts = {}) {
    const review = deps.review ?? reviewLedgerForStore(deps.store);
    const parsed = parseSkillMd(skillMd, { completeValidationPlan: opts.completeValidationPlan });
    const { gene, capsule, capsuleDiagnostic } = reverseDistill(parsed, execution, opts);
    const diag = capsuleDiagnostic ? (capsuleDiagnostic.detail ?? capsuleDiagnostic.reason) : null;
    if (!gene)
        return { geneId: null, geneAssetId: null, quarantined: false, capsuleId: null, capsuleDiagnostic: diag, errors: ['gene synthesis refused (strict mode or empty)'] };
    const semanticIdentity = opts.geneIdentity === 'semantic';
    const existing = semanticIdentity
        ? []
        : (await deps.store.list('Gene', 1000)).map((g) => ({
            id: typeof g['id'] === 'string' ? String(g['id']) : undefined,
            signals_match: Array.isArray(g['signals_match']) ? g['signals_match'] : [],
        }));
    const candidate = semanticIdentity ? { ...gene, id: semanticGeneId(gene) } : gene;
    const r = algo.intakeGene(candidate, existing);
    if (!r.ok || !r.gene)
        return { geneId: null, geneAssetId: null, quarantined: false, capsuleId: null, capsuleDiagnostic: diag, errors: r.errors };
    const assetId = String(r.gene.asset_id);
    const geneId = typeof r.gene.id === 'string' ? r.gene.id : assetId;
    try {
        // Failure-safe order (Bugbot #143). intakeGene dedups an already-pooled gene by signal overlap, so a retry can
        // only recover a partial write while the gene is NOT yet pooled. We therefore commit the gene LAST and emit the
        // audit AT MOST ONCE (guarded by the spine) BEFORE it: if any step before the gene write fails, the gene stays
        // unpooled → a retry re-runs everything (audit skipped if already on the spine, capsule re-put idempotently by
        // content address) and finishes cleanly — never an un-audited pooled gene, never a duplicate audit.
        const alreadyAudited = deps.ingestor
            .readAll()
            .some((e) => e.type === 'gene.distilled' && String(e.payload?.['assetId']) === assetId);
        if (!alreadyAudited) {
            await deps.ingestor.ingest({
                type: 'gene.distilled',
                payload: { geneId, assetId: r.gene.asset_id, category: r.gene.category, source: 'skill2gep', skill: parsed.name },
                human: { title: `skill-distilled gene ${geneId} (UNPROVEN — awaiting review)`.slice(0, 80), severity: 'info' },
                actor: { kind: 'machine', id: 'skill2gep' },
            });
        }
        // Quarantine AFTER the audit (no dangling quarantine for a never-audited asset): a skill-distilled gene is a
        // draft, withheld from inject/cursor (A2a) until a human `review --approve`s it. Sticky across a re-distill.
        review.quarantineIfAbsent(assetId);
        let capsuleId = null;
        if (capsule) {
            // intakeGene may REWRITE the gene id (it only keeps an id already in the distilled-prefix namespace), so the
            // capsule — built from the pre-intake candidate id — must be re-pointed to the POOLED gene id, else it
            // references a gene that is not in the store.
            const pooledCapsule = {
                ...capsule,
                ...(semanticIdentity ? { id: semanticCapsuleId(geneId, capsule.id) } : {}),
                gene: geneId,
            };
            await deps.store.put(pooledCapsule); // evidence; references the (gated) gene
            capsuleId = pooledCapsule.id;
        }
        await deps.store.put(r.gene); // gene LAST = the commit point; until it lands, a retry re-runs the above
        return { geneId, geneAssetId: assetId, quarantined: true, capsuleId, capsuleDiagnostic: diag, errors: [] };
    }
    catch (e) {
        // A write failed before the gene was committed → keep it recoverable: report the error so the caller retries.
        return { geneId: null, geneAssetId: null, quarantined: false, capsuleId: null, capsuleDiagnostic: diag, errors: [e instanceof Error ? e.message : String(e)] };
    }
}
function semanticGeneId(gene) {
    const constraints = gene.constraints ?? {};
    const normalized = JSON.stringify({
        category: String(gene.category ?? ''),
        signals: [...(gene.signals_match ?? [])].map((value) => String(value).trim().toLowerCase()).filter(Boolean).sort(),
        strategy: [...(gene.strategy ?? [])].map((value) => String(value).trim()).filter(Boolean),
        summary: String(gene.summary ?? ''),
        preconditions: [...(gene.preconditions ?? [])].map((value) => String(value).trim()).filter(Boolean),
        constraints: {
            maxFiles: Number(constraints.max_files ?? 0),
            forbiddenPaths: [...(constraints.forbidden_paths ?? [])].map((value) => String(value).trim()).filter(Boolean).sort(),
        },
        validation: [...(gene.validation ?? [])].map((value) => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean),
    });
    return `gene_distilled_${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}
function semanticCapsuleId(geneId, originalCapsuleId) {
    const digest = createHash('sha256').update(`${geneId}|${originalCapsuleId}`).digest('hex').slice(0, 24);
    return `cap_s2g_${digest}`;
}
/** Resolve a `--skill` argument (a SKILL.md file OR a skill directory) to the SKILL.md path. */
function resolveSkillMdPath(skillArg) {
    const p = resolve(skillArg);
    try {
        if (statSync(p).isDirectory())
            return join(p, 'SKILL.md');
    }
    catch { /* missing → reported by the read */ }
    return p;
}
/**
 * `evolver skill-distill --skill <SKILL.md|dir> [--execution <json|@file>] [--scenario <name>] [--strict]` (B3b-ii).
 *
 * The faithful v2 analog of v1's skill-run hook: the CALLER (a skill-run hook, or an operator) supplies the REAL
 * execution — session logs carry no skill-invocation marker, so an after-the-fact daemon cannot honestly attribute
 * a trace to a skill (verified against on-disk logs). Passing the execution in keeps the Capsule's evidence real.
 * With no `--execution`, only the (quarantined) gene is drafted — no Capsule, which is correct: no evidence, no
 * proof. Output reports the gene id, quarantine state, and either the capsule id or why it was withheld.
 */
export async function runSkillDistill(argv, injected = {}) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a?.startsWith('--')) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[a.slice(2)] = next;
                i++;
            }
            else
                flags[a.slice(2)] = '';
        }
    }
    if (!flags['skill']) {
        process.stderr.write('用法: evolver skill-distill --skill <SKILL.md|dir> [--execution <json|@file>] [--scenario <name>] [--strict]\n');
        return 1;
    }
    const mdPath = resolveSkillMdPath(flags['skill']);
    let skillMd;
    try {
        skillMd = readFileSync(mdPath, 'utf8');
    }
    catch (e) {
        process.stderr.write(`skill-distill: cannot read SKILL.md: ${mdPath} (${e instanceof Error ? e.message : String(e)})\n`);
        return 1;
    }
    // The execution is the caller's REAL run record. Accept inline JSON or `@file`. Absent → Gene-only (no evidence).
    let execution = {};
    const exFlag = flags['execution'];
    if (exFlag) {
        let raw = exFlag;
        if (exFlag.startsWith('@')) {
            try {
                raw = readFileSync(resolve(exFlag.slice(1)), 'utf8');
            }
            catch (e) {
                process.stderr.write(`skill-distill: cannot read --execution file: ${exFlag.slice(1)} (${e instanceof Error ? e.message : String(e)})\n`);
                return 1;
            }
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            process.stderr.write(`skill-distill: --execution is not valid JSON (${e instanceof Error ? e.message : String(e)})\n`);
            return 1;
        }
        // A cast alone lets null / arrays / primitives through (Bugbot #145): a malformed hook payload would then pool
        // a gene yet silently never produce the intended capsule. Require a plain object so a bad payload fails loudly.
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            process.stderr.write('skill-distill: --execution must be a JSON object (got ' + (parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed) + ')\n');
            return 1;
        }
        execution = parsed;
    }
    const store = injected.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const deps = {
        store,
        review: injected.review ?? reviewLedgerForStore(store),
        ingestor: injected.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() }),
    };
    const opts = { strict: 'strict' in flags };
    if (flags['scenario'])
        opts.scenario = flags['scenario'];
    const res = await recordSkillDistillation(skillMd, execution, deps, opts);
    if (!res.geneId) {
        process.stderr.write(`skill-distill: no gene produced — ${res.errors.join('; ') || 'refused'}\n`);
        return 1;
    }
    process.stdout.write(`skill-distill: gene ${res.geneId} ${res.quarantined ? 'QUARANTINED (awaiting `evolver review --approve`)' : 'recorded'}\n`);
    if (res.capsuleId)
        process.stdout.write(`  → capsule ${res.capsuleId} (real execution evidence)\n`);
    else {
        // "(no execution provided)" only fits when the flag was OMITTED. With a flag present but no status (e.g. `{}`),
        // reverseDistill skips the capsule WITHOUT a diagnostic — say so honestly rather than claim none was provided (Bugbot #145).
        const why = res.capsuleDiagnostic ? ` (${res.capsuleDiagnostic})`
            : exFlag ? ' (execution lacks a status — no capsule)'
                : ' (no execution provided)';
        process.stdout.write(`  → no capsule${why}\n`);
    }
    if (res.errors.length)
        process.stdout.write(`  ⚠ ${res.errors.join('; ')}\n`);
    return 0;
}
const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
/** Derive a readable skill name from a gene when the target SKILL.md has none to preserve. */
function deriveSkillName(gene) {
    const sigs = strList(gene['signals_match']);
    if (sigs.length)
        return sigs.slice(0, 3).join('-').replace(/_/g, '-');
    const id = String(gene['id'] ?? 'distilled-skill').replace(/^gene_(?:s2g|distilled)_/, '').replace(/^gene_/, '');
    return id || 'distilled-skill';
}
/**
 * Render a gene back into SKILL.md text (B4) — the reverse of `parseSkillMd`. Sections use headings `parseSkillMd`
 * recognizes, so the round-trip recovers signals / validation / preconditions. `opts.name` preserves an existing
 * skill's identity on update; otherwise a readable name is derived. Pure — the proven-gate + file write live in
 * `runSkillMdUpdate`.
 */
export function geneToSkillMd(gene, opts = {}) {
    const name = (opts.name && opts.name.trim()) || deriveSkillName(gene);
    const display = titleCase(name);
    let desc = String(gene['summary'] ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (desc.length < 10)
        desc = 'AI agent skill distilled from a human-approved, capsule-proven evolution gene.';
    const signals = strList(gene['signals_match']);
    const preconditions = strList(gene['preconditions']);
    const strategy = strList(gene['strategy']);
    const avoid = strList(gene['avoid']); // read defensively — not on GeneCandidate, but stored genes may carry it
    const validation = strList(gene['validation']);
    const constraints = (gene['constraints'] && typeof gene['constraints'] === 'object') ? gene['constraints'] : null;
    const out = ['---', `name: ${name}`, `description: ${desc}`, '---', '', `# ${display}`, '', desc, ''];
    if (signals.length) {
        out.push('## When to Use', '', `- When your project encounters: ${signals.slice(0, 4).map((s) => `\`${s}\``).join(', ')}`, '');
        out.push('## Trigger Signals', '', ...signals.map((s) => `- \`${s}\``), '');
    }
    if (preconditions.length)
        out.push('## Preconditions', '', ...preconditions.map((p) => `- ${p}`), '');
    if (strategy.length)
        out.push('## Strategy', '', ...strategy.map((s, i) => `${i + 1}. ${s}`), '');
    if (avoid.length)
        out.push('## Avoid', '', ...avoid.map((a) => `- ${a}`), '');
    if (constraints) {
        const c = [];
        if (constraints['max_files'] != null)
            c.push(`- Max files per invocation: ${String(constraints['max_files'])}`);
        const fp = strList(constraints['forbidden_paths']);
        if (fp.length)
            c.push(`- Forbidden paths: ${fp.map((p) => `\`${p}\``).join(', ')}`);
        if (c.length)
            out.push('## Constraints', '', ...c, '');
    }
    if (validation.length) {
        out.push('## Validation', '');
        for (const cmd of validation)
            out.push('```bash', cmd, '```', '');
    }
    out.push('## Metadata', '', `- Category: \`${String(gene['category'] ?? 'innovate')}\``, `- Gene: \`${String(gene['id'] ?? '')}\``, '');
    out.push('---', '', '*Maintained by Evolver — regenerated from a human-approved, capsule-proven gene.*', '');
    return out.join('\n');
}
/**
 * `evolver skill-md-update --gene <id> --skill <SKILL.md|dir> [--dry-run]` (B4).
 *
 * Write a PROVEN gene back into its SKILL.md — closing the skill2gep loop (SKILL.md → gene → proven → improved
 * SKILL.md). **Proven gate**: refuses unless the gene is human-APPROVED (`review --approve`) AND has ≥1 Capsule
 * (real execution evidence). An unproven/unapproved draft must NEVER overwrite a human's SKILL.md — that is exactly
 * the confident-hallucination the system guards against. On update, the existing SKILL.md's frontmatter `name` is
 * preserved (stable identity); `--dry-run` prints the rendered SKILL.md without writing.
 */
export async function runSkillMdUpdate(argv, injected = {}) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a?.startsWith('--')) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[a.slice(2)] = next;
                i++;
            }
            else
                flags[a.slice(2)] = '';
        }
    }
    if (!flags['gene'] || !flags['skill']) {
        process.stderr.write('用法: evolver skill-md-update --gene <id> --skill <SKILL.md|dir> [--dry-run]\n');
        return 1;
    }
    const store = injected.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = injected.review ?? reviewLedgerForStore(store);
    const genes = await store.list('Gene', 10000);
    const gene = genes.find((g) => String(g['id']) === flags['gene'] || String(g['asset_id']) === flags['gene']);
    if (!gene) {
        process.stderr.write(`skill-md-update: gene not found: ${flags['gene']}\n`);
        return 1;
    }
    const geneId = String(gene['id']);
    const assetId = String(gene['asset_id']);
    // Proven gate — both legs required. A gene reaches a human's SKILL.md only after a human approved it AND a real
    // execution produced capsule evidence for it; an unproven draft writing to disk is the red line we defend.
    if (!review.isApproved(assetId)) {
        process.stderr.write(`skill-md-update: gene ${geneId} is NOT approved — run \`evolver review --approve ${assetId}\` first (refusing to overwrite a SKILL.md with an unapproved gene)\n`);
        return 1;
    }
    const capsules = await store.search({ kind: 'Capsule', gene: geneId, limit: 1 });
    if (capsules.length === 0) {
        process.stderr.write(`skill-md-update: gene ${geneId} has NO capsule evidence — it is unproven; refusing to write it to a SKILL.md\n`);
        return 1;
    }
    const target = resolveSkillMdPath(flags['skill']);
    const existed = existsSync(target);
    // Preserve an existing skill's identity (frontmatter name) across the update.
    let name;
    if (existed) {
        try {
            name = parseSkillMd(readFileSync(target, 'utf8')).name || undefined;
        }
        catch { /* unreadable → derive */ }
    }
    const md = geneToSkillMd(gene, name ? { name } : {});
    if ('dry-run' in flags) {
        process.stdout.write(md.endsWith('\n') ? md : md + '\n');
        process.stdout.write(`\n(dry-run — would ${existed ? 'update' : 'create'} ${target})\n`);
        return 0;
    }
    try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, md);
    }
    catch (e) {
        process.stderr.write(`skill-md-update: cannot write ${target} (${e instanceof Error ? e.message : String(e)})\n`);
        return 1;
    }
    process.stdout.write(`skill-md-update: ${existed ? 'updated' : 'created'} ${target} from proven gene ${geneId}\n`);
    return 0;
}