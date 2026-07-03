// LLM-over-transcript distillation (#319) — the counterpart to the capsule-based autoDistillLlm. Some runtimes
// (cursor especially) write PROSE-RICH but tool-result-POOR transcripts: the agent narrates "root cause … fix …
// verified" but emits no tool_result/error turns, so the structural signal extractor (extractor.ts) finds only a
// weak/zero signal and the fast structural distill never drafts a gene. An LLM can READ that narration and
// synthesize a reusable gene where keyword matching cannot. This module is that path: it runs an LLM over a single
// session's transcript text and produces a QUARANTINED gene draft (A2a-safe).
//
// Boundaries (zero blast to the proven paths): it does NOT touch extractor.ts (claude/codex keep their fast
// structural path) and does NOT touch autoDistillLlm (the capsule meta-distill). It only ADDS an LLM bypass for
// prose-rich sessions whose structural signal is weak/zero. Default OFF; output is quarantined; the transcript is
// an off-box egress, so the same reverse env-value leak block the publish/LLM-distill paths use guards it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { algo, assetstore, events, hub, verify, signals } from '@evomap/evolver-core';
import { adapterForPath } from '@evomap/evolver-runtime-adapters';
import { asGeneCandidate, parseDistillOutput, normalizeValidation, jaccardDuplicate, resolveDistillRunner, p3Decide, } from './autoDistillLlm.js';
const DEFAULT_MIN_TURNS = 2;
const DEFAULT_MIN_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 20_000;
const TRANSCRIPT_CHAR_CAP = 24_000; // bound the off-box prompt; narration beyond this rarely adds reusable signal
function resolveMode(env, explicit) {
    const raw = String(explicit ?? env['EVOLVER_AUTO_DISTILL_TRANSCRIPT'] ?? 'off').trim().toLowerCase();
    return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}
