import { z } from 'zod';
import { extensions, sha256Hash } from './common.js';
export const EVOLUTION_GRAPH_SCHEMA_VERSION = '1.0.0';
export const evolutionGraphNodeKinds = [
    'prompt',
    'code',
    'spec',
    'test',
    'feedback',
    'run',
    'metric',
    'variant',
    'selection',
];
export const evolutionGraphEdgeKinds = [
    'derivation',
    'evaluated_by',
    'regressed',
    'fixed',
    'selected',
];
export const evolutionGraphProvenanceKinds = [
    'root_event',
    'asset',
    'material',
    'review',
    'cycle',
    'workflow',
    'runtime_trace',
    'plugin',
    'manual',
];
export const evolutionGraphNodeKind = z.enum(evolutionGraphNodeKinds);
export const evolutionGraphEdgeKind = z.enum(evolutionGraphEdgeKinds);
export const evolutionGraphProvenanceKind = z.enum(evolutionGraphProvenanceKinds);
export const evolutionGraphNodeRef = z.string().min(1);
export const evolutionGraphArtifactRef = z.object({
    kind: z.enum(['asset', 'material', 'root_event', 'file', 'runtime_trace', 'plugin_resource']),
    ref: z.string().min(1),
    sha256: sha256Hash.optional(),
});
export const evolutionGraphMetricValue = z.object({
    metric: z.string().min(1),
    value: z.number(),
    unit: z.string().min(1).optional(),
    direction: z.enum(['higher_is_better', 'lower_is_better', 'target']).default('higher_is_better'),
    target: z.number().optional(),
});
export const evolutionGraphMetricDelta = z.object({
    metric: z.string().min(1),
    before: z.number().optional(),
    after: z.number(),
    delta: z.number().optional(),
    direction: z.enum(['improved', 'regressed', 'unchanged', 'unknown']).default('unknown'),
});
export const evolutionGraphNode = z.object({
    id: evolutionGraphNodeRef,
    kind: evolutionGraphNodeKind,
    label: z.string().min(1),
    createdAt: z.string().datetime(),
    artifact: evolutionGraphArtifactRef.optional(),
    metrics: z.array(evolutionGraphMetricValue).default([]),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).default([]),
    extensions,
});
export const evolutionGraphProvenance = z.object({
    kind: evolutionGraphProvenanceKind,
    ref: z.string().min(1),
    capturedAt: z.string().datetime(),
    actor: z.string().min(1).optional(),
    digest: sha256Hash.optional(),
    summary: z.string().optional(),
});
export const evolutionGraphEdge = z.object({
    id: z.string().min(1),
    kind: evolutionGraphEdgeKind,
    from: evolutionGraphNodeRef,
    to: evolutionGraphNodeRef,
    createdAt: z.string().datetime(),
    provenance: z.array(evolutionGraphProvenance).min(1),
    metricDelta: evolutionGraphMetricDelta.optional(),
    reason: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    extensions,
});
export const evolutionGraphDashboardSummary = z.object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    variantCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    regressionCount: z.number().int().nonnegative(),
    fixedCount: z.number().int().nonnegative(),
    evaluatedVariantCount: z.number().int().nonnegative(),
    unevaluatedVariantCount: z.number().int().nonnegative(),
    orphanEdgeCount: z.number().int().nonnegative(),
    provenanceGapCount: z.number().int().nonnegative(),
});
export const evolutionGraph = z.object({
    schemaVersion: z.literal(EVOLUTION_GRAPH_SCHEMA_VERSION).default(EVOLUTION_GRAPH_SCHEMA_VERSION),
    graphId: z.string().min(1),
    generatedAt: z.string().datetime(),
    nodes: z.array(evolutionGraphNode),
    edges: z.array(evolutionGraphEdge),
    dashboard: evolutionGraphDashboardSummary.optional(),
    extensions,
}).superRefine((graph, ctx) => {
    const nodesById = new Map();
    for (const [index, node] of graph.nodes.entries()) {
        if (nodesById.has(node.id)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes', index, 'id'], message: 'duplicate evolution graph node id' });
            continue;
        }
        nodesById.set(node.id, node.kind);
    }
    const edgeIds = new Set();
    for (const [index, edge] of graph.edges.entries()) {
        if (edgeIds.has(edge.id)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', index, 'id'], message: 'duplicate evolution graph edge id' });
        }
        else {
            edgeIds.add(edge.id);
        }
        const fromKind = nodesById.get(edge.from);
        const toKind = nodesById.get(edge.to);
        if (!fromKind)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', index, 'from'], message: 'edge source node is missing' });
        if (!toKind)
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', index, 'to'], message: 'edge target node is missing' });
        if (!fromKind || !toKind)
            continue;
        validateEvolutionGraphEdgeShape(edge, fromKind, toKind, ctx, index);
    }
});
export function deriveEvolutionGraphDashboardSummary(input) {
    const variantIds = new Set(input.nodes.filter((node) => node.kind === 'variant').map((node) => node.id));
    const evaluatedVariantIds = new Set();
    let selectedCount = 0;
    let regressionCount = 0;
    let fixedCount = 0;
    let orphanEdgeCount = 0;
    let provenanceGapCount = 0;
    const nodeIds = new Set(input.nodes.map((node) => node.id));
    for (const edge of input.edges) {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to))
            orphanEdgeCount += 1;
        if (edge.provenance.length === 0)
            provenanceGapCount += 1;
        if (edge.kind === 'evaluated_by' && variantIds.has(edge.from))
            evaluatedVariantIds.add(edge.from);
        if (edge.kind === 'selected')
            selectedCount += 1;
        if (edge.kind === 'regressed')
            regressionCount += 1;
        if (edge.kind === 'fixed')
            fixedCount += 1;
    }
    return {
        nodeCount: input.nodes.length,
        edgeCount: input.edges.length,
        variantCount: variantIds.size,
        selectedCount,
        regressionCount,
        fixedCount,
        evaluatedVariantCount: evaluatedVariantIds.size,
        unevaluatedVariantCount: Math.max(0, variantIds.size - evaluatedVariantIds.size),
        orphanEdgeCount,
        provenanceGapCount,
    };
}
function validateEvolutionGraphEdgeShape(edge, fromKind, toKind, ctx, edgeIndex) {
    if (edge.kind === 'selected' && (fromKind !== 'variant' || toKind !== 'selection')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', edgeIndex, 'kind'], message: 'selected edges must connect variant -> selection' });
    }
    if (edge.kind === 'evaluated_by' && !['run', 'metric', 'test'].includes(toKind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', edgeIndex, 'to'], message: 'evaluated_by target must be run, metric, or test' });
    }
    if ((edge.kind === 'regressed' || edge.kind === 'fixed') && !['run', 'metric', 'test'].includes(toKind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', edgeIndex, 'to'], message: `${edge.kind} target must be run, metric, or test` });
    }
    if ((edge.kind === 'regressed' || edge.kind === 'fixed') && !edge.metricDelta) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', edgeIndex, 'metricDelta'], message: `${edge.kind} edges require metricDelta` });
    }
    if (edge.kind === 'selected' && !edge.reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', edgeIndex, 'reason'], message: 'selected edges require a reason' });
    }
}