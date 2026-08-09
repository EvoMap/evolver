// Read-only Evolution Graph projection over already-emitted root_events.
//
// PURE: a function over a root-event snapshot. It never appends events, writes assets, or mutates selection —
// projecting is strictly an observability concern (same posture as ops/reuseOutcomes.ts). The graph it returns is
// evidence for "which variant was selected on what basis, and was that later contradicted", not a new actuator.
//
// Every edge carries provenance back to the root_event seq that justified it, so a dashboard card can always be
// traced to a specific emitted event instead of a narrative summary.
import { deriveEvolutionGraphDashboardSummary, EVOLUTION_GRAPH_SCHEMA_VERSION, } from '../schema/evolutionGraph.js';
import { HOST_SUPPRESS_CLASSES } from '../algo/cycleFailureClassifier.js';
const DEFAULT_MAX_EVENTS = 5_000;
const MAX_LABEL = 120;
const RESOLUTION_STATUSES = new Set([
    'pending',
    'suppressed_observationally',
    'resolved_by_evidence',
    'regressed',
    'inconclusive',
]);
export function projectEvolutionGraph(events, options = {}) {
    const maxEvents = boundedLimit(options.maxEvents, DEFAULT_MAX_EVENTS);
    const window = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
    const builder = new GraphBuilder();
    for (const event of window)
        builder.absorb(event);
    const nodes = builder.nodes();
    const edges = builder.edges();
    const newestTs = window.length > 0 ? text(window[window.length - 1]?.ts) : '';
    return {
        schemaVersion: EVOLUTION_GRAPH_SCHEMA_VERSION,
        graphId: options.graphId ?? 'graph:evolution:root-events',
        generatedAt: options.generatedAt ?? (isoTimestamp(newestTs) ?? '1970-01-01T00:00:00.000Z'),
        nodes,
        edges,
        dashboard: deriveEvolutionGraphDashboardSummary({ nodes, edges }),
        extensions: {},
    };
}
class GraphBuilder {
    nodesById = new Map();
    edgesById = new Map();
    variantByLifecycle = new Map();
    /** cycleId can be reused; only events in the current lifecycle may share evidence or graph nodes. */
    lifecycleByCycle = new Map();
    nodes() {
        return [...this.nodesById.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    edges() {
        return [...this.edgesById.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    absorb(event) {
        const at = isoTimestamp(text(event.ts));
        if (!at)
            return;
        const payload = event.payload ?? {};
        const cycleId = opaqueId(payload['cycleId']);
        switch (event.type) {
            case 'cycle.started': {
                if (cycleId)
                    this.beginLifecycle(cycleId);
                return;
            }
            case 'capsule.produced': {
                if (!cycleId)
                    return;
                const capsuleId = opaqueId(payload['capsuleId']);
                const status = resolutionStatus(payload['resolutionStatus']);
                if (!capsuleId || !status)
                    return;
                const lifecycle = this.activeLifecycle(cycleId);
                lifecycle.capsule = {
                    capsuleId,
                    resolutionStatus: status,
                    producedValue: payload['producedValue'] === true,
                    event,
                };
                return;
            }
            case 'decision.gene_selected': {
                if (!cycleId)
                    return;
                const lifecycle = this.decisionLifecycle(cycleId, event);
                const variant = this.variant(lifecycle, at);
                const gene = opaqueId(payload['selectedAssetId']) ?? opaqueId(payload['selectedGeneId']);
                if (gene) {
                    const spec = this.node(`spec:${gene}`, 'spec', `gene ${gene}`, at);
                    this.edge('derivation', spec, variant, at, event, 'variant derived from the selected gene');
                }
                const selection = this.node(`selection:${lifecycle.key}`, 'selection', `selection for cycle ${cycleId}`, at);
                const reason = text(payload['selectedReason']) || text(event.human?.title) || 'gene selected by cycle engine';
                this.edge('selected', variant, selection, at, event, reason);
                return;
            }
            case 'mutation.built': {
                if (!cycleId)
                    return;
                const lifecycle = this.activeLifecycle(cycleId);
                if (!lifecycle.key)
                    return;
                const variant = this.variant(lifecycle, at);
                const mutationId = opaqueId(payload['mutationId']);
                if (!mutationId)
                    return;
                const code = this.node(`code:${mutationId}`, 'code', `mutation ${mutationId}`, at);
                this.edge('derivation', variant, code, at, event, 'variant produced a mutation');
                return;
            }
            case 'cycle.solidified': {
                if (!cycleId)
                    return;
                const lifecycle = this.activeLifecycle(cycleId);
                lifecycle.terminal = true;
                if (!lifecycle.key)
                    return;
                const score = terminalOutcomeScore(payload['outcome'], 'success');
                if (score === null)
                    return;
                const variant = this.variant(lifecycle, at);
                const run = this.node(`run:${lifecycle.key}`, 'run', `cycle ${cycleId}`, at);
                this.edge('evaluated_by', variant, run, at, event, 'cycle completed with a measured outcome');
                const evidence = this.matchingCapsuleEvidence(lifecycle, payload, true);
                if (evidence?.resolutionStatus === 'resolved_by_evidence'
                    && evidence.producedValue
                    && payload['producedValue'] === true) {
                    this.edge('fixed', variant, run, at, event, 'cycle resolved by output-backed validation evidence', {
                        metric: 'cycle_outcome_score',
                        after: score,
                        direction: 'improved',
                    }, [evidence.event]);
                }
                return;
            }
            case 'cycle.failed': {
                if (!cycleId)
                    return;
                const lifecycle = this.activeLifecycle(cycleId);
                lifecycle.terminal = true;
                if (!lifecycle.key)
                    return;
                const score = terminalOutcomeScore(payload['outcome'], 'failed');
                const failureClass = text(payload['failure_class']);
                if (score === null || text(payload['failureKind']) || suppressesFailure(failureClass))
                    return;
                const variant = this.variant(lifecycle, at);
                const run = this.node(`run:${lifecycle.key}`, 'run', `cycle ${cycleId}`, at);
                this.edge('evaluated_by', variant, run, at, event, 'cycle completed with a measured failed outcome');
                const capsule = this.matchingCapsuleEvidence(lifecycle, payload);
                const inlineStatus = resolutionStatus(payload['resolutionStatus']);
                if (hasOwn(payload, 'resolutionStatus') && !inlineStatus)
                    return;
                const status = inlineStatus ?? capsule?.resolutionStatus ?? null;
                if (inlineStatus && capsule && inlineStatus !== capsule.resolutionStatus)
                    return;
                if (status === 'regressed') {
                    this.edge('regressed', variant, run, at, event, failureClass || 'measured cycle regression', {
                        metric: 'cycle_outcome_score',
                        after: score,
                        direction: 'regressed',
                    }, capsule ? [capsule.event] : []);
                }
                return;
            }
            case 'cycle.aborted': {
                if (cycleId)
                    this.activeLifecycle(cycleId).terminal = true;
                return;
            }
            case 'value.reuse_outcome': {
                const assetId = opaqueId(payload['assetId']);
                if (!assetId)
                    return;
                const spec = this.node(`spec:${assetId}`, 'spec', `gene ${assetId}`, at);
                const feedback = this.node(`feedback:${assetId}:${event.seq}`, 'feedback', `reuse outcome ${text(payload['outcome']) || 'negative'}`, at);
                this.edge('derivation', feedback, spec, at, event, 'reuse feedback recorded against the gene');
                return;
            }
            case 'anti_gene.rollout_result': {
                const suite = opaqueId(payload['suite']) ?? `seq-${event.seq}`;
                const test = this.node(`test:${suite}`, 'test', `anti-gene rollout ${suite}`, at);
                const verdict = text(payload['verdict']);
                const variant = this.node(`variant:rollout:${suite}`, 'variant', `anti-gene arm ${suite}`, at);
                this.edge('evaluated_by', variant, test, at, event, verdict || 'anti-gene rollout evaluated');
                return;
            }
            default:
                return;
        }
    }
    beginLifecycle(cycleId) {
        const lifecycle = {
            cycleId,
            key: '',
            decisionSeen: false,
            capsule: null,
            terminal: false,
        };
        this.lifecycleByCycle.set(cycleId, lifecycle);
        return lifecycle;
    }
    activeLifecycle(cycleId) {
        const current = this.lifecycleByCycle.get(cycleId);
        return !current || current.terminal ? this.beginLifecycle(cycleId) : current;
    }
    decisionLifecycle(cycleId, event) {
        let lifecycle = this.lifecycleByCycle.get(cycleId);
        if (!lifecycle || lifecycle.decisionSeen || lifecycle.capsule || lifecycle.terminal) {
            lifecycle = this.beginLifecycle(cycleId);
        }
        lifecycle.key = `${cycleId}:seq:${event.seq}`;
        lifecycle.decisionSeen = true;
        lifecycle.capsule = null;
        return lifecycle;
    }
    variant(lifecycle, at) {
        const existing = this.variantByLifecycle.get(lifecycle.key);
        if (existing)
            return this.nodesById.get(existing);
        const node = this.node(`variant:${lifecycle.key}`, 'variant', `variant from cycle ${lifecycle.cycleId}`, at);
        this.variantByLifecycle.set(lifecycle.key, node.id);
        return node;
    }
    matchingCapsuleEvidence(lifecycle, payload, requireCapsuleId = false) {
        const evidence = lifecycle.capsule;
        if (!evidence)
            return null;
        if (!hasOwn(payload, 'capsuleId'))
            return requireCapsuleId ? null : evidence;
        const capsuleId = opaqueId(payload['capsuleId']);
        return !capsuleId || capsuleId !== evidence.capsuleId ? null : evidence;
    }
    node(id, kind, label, at) {
        const existing = this.nodesById.get(id);
        if (existing)
            return existing;
        const node = {
            id,
            kind,
            label: label.slice(0, MAX_LABEL) || id,
            createdAt: at,
            metrics: [],
            tags: [],
            extensions: {},
        };
        this.nodesById.set(id, node);
        return node;
    }
    edge(kind, from, to, at, event, reason, metricDelta, supportingEvents = []) {
        const id = `edge:${kind}:${from.id}->${to.id}:${event.seq}`;
        if (this.edgesById.has(id))
            return;
        this.edgesById.set(id, {
            id,
            kind,
            from: from.id,
            to: to.id,
            createdAt: at,
            provenance: provenanceFor([...supportingEvents, event]),
            ...(metricDelta ? { metricDelta } : {}),
            reason: reason.slice(0, MAX_LABEL),
            extensions: {},
        });
    }
}
function boundedLimit(value, fallback) {
    if (!Number.isFinite(value) || value === undefined || value <= 0)
        return fallback;
    return Math.min(fallback, Math.floor(value));
}
function text(value) {
    return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
}
/** Opaque local identifiers only: no control characters, bounded, so a graph id cannot smuggle payload text. */
function opaqueId(value) {
    const candidate = text(value);
    if (!candidate || candidate.length > 160)
        return null;
    return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(candidate) ? candidate : null;
}
function isoTimestamp(value) {
    if (!value)
        return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function terminalOutcomeScore(value, expectedStatus) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const outcome = value;
    if (outcome['status'] !== expectedStatus)
        return null;
    const score = outcome['score'];
    return typeof score === 'number' && Number.isFinite(score) ? score : null;
}
function resolutionStatus(value) {
    return typeof value === 'string' && RESOLUTION_STATUSES.has(value)
        ? value
        : null;
}
function suppressesFailure(value) {
    return value !== '' && HOST_SUPPRESS_CLASSES.has(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function provenanceFor(events) {
    const seen = new Set();
    return events.flatMap((event) => {
        const capturedAt = isoTimestamp(text(event.ts));
        const ref = `seq:${event.seq}`;
        if (!capturedAt || seen.has(ref))
            return [];
        seen.add(ref);
        return [{ kind: 'root_event', ref, capturedAt, summary: event.type }];
    });
}