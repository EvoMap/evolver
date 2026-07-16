import { events, hub as hubNs, observers } from '@evomap/evolver-core';
import { HUB_CONNECT_TIMEOUT_MS, } from '@evomap/evolver-adapter-public';
const MEMORY_EVENT_MIRROR_TYPES = {
    'cycle.started': 'attempt',
    'decision.gene_selected': 'attempt',
    'cycle.failed': 'validation',
    'gene.distilled': 'skill_emit',
    'capsule.produced': 'outcome',
    'value.reuse_hit': 'outcome',
    'value.reuse_outcome': 'outcome',
    'mutation.built': 'mutation_draft',
    'cycle.solidified': 'solidify',
    'evolution_event.projected': 'solidify',
};
const MEMORY_EVENT_MIRROR_EVENT_TYPES = Object.keys(MEMORY_EVENT_MIRROR_TYPES);
const DEFAULT_MEMORY_EVENT_MAX_CHARS = 12_000;
const MEMORY_EVENT_MIRROR_TIMEOUT_MS = HUB_CONNECT_TIMEOUT_MS + 5_000;
function memoryGraphSyncDisabled(env = process.env) {
    return isOff(env['MEMORY_GRAPH_SYNC_HUB']) || isOff(env['EVOLVER_MEMORY_GRAPH_SYNC_HUB']);
}
export function rootEventMemoryGraphKind(type) {
    return MEMORY_EVENT_MIRROR_TYPES[type] ?? null;
}
export function buildMemoryGraphMirrorEvent(event, opts = {}) {
    const kind = rootEventMemoryGraphKind(event.type);
    if (!kind)
        return null;
    const maxChars = opts.maxChars ?? DEFAULT_MEMORY_EVENT_MAX_CHARS;
    const env = opts.env ?? {};
    const payload = sanitizeValue(event.payload, maxChars, env);
    const human = sanitizeValue(event.human, maxChars, env);
    const actor = sanitizeValue(event.actor, maxChars, env);
    return {
        kind,
        event: {
            type: 'MemoryGraphEvent',
            kind,
            id: event.eventId,
            ts: event.ts,
            source: {
                eventId: event.eventId,
                seq: event.seq,
                type: event.type,
            },
            payload: payload.value,
            human: human.value,
            actor: actor.value,
            ...(payload.truncated || human.truncated || actor.truncated ? { truncated: true } : {}),
        },
    };
}
export function memoryEventMirrorObserver(hub, opts = {}) {
    return {
        meta: {
            name: 'memory-event-mirror',
            idempotent: true,
            timeoutMs: MEMORY_EVENT_MIRROR_TIMEOUT_MS,
            eventTypes: MEMORY_EVENT_MIRROR_EVENT_TYPES,
        },
        async handle(event) {
            if (memoryGraphSyncDisabled(opts.env ?? process.env))
                return;
            const report = buildMemoryGraphMirrorEvent(event, { maxChars: opts.maxChars, env: opts.env ?? process.env });
            if (!report)
                return;
            try {
                await hub.recordMemoryEvent(report);
            }
            catch {
                // Hub mirroring is telemetry only. Local root_event durability must never depend on it.
            }
        },
    };
}
export function resolveMemoryEventMirrorObserver(env = process.env, hub) {
    if (memoryGraphSyncDisabled(env))
        return { enabled: false, reason: 'disabled', observer: null };
    if (!hub || typeof hub.recordMemoryEvent !== 'function')
        return { enabled: false, reason: 'no_hub', observer: null };
    return { enabled: true, observer: memoryEventMirrorObserver(hub, { env }) };
}
function isOff(value) {
    if (value === undefined)
        return false;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '' || normalized === '0' || normalized === 'false' || normalized === 'off';
}
function sanitizeValue(value, maxChars, env) {
    const redacted = hubNs.redactDeep(redactEnvValues(value, env));
    let json;
    try {
        json = JSON.stringify(redacted);
    }
    catch {
        json = hubNs.redactString(String(redacted));
    }
    if (hubNs.detectEnvValueLeaks(json, env).length > 0) {
        return {
            value: {
                redacted: true,
                reason: 'env_value_leak',
            },
            truncated: false,
        };
    }
    if (json.length <= maxChars)
        return { value: redacted, truncated: false };
    return {
        value: {
            truncated: true,
            redactedJson: hubNs.redactString(json).slice(0, maxChars),
        },
        truncated: true,
    };
}
function redactEnvValues(value, env) {
    if (typeof value === 'string')
        return redactEnvValueString(value, env);
    if (Array.isArray(value))
        return value.map((item) => redactEnvValues(item, env));
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
        const safeKey = hubNs.redactString(redactEnvValueString(key, env));
        out[safeKey] = redactEnvValues(nested, env);
    }
    return out;
}
function redactEnvValueString(value, env) {
    let out = value;
    for (const [key, secret] of Object.entries(env)) {
        if (!secret || secret.length < 8)
            continue;
        if (hubNs.detectEnvValueLeaks(out, { [key]: secret }).length === 0)
            continue;
        out = out.split(secret).join(hubNs.REDACTED);
    }
    return out;
}