'use strict';

// skill2gep.js -- Reverse distillation: take a locally-invoked Skill (Cursor,
// Claude Code, Codex, or any procedural SKILL.md) plus the real execution that
// just ran on top of it, and turn it into GEP assets (Gene + Capsule) that can
// be published to the EvoMap community.
//
// This module is the *inverse* of skillDistiller.js:
//   skillDistiller.js : capsule stream       -> Gene (forward distillation)
//   skill2gep.js      : Skill.md + 1 run     -> Gene + Capsule (reverse)
//
// Design contract (mirrors ~/.cursor/skills/skill2gep/SKILL.md):
//   - Gene comes from the Skill text (plus its real execution trace),
//     validated via validateSynthesizedGene().
//   - Capsule is produced ONLY from a real execution trace. If the trace
//     is empty or zero blast radius, we refuse to emit a successful Capsule.
//   - Capsule.execution_trace MUST cover every entry in Gene.validation
//     (whitespace-normalized exact match) or we downgrade to Gene-only.
//   - All assets go through assetStore (which SHA-256-content-addresses them)
//     before upload.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');
const assetStore = require('./assetStore');
const skillDistiller = require('./skillDistiller');
const skillPublisher = require('./skillPublisher');
const envFingerprint = require('./envFingerprint');
const a2a = require('./a2aProtocol');
const audit = require('./skill2gepAudit');

const SKILL2GEP_ID_PREFIX = 'gene_s2g_';

// Max strategy steps kept on a distilled Gene. The old value (10) silently
// truncated multi-section Skills, dropping the *governance* tail
// (candidate-gating, Human Gate, Output Contract, rollback) that lives at the
// end of a well-formed SKILL.md. extractSteps emits each list item flatly, so
// a rich Skill (workflow + governance sections) yields ~25-27 short one-line
// steps; the cap must clear that to keep the tail. 28 covers a well-formed
// SKILL.md while staying compact (short one-liners, far below a full Skill's
// token weight). Genuinely longer Skills are still bounded here.
const MAX_STRATEGY_STEPS = 28;
const CAPSULE_ID_PREFIX = 'cap_s2g_';
const LOG_FILE = 'skill2gep_log.jsonl';
const STATE_FILE = 'skill2gep_state.json';
const DEFAULT_HOOK_TIMEOUT_MS = 25000;

// Paper + docs we cite in the rationale field so agents can explain to users
// why we ship Genes/Capsules in addition to the human-facing Skill.
// NOTE: The paper validates Gene as a control-dense interface on 45 scientific
// code-solving scenarios with Gemini 3.1 Pro/Flash Lite. Generalization to other
// agent domains (web ops, long tool chains, multi-agent negotiation, etc.) is an
// explicit assumption of this tool, not a proven result. The rationale string
// we emit reflects this.
const RATIONALE_LINKS = {
  paper: 'Wang, Ren, Zhang. From Procedural Skills to Strategy Genes. arXiv:2604.15097',
  protocol: 'https://evomap.ai/wiki/16-gep-protocol',
  skill_store: 'https://evomap.ai/wiki/31-skill-store',
};

const RATIONALE_TEXT = ''
  + 'Emitted both the human-facing Skill and the machine-facing GEP asset(s). '
  + 'In the paper\'s domain (45 scientific code-solving scenarios, Gemini 3.1 '
  + 'Pro/Flash Lite; ' + 'Wang, Ren, Zhang, arXiv:2604.15097'
  + '), Gene-as-control-interface outperforms procedural SKILL.md. '
  + 'Generalization to other domains is an assumption of this tool, not a '
  + 'proven result; outcome quality depends on the source Skill and on real '
  + 'execution evidence. See ' + 'https://evomap.ai/wiki/16-gep-protocol'
  + ' for the protocol.';

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) { return fallback; }
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function logPath() { return path.join(paths.getMemoryDir(), LOG_FILE); }
function statePath() { return path.join(paths.getMemoryDir(), STATE_FILE); }

function readState() { return readJsonSafe(statePath(), { seen: {} }); }
function writeState(s) {
  ensureDir(path.dirname(statePath()));
  const tmp = statePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath());
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);
}

