import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLock, releaseLock } from './util/fileLock.js';
const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 512;
const MAX_HISTORY = 20_000;
const STABLE_ENVIRONMENT_KEYS = new Set([
    'adapterVersion', 'arch', 'capabilities', 'features', 'node', 'nodeVersion', 'os', 'platform',
    'provider', 'providerVersion', 'runtime', 'schemaVersion', 'toolchain', 'validatorVersion',
]);
const SECRET_OR_VOLATILE_KEY = /(?:token|secret|password|authorization|api[_-]?key|credential|captured|timestamp|hostname|host|cwd|device|machine|serial|uuid|path)/i;
function bounded(value, limit = MAX_TEXT) {
    return typeof value === 'string' ? value.slice(0, limit) : '';
}
function canonical(value, depth = 0) {
    if (depth > 20)
        return '[depth-limit]';
    if (Array.isArray(value))
        return value.map((item) => canonical(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [
            key, canonical(value[key], depth + 1),
        ]));
    }
    if (typeof value === 'number' && !Number.isFinite(value))
        return String(value);
    return value;
}
export function canonicalDigest(value) {
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function normalizeEnvironmentFingerprint(environment) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment))
        return canonicalDigest({});
    const source = environment;
    const selected = Object.fromEntries(Object.keys(source)
        .filter((key) => STABLE_ENVIRONMENT_KEYS.has(key) && !SECRET_OR_VOLATILE_KEY.test(key))
        .sort()
        .map((key) => [key, canonical(source[key])]));
    return canonicalDigest(selected);
}
function normalizedBudget(budget) {
    if (!Number.isFinite(budget.maxUsd) || budget.maxUsd <= 0)
        throw new Error('budget.maxUsd must be positive');
    if (!Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs < 1 || budget.timeoutMs > 120_000) {
        throw new Error('budget.timeoutMs must be an integer from 1 to 120000');
    }
    return { maxUsd: budget.maxUsd, timeoutMs: budget.timeoutMs };
}
export function compatibilityKey(test) {
    const budget = normalizedBudget(test.budget);
    const family = bounded(test.taskFamily, 256);
    if (!family)
        throw new Error('taskFamily is required');
    const requestedModelId = bounded(test.requestedModelId);
    if (!requestedModelId)
        throw new Error('requestedModelId is required');
    return Object.freeze({
        type: bounded(test.asset.type, 256),
        id: bounded(test.asset.id),
        revision: bounded(test.asset.revision, 256),
        requestedModelId,
        family,
        inputDigest: canonicalDigest(test.input),
        budget,
        environmentFingerprint: normalizeEnvironmentFingerprint(test.environment),
    });
}
export function compatibilityKeyString(key) {
    return JSON.stringify(canonical(key));
}
export function validationTrace(isolated, steps) {
    const normalized = steps.map((step) => ({
        command: bounded(step.command, 2048),
        exitCode: typeof step.exitCode === 'number' ? step.exitCode : null,
        passed: step.passed === true,
        executed: step.executed === true,
        termination: step.termination,
    }));
    const complete = isolated && normalized.length > 0 && normalized.every((step) => (step.executed && step.exitCode !== null && step.termination === 'exit'));
    return { schemaVersion: 1, isolated, complete, steps: normalized, digest: canonicalDigest(normalized) };
}
export function validationTracesComparable(baseline, enabled) {
    return baseline.complete && enabled.complete
        && baseline.isolated && enabled.isolated
        && baseline.digest === enabled.digest;
}
export function isStrictRunnerSuccess(observation) {
    return observation.trust === 'claude-cli'
        && observation.ok
        && observation.exitCode === 0
        && observation.termination === 'exit'
        && observation.requestedModel.id.length > 0
        && observation.servedModel?.source === 'claude-cli-envelope'
        && observation.servedModel.id === observation.requestedModel.id
        && typeof observation.sessionId === 'string' && observation.sessionId.length > 0
        && observation.usage !== null
        && observation.usage.inputTokens >= 0
        && observation.usage.outputTokens >= 0
        && observation.usage.costUsd >= 0
        && observation.structuredResult !== null
        && observation.structuredResult !== undefined
        && observation.validation.complete
        && !observation.stdoutTruncated
        && !observation.stderrTruncated;
}
export function evaluateEvidence(evidence) {
    if (!isStrictRunnerSuccess(evidence.baseline))
        return 'inconclusive';
    if (!validationTracesComparable(evidence.baseline.validation, evidence.enabled.validation))
        return 'inconclusive';
    if (!isStrictRunnerSuccess(evidence.enabled))
        return 'quarantine';
    return 'compatible';
}
function failedObservation(mode, test) {
    return {
        trust: 'fixture', mode, ok: false, exitCode: null, termination: 'spawn-error',
        requestedModel: { id: test.requestedModelId }, servedModel: null, sessionId: null, usage: null,
        structuredResult: null, validation: validationTrace(false, []), stdoutTruncated: false, stderrTruncated: false,
    };
}
export async function replayCorpus(corpus, execute, options = {}) {
    const now = options.now ?? Date.now;
    const requestId = bounded(options.requestId ?? randomUUID(), 256) || randomUUID();
    const retries = Math.max(0, Math.min(options.retries ?? 1, 5));
    const startedAt = new Date(now()).toISOString();
    const evidence = [];
    let partial = false;
    const sorted = [...corpus].sort((a, b) => compatibilityKeyString(compatibilityKey(a)).localeCompare(compatibilityKeyString(compatibilityKey(b))));
    for (const test of sorted) {
        const outcomes = new Map();
        for (const mode of ['baseline', 'asset-enabled']) {
            let observation = failedObservation(mode, test);
            for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
                try {
                    observation = await execute({ mode, test, attempt });
                }
                catch {
                    observation = failedObservation(mode, test);
                }
                if (observation.termination === 'exit')
                    break;
            }
            outcomes.set(mode, observation);
        }
        const item = {
            schemaVersion: 4,
            requestId,
            key: compatibilityKey(test),
            baseline: outcomes.get('baseline'),
            enabled: outcomes.get('asset-enabled'),
            observedAt: new Date(now()).toISOString(),
            staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_MS,
        };
        if (evaluateEvidence(item) === 'inconclusive')
            partial = true;
        evidence.push(item);
    }
    return { schemaVersion: 4, requestId, startedAt, completedAt: new Date(now()).toISOString(), evidence, partial };
}
export class CompatibilityLedger {
    path;
    lockPath;
    constructor(path) {
        this.path = path;
        this.lockPath = `${path}.lock`;
        mkdirSync(dirname(path), { recursive: true });
    }
    state() {
        if (!existsSync(this.path))
            return { state: { schemaVersion: 4, nextSequence: 1, events: [] }, malformed: 0, legacy: 0 };
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            if (parsed.schemaVersion !== 4 || !Array.isArray(parsed.events)) {
                const legacyKey = canonicalDigest(parsed);
                const legacyEvent = {
                    schemaVersion: 4, sequence: 1, eventId: `legacy-${legacyKey}`, requestId: `legacy-${legacyKey}`,
                    transition: 'revalidate',
                    key: {
                        type: 'legacy', id: legacyKey, revision: String(parsed.schemaVersion ?? 'unknown'),
                        requestedModelId: 'legacy-unknown', family: 'legacy-migration', inputDigest: legacyKey,
                        budget: { maxUsd: 1, timeoutMs: 1 }, environmentFingerprint: canonicalDigest({}),
                    },
                    at: new Date(0).toISOString(), reason: 'legacy ledger requires explicit revalidation', legacyPayload: canonical(parsed),
                };
                return { state: { schemaVersion: 4, nextSequence: 2, events: [legacyEvent] }, malformed: 0, legacy: 1 };
            }
            const events = parsed.events.filter((event) => event?.schemaVersion === 4 && Number.isSafeInteger(event.sequence));
            const nextSequence = Math.max(Number(parsed.nextSequence) || 1, ...events.map((event) => event.sequence + 1));
            return { state: { schemaVersion: 4, nextSequence, events: events.slice(-MAX_HISTORY) }, malformed: 0, legacy: 0 };
        }
        catch {
            return { state: { schemaVersion: 4, nextSequence: 1, events: [] }, malformed: 1, legacy: 0 };
        }
    }
    read() {
        const current = this.state();
        return { events: current.state.events, malformed: current.malformed, legacy: current.legacy };
    }
    mutate(requestId, apply) {
        acquireLock(this.lockPath);
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            const { state } = this.state();
            if (state.events.some((event) => event.requestId === requestId))
                return false;
            apply(state);
            state.events = state.events.slice(-MAX_HISTORY);
            writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
            renameSync(temporary, this.path);
            return true;
        }
        finally {
            rmSync(temporary, { force: true });
            releaseLock(this.lockPath);
        }
    }
    appendRun(run) {
        return this.mutate(run.requestId, (state) => {
            for (const evidence of run.evidence) {
                state.events.push({
                    schemaVersion: 4, sequence: state.nextSequence++, eventId: randomUUID(), requestId: run.requestId,
                    transition: 'observation', key: evidence.key, at: evidence.observedAt, evidence,
                });
            }
        });
    }
    transition(key, transition, requestId, reason, now = Date.now()) {
        const boundedRequest = bounded(requestId, 256);
        if (!boundedRequest)
            throw new Error('requestId is required');
        if (!bounded(reason, 2048))
            throw new Error('transition reason is required');
        return this.mutate(boundedRequest, (state) => {
            const selected = compatibilityKeyString(key);
            const history = state.events
                .filter((event) => compatibilityKeyString(event.key) === selected)
                .sort((a, b) => a.sequence - b.sequence);
            if (transition === 'quarantine' && !history.some((event) => event.transition === 'observation')) {
                throw new Error('quarantine requires recorded evidence');
            }
            if (transition === 'release') {
                const lastQuarantine = history.findLastIndex((event) => event.transition === 'quarantine');
                const lastRevalidate = history.findLastIndex((event) => event.transition === 'revalidate');
                const successfulRevalidation = history.slice(lastRevalidate + 1).find((event) => (event.transition === 'observation' && event.evidence && evaluateEvidence(event.evidence) === 'compatible'));
                if (lastQuarantine < 0 || lastRevalidate <= lastQuarantine || !successfulRevalidation) {
                    throw new Error('release requires quarantine, explicit revalidate, and newer compatible evidence');
                }
            }
            state.events.push({
                schemaVersion: 4, sequence: state.nextSequence++, eventId: randomUUID(), requestId: boundedRequest,
                transition, key, at: new Date(now).toISOString(), reason: bounded(reason, 2048),
            });
        });
    }
    resolve(key, now = Date.now()) {
        const selected = compatibilityKeyString(key);
        const events = this.state().state.events.filter((event) => compatibilityKeyString(event.key) === selected);
        if (events.length === 0)
            return { decision: 'unrecorded', key, reason: 'no-evidence' };
        let quarantined = false;
        let needsRevalidation = false;
        let latestEvidence;
        let sequence;
        for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
            sequence = event.sequence;
            if (event.transition === 'quarantine')
                quarantined = true;
            if (event.transition === 'release') {
                quarantined = false;
                needsRevalidation = false;
            }
            if (event.transition === 'revalidate')
                needsRevalidation = true;
            if (event.transition === 'observation' && event.evidence) {
                latestEvidence = event.evidence;
                needsRevalidation = false;
            }
        }
        if (quarantined)
            return { decision: 'quarantine', key, evidence: latestEvidence, sequence, reason: 'sticky-quarantine' };
        if (!latestEvidence)
            return { decision: 'revalidate', key, sequence, reason: 'transition-without-evidence' };
        if (needsRevalidation || now - Date.parse(latestEvidence.observedAt) > latestEvidence.staleAfterMs) {
            return { decision: 'revalidate', key, evidence: latestEvidence, sequence, reason: needsRevalidation ? 'explicit-revalidate' : 'stale-at-resolution' };
        }
        return { decision: evaluateEvidence(latestEvidence), key, evidence: latestEvidence, sequence, reason: 'latest-evidence' };
    }
}
export function makeCompatibilityEvidenceIndex(ledger, context, now) {
    return {
        decisionFor: (identity) => ledger.resolve(compatibilityKey({
            ...context,
            asset: { type: identity.assetType, id: identity.assetId, revision: identity.revision },
            validation: [],
        }), (now ?? Date.now)()),
    };
}
export function checkAssetApplicability(identity, evidence) {
    if (!evidence)
        return { selectable: true, decision: 'unrecorded', reason: 'no-evidence-index' };
    const resolved = evidence.decisionFor(identity);
    return { selectable: resolved.decision !== 'quarantine', decision: resolved.decision, reason: resolved.reason };
}
export function isCompatibilityBlocked(identity, evidence) {
    return !checkAssetApplicability(identity, evidence).selectable;
}