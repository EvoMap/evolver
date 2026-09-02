// skill2gep (#117-B) — reverse-distill a SKILL.md (+ a real execution trace) into GEP assets (Gene + Capsule),
// ported from v1 `src/gep/skill2gep.js`. This slice (B1) ports `parseSkillMd`: SKILL.md text → a structured
// intermediate (frontmatter / sections / signals / strategy / validation / preconditions / avoid). PURE (no I/O),
// faithful to v1 (golden-tested). B2 adds `synthesizeGene` + the Capsule contracts (trace-only / empty→Gene-only /
// validation-coverage); the human-review + real-trace red lines live there.
import { createHash } from 'node:crypto';
import { bootstrap, verify } from '@evomap/evolver-core';
const { isValidationCommandAllowed } = verify;
// Re-export for backward compatibility (used by tests)
export { isValidationCommandAllowed };
/** Max strategy steps kept from a skill (v1 parity: MAX_STRATEGY_STEPS). */
export const MAX_STRATEGY_STEPS = 28;
/** Gene id prefix for skill-distilled genes (v1 SKILL2GEP_ID_PREFIX). */
const SKILL2GEP_ID_PREFIX = 'gene_s2g_';
/** Default max-files constraint for a distilled gene (v1 skillDistiller.DISTILLED_MAX_FILES). */
const SKILL_MAX_FILES = 12;
const WORKFLOW_SECTION_KEYWORDS = [
    'workflow', 'strategy', 'steps', 'procedure', 'quick start', 'how to',
    'human gate', 'output contract', 'release', 'rollback', 'promotion',
    'process each', 'request process', 'request path',
    '工作流', '流程', '步骤', '核心方法', '方法', '快速规则', '规则',
    '输出门', '输出门槛', '人工确认', '人工门', '回滚', '发布', '晋级',
];
// 安全与请求章节属于策略，而不是可选说明；丢失它们会让蒸馏后的 Skill 缺少审批和信任边界契约。
const GOVERNANCE_SECTION_KEYWORDS = [
    'security', 'safety', 'credential', 'approval', 'adversarial',
    'trust boundary', 'content isolation', 'untrusted content',
    'protect x data', 'protect data', 'data protection', 'privacy', 'legal basis', 'consent',
];
function sectionHeadingMatches(heading, keyword) {
    if (/^[a-z0-9 ]+$/i.test(keyword)) {
        const forms = keyword === 'verify'
            ? ['verify', 'verification', 'verifications']
            : [keyword, `${keyword}s`];
        return forms.some((form) => new RegExp('(^|[^a-z0-9])' + form + '($|[^a-z0-9])', 'i').test(heading));
    }
    return heading.includes(keyword);
}
/**
 * Parse a SKILL.md into a structured intermediate — faithful port of v1 `parseSkillMd`. Pure. Section keywords are
 * matched against lower-cased headings and include CJK synonyms (skills authored in Chinese), though the signal
 * tokenizer keeps ASCII `[a-z0-9_]` only, so a CJK skill's signals come from its (English) frontmatter description.
 */