function normalizeCmd(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------------------
// Parse a procedural SKILL.md / markdown workflow into structured sections.
// ---------------------------------------------------------------------------
function parseSkillMd(skillMd) {
  const text = String(skillMd || '');

  let frontmatter = {};
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  let body = text;
  if (fmMatch) {
    fmMatch[1].split(/\n/).forEach((line) => {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) frontmatter[kv[1].trim().toLowerCase()] = kv[2].trim();
    });
    body = text.slice(fmMatch[0].length);
  }

  const sections = {};
  let currentKey = '_preamble';
  sections[currentKey] = [];
  body.split(/\n/).forEach((line) => {
    const hdr = line.match(/^##+\s+(.+?)\s*$/);
    if (hdr) {
      currentKey = hdr[1].toLowerCase().trim();
      sections[currentKey] = [];
    } else {
      sections[currentKey].push(line);
    }
  });
  Object.keys(sections).forEach((k) => { sections[k] = sections[k].join('\n').trim(); });

  // Return the FIRST matching section (kept for signals, which wants one block).
  function pickSection(keywords) {
    for (const kw of keywords) {
      for (const k of Object.keys(sections)) {
        if (k.indexOf(kw) !== -1) return sections[k];
      }
    }
    return '';
  }

  // Return ALL matching sections concatenated, in document order. A SKILL.md
  // often spreads positive steps across several headed sections ("Quick
  // Workflow", "Human Gate Defaults", "Output Contract"); picking only the
  // first dropped the governance tail. Each section's title is preserved as a
  // step-context line so a trailing "## Human Gate" still contributes its
  // bullets. De-duplicated by section key.
  function pickSectionsAll(keywords) {
    const seen = new Set();
    const out = [];
    for (const k of Object.keys(sections)) {
      if (keywords.some((kw) => k.indexOf(kw) !== -1) && !seen.has(k)) {
        seen.add(k);
        out.push(sections[k]);
      }
    }
    return out.join('\n');
  }

  // Extract ordered steps from a markdown block: every list item becomes its
  // own step, in document order. This is the pre-PR flat behaviour, kept
  // deliberately simple — an earlier version folded indented sub-bullets into
  // their parent step to look tidier, but that indentation logic grew a long
  // tail of edge cases (section-trim interaction, length-filtered parents,
  // cross-section indentation). Folding was only cosmetic; flat extraction
  // preserves the same governance tail with no indentation reasoning at all.
  // opts.minLen / opts.maxLen bound each item (defaults 5..300, matching the
  // original strategy/avoid gate). Preconditions pass {minLen: 1,
  // maxLen: Infinity} so short prerequisites like "Git"/"npm" survive.
  function extractSteps(block, opts) {
    const minLen = opts && typeof opts.minLen === 'number' ? opts.minLen : 5;
    const maxLen = opts && typeof opts.maxLen === 'number' ? opts.maxLen : 300;
    const steps = [];
    for (const line of String(block || '').split(/\n/)) {
      const m = line.match(/^\s*(?:\d+\.|[-*])\s+(.+?)\s*$/);
      if (!m) continue;
      const txt = m[1].trim();
      if (txt.length >= minLen && txt.length <= maxLen) steps.push(txt);
    }
    return steps;
  }

  const signals = [];
  // Section keywords are matched against lower-cased headings. A SKILL.md may
  // be authored in Chinese (e.g. game-* skills use "## 何时使用" / "## 触发条件"),
  // whose heading key never contains an English token, so the CJK synonyms
  // below are required for those skills to contribute signals/strategy/avoid
  // at all — without them the distiller silently falls back to a thin gene.
  // NOTE: this only fixes *section matching*. The signal tokenizer below still
  // keeps ASCII [a-z0-9_] only, so signals for a Chinese skill come from its
  // (English) frontmatter description, not from CJK body words. CJK signal
  // tokenization needs a word segmenter and is intentionally out of scope here.
  const signalSource = (frontmatter.description || '') + '\n' + pickSection([
    'trigger', 'when to use', 'when', 'use when', 'scenario',
    '何时使用', '什么时候使用', '触发条件', '触发', '使用场景', '核心目标', '适用',
  ]);
  signalSource.split(/[`,.\n]/).forEach((tok) => {
    const s = tok.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (s.length >= 3 && s.length <= 40 && /[a-z]/.test(s) && signals.indexOf(s) === -1 && !/^\d+$/.test(s)) {
      signals.push(s);
    }
  });

  // Strategy spans the workflow AND the governance tail (Human Gate, Output
  // Contract) — concatenate all matching sections so the candidate/gate/rollback
  // discipline survives, and fold nested sub-bullets into their parent step.
  const strategyBlock = pickSectionsAll([
    'workflow', 'strategy', 'steps', 'procedure', 'quick start', 'how to',
    'process each', 'request process', 'request path',
    'human gate', 'output contract', 'release', 'rollback', 'promotion',
    'security', 'safety', 'credential', 'approval', 'adversarial',
    'trust boundary', 'content isolation', 'untrusted content',
    // CJK synonyms: positive workflow + governance-tail headings.
    '工作流', '流程', '步骤', '核心方法', '方法', '快速规则', '规则',
    '输出门', '输出门槛', '人工确认', '人工门', '回滚', '发布', '晋级',
  ]);
  const strategy = extractSteps(strategyBlock);

  const avoidBlock = pickSectionsAll([
    'avoid', 'pitfall', 'anti-pattern', 'common mistake', 'do not', 'forbidden', "don't",
    // CJK synonyms: anti-pattern / "do not" headings.
    '不要做', '不要', '常见错误', '避免', '陷阱', '禁止',
  ]);
  const avoid = extractSteps(avoidBlock);

  const validation = [];
  const valBlock = pickSection(['validation', 'test', 'verify', 'check', '校验', '验证', '测试', '检查']);
  const fenceRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```/g;
  let fm;
  while ((fm = fenceRe.exec(valBlock)) !== null) {
    fm[1].split(/\n/).forEach((ln) => {
      const t = ln.trim();
      if (t && !t.startsWith('#') && t.length <= 300) validation.push(t);
    });
  }

  // Preconditions keep the pre-PR behaviour: no length gate, no folding, so
  // short items like "Git"/"npm" survive and preconditions_extracted is stable.
  const preBlock = pickSection(['precondition', 'requirement', 'prerequisite', '前置条件', '前置', '先决条件', '要求']);
  const preconditions = extractSteps(preBlock, { minLen: 1, maxLen: Infinity });

  return {
    frontmatter: frontmatter,
    sections: sections,
    name: frontmatter.name || (sections['_preamble'] || '').split(/\n/)[0].replace(/^#+\s*/, '').trim(),
    description: frontmatter.description || '',
    signals_match: signals.slice(0, 8),
    strategy: strategy.slice(0, MAX_STRATEGY_STEPS),
    avoid: avoid.slice(0, 5),
    validation: validation.slice(0, 5),
    preconditions: preconditions.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Provenance classification (the central finding of TaskGenome Bench, §3.1):
// a Gene's value depends on WHERE it came from, not on being short.
//
//   evolved   -- distilled from a real solve -> fail -> mutate -> pass
//                trajectory. The corrective insight that flipped the outcome
//                is the high-value payload. These beat Skills (+8.7..+15.5pp).
//   distilled -- transcribed from reference/teacher text with no real failing
//                trajectory to learn from. The report shows these tend to be
//                WORSE than Skills (-3.2..-11.2pp), so we flag/downgrade them.
//   manual    -- pure SKILL.md transcription, no execution evidence at all.
// ---------------------------------------------------------------------------
function classifyProvenance(execution) {
  const ex = execution || {};
  const rollouts = Array.isArray(ex.rollouts) ? ex.rollouts : [];
  const mutationLog = Array.isArray(ex.mutation_log) ? ex.mutation_log : [];
  const status = ex.status ? String(ex.status) : null;
  const blast = ex.blast_radius || null;
  const hasBlast = blast && (Number(blast.files || 0) > 0 || Number(blast.lines || 0) > 0);

  const failedRollouts = rollouts.filter((r) => r && String(r.status) === 'failed').length;
  const passedRollouts = rollouts.some((r) => r && String(r.status) === 'success');
  const overcameFailure = mutationLog.length > 0 || (failedRollouts > 0 && (passedRollouts || status === 'success'));

  if (status === 'success' && hasBlast && overcameFailure) return 'evolved';
  // Anything carrying real execution evidence (a status, a rollout, or an
  // overcome-failure log) but not meeting the evolved bar is "distilled" -- it
  // has evidence, just not a verified fail->pass-with-blast trajectory. Only a
  // run with NO evidence at all is "manual" (per docs/skill2gep.md). A success
  // with mutation_log but zero blast radius must therefore be distilled, not
  // manual.
  if ((ex.reference_distilled === true) || status || rollouts.length > 0 || mutationLog.length > 0) {
    return 'distilled';
  }
  return 'manual';
}

// Build the corrective-insight strategy for an evolved Gene. The insight that
// flipped fail -> pass goes FIRST (the case-study shape), then any
// LLM-distilled steps the host supplied, then the Skill's own workflow steps.
function buildEvolvedStrategy(parsed, execution) {
  const strategy = [];
  const insight = execution && execution.corrective_insight
    ? String(execution.corrective_insight).trim()
    : '';
  if (insight && insight.length >= 5) {
    strategy.push(insight.length <= 300 ? insight : insight.slice(0, 297) + '...');
  }
  const distilled = Array.isArray(execution && execution.distilled_strategy) ? execution.distilled_strategy : [];
  distilled.forEach((s) => {
    const t = String(s || '').trim();
    if (t.length >= 5 && strategy.indexOf(t) === -1) strategy.push(t.length <= 300 ? t : t.slice(0, 297) + '...');
  });
  (parsed.strategy || []).forEach((s) => { if (strategy.indexOf(s) === -1) strategy.push(s); });
  return strategy;
}

// Turn the error categories the trajectory overcame into verifiable
// preconditions ("a prior attempt failed with X; confirm it is handled").
function preconditionsFromErrors(execution) {
  const mutationLog = Array.isArray(execution && execution.mutation_log) ? execution.mutation_log : [];
  const out = [];
  const seen = new Set();
  for (const err of mutationLog) {
    const e = String(err || '').trim();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    const human = e.replace(/_/g, ' ');
    out.push('A prior attempt failed with "' + human + '"; verify this condition is handled before trusting the approach.');
    if (out.length >= 4) break;
  }
  return out;
}

// Quality score in [0,1]. Evolved trajectories with a recorded corrective
// insight score highest; pure transcription with no evidence scores lowest.
function computeQualityScore(source, parsed, execution) {
  const ex = execution || {};
  let score;
  if (source === 'evolved') {
    score = 0.7;
    if (ex.corrective_insight && String(ex.corrective_insight).trim().length >= 5) score += 0.15;
    const depth = Array.isArray(ex.mutation_log) ? ex.mutation_log.length
      : (Array.isArray(ex.rollouts) ? ex.rollouts.length - 1 : 0);
    if (depth >= 1) score += Math.min(0.15, depth * 0.05);
  } else if (source === 'distilled') {
    score = 0.4;
  } else {
    score = 0.3;
  }
  const strategySteps = (parsed.strategy || []).length;
  if (strategySteps >= 4) score += 0.05;
  if ((parsed.avoid || []).length >= 1) score += 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

// ---------------------------------------------------------------------------
// Synthesize a draft Gene from parsed Skill + execution trace.
//
// The strategy/preconditions content depends on provenance:
//   - evolved   -> corrective insight first, overcome-errors -> preconditions.
//   - otherwise -> Skill transcription (legacy behavior), tagged so consumers
//                  know it was not learned from a real run.
//
// Validation is delegated to skillDistiller.validateSynthesizedGene() so that
// we reuse the sanitization, ID-rewrite, forbidden-path, and validation-cmd
// policy rules already hardened there.
// ---------------------------------------------------------------------------
function synthesizeGene(parsed, execution, opts) {
  execution = execution || {};
  opts = opts || {};
  const traceSignals = Array.isArray(execution.signals) ? execution.signals : [];
  const mergedSignals = Array.from(new Set([].concat(parsed.signals_match || [], traceSignals)));

  const source = classifyProvenance(execution);

  // Strategy source depends on provenance. For an evolved trajectory the
  // corrective insight leads (this is what beats a Skill); otherwise we
  // transcribe the Skill's own workflow, tagged so consumers know it was not
  // learned from a real run.
  let strategy;
  if (source === 'evolved') {
    strategy = buildEvolvedStrategy(parsed, execution);
  } else {
    strategy = [];
    (parsed.strategy || []).forEach((s) => strategy.push(s));
  }
  if (strategy.length < 3) {
    strategy.push('Identify the dominant trigger signals from the Skill description.');
    strategy.push('Apply the smallest targeted change that satisfies the Skill workflow.');
    strategy.push('Run the Skill validation commands and abort if any fails.');
  }
  const avoid = Array.isArray(parsed.avoid) ? parsed.avoid.slice(0, 5) : [];

  // Preconditions: for evolved Genes, the error categories the trajectory had
  // to overcome become verifiable preconditions; the Skill's declared
  // preconditions (and any host-distilled ones) are appended.
  let preconditions;
  if (source === 'evolved') {
    preconditions = preconditionsFromErrors(execution)
      .concat(Array.isArray(execution.distilled_preconditions) ? execution.distilled_preconditions.map(String) : [])
      .concat(parsed.preconditions || []);
  } else {
    preconditions = (parsed.preconditions && parsed.preconditions.length > 0)
      ? parsed.preconditions.slice()
      : ['Skill ' + (parsed.name || 'unknown') + ' has just been executed locally'];
  }
  if (preconditions.length === 0) {
    preconditions = ['Skill ' + (parsed.name || 'unknown') + ' has just been executed locally'];
  }

  // Filter validation commands through the same allow-list that
  // validateSynthesizedGene will later apply (node/npm/npx only). Per the
  // Gene-Bench DISTILL contract ("validation: [] only; do not add bogus
  // console-log validations"), we no longer inject a near-trivial
  // 'node --version' when nothing runnable is found -- an empty validation
  // list is the correct outcome for a Gene asset.
  //
  // strict mode is a different consumer: skill2recipes calls us with
  // strict=true because a recipe STEP must carry a real, runnable check (its
  // verify stage executes the commands). An empty validation there would
  // verify nothing, so strict still rejects it.
  const policyCheck = require('./policyCheck');
  const rawValidations = Array.isArray(parsed.validation) ? parsed.validation : [];
  const allowedValidations = rawValidations
    .map((v) => String(v || '').trim())
    .filter((v) => v && policyCheck.isValidationCommandAllowed(v));
  const validation = allowedValidations;
  if (Boolean(opts.strict) && validation.length === 0) {
    return {
      valid: false,
      errors: [
        'strict mode: no allowed validation commands found in the Skill. '
        + 'GEP validation only permits "node "/"npm "/"npx " prefixes. '
        + 'Rewrite the Skill\'s validation section with those, or drop --strict.',
      ],
      gene: null,
      source: source,
    };
  }

  // Quality: a coarse score (used by the quality gate to downgrade thin
  // distilled Genes) plus descriptive heuristics for reviewers.
  const qualityScore = computeQualityScore(source, parsed, execution);
  const qualityHeuristics = {
    strategy_steps: (parsed.strategy || []).length,
    avoid_count: (parsed.avoid || []).length,
    validation_declared_count: rawValidations.length,
    validation_runnable_count: allowedValidations.length,
    signals_extracted: (parsed.signals_match || []).length,
    preconditions_extracted: (parsed.preconditions || []).length,
    trajectory_depth: Array.isArray(execution.mutation_log) ? execution.mutation_log.length
      : (Array.isArray(execution.rollouts) ? Math.max(0, execution.rollouts.length - 1) : 0),
    has_corrective_insight: Boolean(execution.corrective_insight
      && String(execution.corrective_insight).trim().length >= 5),
  };

  const skillSlug = slugify(parsed.name || opts.skillName || 'skill');
  let draft = {
    type: 'Gene',
    id: SKILL2GEP_ID_PREFIX + skillSlug,
    summary: (parsed.description || strategy[0] || 'Reusable strategy distilled from Skill').slice(0, 200),
    category: inferCategory(mergedSignals, parsed.description),
    signals_match: mergedSignals.slice(0, 8),
    preconditions: preconditions.slice(0, 6),
    strategy: strategy.slice(0, MAX_STRATEGY_STEPS),
    avoid: avoid,
    constraints: {
      max_files: opts.maxFiles || skillDistiller.DISTILLED_MAX_FILES,
      forbidden_paths: ['.git', 'node_modules'],
    },
    validation: validation,
    schema_version: '1.6.0',
    _source: {
      kind: 'skill2gep',
      generation_source: source,
      skill_name: parsed.name || null,
      skill_platform: opts.platform || null,
      skill_hash: opts.skillHash ? opts.skillHash : null,
      rationale_paper: RATIONALE_LINKS.paper,
      paper_scope: 'code-science (arXiv:2604.15097, 45 tasks, Gemini 3.1 Pro/Flash Lite)',
      claims_outside_scope: 'assumption',
      quality_score: qualityScore,
      overcame_errors: Array.isArray(execution.mutation_log) ? execution.mutation_log.slice(0, 8) : [],
      quality_heuristics: qualityHeuristics,
    },
  };

  // Mechanical leakage audit (Gene-Bench Stage-3): strip any hard literal that
  // appears only in the run's hidden text (final solution / verifier feedback)
  // and not in the public SKILL.md. Run BEFORE validateSynthesizedGene so the
  // sanitized payload is what gets ID-rewritten and persisted.
  let auditInfo = { leaks_found_count: 0, redacted: false };
  if (opts.skillMd) {
    const privateVocab = audit.buildPrivateVocab(opts.skillMd, execution);
    const leaks = audit.findLeakage(draft, privateVocab);
    if (leaks.length > 0) {
      draft = audit.redactPrivateLiterals(draft, privateVocab);
      const residual = audit.findLeakage(draft, privateVocab);
      // Record only counts/locations, never the private literals themselves --
      // storing the leaked token verbatim in the published asset would defeat
      // the audit.
      auditInfo = {
        leaks_found_count: leaks.length,
        leak_locations: Array.from(new Set(leaks.map((l) => l.location))),
        redacted: true,
        residual_leak_count: residual.length,
      };
      draft._source.leakage_audit = auditInfo;
      if (opts.strict && residual.length > 0) {
        return {
          valid: false,
          errors: ['strict mode: leakage audit could not remove ' + residual.length
            + ' private literal(s) at: ' + Array.from(new Set(residual.map((l) => l.location))).join(', ')],
          gene: null,
          source: source,
          quality_score: qualityScore,
        };
      }
      // The audit may have dropped validation commands that carried a private
      // literal. Re-assert strict mode's runnable-validation requirement here,
      // since the earlier check ran before redaction.
      if (opts.strict && (!Array.isArray(draft.validation) || draft.validation.length === 0)) {
        return {
          valid: false,
          errors: ['strict mode: all runnable validation commands were dropped by the '
            + 'leakage audit (they contained private literals), leaving no verifiable check.'],
          gene: null,
          source: source,
          quality_score: qualityScore,
        };
      }
    }
  }

  const assetsDir = paths.getGepAssetsDir();
  const existingGenesJson = readJsonSafe(path.join(assetsDir, 'genes.json'), { genes: [] });
  const existingGenes = Array.isArray(existingGenesJson.genes) ? existingGenesJson.genes : [];
  const result = skillDistiller.validateSynthesizedGene(draft, existingGenes);
  // Surface provenance + quality so the caller's quality gate can act on it.
  result.source = source;
  result.quality_score = qualityScore;
  result.audit = auditInfo;
  return result;
}

function inferCategory(signals, description) {
  const hay = ((description || '') + ' ' + (signals || []).join(' ')).toLowerCase();
  // Priority repair -> innovate -> optimize, mirroring the sibling
  // inferCategoryFromSignals() in skillDistiller.js / solidify.js.
  //
  // REPAIR set uses SUBSTRING matching (no \b): it must catch both inflected
  // forms ("errors", "fixed", "crashes") and the project's underscore signal
  // format ("log_error", "test_failure"), which a \b-anchored regex breaks
  // (\b treats `_` as a word char, so "error" inside "log_error" has no
  // boundary). Changes vs. the pre-PR original:
  //   - repair: removed "rollback"/"guard" — cross-cutting safety words common
  //     in *optimize* skills (e.g. paranoia-ai-system-evolver lists "rollback"
  //     in its safe-change method) that must not by themselves force repair.
  //   - innovate: "add" is matched with a \b word boundary so it catches the
  //     verb ("add a dashboard") without false-positives on address/additional/
  //     padding (the pre-PR bare-substring "add" matched all of those). The
  //     innovate set only reads natural-language description, so \b is safe here.
  if (/error|fail|bug|crash|broken|incident|regress|debug|repair|fix/.test(hay)) {
    return 'repair';
  }
  if (/feature|\badd\b|implement|new capability|capability|innovate|greenfield|prototype/.test(hay)) {
    return 'innovate';
  }
  return 'optimize';
}

// ---------------------------------------------------------------------------
// LLM distillation = the host agent.
//
// The evolver engine has no in-process LLM client and never spawns one. The
// "LLM" IS the host agent (Claude Code / Cursor / Codex) that just ran the
// Skill -- it already has the full execution in context. So this stage does
// not call out anywhere: it simply consumes the distillation the host agent
// provides inline on opts.execution (docs/skill2gep.md):
//
//   - execution.corrective_insight : the single fix that flipped fail -> pass
//                                     (becomes strategy[0]).
//   - execution.distilled_payload  : optional { corrective_insight, strategy,
//                                     preconditions } the host already wrote.
//
// If the host supplied neither, synthesizeGene falls back to the mechanical
// corrective distillation. Zero network, zero subprocess, in-budget.
// ---------------------------------------------------------------------------
function _hostDistilledPayload(execution) {
  const p = execution && execution.distilled_payload;
  if (!p || typeof p !== 'object') return null;
  const out = {};
  if (Array.isArray(p.strategy) && p.strategy.length) out.strategy = p.strategy.map(String);
  if (Array.isArray(p.preconditions)) out.preconditions = p.preconditions.map(String);
  if (typeof p.corrective_insight === 'string') out.corrective_insight = p.corrective_insight;
  return Object.keys(out).length ? out : null;
}

function distillWithLLM(parsed, execution, opts) { // eslint-disable-line no-unused-vars
  execution = execution || {};

  // A top-level corrective_insight and a distilled_payload are not mutually
  // exclusive, so do not early-return on the insight alone -- merge both.
  const hostPayload = _hostDistilledPayload(execution);
  if (!execution.corrective_insight && !hostPayload) {
    return execution; // nothing from the host -> mechanical fallback
  }
  const merged = Object.assign({}, execution);
  if (hostPayload) {
    if (!merged.corrective_insight && hostPayload.corrective_insight) {
      merged.corrective_insight = hostPayload.corrective_insight;
    }
    if (hostPayload.strategy) merged.distilled_strategy = hostPayload.strategy;
    if (hostPayload.preconditions) merged.distilled_preconditions = hostPayload.preconditions;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Forgery guard: a Capsule with status=success but no execution evidence is
// rejected outright. This is the single most important defence against agents
// "hallucinating" a successful run just to bulk up the community registry.
// ---------------------------------------------------------------------------
function detectForgery(execution) {
  const trace = Array.isArray(execution && execution.trace) ? execution.trace : [];
  const blast = execution && execution.blast_radius ? execution.blast_radius : null;
  const files = blast ? Number(blast.files || 0) : 0;
  const lines = blast ? Number(blast.lines || 0) : 0;
  const status = execution && execution.status ? String(execution.status) : 'failed';
  if (status !== 'success') return null;
  if (trace.length === 0) return 'empty_execution_trace';
  if (files === 0 && lines === 0) return 'zero_blast_radius_with_success';
  const anyExitRecorded = trace.some((t) => Number.isInteger(t && t.exit));
  if (!anyExitRecorded) return 'no_exit_code_in_trace';
  return null;
}

// ---------------------------------------------------------------------------
// Assemble a Capsule from a gene reference + real execution evidence.
// Cross-references Gene.validation -> execution.trace. If any validation
// command is missing from the trace, we refuse to emit the Capsule and
// return a diagnostic instead.
// ---------------------------------------------------------------------------
function assembleCapsule(gene, execution, opts) {
  const trace = Array.isArray(execution && execution.trace) ? execution.trace : [];
  const geneValidations = Array.isArray(gene.validation) ? gene.validation : [];
  const traceCmds = new Set(trace.map((t) => normalizeCmd(t && t.cmd)));
  const missing = [];
  geneValidations.forEach((v) => { if (!traceCmds.has(normalizeCmd(v))) missing.push(v); });
  if (missing.length > 0) {
    return { ok: false, reason: 'validation_coverage_missing', missing: missing };
  }
  for (const v of geneValidations) {
    const t = trace.find((tt) => normalizeCmd(tt && tt.cmd) === normalizeCmd(v));
    if (t && !Number.isInteger(t.exit)) {
      return { ok: false, reason: 'validation_missing_exit_code', cmd: v };
    }
  }

  const scoreRaw = execution && execution.score != null ? Number(execution.score) : null;
  const status = execution && execution.status ? String(execution.status) : 'failed';
  let score;
  if (Number.isFinite(scoreRaw)) {
    score = Math.max(0, Math.min(1, scoreRaw));
  } else {
    score = status === 'success' ? 0.8 : 0.2;
  }

  const blast = execution && execution.blast_radius ? execution.blast_radius : { files: 0, lines: 0 };
  const env = (envFingerprint && typeof envFingerprint.captureEnvFingerprint === 'function')
    ? envFingerprint.captureEnvFingerprint()
    : ((execution && execution.env_fingerprint) || null);

  // gene.id may have been rewritten by validateSynthesizedGene (e.g. to
  // DISTILLED_ID_PREFIX); extract whatever suffix is there instead of
  // assuming our original SKILL2GEP_ID_PREFIX is still present.
  const geneIdSuffix = String(gene.id).replace(/^gene_[a-z0-9]+_/, '').replace(/^gene_/, '');
  const idKey = shortHash(gene.id + '|' + (execution && execution.started_at || new Date().toISOString()));
  const capsule = {
    type: 'Capsule',
    id: CAPSULE_ID_PREFIX + slugify(geneIdSuffix) + '_' + idKey,
    gene: gene.id,
    trigger: Array.isArray(execution && execution.trigger) ? execution.trigger : (gene.signals_match || []).slice(0, 6),
    summary: (execution && execution.summary) || ('Applied ' + gene.id + ' on scenario ' + (opts && opts.scenario || 'local skill invocation')),
    confidence: Math.max(0, Math.min(1, score)),
    blast_radius: { files: Number(blast.files || 0), lines: Number(blast.lines || 0) },
    outcome: { status: status, score: score },
    success_reason: status === 'success' ? ((execution && execution.success_reason) || 'Skill workflow completed and all declared validations passed.') : null,
    env_fingerprint: env || { os: process.platform, node: process.version },
    source_type: 'skill2gep_hook',
    strategy: Array.isArray(gene.strategy) ? gene.strategy.slice() : [],
    content: (execution && execution.content_summary) || buildContentSummary(trace, blast),
    execution_trace: trace.map((t, i) => ({
      step: Number.isInteger(t && t.step) ? t.step : i + 1,
      cmd: String(t && t.cmd || ''),
      exit: Number.isInteger(t && t.exit) ? t.exit : null,
      stdout_tail: t && t.stdout_tail ? String(t.stdout_tail).slice(0, 300) : '',
    })),
    schema_version: '1.6.0',
  };
  return { ok: true, capsule: capsule };
}

function buildContentSummary(trace, blast) {
  const okCount = trace.filter((t) => Number(t && t.exit) === 0).length;
  const files = blast ? Number(blast.files || 0) : 0;
  const lines = blast ? Number(blast.lines || 0) : 0;
  return 'Ran ' + trace.length + ' validation command(s), ' + okCount + ' passed. Blast radius: ' + files + ' files, ' + lines + ' lines.';
}

// ---------------------------------------------------------------------------
// Main entrypoint: runOnSkillInvocation(opts)
//
// opts = {
//   skillPath:   absolute path to SKILL.md or skill directory (required)
//   skillName:   optional, auto-derived from frontmatter otherwise
//   platform:    'cursor' | 'claude-code' | 'codex' | generic (optional)
//   execution: {
//     status:       'success' | 'failed'   (REQUIRED for Capsule emission)
//     score:        0..1
//     started_at:   ISO8601 string
//     trace:        [ { step, cmd, exit, stdout_tail }, ... ]
//     blast_radius: { files, lines }
//     trigger:      [ signals actually fired ]
//     signals:      [ signals actually detected ]
//     summary:      optional one-line result
//     success_reason, env_fingerprint, content_summary  -- all optional
//   },
//   publish: boolean (default true, from SKILL2GEP_AUTO_PUBLISH)
// }
//
// Returns {
//   ok: boolean,
//   gene, capsule,
//   capsule_diagnostic,    // null, or reason why we refused to emit a Capsule
//   persist_errors,        // list of local storage errors (upsert, write state)
//   publish_requested,     // true if auto-publish was attempted
//   publish_promise,       // Promise<publish result> if publish was fired
//   rationale,             // one-line explanation citing the paper
//   reason, errors         // set when ok=false
// }
// ---------------------------------------------------------------------------
function runOnSkillInvocation(opts) {
  opts = opts || {};
  const skillPath = opts.skillPath;
  if (!skillPath || !fs.existsSync(skillPath)) {
    return { ok: false, reason: 'skill_path_missing', skillPath: skillPath };
  }

  let skillMdPath = skillPath;
  try {
    const stat = fs.statSync(skillPath);
    if (stat.isDirectory()) skillMdPath = path.join(skillPath, 'SKILL.md');
  } catch (_) { return { ok: false, reason: 'skill_path_unreadable' }; }
  if (!fs.existsSync(skillMdPath)) return { ok: false, reason: 'skill_md_missing', tried: skillMdPath };

  let skillMd;
  try { skillMd = fs.readFileSync(skillMdPath, 'utf8'); }
  catch (err) { return { ok: false, reason: 'skill_md_read_failed', error: err && err.message ? err.message : String(err) }; }
  const skillHash = shortHash(skillMd);

  // Idempotency: if we've already distilled this exact skill content + the
  // same execution fingerprint, skip to avoid duplicate community uploads.
  // Include the evolved-trajectory + host-distillation fields in the
  // idempotency key: they change the synthesized Gene, so a later, richer host
  // distillation of the same trace must NOT be short-circuited as
  // already_distilled with a stale Gene.
  const ex0 = opts.execution || {};
  const execHash = shortHash(JSON.stringify({
    trace: ex0.trace || [],
    br: ex0.blast_radius || null,
    status: ex0.status || null,
    mutation_log: ex0.mutation_log || null,
    rollouts: ex0.rollouts || null,
    corrective_insight: ex0.corrective_insight || null,
    distilled_payload: ex0.distilled_payload || null,
  }));
  const state = readState();
  const seenKey = skillHash + ':' + execHash;
  if (state.seen && state.seen[seenKey]) {
    return { ok: false, reason: 'already_distilled', gene: state.seen[seenKey].gene, capsule: state.seen[seenKey].capsule };
  }

  const parsed = parseSkillMd(skillMd);

  // Consume any distillation the host agent (the LLM) supplied inline on the
  // execution record. This never calls out -- it just promotes a host-provided
  // corrective_insight / distilled_payload onto the execution before synthesis.
  let execution = opts.execution || {};
  try {
    const enriched = distillWithLLM(parsed, execution, { skillMd: skillMd });
    if (enriched) execution = enriched;
  } catch (_) { /* non-fatal: keep the original execution record */ }

  const geneResult = synthesizeGene(parsed, execution, {
    skillName: opts.skillName || parsed.name,
    platform: opts.platform || null,
    skillHash: skillHash,
    skillMd: skillMd,
    strict: Boolean(opts.strict),
  });
  if (!geneResult.valid) {
    appendJsonl(logPath(), {
      timestamp: new Date().toISOString(), status: 'gene_validation_failed',
      skill: opts.skillName || parsed.name, errors: geneResult.errors,
    });
    return { ok: false, reason: 'gene_validation_failed', errors: geneResult.errors };
  }
  const gene = geneResult.gene;

  // Quality gate (operationalizes the TaskGenome Bench finding that
  // reference-distilled Genes can be WORSE than Skills). A low-quality
  // distilled/manual Gene is downgraded to Gene-only and flagged; strict mode
  // refuses it. Evolved Genes are never gated. A malformed env value parses to
  // NaN -> treat as "gate disabled" (0) rather than passing everything.
  const minQualityRaw = Number(process.env.SKILL2GEP_MIN_QUALITY);
  const minQuality = Number.isFinite(minQualityRaw) ? minQualityRaw : 0;
  let qualityGate = null;
  if (geneResult.source !== 'evolved' && geneResult.quality_score < minQuality) {
    qualityGate = {
      reason: 'low_quality_distilled_gene',
      source: geneResult.source,
      quality_score: geneResult.quality_score,
      note: 'reference-distilled/manual Gene below SKILL2GEP_MIN_QUALITY; '
        + 'TaskGenome Bench shows such Genes may underperform the source Skill.',
    };
    if (opts.strict) {
      appendJsonl(logPath(), {
        timestamp: new Date().toISOString(), status: 'quality_gate_rejected',
        skill: opts.skillName || parsed.name, gate: qualityGate,
      });
      return { ok: false, reason: 'quality_gate_rejected', gate: qualityGate };
    }
  }

  let capsule = null;
  let capsuleDiag = null;
  // A quality-gated Gene is published as Gene-only: do not mint a Capsule that
  // would advertise it as a verified success.
  if (execution && execution.status && !qualityGate) {
    const forgery = detectForgery(execution);
    if (forgery) {
      capsuleDiag = { reason: 'capsule_rejected_forgery', detail: forgery };
    } else {
      const capRes = assembleCapsule(gene, execution, { scenario: opts.scenario || parsed.name });
      if (capRes.ok) capsule = capRes.capsule; else capsuleDiag = capRes;
    }
  }

  const persistErrors = [];
  try { assetStore.upsertGene(gene); }
  catch (err) { persistErrors.push({ step: 'upsertGene', error: err && err.message ? err.message : String(err) }); }
  if (capsule) {
    try { assetStore.appendCapsule(capsule); }
    catch (err) { persistErrors.push({ step: 'appendCapsule', error: err && err.message ? err.message : String(err) }); }
  }

  state.seen = state.seen || {};
  state.seen[seenKey] = {
    at: new Date().toISOString(),
    gene: gene.id,
    capsule: capsule ? capsule.id : null,
  };
  try { writeState(state); } catch (err) { persistErrors.push({ step: 'writeState', error: err && err.message ? err.message : String(err) }); }

  const shouldPublish = (opts.publish !== false)
    && String(process.env.SKILL2GEP_AUTO_PUBLISH || 'true').toLowerCase() !== 'false';

  // Kick off publish in background. We never block the hook on the Hub -- if
  // the network is slow, the hook still exits in bounded time and we log the
  // publish promise's outcome asynchronously.
  let publishPromise = null;
  if (shouldPublish) {
    publishPromise = publishAssets(gene, capsule).then((result) => {
      appendJsonl(logPath(), {
        timestamp: new Date().toISOString(),
        status: 'publish_result',
        skill: opts.skillName || parsed.name,
        gene_id: gene.id,
        capsule_id: capsule ? capsule.id : null,
        publish: result,
      });
      return result;
    }).catch((err) => {
      const fail = { ok: false, error: err && err.message ? err.message : String(err) };
      appendJsonl(logPath(), {
        timestamp: new Date().toISOString(),
        status: 'publish_error',
        skill: opts.skillName || parsed.name,
        gene_id: gene.id,
        capsule_id: capsule ? capsule.id : null,
        publish: fail,
      });
      return fail;
    });
  }

  appendJsonl(logPath(), {
    timestamp: new Date().toISOString(),
    status: 'distilled',
    skill: opts.skillName || parsed.name,
    gene_id: gene.id,
    generation_source: geneResult.source,
    quality_score: geneResult.quality_score,
    quality_gate: qualityGate,
    leakage_audit: geneResult.audit,
    capsule_id: capsule ? capsule.id : null,
    capsule_diagnostic: capsuleDiag,
    persist_errors: persistErrors,
    published_requested: shouldPublish,
  });

  return {
    ok: true,
    gene: gene,
    capsule: capsule,
    generation_source: geneResult.source,
    quality_score: geneResult.quality_score,
    quality_gate: qualityGate,
    leakage_audit: geneResult.audit,
    capsule_diagnostic: capsuleDiag,
    persist_errors: persistErrors,
    publish_requested: shouldPublish,
    publish_promise: publishPromise,
    rationale: RATIONALE_TEXT,
  };
}

// ---------------------------------------------------------------------------
// Community upload. Two channels, both best-effort:
//
//  1. Skill Store: skillPublisher.publishSkillToHub() converts the Gene into a
//     SKILL.md and POSTs it to /a2a/skill/store/publish. This is the human-
//     facing channel that also serves as a Gene index.
//
//  2. GEP publish bundle: a2a.buildPublishBundle({gene, capsule}) signs both
//     assets with the node secret and a2a.httpTransportSend() POSTs them to
//     /a2a/publish (the A2A message_type routing). This is the auditable
//     machine-facing channel used by solidify.js for normal capsule
//     publishing.
//
// We always try channel 1 for the Gene; channel 2 only runs if a real Capsule
// is attached (Gene-only bundles are not supported by the A2A schema). Each
// channel's failure is isolated so a broken one cannot block the other.
// ---------------------------------------------------------------------------
// publishAssets runs two independent publish channels in parallel:
//   skill_store: skillPublisher.publishSkillToHub (human-facing Gene index)
//   gep_bundle:  a2a.httpTransportSend (machine-facing auditable channel)
// ok is true only when at least one channel succeeds with a real (non-dry-run) publish.
// When HUB_DRY_RUN is active, both channels short-circuit and ok is false;
// callers should check result.dry_run to distinguish from a real failure.
function publishAssets(gene, capsule) {
  const skillPromise = publishSkillChannel(gene);
  const bundlePromise = capsule ? publishBundleChannel(gene, capsule) : Promise.resolve({ ok: false, skipped: 'no_capsule' });
  return Promise.all([skillPromise, bundlePromise]).then(([skill, bundle]) => ({
    skill_store: skill,
    gep_bundle: bundle,
    ok: Boolean((skill && skill.ok && !skill.dry_run) || (bundle && bundle.ok && !bundle.dry_run)),
    dry_run: Boolean((skill && skill.dry_run) || (bundle && bundle.dry_run)),
  }));
}

function publishSkillChannel(gene) {
  if (a2a._isDryRun()) return Promise.resolve({ ok: true, dry_run: true });
  try {
    const p = skillPublisher.publishSkillToHub(gene);
    return Promise.resolve(p).catch((err) => ({ ok: false, error: err && err.message ? err.message : String(err) }));
  } catch (err) {
    return Promise.resolve({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function publishBundleChannel(gene, capsule) {
  const hubUrl = a2a.getHubUrl && a2a.getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });
  let message;
  let capsuleClone;
  try {
    // buildPublishBundle mutates asset_id on the objects it receives, so
    // clone first to avoid polluting the locally stored gene/capsule.
    // Also sanitize the clone before publishing so the recall verifier
    // can index by the same hash the Hub will store. Without client-side
    // sanitize, Hub's server-side PII redaction silently rewrites the
    // body and recomputes a different asset_id; the verifier then looks
    // up a hash that does not exist on Hub, producing persistent
    // roundtrip_missing. Mirrors solidify.js publish paths.
    // (Bugbot review on PR #53 round 3.)
    const geneClone = JSON.parse(JSON.stringify(gene));
    capsuleClone = JSON.parse(JSON.stringify(capsule));
    try {
      const { sanitizePayload } = require('./sanitize');
      capsuleClone = sanitizePayload(capsuleClone);
      // Note: do NOT compute asset_id here. buildPublishBundle stamps the
      // canonical asset_id (after also potentially adding execution_trace
      // and model_name). Computing a hash here would be discarded — and if
      // buildPublishBundle adds execution_trace, the pre-hash would silently
      // disagree with the post-hash. The verifier-enqueue closure below reads
      // capsuleClone.asset_id AFTER buildPublishBundle returns.
      // (Bugbot review on PR #53 round 4.)
    } catch (sanitizeErr) {
      // sanitize is best-effort here; if it fails the unsanitized clone
      // still publishes — Hub's own PII redaction will still kick in.
      // Log so the operator can investigate but do not abort the publish.
      console.log('[skill2gep] sanitize failed (non-fatal): ' + (sanitizeErr && sanitizeErr.message || sanitizeErr));
    }
    message = a2a.buildPublishBundle({ gene: geneClone, capsule: capsuleClone });
  } catch (err) {
    return Promise.resolve({ ok: false, error: 'build_publish_bundle_failed: ' + (err && err.message ? err.message : String(err)) });
  }
  try {
    const send = a2a.httpTransportSend(message, { hubUrl: hubUrl, timeoutMs: 15000 });
    return Promise.resolve(send)
      .then(function (res) {
        if (res && res.ok && !res.dry_run) {
          try {
            require('./recallVerifier').enqueuePublishedAsset({
              asset_id: (capsuleClone && capsuleClone.asset_id) || capsule.asset_id,
              type: 'SkillBundle',
              signals: Array.isArray(capsule.trigger) ? capsule.trigger : [],
              publishedAt: Date.now(),
            });
          } catch (rvErr) { /* non-fatal */ }
        }
        return res;
      })
      .catch((err) => ({ ok: false, error: err && err.message ? err.message : String(err) }));
  } catch (err) {
    return Promise.resolve({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

module.exports = {
  SKILL2GEP_ID_PREFIX,
  CAPSULE_ID_PREFIX,
  RATIONALE_LINKS,
  RATIONALE_TEXT,
  parseSkillMd,
  classifyProvenance,
  synthesizeGene,
  distillWithLLM,
  inferCategory,
  detectForgery,
  assembleCapsule,
  runOnSkillInvocation,
  publishAssets,
  publishSkillChannel,
  publishBundleChannel,
  logPath,
  statePath,
  DEFAULT_HOOK_TIMEOUT_MS,
};
