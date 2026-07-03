// Anti-gene LLM distillation (#326 slice 2): learn guardrails from repeated failures without adding executable
// strategies to the Gene pool. The output is a local AntiGene asset, quarantined by default, and never selected by
// the Gene candidate/fallback pool. Approved, signal-matched AntiGenes are surfaced only as advisory warnings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { algo, assetstore, events, hub, wire } from '@evomap/evolver-core';
import { p3Decide, resolveDistillRunner, } from './autoDistillLlm.js';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_COOLDOWN_MS = 1_800_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_HASH_CAP = 64;
const DEFAULT_MAX_CLUSTERS = 8;
const DEFAULT_SEVERITY = 'medium';
const ALL_CAPSULES_LIMIT = Number.MAX_SAFE_INTEGER;
function autoDistillAntiGeneStatePath(home = events.evomapHome()) {
    return join(home, 'evolution', 'auto-distill-anti-gene-state.json');
}
function envInt(env, name, fallback) {
    const n = Number.parseInt(String(env[name] ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envFloat(env, name, fallback) {
    const n = Number.parseFloat(String(env[name] ?? ''));
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}
function resolveMode(env, explicit) {
    const raw = String(explicit ?? env['EVOLVER_AUTO_DISTILL_ANTI_GENE'] ?? 'off').trim().toLowerCase();
    return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}
function readState(path) {
    if (!existsSync(path))
        return { version: 1, by_hash: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { version: 1, by_hash: parsed.by_hash && typeof parsed.by_hash === 'object' ? parsed.by_hash : {} };
}
function writeState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
}
function hasSkipState(record) {
    return Boolean(record?.enforced_at || record?.shadowed_at || (record?.failed_attempts ?? 0) > 0);
}
function capByHash(byHash, cap, preserveKey) {
    const keys = Object.keys(byHash);
    if (keys.length <= cap)
        return byHash;
    const age = (key) => {
        const rec = byHash[key] ?? {};
        return Math.max(Date.parse(rec.shadowed_at ?? '') || 0, Date.parse(rec.enforced_at ?? '') || 0, Date.parse(rec.last_attempt_at ?? '') || 0);
    };
    const evictable = keys
        .filter((key) => key !== preserveKey && !hasSkipState(byHash[key]))
        .sort((a, b) => age(a) - age(b));
    const terminalEvictable = keys
        .filter((key) => key !== preserveKey && hasSkipState(byHash[key]))
        .sort((a, b) => age(a) - age(b));
    for (const key of [...evictable, ...terminalEvictable]) {
        if (Object.keys(byHash).length <= cap)
            break;
        delete byHash[key];
    }
    return byHash;
}
function patchState(path, dataHash, patch, cap) {
    try {
        const state = readState(path);
        const cur = state.by_hash[dataHash] ?? { shadowed_at: null, enforced_at: null, enforced_gene_id: null, failed_attempts: 0, last_attempt_at: null };
        const next = { ...cur, ...patch };
        if (patch.failed_attempts_inc)
            next.failed_attempts = (cur.failed_attempts ?? 0) + 1;
        delete next.failed_attempts_inc;
        state.by_hash[dataHash] = next;
        state.by_hash = capByHash(state.by_hash, cap, dataHash);
        writeState(path, state);
        return true;
    }
    catch {
        return false;
    }
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
                    catch { /* keep scanning from the next opening brace */ }
                    break;
                }
            }
        }
        start = s.indexOf('{', advanced >= 0 ? advanced : start + 1);
    }
    return out;
}
function pickAntiGeneObject(text) {
    const objects = findJsonObjects(text);
    const antiGene = objects.find((object) => isRecord(object) && object['type'] === 'AntiGene');
    if (antiGene)
        return antiGene;
    const decline = objects.find((object) => isRecord(object) && object['type'] === 'none');
    if (decline)
        return decline;
    return objects[0] ?? null;
}
function isAntiGeneOrDecline(value) {
    return isRecord(value) && (value['type'] === 'AntiGene' || value['type'] === 'none');
}
function parseAntiGeneOutput(stdout) {
    const text = String(stdout ?? '');
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (!last)
        return null;
    try {
        const parsed = JSON.parse(last);
        if (isRecord(parsed) && 'is_error' in parsed) {
            if (parsed['is_error'])
                return null;
            const result = parsed['result'];
            if (typeof result === 'string')
                return pickAntiGeneObject(result);
            return isAntiGeneOrDecline(result) ? result : pickAntiGeneObject(text) ?? result;
        }
        return isAntiGeneOrDecline(parsed) ? parsed : pickAntiGeneObject(text) ?? parsed;
    }
    catch {
        return pickAntiGeneObject(text);
    }
}
function strings(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}
function asSeverity(value) {
    return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}