/** The resolved mode (off|shadow|enforce) — the daemon wiring reads this to decide whether to build the producer. */
export function transcriptDistillMode(env = process.env) {
    return resolveMode(env);
}
/** Positive-int env read (fallback otherwise), so this path honors the SAME distill timeout knobs as autoDistillLlm. */
function envInt(env, name, fallback) {
    const n = Number.parseInt(String(env[name] ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function proseText(turns) {
    return turns.filter((t) => !t.isMeta && typeof t.text === 'string' && t.text.trim()).map((t) => String(t.text)).join('\n');
}
/**
 * Pure gate: should this session go to the LLM-over-transcript path? YES only when it is prose-rich enough to be
 * worth an LLM call AND the structural extractor found NO strong/agent signal (a strong signal means the fast
 * structural distill already handles it — do not double-spend an LLM). A weak `difficulty` signal does not block:
 * weak is exactly what the structural path drops, so the LLM is the intended fallback for it.
 */
export function shouldTranscriptDistill(turns, opts = {}) {
    const minTurns = opts.minTurns ?? DEFAULT_MIN_TURNS;
    const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
    const textTurns = turns.filter((t) => !t.isMeta && typeof t.text === 'string' && t.text.trim());
    const chars = textTurns.reduce((n, t) => n + String(t.text).length, 0);
    if (textTurns.length < minTurns || chars < minChars)
        return { distill: false, reason: 'insufficient_substance' };
    const sig = signals.extractSignals(turns);
    if (sig.some((s) => s.strength === 'strong' || s.strength === 'agent'))
        return { distill: false, reason: 'structural_signal_present' };
    return { distill: true, reason: 'prose_rich_weak_or_zero_signal' };
}
/** Build the LLM prompt from the session's prose. Redacted + capped (off-box egress). Mirrors the Gene JSON shape
 *  the autoDistillLlm path uses so parseDistillOutput/asGeneCandidate handle the response unchanged. */
export function buildTranscriptDistillPrompt(turns) {
    const redacted = hub.redactString(proseText(turns)).slice(0, TRANSCRIPT_CHAR_CAP);
    return [
        'You are synthesizing ONE high-quality reusable EvoMap Gene from a single coding session transcript.',
        'The transcript narrates a problem the agent solved. Capture the GENERAL, reusable lesson — not one-off file names or secrets.',
        'Return only JSON. Do not use markdown. Do not include commentary.',
        '',
        'If the transcript contains NO concrete, reusable engineering lesson — e.g. it is only orientation/exploration/',
        'chatter, asks for clarification, or solved nothing — return exactly {"type":"none"} and nothing else. Do NOT',
        'manufacture a vague process or meta lesson just to return a gene.',
        '',
        'Otherwise produce a Gene:',
        '- Produce a single Gene object.',
        '- signals_match: the generic problem signals this gene applies to (not file names).',
        '- strategy: concrete, defensive, reusable steps.',
        '- Validation must be light. Prefer ["node --version"]. Do not use test suites, node --test, jest, mocha, or node -e.',
        '',
        'Required JSON shape:',
        '{"type":"Gene","id":"gene_distilled_<descriptive-kebab-name>","summary":"...","category":"repair|optimize|innovate|explore","signals_match":["signal"],"preconditions":["condition"],"strategy":["step"],"constraints":{"max_files":3,"forbidden_paths":[".git","node_modules"]},"validation":["node --version"]}',
        '',
        'SESSION_TRANSCRIPT:',
        redacted,
    ].join('\n');
}
function existingGeneRefs(records) {
    return records.map((r) => ({
        id: typeof r['id'] === 'string' ? r['id'] : undefined,
        signals_match: Array.isArray(r['signals_match']) ? r['signals_match'].map(String).filter(Boolean) : [],
    }));
}
/** Emit gene.distilled ONCE per (assetId, source): a re-run / duplicate-content put must not re-emit (mirrors
 *  autoDistillLlm.emitDistilledEventIfAbsent), so the event rail stays idempotent even when store.put is a no-op. */
async function emitDistilledEventIfAbsent(ingestor, gene, sourceLabel) {
    if (!ingestor)
        return;
    const assetId = gene.asset_id;
    const exists = ingestor.readAll().some((e) => {
        const p = e.payload;
        return e.type === 'gene.distilled' && p?.['assetId'] === assetId && p?.['source'] === 'auto-distill-transcript';
    });
    if (exists)
        return;
    await ingestor.ingest({
        type: 'gene.distilled',
        payload: { geneId: gene['id'], assetId, source: 'auto-distill-transcript', ...(sourceLabel ? { sourceLabel } : {}) },
        human: { title: `transcript-distilled gene ${String(gene['id'] ?? assetId)}`, severity: 'info' },
        actor: { kind: 'machine', id: 'auto-distill-transcript' },
    });
}
/** Shadow observability (A1): shadow mode computes a candidate but stores nothing, so without this the operator
 *  has no way to judge what enforce mode WOULD distill. Emit ONE gene.distill_shadowed per (content hash, source)
 *  carrying the candidate's summary + signals (no strategy body — keep the event light). Idempotent: a re-scan of
 *  the same session never re-emits. */
async function emitShadowObservationIfAbsent(ingestor, sourceLabel, contentHash, candidate) {
    if (!ingestor || !candidate)
        return;
    const exists = ingestor.readAll().some((e) => {
        const p = e.payload;
        return e.type === 'gene.distill_shadowed' && p?.['contentHash'] === contentHash && p?.['source'] === 'auto-distill-transcript';
    });
    if (exists)
        return;
    await ingestor.ingest({
        type: 'gene.distill_shadowed',
        payload: { contentHash, source: 'auto-distill-transcript', sourceLabel, summary: candidate.summary ?? '', signals_match: [...(candidate.signals_match ?? [])] },
        human: { title: `shadow transcript-distill candidate (${sourceLabel})`, severity: 'info' },
        actor: { kind: 'machine', id: 'auto-distill-transcript' },
    });
}
/**
 * Run the LLM-over-transcript distill for ONE session. Default OFF. Gated by shouldTranscriptDistill. The output
 * gene is QUARANTINED (review/probation decides), never auto-trusted. Best-effort and side-effect-safe; persistent
 * per-session idempotency is the producer's job (#319 slice 2), so this is single-shot.
 */
export async function autoDistillTranscript(options) {
    const env = options.env ?? process.env;
    const mode = resolveMode(env, options.mode);
    if (mode === 'off')
        return { ok: false, mode, reason: 'disabled' };
    const gate = shouldTranscriptDistill(options.turns);
    if (!gate.distill)
        return { ok: false, mode, reason: gate.reason };
    const cwd = options.cwd ?? process.cwd();
    const prompt = buildTranscriptDistillPrompt(options.turns);
    // Off-box egress (stdin to a spawned LLM): hold it to the publish-path floor — a reverse env-value scan that
    // flags any process-env secret appearing verbatim, catching custom-format secrets no pattern matches. Fail CLOSED.
    if (hub.detectEnvValueLeaks(prompt, env).length > 0)
        return { ok: false, mode, reason: 'prompt_env_leak_blocked' };
    const runner = options.runner ?? resolveDistillRunner(env);
    const timeoutMs = options.timeoutMs ?? envInt(env, 'EVOLVE_DISTILL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const llm = await runner(prompt, { cwd, timeoutMs, env });
    if (llm.exitCode !== 0)
        return { ok: false, mode, reason: llm.exitCode === null ? 'llm_spawn_error' : 'llm_nonzero_exit' };
    const parsed = parseDistillOutput(llm.stdout);
    // The LLM's explicit decline ({"type":"none"}): the session had no reusable lesson, so do NOT manufacture a
    // vague process/meta gene (the trial showed an LLM will otherwise always invent one, polluting the pool).
    if (parsed && typeof parsed === 'object' && parsed['type'] === 'none') {
        return { ok: false, mode, reason: 'no_reusable_lesson' };
    }
    const candidate0 = asGeneCandidate(parsed);
    if (!candidate0)
        return { ok: false, mode, reason: 'no_gene_in_response' };
    const existing = existingGeneRefs(await options.store.list('Gene', 10_000));
    const normalized = normalizeValidation(candidate0, cwd).candidate;
    // Near-duplicate guard (mirrors autoDistillLlm): intakeGene only rejects when an existing gene's signals are a
    // SUPERSET of the candidate's, so a highly-similar but non-subset signal set would otherwise slip through and
    // emit a redundant gene.distilled. Jaccard catches those before intake.
    const duplicate = jaccardDuplicate(normalized, existing);
    if (duplicate)
        return { ok: false, mode, reason: 'near_duplicate', candidate: normalized };
    const intake = algo.intakeGene(normalized, existing);
    if (!intake.ok || !intake.gene)
        return { ok: false, mode, reason: 'validation_failed', candidate: normalized };
    const validation = await verify.runSandboxedValidation(intake.gene.validation, cwd, {
        timeoutMs: options.validationTimeoutMs ?? envInt(env, 'EVOLVE_DISTILL_VALIDATION_TIMEOUT_MS', DEFAULT_VALIDATION_TIMEOUT_MS),
    });
    if (!validation.passed)
        return { ok: false, mode, reason: 'light_validation_failed', candidate: normalized };
    if (mode === 'shadow')
        return { ok: false, mode, reason: 'shadow_logged', candidate: normalized };
    const gene = intake.gene;
    // Order mirrors autoDistillLlm: emit + quarantine BEFORE store.put, so the LAST step is the store. A throw after a
    // successful put would leave a stored gene the producer never marks enforced (it treats the throw as transient) and
    // re-distill the same content every beat. With store.put last, a throw can only happen before anything is stored,
    // so a transient retry is correct; both emit and quarantine are idempotent if a later step fails and we retry.
    await emitDistilledEventIfAbsent(options.ingestor, gene, options.sourceLabel);
    options.review?.quarantineIfAbsent(gene.asset_id, 'transcript LLM-distilled — review before use'); // A2a: never auto-trusted
    const put = await options.store.put(gene);
    return { ok: true, mode, gene, stored: put.stored };
}
const TSTATE_CAP = 64;
const DEFAULT_TCOOLDOWN_MS = 1_800_000; // 30 min between retries of a bad-result session
const DEFAULT_TMAX_ATTEMPTS = 3;
const DEFAULT_MAX_PER_TICK = 3; // cap LLM calls per idle beat (cost)
// Transient outcomes do NOT count toward failed_attempts (mirror autoDistillLlm): an env hiccup must not exhaust a
// session. A leak-block is a data-hygiene stop, also not a deterministic LLM failure. Everything else deterministic.
const TRANSIENT_REASONS = new Set(['llm_spawn_error', 'llm_nonzero_exit', 'prompt_env_leak_blocked']);
// The LLM's explicit "no reusable lesson" decline is a TERMINAL decision for this session — mark it resolved so it
// is never re-asked (treated like enforced: decided, no gene needed).
const RESOLVED_REASONS = new Set(['no_reusable_lesson']);
export function autoDistillTranscriptStatePath(home = events.evomapHome()) {
    return join(home, 'evolution', 'auto-distill-transcript-state.json');
}
function readTState(path) {
    if (!existsSync(path))
        return { version: 1, by_hash: {} };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return { version: 1, by_hash: parsed.by_hash && typeof parsed.by_hash === 'object' ? parsed.by_hash : {} };
    }
    catch {
        return { version: 1, by_hash: {} };
    }
}
function patchTState(path, hash, patch, cap = TSTATE_CAP) {
    try {
        const state = readTState(path);
        const cur = state.by_hash[hash] ?? { shadowed_at: null, enforced_at: null, enforced_gene_id: null, failed_attempts: 0, last_attempt_at: null };
        const next = { ...cur, ...patch };
        if (patch.failed_attempts_inc)
            next.failed_attempts = (cur.failed_attempts ?? 0) + 1;
        delete next.failed_attempts_inc;
        state.by_hash[hash] = next;
        // Cap eviction (mirrors autoDistillLlm.capByHash): evict NON-terminal rows (in-progress / retryable) oldest-first,
        // and only touch terminal rows (enforced_at = distilled/declined, shadowed_at = shadow-logged) if still over cap.
        // Otherwise a finished session could be dropped and re-distilled though its transcript is unchanged (Bugbot Low).
        const keys = Object.keys(state.by_hash);
        if (keys.length > cap) {
            const age = (k) => Date.parse(state.by_hash[k]?.last_attempt_at ?? '') || 0;
            const terminal = (k) => Boolean(state.by_hash[k]?.enforced_at || state.by_hash[k]?.shadowed_at);
            const order = [
                ...keys.filter((k) => !terminal(k)).sort((a, b) => age(a) - age(b)),
                ...keys.filter((k) => terminal(k)).sort((a, b) => age(a) - age(b)),
            ];
            for (const k of order) {
                if (Object.keys(state.by_hash).length <= cap)
                    break;
                delete state.by_hash[k];
            }
        }
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
        renameSync(tmp, path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * One idle-beat pass: scan candidate session files, gate (prose-rich + weak/zero structural signal), apply
 * per-session dedup/cooldown (p3Decide), and LLM-distill up to maxPerTick of the survivors. Default OFF. Bounds
 * LLM spend by the per-tick cap + per-session state. Best-effort: a bad file never breaks the scan.
 */
export async function runTranscriptDistillTick(deps) {
    const env = deps.env ?? process.env;
    const mode = resolveMode(env);
    const out = { scanned: 0, distilled: 0, shadowed: 0, skipped: 0, transient: 0 };
    if (mode === 'off')
        return out;
    const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    const statePath = deps.statePath ?? autoDistillTranscriptStatePath();
    const now = deps.now ?? (() => Date.now());
    const maxPerTick = deps.maxPerTick ?? envInt(env, 'EVOLVER_AUTO_DISTILL_TRANSCRIPT_MAX_PER_TICK', DEFAULT_MAX_PER_TICK);
    const cooldownMs = envInt(env, 'EVOLVER_AUTO_DISTILL_TRANSCRIPT_COOLDOWN_MS', DEFAULT_TCOOLDOWN_MS);
    const maxAttempts = envInt(env, 'EVOLVER_AUTO_DISTILL_TRANSCRIPT_MAX_ATTEMPTS', DEFAULT_TMAX_ATTEMPTS);
    const stateCap = envInt(env, 'EVOLVER_AUTO_DISTILL_TRANSCRIPT_STATE_CAP', TSTATE_CAP);
    const tpatch = (hash, patch) => patchTState(statePath, hash, patch, stateCap);
    let spawned = 0;
    const seenThisTick = new Set(); // dedup identical-content files within ONE beat (state only dedups ACROSS beats)
    for (const file of deps.files) {
        if (spawned >= maxPerTick)
            break;
        const adapter = adapterForPath(file);
        if (!adapter)
            continue;
        let turns;
        let content;
        try {
            content = readFile(file);
            turns = adapter.parse(content);
        }
        catch {
            continue;
        } // unreadable/unparseable → skip
        out.scanned += 1;
        if (!shouldTranscriptDistill(turns).distill) {
            out.skipped += 1;
            continue;
        } // structural path / too thin
        const hash = createHash('sha256').update(content).digest('hex');
        // Same transcript bytes already attempted THIS beat (duplicate file): skip so identical content cannot consume
        // multiple maxPerTick LLM slots in one tick — the first attempt's state decides it for subsequent beats.
        if (seenThisTick.has(hash)) {
            out.skipped += 1;
            continue;
        }
        seenThisTick.add(hash);
        const state = readTState(statePath);
        if (p3Decide(mode, state.by_hash[hash], now(), { cooldownMs, maxAttempts }) !== 'spawn') {
            out.skipped += 1;
            continue;
        }
        // Pre-attempt state write MUST persist before spending an LLM call: without durable last_attempt_at there is
        // no dedup, so the same session would be re-distilled every tick. If the write fails, skip (don't spawn).
        if (!tpatch(hash, { last_attempt_at: new Date(now()).toISOString() })) {
            out.skipped += 1;
            continue;
        }
        spawned += 1;
        let r;
        // Best-effort scan: a store/validation/ingest throw on ONE session must not abort the whole idle tick (mirrors
        // runSessionIngestTick's per-file guard). A throw is environmental → treat as transient (retry next tick).
        try {
            r = await autoDistillTranscript({
                turns, store: deps.store, env, mode, sourceLabel: basename(file),
                ...(deps.review ? { review: deps.review } : {}), ...(deps.ingestor ? { ingestor: deps.ingestor } : {}),
                ...(deps.runner ? { runner: deps.runner } : {}), ...(deps.cwd ? { cwd: deps.cwd } : {}),
            });
        }
        catch {
            out.transient += 1;
            continue;
        }
        if (r.ok) {
            tpatch(hash, { enforced_at: new Date(now()).toISOString(), enforced_gene_id: String(r.gene['id'] ?? '') });
            out.distilled += 1;
        }
        else if (r.reason === 'shadow_logged') {
            // Shadow stores nothing, so this event is the ONLY artifact of what enforce mode WOULD distill (A1 probation).
            // Mirror the enforce path's "durable artifact before completion state": emit BEFORE writing shadowed_at. If the
            // state were written first, a failed/throwing emit would mark the session shadow-complete (p3Decide skips it
            // forever) with no event ever produced, while `shadowed` over-counts. On emit failure, treat as transient and
            // retry next tick, so the count and the emitted events stay exactly in step. The emit is idempotent per hash,
            // so a retry after a partial failure never double-emits.
            try {
                await emitShadowObservationIfAbsent(deps.ingestor, basename(file), hash, r.candidate);
            }
            catch {
                out.transient += 1;
                continue;
            }
            tpatch(hash, { shadowed_at: new Date(now()).toISOString() });
            out.shadowed += 1;
        }
        else if (RESOLVED_REASONS.has(r.reason)) {
            tpatch(hash, { enforced_at: new Date(now()).toISOString() }); // LLM declined → resolved, never re-ask
            out.skipped += 1;
        }
        else if (TRANSIENT_REASONS.has(r.reason)) {
            out.transient += 1; // no state change → retry next tick
        }
        else if (tpatch(hash, { failed_attempts_inc: true })) {
            out.skipped += 1; // deterministic bad result, increment persisted → toward exhaust + cooldown
        }
        else {
            // The attempt increment did not persist; without it p3Decide never advances toward failed_exhausted, so this
            // is a (transient) state-write failure, not a counted attempt. Classify as transient: retry next beat rather
            // than silently treating the unpersisted failure as handled. The pre-attempt write guard already stops us
            // from spending an LLM call when state cannot be written at all.
            out.transient += 1;
        }
    }
    return out;
}