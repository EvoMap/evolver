import { createHash } from 'node:crypto';
export const JEV_DECISION_SCHEMA_VERSION = 'evolver-v2.jev-decision-shadow.v1';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8009';
const DEFAULT_MODEL = 'kev-latest';
function digest(input) {
    const canonical = JSON.stringify({ options: input.options, state: input.state });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
function loopbackBaseUrl(value) {
    if (value !== value.trim())
        throw new Error('jev endpoint must not contain surrounding whitespace');
    const url = new URL(value);
    if (url.protocol !== 'http:')
        throw new Error('jev endpoint must use http');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        throw new Error('jev endpoint must be loopback');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('jev endpoint must not include credentials, query, or fragment');
    }
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
}
function validProbabilities(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.values(value).every((probability) => typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1);
}
function fallback(input, model, endpoint, reason) {
    return {
        schemaVersion: JEV_DECISION_SCHEMA_VERSION,
        provider: 'jev',
        model,
        endpoint,
        status: 'fallback',
        advisoryOnly: true,
        deterministicAuthority: true,
        inputDigest: digest(input),
        fallbackReason: reason,
    };
}
export class JevDecisionCapability {
    enabled;
    baseUrl;
    model;
    timeoutMs;
    fetchImpl;
    constructor(options = {}) {
        this.enabled = options.enabled ?? false;
        this.baseUrl = loopbackBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
        this.model = options.model ?? DEFAULT_MODEL;
        const configuredTimeout = options.timeoutMs ?? 12_000;
        this.timeoutMs = Number.isFinite(configuredTimeout)
            ? Math.max(50, Math.min(30_000, Math.floor(configuredTimeout)))
            : 12_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    static fromEnvironment(env = process.env, fetchImpl) {
        return new JevDecisionCapability({
            enabled: env.EVOLVER_JEV_DECISION_ENABLED === 'true',
            baseUrl: env.EVOLVER_JEV_BASE_URL ?? DEFAULT_BASE_URL,
            model: env.EVOLVER_JEV_MODEL ?? DEFAULT_MODEL,
            timeoutMs: env.EVOLVER_JEV_TIMEOUT_MS ? Number(env.EVOLVER_JEV_TIMEOUT_MS) : undefined,
            fetchImpl,
        });
    }
    async evaluate(input) {
        const snapshot = { state: input.state.slice(0, 4_000), options: { ...input.options } };
        const endpoint = `${this.baseUrl}/v1/systemone`;
        const inputDigest = digest(snapshot);
        if (!this.enabled)
            return fallback(snapshot, this.model, endpoint, 'disabled');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const started = performance.now();
        try {
            const response = await this.fetchImpl(endpoint, {
                method: 'POST',
                redirect: 'error',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    state: snapshot.state,
                    model: this.model,
                    questions: {
                        decision: {
                            type: 'choice',
                            instructions: 'Return advisory evidence only. Do not approve, publish, settle, or override deterministic verification.',
                            criteria: snapshot.options,
                        },
                    },
                }),
                signal: controller.signal,
            });
            if (!response.ok)
                return fallback(snapshot, this.model, endpoint, `http_${response.status}`);
            const body = (await response.json());
            const answer = body.answers?.decision;
            if (!answer ||
                typeof answer.choice !== 'string' ||
                !Object.prototype.hasOwnProperty.call(snapshot.options, answer.choice) ||
                (answer.confidence !== undefined && (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) ||
                (answer.probabilities !== undefined && !validProbabilities(answer.probabilities))) {
                return fallback(snapshot, this.model, endpoint, 'invalid_schema');
            }
            const evidence = {
                schemaVersion: JEV_DECISION_SCHEMA_VERSION,
                provider: 'jev',
                model: this.model,
                endpoint,
                status: 'ok',
                advisoryOnly: true,
                deterministicAuthority: true,
                inputDigest,
                choice: answer.choice,
                latencyMs: performance.now() - started,
            };
            if (typeof answer.confidence === 'number')
                evidence.confidence = answer.confidence;
            if (validProbabilities(answer.probabilities))
                evidence.probabilities = answer.probabilities;
            return evidence;
        }
        catch (error) {
            return fallback(snapshot, this.model, endpoint, error instanceof Error ? error.name : 'request_failed');
        }
        finally {
            clearTimeout(timer);
        }
    }
}