function asAntiGeneCandidate(value) {
    if (!isRecord(value))
        return null;
    if (typeof value['type'] === 'string' && value['type'] !== 'AntiGene')
        return null;
    const summary = typeof value['summary'] === 'string' ? value['summary'].trim() : '';
    const trigger = strings(value['trigger']);
    const avoid = strings(value['avoid']);
    if (!summary || trigger.length === 0 || avoid.length === 0)
        return null;
    return {
        ...(typeof value['id'] === 'string' && value['id'].trim() ? { id: value['id'].trim() } : {}),
        summary,
        trigger,
        avoid,
        ...(typeof value['rationale'] === 'string' && value['rationale'].trim() ? { rationale: value['rationale'].trim() } : {}),
        ...(asSeverity(value['severity']) ? { severity: asSeverity(value['severity']) } : {}),
        ...(strings(value['evidence_capsules']).length > 0 ? { evidence_capsules: strings(value['evidence_capsules']) } : {}),
        ...(strings(value['source_clusters']).length > 0 ? { source_clusters: strings(value['source_clusters']) } : {}),
    };
}
function slug(value) {
    const out = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return out || 'recurring-failure-guardrail';
}
function buildAntiGenePrompt(input) {
    const clusters = hub.redactDeep(input.failureClusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        trigger: cluster.trigger,
        sharedTrigger: cluster.sharedTrigger,
        capsuleIds: cluster.capsuleIds,
        genes: cluster.genes,
        failures: cluster.failureCapsules.map((capsule) => ({
            capsuleId: capsule.capsuleId,
            trigger: capsule.trigger,
            gene: capsule.gene,
            summary: capsule.summary,
            outcome: capsule.outcome,
            proofOfWork: capsule.proofOfWork,
        })),
    })));
    return [
        'You are synthesizing one EvoMap AntiGene from recurring failed Capsules.',
        'An AntiGene is a guardrail: it says what to avoid or check before repeating a known failure pattern.',
        'Return only JSON. Do not use markdown. Do not include commentary.',
        '',
        'Rules:',
        '- Produce a single AntiGene object.',
        '- Do not include executable strategy steps. The asset must never be used as a Gene strategy.',
        '- Trigger tokens must be generic failure signals, not one-off file names or secrets.',
        '- Avoid entries must be concrete guardrails phrased as things NOT to do, or pre-flight checks to prevent recurrence.',
        '- If the clusters do not show a reusable repeated failure pattern, return exactly {"type":"none"}.',
        '',
        'Required JSON shape:',
        '{"type":"AntiGene","id":"anti_gene_<descriptive-kebab-name>","summary":"...","trigger":["signal"],"avoid":["guardrail"],"rationale":"...","severity":"low|medium|high","source_clusters":["anti_cluster_..."],"evidence_capsules":["sha256:..."]}',
        '',
        `DATA_HASH: ${input.dataHash}`,
        `FAILED_CAPSULE_COUNT: ${input.failedCapsuleCount}`,
        'FAILURE_CLUSTERS:',
        JSON.stringify(clusters, null, 2),
    ].join('\n');
}
function toAntiGeneAsset(candidate, input) {
    const sourceClusters = candidate.source_clusters?.length
        ? candidate.source_clusters
        : input.failureClusters.map((cluster) => cluster.clusterId);
    const evidenceCapsules = candidate.evidence_capsules?.length
        ? candidate.evidence_capsules
        : [...new Set(input.failureClusters.flatMap((cluster) => cluster.capsuleIds))].sort();
    const failureCount = input.failureClusters.reduce((sum, cluster) => sum + cluster.capsuleIds.length, 0);
    const record = {
        type: 'AntiGene',
        schema_version: wire.SCHEMA_VERSION,
        id: candidate.id && candidate.id.startsWith('anti_gene_') ? candidate.id : `anti_gene_${slug(candidate.id ?? candidate.summary)}`,
        summary: candidate.summary,
        trigger: [...new Set(candidate.trigger)].sort(),
        avoid: [...new Set(candidate.avoid)],
        source_clusters: [...new Set(sourceClusters)].sort(),
        evidence_capsules: [...new Set(evidenceCapsules)].sort(),
        failure_count: failureCount,
        ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
        severity: candidate.severity ?? DEFAULT_SEVERITY,
    };
    const assetId = wire.computeAssetId({ ...record, asset_id: '' });
    if (!assetId)
        throw new Error('AntiGene asset_id compute failed');
    return { ...record, asset_id: assetId };
}
async function emitDistilledEventIfAbsent(ingestor, antiGene, dataHash, clusterCount) {
    if (!ingestor)
        return;
    const exists = ingestor.readAll().some((event) => {
        const payload = event.payload;
        return event.type === 'anti_gene.distilled' && payload?.['assetId'] === antiGene.asset_id && payload?.['source'] === 'auto-distill-anti-gene';
    });
    if (exists)
        return;
    await ingestor.ingest({
        type: 'anti_gene.distilled',
        payload: {
            antiGeneId: antiGene.id,
            assetId: antiGene.asset_id,
            source: 'auto-distill-anti-gene',
            dataHash,
            clusterCount,
            failureCount: antiGene.failure_count,
        },
        human: { title: `anti-gene distilled ${antiGene.id}`.slice(0, 80), severity: 'info' },
        actor: { kind: 'machine', id: 'auto-distill-anti-gene' },
    });
}
async function emitShadowObservationIfAbsent(ingestor, dataHash, observation) {
    if (!ingestor)
        return;
    const exists = ingestor.readAll().some((event) => {
        const payload = event.payload;
        return event.type === 'anti_gene.distill_shadowed' && payload?.['dataHash'] === dataHash && payload?.['source'] === 'auto-distill-anti-gene';
    });
    if (exists)
        return;
    const payload = observation.status === 'candidate'
        ? {
            dataHash,
            source: 'auto-distill-anti-gene',
            status: 'candidate',
            summary: observation.candidate.summary,
            trigger: observation.candidate.trigger,
            avoid: observation.candidate.avoid,
        }
        : { dataHash, source: 'auto-distill-anti-gene', status: 'declined' };
    const title = observation.status === 'candidate'
        ? `shadow anti-gene candidate ${slug(observation.candidate.summary)}`
        : 'shadow anti-gene declined';
    await ingestor.ingest({
        type: 'anti_gene.distill_shadowed',
        payload,
        human: { title: title.slice(0, 80), severity: 'info' },
        actor: { kind: 'machine', id: 'auto-distill-anti-gene' },
    });
}
export async function autoDistillAntiGene(options) {
    const env = options.env ?? process.env;
    const mode = resolveMode(env, options.mode);
    if (mode === 'off')
        return { ok: false, mode, reason: 'disabled' };
    const capsules = await options.store.list('Capsule', ALL_CAPSULES_LIMIT);
    const input = algo.collectAntiDistillInput(capsules, {
        minFailures: options.minFailures ?? envInt(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_MIN_FAILURES', algo.ANTI_DISTILL_MIN_FAILURES),
        triggerOverlapMin: options.triggerOverlapMin ?? envFloat(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_TRIGGER_OVERLAP_MIN', algo.ANTI_DISTILL_TRIGGER_OVERLAP_MIN),
        maxClusters: options.maxClusters ?? envInt(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_MAX_CLUSTERS', DEFAULT_MAX_CLUSTERS),
    });
    if (input.failureClusters.length === 0)
        return { ok: false, mode, reason: 'insufficient_data', dataHash: input.dataHash };
    const now = options.now?.() ?? Date.now();
    const statePath = options.statePath ?? autoDistillAntiGeneStatePath();
    let state;
    try {
        state = readState(statePath);
    }
    catch {
        return { ok: false, mode, reason: 'state_read_failed', dataHash: input.dataHash };
    }
    const cooldownMs = envInt(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
    const maxAttempts = envInt(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
    const decision = p3Decide(mode, state.by_hash[input.dataHash], now, { cooldownMs, maxAttempts });
    if (decision !== 'spawn')
        return { ok: false, mode, reason: decision, dataHash: input.dataHash };
    const hashCap = envInt(env, 'EVOLVER_AUTO_DISTILL_ANTI_GENE_HASH_CAP', DEFAULT_HASH_CAP);
    if (!patchState(statePath, input.dataHash, { last_attempt_at: new Date(now).toISOString() }, hashCap)) {
        return { ok: false, mode, reason: 'state_write_failed', dataHash: input.dataHash };
    }
    const prompt = buildAntiGenePrompt(input);
    if (hub.detectEnvValueLeaks(prompt, env).length > 0) {
        return { ok: false, mode, reason: 'prompt_env_leak_blocked', dataHash: input.dataHash };
    }
    const runner = options.runner ?? resolveDistillRunner(env);
    const timeoutMs = envInt(env, 'EVOLVE_DISTILL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const llm = await runner(prompt, { cwd: options.cwd ?? process.cwd(), timeoutMs, env });
    if (llm.exitCode !== 0) {
        return { ok: false, mode, reason: llm.exitCode === null ? 'llm_spawn_error' : 'llm_nonzero_exit', dataHash: input.dataHash };
    }
    const parsed = parseAntiGeneOutput(llm.stdout);
    if (parsed && isRecord(parsed) && parsed['type'] === 'none') {
        if (mode === 'shadow') {
            await emitShadowObservationIfAbsent(options.ingestor, input.dataHash, { status: 'declined' });
            if (!patchState(statePath, input.dataHash, { shadowed_at: new Date(now).toISOString() }, hashCap)) {
                return { ok: false, mode, reason: 'state_write_failed_after_shadow', dataHash: input.dataHash };
            }
            return { ok: false, mode, reason: 'shadow_logged', dataHash: input.dataHash };
        }
        if (!patchState(statePath, input.dataHash, { enforced_at: new Date(now).toISOString() }, hashCap)) {
            return { ok: false, mode, reason: 'state_write_failed_after_decline', dataHash: input.dataHash };
        }
        return { ok: false, mode, reason: 'no_reusable_failure_pattern', dataHash: input.dataHash };
    }
    const candidate = asAntiGeneCandidate(parsed);
    if (!candidate) {
        patchState(statePath, input.dataHash, { failed_attempts_inc: true }, hashCap);
        return { ok: false, mode, reason: 'no_anti_gene_in_response', dataHash: input.dataHash };
    }
    if (mode === 'shadow') {
        await emitShadowObservationIfAbsent(options.ingestor, input.dataHash, { status: 'candidate', candidate });
        if (!patchState(statePath, input.dataHash, { shadowed_at: new Date(now).toISOString() }, hashCap)) {
            return { ok: false, mode, reason: 'state_write_failed_after_shadow', dataHash: input.dataHash, candidate };
        }
        return { ok: false, mode, reason: 'shadow_logged', dataHash: input.dataHash, candidate };
    }
    const antiGene = toAntiGeneAsset(candidate, input);
    await emitDistilledEventIfAbsent(options.ingestor, antiGene, input.dataHash, input.failureClusters.length);
    options.review?.quarantineIfAbsent(antiGene.asset_id, 'anti-gene LLM-distilled - review before use');
    const put = await options.store.put(antiGene);
    const stateWritten = patchState(statePath, input.dataHash, { enforced_at: new Date(now).toISOString(), enforced_gene_id: antiGene.id }, hashCap);
    if (!stateWritten)
        return { ok: false, mode, reason: 'state_write_failed_after_store', dataHash: input.dataHash };
    return { ok: true, mode, antiGene, dataHash: input.dataHash, stored: put.stored };
}
export function resolveAutoDistillAntiGene(env, opts) {
    const mode = resolveMode(env);
    if (mode === 'off')
        return { enabled: false, mode, reason: 'off', tick: async () => ({ ok: false, mode, reason: 'disabled' }) };
    return { enabled: true, mode, tick: () => autoDistillAntiGene({ ...opts, env, mode }) };
}