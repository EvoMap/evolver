import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { algo, assetstore, events, exec, hub, verify } from '@evomap/evolver-core';
const DEFAULT_MIN_CAPSULES = 10;
const DEFAULT_MAX_CAPSULES = 24;
const DEFAULT_MIN_SUCCESS_SCORE = 0.7;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 20_000;
const DEFAULT_COOLDOWN_MS = 1_800_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_HASH_CAP = 32;
const DEFAULT_DUP_JACCARD = 0.8;
const HEAVY_VALIDATION_RE = /\b(validate-suite|jest|mocha)\b|(?:^|\s)--test\b|\b(?:pnpm|npm)\s+(?:test|vitest)\b|test\/[^ ]*\.test\.(?:c|m)?js/i;
export function autoDistillLlmStatePath(home = events.evomapHome()) {
    return join(home, 'evolution', 'auto-distill-llm-state.json');
}
function envInt(env, name, fallback) {
    const n = Number.parseInt(String(env[name] ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envFloat(env, name, fallback) {
    const n = Number.parseFloat(String(env[name] ?? ''));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function resolveMode(env, explicit) {
    const raw = String(explicit ?? env['EVOLVER_AUTO_DISTILL_LLM'] ?? 'off').trim().toLowerCase();
    return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}
function emptyState() {
    return { version: 1, p3_llm: { by_hash: {} } };
}
function readState(path) {
    if (!existsSync(path))
        return emptyState();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const byHash = parsed.p3_llm && typeof parsed.p3_llm === 'object' && parsed.p3_llm.by_hash && typeof parsed.p3_llm.by_hash === 'object'
        ? parsed.p3_llm.by_hash
        : {};
    return { version: 1, p3_llm: { by_hash: byHash } };
}
function writeState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
}
function capByHash(byHash, cap) {
    const keys = Object.keys(byHash);
    if (keys.length <= cap)
        return byHash;
    const age = (key) => {
        const rec = byHash[key] ?? {};
        return Math.max(Date.parse(rec.shadowed_at ?? '') || 0, Date.parse(rec.enforced_at ?? '') || 0, Date.parse(rec.last_attempt_at ?? '') || 0);
    };
    const evictionOrder = [
        ...keys.filter((key) => !byHash[key]?.enforced_at).sort((a, b) => age(a) - age(b)),
        ...keys.filter((key) => byHash[key]?.enforced_at).sort((a, b) => age(a) - age(b)),
    ];
    for (const key of evictionOrder) {
        if (Object.keys(byHash).length <= cap)
            break;
        delete byHash[key];
    }
    return byHash;
}
function patchState(path, dataHash, patch, cap) {
    try {
        const state = readState(path);
        const current = state.p3_llm.by_hash[dataHash] ?? { shadowed_at: null, enforced_at: null, enforced_gene_id: null, failed_attempts: 0, last_attempt_at: null };
        const next = { ...current, ...patch };
        if (patch.failed_attempts_inc)
            next.failed_attempts = (current.failed_attempts ?? 0) + 1;
        delete next.failed_attempts_inc;
        state.p3_llm.by_hash[dataHash] = next;
        state.p3_llm.by_hash = capByHash(state.p3_llm.by_hash, cap);
        writeState(path, state);
        return true;
    }
    catch {
        return false;
    }
}
export function p3Decide(mode, rec, nowMs, opts = {}) {
    if (rec?.enforced_at)
        return 'enforced_idempotent_skip';
    if (mode === 'shadow' && rec?.shadowed_at)
        return 'shadow_idempotent_skip';
    if ((rec?.failed_attempts ?? 0) >= (opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
        return 'failed_exhausted';
    const lastAttempt = Date.parse(rec?.last_attempt_at ?? '');
    if ((rec?.failed_attempts ?? 0) > 0 && lastAttempt > 0 && nowMs - lastAttempt < (opts.cooldownMs ?? DEFAULT_COOLDOWN_MS))
        return 'p3_cooldown';
    return 'spawn';
}
function normalizedSignals(record) {
    const raw = record['signals_match'];
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
}
function existingGeneRefs(records) {
    return records.map((record) => ({
        id: typeof record['id'] === 'string' ? record['id'] : undefined,
        signals_match: normalizedSignals(record),
    }));
}
function isSuccessCapsule(record, minSuccessScore) {
    const outcome = record['outcome'];
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome))
        return false;
    const typedOutcome = outcome;
    if (typedOutcome.status !== 'success')
        return false;
    if (typedOutcome.score === undefined || typedOutcome.score === null)
        return true;
    const score = typeof typedOutcome.score === 'number' ? typedOutcome.score : Number.parseFloat(String(typedOutcome.score));
    return Number.isFinite(score) && score >= minSuccessScore;
}
function capsuleDigestView(record) {
    return {
        id: record['id'],
        asset_id: record.asset_id,
        gene: record['gene'],
        trigger: record['trigger'],
        summary: record['summary'],
        outcome: record['outcome'],
    };
}
function hashCapsules(capsules) {
    const stable = capsules.map(capsuleDigestView).sort((a, b) => String(a['asset_id'] ?? a['id']).localeCompare(String(b['asset_id'] ?? b['id'])));
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
async function collectDistillInput(store, maxCapsules, minSuccessScore) {
    const [capsules, existingGenes] = await Promise.all([store.list('Capsule', 10_000), store.list('Gene', 10_000)]);
    const successCapsules = capsules.filter((record) => isSuccessCapsule(record, minSuccessScore)).slice(-maxCapsules);
    return { dataHash: hashCapsules(successCapsules), successCapsules, existingGenes };
}
function buildDistillPrompt(input) {
    const capsules = hub.redactDeep(input.successCapsules.map(capsuleDigestView));
    const genes = hub.redactDeep(input.existingGenes.map((gene) => ({
        id: gene['id'],
        category: gene['category'],
        signals_match: gene['signals_match'],
        summary: gene['summary'],
    })));
    return [
        'You are synthesizing one high-quality EvoMap Gene from recurring successful Capsules.',
        'Return only JSON. Do not use markdown. Do not include commentary.',
        '',
        'Rules:',
        '- Produce a single Gene object.',
        '- Prefer generic reusable signals, not one-off file names or secrets.',
        '- Strategy steps must be concrete, defensive, and reusable.',
        '- Validation must be light. Prefer ["node --version"]. Do not use test suites, node --test, jest, mocha, or node -e.',
        '- Avoid duplicating existing genes.',
        '',
        'Required JSON shape:',
        '{"type":"Gene","id":"gene_distilled_<descriptive-kebab-name>","summary":"...","category":"repair|optimize|innovate|explore","signals_match":["signal"],"preconditions":["condition"],"strategy":["step"],"constraints":{"max_files":3,"forbidden_paths":[".git","node_modules"]},"validation":["node --version"]}',
        '',
        `DATA_HASH: ${input.dataHash}`,
        'SUCCESS_CAPSULES:',
        JSON.stringify(capsules, null, 2),
        '',
        'EXISTING_GENES:',
        JSON.stringify(genes, null, 2),
    ].join('\n');
}
function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function findJsonObjects(text) {
    const s = String(text ?? '');
    const out = [];
    let start = s.indexOf('{');
    while (start >= 0) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let advanced = -1;
        for (let i = start; i < s.length; i += 1) {
            const ch = s[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{')
                depth += 1;
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        out.push(JSON.parse(s.slice(start, i + 1)));
                        advanced = i + 1;
                    }
                    catch { /* not valid JSON; resume scanning from the next opening brace */ }
                    break;
                }
            }
        }
        start = s.indexOf('{', advanced >= 0 ? advanced : start + 1);
    }
    return out;
}
// Prefer an explicit Gene-shaped object: an LLM may emit reasoning/wrapper objects BEFORE the gene, and
// taking the first parseable object (the prior behavior) would lock onto the wrong one and burn an attempt.
// Falls back to the first object so a gene that omits `type` still parses (asGeneCandidate allows that). (V1 parity.)
function pickGeneObject(text) {
    const objects = findJsonObjects(text);
    const gene = objects.find((o) => isRecord(o) && o['type'] === 'Gene');
    if (gene)
        return gene;
    return objects.length > 0 ? (objects[0] ?? null) : null;
}
export function parseDistillOutput(stdout) {
    const lines = String(stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (last) {
        try {
            const parsed = JSON.parse(last);
            if (isRecord(parsed) && 'is_error' in parsed) {
                if (parsed['is_error'])
                    return null;
                const result = parsed['result'];
                return typeof result === 'string' ? pickGeneObject(result) : result;
            }
            return parsed;
        }
        catch {
            return pickGeneObject(stdout);
        }
    }
    return null;
}
export function asGeneCandidate(value) {
    if (!isRecord(value))
        return null;
    if (typeof value['type'] === 'string' && value['type'] !== 'Gene')
        return null;
    return {
        ...(typeof value['id'] === 'string' ? { id: value['id'] } : {}),
        ...(typeof value['category'] === 'string' ? { category: value['category'] } : {}),
        signals_match: Array.isArray(value['signals_match']) ? value['signals_match'].map(String) : [],
        strategy: Array.isArray(value['strategy']) ? value['strategy'].map(String) : [],
        ...(typeof value['summary'] === 'string' ? { summary: value['summary'] } : {}),
        ...(Array.isArray(value['preconditions']) ? { preconditions: value['preconditions'].map(String) } : {}),
        ...(isRecord(value['constraints']) ? {
            constraints: {
                ...(typeof value['constraints']['max_files'] === 'number' ? { max_files: value['constraints']['max_files'] } : {}),
                // Only carry a NON-EMPTY forbiddenPaths through. intakeGene defaults the field with `?? DEFAULT`,
                // and nullish-coalescing does NOT replace an empty array — so an LLM-supplied `[]` would drop the
                // default `.git`/`node_modules` guard on an autonomously-stored gene. Omit it so the default kicks in. (V1 parity.)
                ...(Array.isArray(value['constraints']['forbidden_paths']) && value['constraints']['forbidden_paths'].length > 0
                    ? { forbidden_paths: value['constraints']['forbidden_paths'].map(String) } : {}),
            },
        } : {}),
        ...(Array.isArray(value['validation']) ? { validation: value['validation'].map(String) } : {}),
        // An LLM-distilled gene is distilled from prior capsule/session evidence (not a verified fail→pass trajectory,
        // not a human-taught gene) → `distilled` per V1 #302 classifyProvenance. intakeGene normalizes + validates it.
        generation_meta: { source: 'distilled' },
    };
}
export function jaccardDuplicate(candidate, existing, threshold = DEFAULT_DUP_JACCARD) {
    const a = new Set((candidate.signals_match ?? []).map((s) => String(s).toLowerCase()).filter(Boolean));
    if (a.size === 0)
        return null;
    for (const eg of existing) {
        if (eg.id && eg.id === candidate.id)
            continue;
        const b = new Set((eg.signals_match ?? []).map((s) => String(s).toLowerCase()).filter(Boolean));
        if (b.size === 0)
            continue;
        const inter = [...a].filter((s) => b.has(s)).length;
        const union = new Set([...a, ...b]).size;
        if (union > 0 && inter / union >= threshold)
            return eg.id ?? '?';
    }
    return null;
}
function isLightValidationCommand(cmd, cwd) {
    const trimmed = cmd.trim();
    if (!trimmed || HEAVY_VALIDATION_RE.test(trimmed) || verify.SHELL_METACHARS.test(trimmed))
        return false;
    const [head = '', ...args] = trimmed.split(/\s+/);
    if (!verify.isNodeExecutable(head))
        return false;
    if (verify.nodeFlagViolation(head, args))
        return false;
    const script = verify.validationScriptPath(trimmed);
    if (!script)
        return args.length === 1 && args[0] === '--version';
    if (isAbsolute(script))
        return false;
    const root = resolve(cwd);
    const resolvedScript = resolve(root, script);
    if (!existsSync(resolvedScript))
        return false;
    const relativeScript = relative(realpathSync(root), realpathSync(resolvedScript));
    if (!relativeScript || relativeScript === '..' || relativeScript.startsWith(`..${sep}`) || isAbsolute(relativeScript))
        return false;
    return true;
}
export function normalizeValidation(candidate, cwd = process.cwd()) {
    const original = candidate.validation?.map(String) ?? [];
    const dropped = [];
    const kept = original.filter((cmd) => {
        const keep = isLightValidationCommand(cmd, cwd);
        if (!keep)
            dropped.push(cmd);
        return keep;
    });
    const validation = kept.length > 0 ? kept : ['node --version'];
    return { candidate: { ...candidate, validation }, dropped, injected: kept.length === 0 };
}
export async function runClaudeDistill(prompt, ctx) {
    const args = [
        '-p', '--output-format', 'json',
        '--permission-mode', 'plan',
        '--model', ctx.env['EVOLVE_DISTILL_MODEL'] ?? 'sonnet',
        '--session-id', randomUUID(),
        '--max-turns', String(envInt(ctx.env, 'EVOLVE_DISTILL_MAX_TURNS', 3)),
    ];
    // Per-vendor auth scoping comes from the execution runner registry's single source of truth (claude → ANTHROPIC_/
    // CLAUDE_), so a distiller and an executor of the same vendor never diverge and one vendor's key never reaches
    // another agent. Value is byte-identical to the previous hardcoded ['ANTHROPIC_','CLAUDE_'].
    const env = exec.scrubAgentEnv(ctx.env, { allowPrefixes: exec.getRunnerSpec('claude').envAllow.prefixes });
    try {
        const r = await exec.spawnCapture('claude', args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, input: prompt, env });
        return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    }
    catch (e) {
        return { exitCode: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
}
/** Build the read-only `codex exec` argv for a distill run (pure, testable). SAFETY INVARIANT: `--sandbox read-only`
 *  is ALWAYS present — a distiller only reads the transcript (carried in the prompt) and emits a gene; it must never
 *  edit files. `--skip-git-repo-check`: the distill cwd may not be a git repo (codex exec otherwise refuses).
 *  `--output-last-message <file>`: capture ONLY the final assistant message (the gene JSON), avoiding codex's stdout
 *  preamble/token-count noise. Prompt arrives via stdin (the trailing `-`). Verified live against codex-cli 0.137.0. */
export function codexDistillArgs(cwd, lastMessageFile, model) {
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', cwd, '--output-last-message', lastMessageFile];
    if (model)
        args.push('--model', model);
    args.push('-');
    return args;
}
/** Distill a prompt with `codex exec` (read-only). Reads the clean final message from --output-last-message so
 *  parseDistillOutput sees a bare gene JSON; falls back to raw stdout (pickGeneObject scans it) if the file is absent.
 *  Windows: codex is a `.cmd` npm shim, so route through resolveSpawnCommand (shell-free). */
export async function runCodexDistill(prompt, ctx) {
    const env = exec.scrubAgentEnv(ctx.env, { allowPrefixes: exec.getRunnerSpec('codex').envAllow.prefixes });
    const lastMessageFile = join(tmpdir(), `evolver-codex-distill-${randomUUID()}.txt`);
    const args = codexDistillArgs(ctx.cwd, lastMessageFile, ctx.env['EVOLVE_DISTILL_MODEL']);
    const resolved = exec.resolveSpawnCommand('codex', args, env);
    try {
        const r = await exec.spawnCapture(resolved.cmd, resolved.args, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, input: prompt, env });
        let stdout = r.stdout;
        try {
            const last = readFileSync(lastMessageFile, 'utf8').trim();
            if (last)
                stdout = last;
        }
        catch { /* file absent (codex failed early) → keep raw stdout for pickGeneObject */ }
        return { exitCode: r.code, stdout, stderr: r.stderr };
    }
    catch (e) {
        return { exitCode: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
    finally {
        try {
            rmSync(lastMessageFile, { force: true });
        }
        catch { /* best-effort temp cleanup */ }
    }
}
const DISTILL_RUNNERS = { claude: runClaudeDistill, codex: runCodexDistill };
/** Pick the distill runner from EVOLVE_DISTILL_PROVIDER. Unknown/unset → claude (cursor is never a distill provider). */
export function resolveDistillRunner(env) {
    const raw = String(env['EVOLVE_DISTILL_PROVIDER'] ?? '').trim().toLowerCase();
    const provider = Object.prototype.hasOwnProperty.call(DISTILL_RUNNERS, raw) ? raw : 'claude';
    return DISTILL_RUNNERS[provider];
}
async function emitDistilledEventIfAbsent(ingestor, gene, dataHash, capsuleCount) {
    if (!ingestor)
        return;
    const assetId = gene.asset_id;
    const exists = ingestor.readAll().some((event) => {
        const payload = event.payload;
        return event.type === 'gene.distilled' && payload?.['assetId'] === assetId && payload?.['source'] === 'auto-distill-llm';
    });
    if (exists)
        return;
    await ingestor.ingest({
        type: 'gene.distilled',
        payload: {
            geneId: gene['id'],
            assetId,
            source: 'auto-distill-llm',
            dataHash,
            capsuleCount,
        },
        human: { title: `LLM auto-distilled gene ${String(gene['id'] ?? assetId)}`, severity: 'info' },
        actor: { kind: 'machine', id: 'auto-distill-llm' },
    });
}
export async function autoDistillLlm(options) {
    const env = options.env ?? process.env;
    const mode = resolveMode(env, options.mode);
    if (mode === 'off')
        return { ok: false, mode, reason: 'disabled' };
    const cwd = options.cwd ?? process.cwd();
    const now = options.now?.() ?? Date.now();
    const statePath = options.statePath ?? autoDistillLlmStatePath();
    const maxCapsules = options.maxCapsules ?? envInt(env, 'EVOLVER_AUTO_DISTILL_LLM_MAX_CAPSULES', DEFAULT_MAX_CAPSULES);
    const minCapsules = options.minCapsules ?? envInt(env, 'EVOLVER_AUTO_DISTILL_LLM_MIN_CAPSULES', DEFAULT_MIN_CAPSULES);
    const minSuccessScore = envFloat(env, 'EVOLVER_AUTO_DISTILL_LLM_MIN_SUCCESS_SCORE', DEFAULT_MIN_SUCCESS_SCORE);
    const input = await collectDistillInput(options.store, maxCapsules, minSuccessScore);
    if (input.successCapsules.length < minCapsules)
        return { ok: false, mode, reason: 'insufficient_data', dataHash: input.dataHash };
    let state;
    try {
        state = readState(statePath);
    }
    catch {
        return { ok: false, mode, reason: 'state_read_failed', dataHash: input.dataHash };
    }
    const cooldownMs = envInt(env, 'EVOLVER_AUTO_DISTILL_LLM_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
    const maxAttempts = envInt(env, 'EVOLVER_AUTO_DISTILL_LLM_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
    const decision = p3Decide(mode, state.p3_llm.by_hash[input.dataHash], now, { cooldownMs, maxAttempts });
    if (decision !== 'spawn')
        return { ok: false, mode, reason: decision, dataHash: input.dataHash };
    const hashCap = envInt(env, 'EVOLVER_AUTO_DISTILL_LLM_HASH_CAP', DEFAULT_HASH_CAP);
    if (!patchState(statePath, input.dataHash, { last_attempt_at: new Date(now).toISOString() }, hashCap)) {
        return { ok: false, mode, reason: 'state_write_failed', dataHash: input.dataHash };
    }
    const runner = options.runner ?? resolveDistillRunner(env);
    const timeoutMs = envInt(env, 'EVOLVE_DISTILL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const prompt = buildDistillPrompt(input);
    // Egress-floor parity: buildDistillPrompt already pattern-redacts via hub.redactDeep, but the Hub publish path
    // additionally runs a REVERSE env-value scan (hub.detectEnvValueLeaks) that flags any process-env value
    // appearing verbatim in the payload — catching custom-format secrets no pattern matches. The prompt is an
    // off-box egress (stdin to a spawned `claude`), so hold it to the same floor the repo enforces on publish: if a
    // daemon env secret leaked into a capsule, fail CLOSED and never send it. This is a data-hygiene block, not a
    // deterministic claude failure, so — like a transient exit below — it does NOT bump failed_attempts.
    if (hub.detectEnvValueLeaks(prompt, env).length > 0) {
        return { ok: false, mode, reason: 'prompt_env_leak_blocked', dataHash: input.dataHash };
    }
    const llm = await runner(prompt, { cwd, timeoutMs, env });
    if (llm.exitCode !== 0) {
        // V1 parity: a PROCESS-level claude failure — spawn error/ENOENT or timeout→SIGKILL (exitCode === null), OR a
        // non-null nonzero exit code — is TRANSIENT and must NOT count toward failed_attempts. Only a usable-but-bad
        // RESULT (is_error / no-gene / validation / near-duplicate / light-validation, below) is deterministic and
        // bumps toward failed_exhausted. V1 buckets a raw nonzero exit with spawn-error/timeout and keeps retrying it;
        // bumping here would let an environmental hiccup (e.g. a rate-limit surfacing as exit 1 rather than null)
        // permanently exhaust this data hash after MAX_ATTEMPTS — the exact silent stall this exemption prevents.
        return { ok: false, mode, reason: llm.exitCode === null ? 'claude_spawn_error' : 'claude_nonzero_exit', dataHash: input.dataHash };
    }
    const raw = parseDistillOutput(llm.stdout);
    const candidate0 = asGeneCandidate(raw);
    if (!candidate0) {
        patchState(statePath, input.dataHash, { failed_attempts_inc: true }, hashCap);
        return { ok: false, mode, reason: 'no_gene_in_response', dataHash: input.dataHash };
    }
    const existing = existingGeneRefs(input.existingGenes);
    const normalized = normalizeValidation(candidate0, cwd).candidate;
    const duplicate = jaccardDuplicate(normalized, existing, envFloat(env, 'EVOLVER_AUTO_DISTILL_LLM_DUP_JACCARD', DEFAULT_DUP_JACCARD));
    if (duplicate) {
        patchState(statePath, input.dataHash, { failed_attempts_inc: true }, hashCap);
        return { ok: false, mode, reason: 'near_duplicate', dataHash: input.dataHash };
    }
    const intake = algo.intakeGene(normalized, existing);
    if (!intake.ok || !intake.gene) {
        patchState(statePath, input.dataHash, { failed_attempts_inc: true }, hashCap);
        return { ok: false, mode, reason: 'validation_failed', dataHash: input.dataHash };
    }
    const validation = await verify.runSandboxedValidation(intake.gene.validation, cwd, {
        timeoutMs: options.validationTimeoutMs ?? envInt(env, 'EVOLVE_DISTILL_VALIDATION_TIMEOUT_MS', DEFAULT_VALIDATION_TIMEOUT_MS),
    });
    if (!validation.passed) {
        patchState(statePath, input.dataHash, { failed_attempts_inc: true }, hashCap);
        return { ok: false, mode, reason: 'light_validation_failed', dataHash: input.dataHash };
    }
    if (mode === 'shadow') {
        patchState(statePath, input.dataHash, { shadowed_at: new Date(now).toISOString() }, hashCap);
        return { ok: false, mode, reason: 'shadow_logged', dataHash: input.dataHash, candidate: normalized };
    }
    const gene = intake.gene;
    await emitDistilledEventIfAbsent(options.ingestor, gene, input.dataHash, input.successCapsules.length);
    options.review?.quarantineIfAbsent(gene.asset_id, 'LLM auto-distilled — review before use');
    const put = await options.store.put(gene);
    const stateWritten = patchState(statePath, input.dataHash, { enforced_at: new Date(now).toISOString(), enforced_gene_id: String(gene['id'] ?? '') }, hashCap);
    if (!stateWritten)
        return { ok: false, mode, reason: 'state_write_failed_after_store', dataHash: input.dataHash };
    return { ok: true, mode, gene, dataHash: input.dataHash, stored: put.stored };
}
export function resolveAutoDistillLlm(env, opts) {
    const mode = resolveMode(env);
    if (mode === 'off')
        return { enabled: false, mode, reason: 'off', tick: async () => ({ ok: false, mode, reason: 'disabled' }) };
    return { enabled: true, mode, tick: () => autoDistillLlm({ ...opts, env, mode }) };
}