export function parseSkillMd(skillMd, opts = {}) {
    const text = String(skillMd || '');
    // --- frontmatter (--- … --- block of key: value lines, keys lower-cased) ---
    const frontmatter = {};
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
    let body = text;
    if (fmMatch) {
        fmMatch[1].split(/\n/).forEach((line) => {
            const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
            if (kv)
                frontmatter[kv[1].trim().toLowerCase()] = kv[2].trim();
        });
        body = text.slice(fmMatch[0].length);
    }
    // --- sections: split by `##+ heading`; content before the first heading is `_preamble`. A repeated heading
    //     resets its block (last occurrence wins), matching v1. ---
    const lines = { _preamble: [] };
    const sectionOccurrences = [{ key: '_preamble', lines: [] }];
    let currentKey = '_preamble';
    let currentOccurrence = sectionOccurrences[0];
    body.split(/\n/).forEach((line) => {
        const hdr = line.match(/^##+\s+(.+?)\s*$/);
        if (hdr) {
            currentKey = hdr[1].toLowerCase().trim();
            lines[currentKey] = [];
            currentOccurrence = { key: currentKey, lines: [] };
            sectionOccurrences.push(currentOccurrence);
        }
        else {
            (lines[currentKey] ??= []).push(line);
            currentOccurrence.lines.push(line);
        }
    });
    const sections = {};
    for (const k of Object.keys(lines))
        sections[k] = lines[k].join('\n').trim();
    /** First section whose (lower-cased) heading contains any keyword. */
    const pickSection = (keywords) => {
        for (const kw of keywords)
            for (const k of Object.keys(sections))
                if (k.indexOf(kw) !== -1)
                    return sections[k];
        return '';
    };
    /** ALL matching sections concatenated in document order, de-duped by key (keeps a governance tail like
     *  "## Human Gate" that a first-match would drop). */
    const pickSectionsAll = (keywords) => {
        const seen = new Set();
        const out = [];
        for (const k of Object.keys(sections)) {
            if (keywords.some((kw) => k.indexOf(kw) !== -1) && !seen.has(k)) {
                seen.add(k);
                out.push(sections[k]);
            }
        }
        return out.join('\n');
    };
    /** Every matching section occurrence, including repeated headings, in document order. */
    const pickSectionOccurrencesAll = (keywords) => sectionOccurrences
        .filter(({ key }) => keywords.some((kw) => sectionHeadingMatches(key, kw)))
        .map(({ lines: occurrenceLines }) => occurrenceLines.join('\n').trim())
        .join('\n');
    /** Every markdown list item → one step, in document order, length-bounded (default 5..300). */
    const extractSteps = (block, opts) => {
        const minLen = opts && typeof opts.minLen === 'number' ? opts.minLen : 5;
        const maxLen = opts && typeof opts.maxLen === 'number' ? opts.maxLen : 300;
        const steps = [];
        for (const line of String(block || '').split(/\n/)) {
            const m = line.match(/^\s*(?:\d+\.|[-*])\s+(.+?)\s*$/);
            if (!m)
                continue;
            const txt = m[1].trim();
            if (txt.length >= minLen && txt.length <= maxLen)
                steps.push(txt);
        }
        return steps;
    };
    /** 将只有 prose 的安全章节中的声明式防护规则保留为有界策略语句。 */
    const extractGovernanceStatements = (blocks) => {
        const statements = [];
        for (const block of blocks) {
            let fenceMarker;
            for (const rawLine of String(block || '').split(/\n/)) {
                const line = rawLine.trim();
                if (fenceMarker !== undefined) {
                    const closingFence = line.match(/^(`+|~+)$/);
                    if (closingFence !== null
                        && closingFence[1][0] === fenceMarker.char
                        && closingFence[1].length >= fenceMarker.length) {
                        fenceMarker = undefined;
                    }
                    continue;
                }
                const openingFence = line.match(/^(`{3,}|~{3,})(?:.*)?$/);
                if (openingFence !== null) {
                    fenceMarker = { char: openingFence[1][0], length: openingFence[1].length };
                    continue;
                }
                if (!line || /^<\/?[A-Z0-9_-]+(?:>|\s)/.test(line))
                    continue;
                const listItem = line.match(/^(?:\d+\.|[-*])\s+(.+?)\s*$/);
                const statement = (listItem ? listItem[1] : line).replace(/^>\s?/, '').trim();
                if (statement.length >= 5 && statement.length <= 300 && !statements.includes(statement)) {
                    statements.push(statement);
                }
            }
        }
        return statements;
    };
    const matchingGovernanceBlocks = sectionOccurrences
        .filter(({ key }) => GOVERNANCE_SECTION_KEYWORDS.some((kw) => sectionHeadingMatches(key, kw)))
        .map(({ lines: occurrenceLines }) => occurrenceLines.join('\n').trim());
    const selectStrategySteps = (workflowSteps, governanceSteps) => {
        const workflow = [...new Set(workflowSteps)];
        const governance = [...new Set(governanceSteps)];
        if (workflow.length + governance.length <= MAX_STRATEGY_STEPS)
            return [...workflow, ...governance];
        return [...governance.slice(0, MAX_STRATEGY_STEPS), ...workflow]
            .slice(0, MAX_STRATEGY_STEPS);
    };
    // --- signals: frontmatter.description + the trigger/when section, tokenized to [a-z0-9_] (3..40, has-letter) ---
    const signals = [];
    const signalSource = (frontmatter['description'] || '') + '\n' + pickSection([
        'trigger', 'when to use', 'when', 'use when', 'scenario',
        '何时使用', '什么时候使用', '触发条件', '触发', '使用场景', '核心目标', '适用',
    ]);
    signalSource.split(/[`,.\n]/).forEach((tok) => {
        const s = tok.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        if (s.length >= 3 && s.length <= 40 && /[a-z]/.test(s) && signals.indexOf(s) === -1 && !/^\d+$/.test(s))
            signals.push(s);
    });
    // --- strategy: workflow + governance-tail sections; avoid: anti-pattern sections ---
    const strategy = selectStrategySteps(extractSteps(pickSectionsAll(WORKFLOW_SECTION_KEYWORDS)), extractGovernanceStatements(matchingGovernanceBlocks));
    const avoid = extractSteps(pickSectionsAll([
        'avoid', 'pitfall', 'anti-pattern', 'common mistake', 'do not', 'forbidden', "don't",
        '不要做', '不要', '常见错误', '避免', '陷阱', '禁止',
    ]));
    // --- validation: the bash/sh fenced commands in the validation/test section (non-comment, ≤300) ---
    const validation = [];
    const validationKeywords = ['validation', 'test', 'verify', 'check', '校验', '验证', '测试', '检查'];
    const valBlock = opts.completeValidationPlan
        ? pickSectionOccurrencesAll(validationKeywords)
        : pickSection(validationKeywords);
    const fenceRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```/g;
    let fence;
    while ((fence = fenceRe.exec(valBlock)) !== null) {
        fence[1].split(/\n/).forEach((ln) => {
            const t = ln.trim();
            if (t && !t.startsWith('#') && t.length <= 300)
                validation.push(t);
        });
    }
    // --- preconditions: no length gate (short prereqs like "Git"/"npm" survive) ---
    const preconditions = extractSteps(pickSection(['precondition', 'requirement', 'prerequisite', '前置条件', '前置', '先决条件', '要求']), { minLen: 1, maxLen: Infinity });
    return {
        frontmatter,
        sections,
        name: frontmatter['name'] || (sections['_preamble'] || '').split(/\n/)[0].replace(/^#+\s*/, '').trim(),
        description: frontmatter['description'] || '',
        signals_match: signals.slice(0, 8),
        strategy: strategy.slice(0, MAX_STRATEGY_STEPS),
        avoid: avoid.slice(0, 5),
        validation: opts.completeValidationPlan ? validation : validation.slice(0, 5),
        preconditions: preconditions.slice(0, 4),
    };
}
/** Stable slug for a skill-distilled gene id (v1 slugify). */
function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}
/** Infer a gene category from signals + description (v1 inferCategory): priority repair > innovate > optimize,
 *  substring match (catches inflections + underscore signal tokens like `log_error`). */
export function inferCategory(signals, description) {
    const hay = ((description || '') + ' ' + (signals || []).join(' ')).toLowerCase();
    if (/error|fail|bug|crash|broken|incident|regress|debug|repair|fix/.test(hay))
        return 'repair';
    if (/feature|\badd\b|implement|new capability|capability|innovate|greenfield|prototype/.test(hay))
        return 'innovate';
    return 'optimize';
}
// ── v1 #302: provenance classification + quality scoring (aligned with TaskGenome Bench §3.1) ────────────────
// A Gene's value depends on WHERE it came from, not on being short. Evolved Genes (distilled from a verified
// solve→fail→mutate→pass trajectory) beat Skills +8.7..+15.5pp; reference-distilled Genes are 3-11pp WORSE.
/**
 * Classify a Gene's provenance from its execution trace (faithful port of v1 #302 `classifyProvenance`). PURE,
 * mechanical, reads only trajectory fields (status / blast_radius / rollouts / mutation_log / reference_distilled):
 *   evolved   — a verified success that overcame a real failure (mutation_log non-empty, or rollouts went fail→pass)
 *               with a non-zero blast radius. The corrective_insight that flipped the outcome is the payload.
 *   distilled — has execution evidence (a status, rollouts, mutation_log, or an explicit reference_distilled flag)
 *               but did NOT clear the evolved bar. A first-try success or a zero-blast success lands here.
 *   manual    — no execution evidence at all (pure SKILL.md transcription).
 */
export function classifyProvenance(execution) {
    const rollouts = Array.isArray(execution?.rollouts) ? execution.rollouts : [];
    const mutationLog = Array.isArray(execution?.mutation_log) ? execution.mutation_log : [];
    const status = execution?.status ? String(execution.status) : null;
    const blast = execution?.blast_radius || null;
    const hasBlast = blast !== null && (Number(blast.files || 0) > 0 || Number(blast.lines || 0) > 0);
    const failedRollouts = rollouts.filter((r) => r && String(r.status) === 'failed').length;
    const passedRollouts = rollouts.some((r) => r && String(r.status) === 'success');
    const overcameFailure = mutationLog.length > 0 || (failedRollouts > 0 && (passedRollouts || status === 'success'));
    if (status === 'success' && hasBlast && overcameFailure)
        return 'evolved';
    // Anything carrying real execution evidence but not meeting the evolved bar is "distilled" — it has evidence, just
    // not a verified fail→pass-with-blast trajectory. A success with mutation_log but ZERO blast radius must therefore
    // be distilled, not manual (otherwise a zero-blast success would masquerade as a no-evidence transcription).
    if ((execution?.reference_distilled === true) || status !== null || rollouts.length > 0 || mutationLog.length > 0) {
        return 'distilled';
    }
    return 'manual';
}
/**
 * Build the corrective-insight strategy for an evolved Gene (v1 #302 `buildEvolvedStrategy`). The insight that
 * flipped fail→pass goes FIRST (the case-study shape), then the Skill's own workflow steps. De-duped, length-bounded.
 */
function buildEvolvedStrategy(parsed, execution) {
    const strategy = [];
    const insight = execution?.corrective_insight ? String(execution.corrective_insight).trim() : '';
    if (insight.length >= 5)
        strategy.push(insight.length <= 300 ? insight : insight.slice(0, 297) + '...');
    (parsed.strategy || []).forEach((s) => { if (strategy.indexOf(s) === -1)
        strategy.push(s); });
    return strategy;
}
/**
 * Turn the error categories a trajectory overcame into verifiable preconditions (v1 #302 `preconditionsFromErrors`):
 * "A prior attempt failed with X; verify this condition is handled before trusting the approach."
 */
function preconditionsFromErrors(execution) {
    const mutationLog = Array.isArray(execution?.mutation_log) ? execution.mutation_log : [];
    const out = [];
    const seen = new Set();
    for (const err of mutationLog) {
        const e = String(err || '').trim();
        if (!e || seen.has(e))
            continue;
        seen.add(e);
        out.push(`A prior attempt failed with "${e.replace(/_/g, ' ')}"; verify this condition is handled before trusting the approach.`);
        if (out.length >= 4)
            break;
    }
    return out;
}
/**
 * Quality score in [0,1] (v1 #302 `computeQualityScore`). Evolved trajectories with a recorded corrective insight
 * score highest (0.7 baseline + bonuses); pure transcription with no evidence scores lowest (0.3).
 */
function computeQualityScore(source, parsed, execution) {
    const ex = execution || {};
    let score;
    if (source === 'evolved') {
        score = 0.7;
        if (ex.corrective_insight && String(ex.corrective_insight).trim().length >= 5)
            score += 0.15;
        const depth = Array.isArray(ex.mutation_log) ? ex.mutation_log.length
            : (Array.isArray(ex.rollouts) ? ex.rollouts.length - 1 : 0);
        if (depth >= 1)
            score += Math.min(0.15, depth * 0.05);
    }
    else if (source === 'distilled') {
        score = 0.4;
    }
    else {
        score = 0.3;
    }
    const strategySteps = (parsed.strategy || []).length;
    if (strategySteps >= 4)
        score += 0.05;
    if ((parsed.avoid || []).length >= 1)
        score += 0.05;
    return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}
/**
 * Assemble a draft GeneCandidate from a parsed skill + its execution trace (B2a — faithful port of v1
 * `synthesizeGene`'s Gene half, mapped onto v2 `GeneCandidate`; pool intake/dedup/asset_id is the caller's
 * `algo.intakeGene`). Signals merge skill + trace. Provenance is classified from the execution trace (v1 #302):
 *   - evolved → corrective_insight leads strategy; mutation_log → verifiable preconditions.
 *   - otherwise → Skill transcription (legacy behavior), tagged so consumers know it was not learned from a real run.
 *
 * Validation keeps only the allowed `node …` commands (v1 #302 DISTILL contract: do NOT inject a bogus
 * `node --version` fallback — an empty validation list is the CORRECT outcome for a Gene with nothing runnable,
 * not a near-trivial check that would silently pass). STRICT mode + no allowed validation → refuse (errors, no gene).
 * `avoid` is dropped here (not on GeneCandidate); `generation_meta` carries the provenance + quality metadata.
 */
export function synthesizeGene(parsed, execution = {}, opts = {}) {
    const traceSignals = Array.isArray(execution?.signals) ? execution.signals : [];
    // Trace signals come from the REAL execution (ground truth), so put them FIRST — the 8-slot cap below then never
    // starves them in favor of the skill's DECLARED signals. (Improves on v1's skill-first merge, which dropped
    // trace-only signals once the skill already filled 8 slots — Bugbot #141.)
    const mergedSignals = [...new Set([...traceSignals, ...(parsed.signals_match || [])])];
    // ── v1 #302: classify provenance, then branch strategy/preconditions on it ────────────────────────────────
    const source = classifyProvenance(execution);
    let strategy;
    let preconditions;
    if (source === 'evolved') {
        strategy = buildEvolvedStrategy(parsed, execution);
        preconditions = preconditionsFromErrors(execution).concat(parsed.preconditions || []);
    }
    else {
        strategy = [...(parsed.strategy || [])];
        preconditions = (parsed.preconditions && parsed.preconditions.length > 0)
            ? [...parsed.preconditions]
            : [`Skill ${parsed.name || 'unknown'} has just been executed locally`];
    }
    if (strategy.length < 3) {
        strategy.push('Identify the dominant trigger signals from the Skill description.');
        strategy.push('Apply the smallest targeted change that satisfies the Skill workflow.');
        strategy.push('Run the Skill validation commands and abort if any fails.');
    }
    const rawValidations = Array.isArray(parsed.validation) ? parsed.validation : [];
    const normalizedValidations = rawValidations.map((v) => String(v || '').trim()).filter(Boolean);
    const sanitizedValidations = normalizedValidations.map((command) => verify.sanitizeExecutionCommand(command));
    if (sanitizedValidations.some((command) => command.changed || command.blocked)) {
        return {
            gene: null,
            errors: ['execution_validation_unsafe: validation commands must not contain credential-bearing arguments'],
            generation_meta: { source, quality_score: computeQualityScore(source, parsed, execution) },
        };
    }
    const allowedValidations = sanitizedValidations.map((command) => command.value)
        .filter((command) => isValidationCommandAllowed(command));
    if (opts.strict && allowedValidations.length === 0) {
        return {
            gene: null,
            errors: ['strict mode: no allowed validation commands found in the Skill (GEP validation only permits "node " prefixes). Rewrite the Skill validation section, or drop strict.'],
            generation_meta: { source, quality_score: computeQualityScore(source, parsed, execution) },
        };
    }
    // v1 #302 DISTILL contract: an empty validation list is correct when nothing runnable exists — do NOT inject a
    // bogus `node --version` fallback. A trivially-passing check would silently defeat the Capsule coverage red line.
    const validation = allowedValidations;
    const slug = slugify(parsed.name || opts.skillName || 'skill');
    // Quality score + heuristics for the generation_meta block (v1 #302).
    const qualityScore = computeQualityScore(source, parsed, execution);
    const mutationLog = Array.isArray(execution?.mutation_log) ? execution.mutation_log : [];
    const heuristics = {
        strategy_steps: (parsed.strategy || []).length,
        avoid_count: (parsed.avoid || []).length,
        validation_declared_count: rawValidations.length,
        validation_runnable_count: allowedValidations.length,
        signals_extracted: (parsed.signals_match || []).length,
        preconditions_extracted: (parsed.preconditions || []).length,
        trajectory_depth: mutationLog.length > 0 ? mutationLog.length
            : (Array.isArray(execution?.rollouts) ? Math.max(0, execution.rollouts.length - 1) : 0),
        has_corrective_insight: Boolean(execution?.corrective_insight && String(execution.corrective_insight).trim().length >= 5),
    };
    const generation_meta = {
        source,
        quality_score: qualityScore,
        quality_heuristics: heuristics,
        ...(mutationLog.length > 0 ? { overcame_errors: [...mutationLog] } : {}),
    };
    const gene = {
        id: SKILL2GEP_ID_PREFIX + slug,
        category: inferCategory(mergedSignals, parsed.description),
        signals_match: mergedSignals.slice(0, 8),
        strategy: strategy.slice(0, MAX_STRATEGY_STEPS),
        summary: (parsed.description || strategy[0] || 'Reusable strategy distilled from Skill').slice(0, 200),
        preconditions,
        constraints: { max_files: opts.maxFiles ?? SKILL_MAX_FILES, forbidden_paths: ['.git', 'node_modules'] },
        validation,
        generation_meta,
    };
    return { gene, errors: [], generation_meta };
}
// ── B2b: Capsule from REAL execution evidence + the forgery / coverage red lines ─────────────────────────────
/** Gene id prefix for skill-distilled capsules (v1 CAPSULE_ID_PREFIX). */
const CAPSULE_ID_PREFIX = 'cap_s2g_';
const normalizeCmd = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shortHash = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 10);
/**
 * Forgery guard (v1 detectForgery) — RED LINE #1. A status=success Capsule with no real execution evidence is
 * refused outright: empty trace, zero blast radius, or no recorded exit code. The core defence against an agent
 * hallucinating a successful run to pad the registry. Non-success executions are honest, so not checked. Returns
 * the rejection reason, or null when clean.
 */
export function detectForgery(execution, evidenceMode = 'workflow_execution') {
    const trace = Array.isArray(execution?.trace) ? execution.trace : [];
    const files = Number(execution?.blast_radius?.files ?? 0);
    const lines = Number(execution?.blast_radius?.lines ?? 0);
    if ((execution?.status ?? 'failed') !== 'success')
        return null;
    if (trace.length === 0)
        return 'empty_execution_trace';
    if (evidenceMode === 'workflow_execution' && files === 0 && lines === 0)
        return 'zero_blast_radius_with_success';
    if (!trace.some((t) => Number.isInteger(t?.exit)))
        return 'no_exit_code_in_trace';
    return null;
}
const buildContentSummary = (trace, blast) => {
    const okCount = trace.filter((t) => Number(t?.exit) === 0).length;
    return `Ran ${trace.length} validation command(s), ${okCount} passed. Blast radius: ${Number(blast?.files ?? 0)} files, ${Number(blast?.lines ?? 0)} lines.`;
};
/**
 * Assemble a Capsule from a gene + real execution evidence (v1 assembleCapsule) — RED LINE #2/#3. Every
 * `Gene.validation` command MUST appear in `execution.trace` (whitespace-normalized exact match) AND carry an
 * integer exit code; otherwise refuse → the caller degrades to Gene-only. No coverage = no Capsule.
 */
export function assembleCapsule(gene, execution, opts = {}) {
    const trace = Array.isArray(execution?.trace) ? execution.trace : [];
    const geneValidations = Array.isArray(gene.validation) ? gene.validation : [];
    const traceCmds = new Set(trace.map((t) => normalizeCmd(t?.cmd)));
    const missing = geneValidations.filter((v) => !traceCmds.has(normalizeCmd(v)));
    if (missing.length > 0)
        return { ok: false, reason: 'validation_coverage_missing', missing: [...missing] };
    for (const v of geneValidations) {
        // Consider ALL trace rows for this command, not just the first: coverage holds if ANY run of it recorded an
        // integer exit — a duplicate earlier row without one must not mask a later real result (Bugbot #142).
        const matches = trace.filter((tt) => normalizeCmd(tt?.cmd) === normalizeCmd(v));
        if (matches.length > 0 && !matches.some((t) => Number.isInteger(t.exit)))
            return { ok: false, reason: 'validation_missing_exit_code', cmd: v };
    }
    const scoreRaw = execution?.score != null ? Number(execution.score) : null;
    const status = execution?.status ?? 'failed';
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(1, scoreRaw)) : (status === 'success' ? 0.8 : 0.2);
    const files = Number(execution?.blast_radius?.files ?? 0);
    const lines = Number(execution?.blast_radius?.lines ?? 0);
    const geneIdSuffix = String(gene.id).replace(/^gene_[a-z0-9]+_/, '').replace(/^gene_/, '');
    // The capsule id distinguishes DIFFERENT runs of the same gene. Prefer the real start time; when it is absent,
    // fall back to a DETERMINISTIC digest of the execution itself (status/score/blast/trace) — NOT a fresh wall clock
    // — so re-distilling the same execution (e.g. a retry after a write failure) yields the SAME id and store.put
    // dedups by content address, instead of persisting a duplicate capsule (Bugbot #143).
    const stableExecKey = execution?.started_at ??
        JSON.stringify({ s: status, sc: score, f: files, l: lines, t: trace.map((t) => `${normalizeCmd(t?.cmd)}:${Number.isInteger(t?.exit) ? t.exit : 'x'}`) });
    const idKey = shortHash(`${String(gene.id)}|${stableExecKey}`);
    const capsule = {
        type: 'Capsule',
        id: CAPSULE_ID_PREFIX + slugify(geneIdSuffix) + '_' + idKey,
        gene: String(gene.id),
        trigger: Array.isArray(execution?.trigger) ? [...execution.trigger] : [...(gene.signals_match ?? [])].slice(0, 6),
        summary: execution?.summary || `Applied ${gene.id} on scenario ${opts.scenario || 'local skill invocation'}`,
        confidence: Math.max(0, Math.min(1, score)),
        blast_radius: { files, lines },
        outcome: { status, score },
        success_reason: status === 'success'
            ? (execution?.success_reason || (opts.evidenceMode === 'validation_only'
                ? 'All declared validation commands passed in the local verifier.'
                : 'Skill workflow completed and all declared validations passed.'))
            : null,
        env_fingerprint: bootstrap.captureEnvFingerprint(),
        source_type: opts.evidenceMode === 'validation_only' ? 'skill2gep_validation' : 'skill2gep_hook',
        strategy: Array.isArray(gene.strategy) ? [...gene.strategy] : [],
        content: execution?.content_summary || buildContentSummary(trace, execution?.blast_radius),
        execution_trace: trace.map((t, i) => ({
            step: Number.isInteger(t?.step) ? t.step : i + 1,
            cmd: String(t?.cmd ?? ''),
            exit: Number.isInteger(t?.exit) ? t.exit : null,
            stdout_tail: t?.stdout_tail ? String(t.stdout_tail).slice(0, 300) : '',
        })),
        schema_version: '1.6.0',
    };
    const sanitized = verify.sanitizeExecutionPayload(capsule);
    if (sanitized.blocked)
        return { ok: false, reason: 'execution_trace_unsafe' };
    return { ok: true, capsule: sanitized.value };
}
/**
 * Reverse-distill a parsed SKILL.md + its execution into GEP assets — the PURE core of v1 runOnSkillInvocation
 * (file read / persist / idempotency are B3's wiring). RED LINE: a Capsule is emitted ONLY when the execution is a
 * real, forgery-clear success AND its trace covers every Gene.validation; otherwise Gene-only + a diagnostic. The
 * human-review gate stays the caller's — a skill-distilled Gene is a draft like any other.
 */
export function reverseDistill(parsed, execution = {}, opts = {}) {
    const { gene, errors } = synthesizeGene(parsed, execution, opts);
    if (!gene)
        return { gene: null, capsule: null, capsuleDiagnostic: null, errors };
    let capsule = null;
    let capsuleDiagnostic = null;
    if (execution?.status) {
        const forgery = detectForgery(execution, opts.evidenceMode);
        if (forgery) {
            capsuleDiagnostic = { reason: 'capsule_rejected_forgery', detail: forgery };
        }
        else {
            const r = assembleCapsule(gene, execution, {
                ...(opts.scenario ? { scenario: opts.scenario } : {}),
                ...(opts.evidenceMode ? { evidenceMode: opts.evidenceMode } : {}),
            });
            if (r.ok)
                capsule = r.capsule;
            else
                capsuleDiagnostic = { reason: r.reason, ...(r.missing ? { missing: r.missing } : {}), ...(r.cmd ? { cmd: r.cmd } : {}) };
        }
    }
    return { gene, capsule, capsuleDiagnostic, errors: [] };
}