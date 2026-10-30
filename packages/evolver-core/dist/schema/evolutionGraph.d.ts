import { z } from 'zod';
export declare const EVOLUTION_GRAPH_SCHEMA_VERSION = "1.0.0";
export declare const evolutionGraphNodeKinds: readonly ["prompt", "code", "spec", "test", "feedback", "run", "metric", "variant", "selection"];
export declare const evolutionGraphEdgeKinds: readonly ["derivation", "evaluated_by", "regressed", "fixed", "selected"];
export declare const evolutionGraphProvenanceKinds: readonly ["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"];
export declare const evolutionGraphNodeKind: z.ZodEnum<{
    prompt: "prompt";
    selection: "selection";
    run: "run";
    code: "code";
    spec: "spec";
    test: "test";
    feedback: "feedback";
    metric: "metric";
    variant: "variant";
}>;
export declare const evolutionGraphEdgeKind: z.ZodEnum<{
    regressed: "regressed";
    fixed: "fixed";
    derivation: "derivation";
    evaluated_by: "evaluated_by";
    selected: "selected";
}>;
export declare const evolutionGraphProvenanceKind: z.ZodEnum<{
    manual: "manual";
    asset: "asset";
    review: "review";
    cycle: "cycle";
    material: "material";
    root_event: "root_event";
    workflow: "workflow";
    runtime_trace: "runtime_trace";
    plugin: "plugin";
}>;
export type EvolutionGraphNodeKind = z.infer<typeof evolutionGraphNodeKind>;
export type EvolutionGraphEdgeKind = z.infer<typeof evolutionGraphEdgeKind>;
export type EvolutionGraphProvenanceKind = z.infer<typeof evolutionGraphProvenanceKind>;
export declare const evolutionGraphNodeRef: z.ZodString;
export type EvolutionGraphNodeRef = z.infer<typeof evolutionGraphNodeRef>;
export declare const evolutionGraphArtifactRef: z.ZodObject<{
    kind: z.ZodEnum<{
        asset: "asset";
        file: "file";
        material: "material";
        root_event: "root_event";
        runtime_trace: "runtime_trace";
        plugin_resource: "plugin_resource";
    }>;
    ref: z.ZodString;
    sha256: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type EvolutionGraphArtifactRef = z.infer<typeof evolutionGraphArtifactRef>;
export declare const evolutionGraphMetricValue: z.ZodObject<{
    metric: z.ZodString;
    value: z.ZodNumber;
    unit: z.ZodOptional<z.ZodString>;
    direction: z.ZodDefault<z.ZodEnum<{
        target: "target";
        higher_is_better: "higher_is_better";
        lower_is_better: "lower_is_better";
    }>>;
    target: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type EvolutionGraphMetricValue = z.infer<typeof evolutionGraphMetricValue>;
export declare const evolutionGraphMetricDelta: z.ZodObject<{
    metric: z.ZodString;
    before: z.ZodOptional<z.ZodNumber>;
    after: z.ZodNumber;
    delta: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodDefault<z.ZodEnum<{
        unknown: "unknown";
        regressed: "regressed";
        improved: "improved";
        unchanged: "unchanged";
    }>>;
}, z.core.$strip>;
export type EvolutionGraphMetricDelta = z.infer<typeof evolutionGraphMetricDelta>;
export declare const evolutionGraphNode: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        prompt: "prompt";
        selection: "selection";
        run: "run";
        code: "code";
        spec: "spec";
        test: "test";
        feedback: "feedback";
        metric: "metric";
        variant: "variant";
    }>;
    label: z.ZodString;
    createdAt: z.ZodString;
    artifact: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            asset: "asset";
            file: "file";
            material: "material";
            root_event: "root_event";
            runtime_trace: "runtime_trace";
            plugin_resource: "plugin_resource";
        }>;
        ref: z.ZodString;
        sha256: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metrics: z.ZodDefault<z.ZodArray<z.ZodObject<{
        metric: z.ZodString;
        value: z.ZodNumber;
        unit: z.ZodOptional<z.ZodString>;
        direction: z.ZodDefault<z.ZodEnum<{
            target: "target";
            higher_is_better: "higher_is_better";
            lower_is_better: "lower_is_better";
        }>>;
        target: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    summary: z.ZodOptional<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type EvolutionGraphNode = z.infer<typeof evolutionGraphNode>;
export declare const evolutionGraphProvenance: z.ZodObject<{
    kind: z.ZodEnum<{
        manual: "manual";
        asset: "asset";
        review: "review";
        cycle: "cycle";
        material: "material";
        root_event: "root_event";
        workflow: "workflow";
        runtime_trace: "runtime_trace";
        plugin: "plugin";
    }>;
    ref: z.ZodString;
    capturedAt: z.ZodString;
    actor: z.ZodOptional<z.ZodString>;
    digest: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type EvolutionGraphProvenance = z.infer<typeof evolutionGraphProvenance>;
export declare const evolutionGraphEdge: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        regressed: "regressed";
        fixed: "fixed";
        derivation: "derivation";
        evaluated_by: "evaluated_by";
        selected: "selected";
    }>;
    from: z.ZodString;
    to: z.ZodString;
    createdAt: z.ZodString;
    provenance: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            manual: "manual";
            asset: "asset";
            review: "review";
            cycle: "cycle";
            material: "material";
            root_event: "root_event";
            workflow: "workflow";
            runtime_trace: "runtime_trace";
            plugin: "plugin";
        }>;
        ref: z.ZodString;
        capturedAt: z.ZodString;
        actor: z.ZodOptional<z.ZodString>;
        digest: z.ZodOptional<z.ZodString>;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metricDelta: z.ZodOptional<z.ZodObject<{
        metric: z.ZodString;
        before: z.ZodOptional<z.ZodNumber>;
        after: z.ZodNumber;
        delta: z.ZodOptional<z.ZodNumber>;
        direction: z.ZodDefault<z.ZodEnum<{
            unknown: "unknown";
            regressed: "regressed";
            improved: "improved";
            unchanged: "unchanged";
        }>>;
    }, z.core.$strip>>;
    reason: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodNumber>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type EvolutionGraphEdge = z.infer<typeof evolutionGraphEdge>;
export declare const evolutionGraphDashboardSummary: z.ZodObject<{
    nodeCount: z.ZodNumber;
    edgeCount: z.ZodNumber;
    variantCount: z.ZodNumber;
    selectedCount: z.ZodNumber;
    regressionCount: z.ZodNumber;
    fixedCount: z.ZodNumber;
    evaluatedVariantCount: z.ZodNumber;
    unevaluatedVariantCount: z.ZodNumber;
    orphanEdgeCount: z.ZodNumber;
    provenanceGapCount: z.ZodNumber;
}, z.core.$strip>;
export type EvolutionGraphDashboardSummary = z.infer<typeof evolutionGraphDashboardSummary>;
export declare const evolutionGraph: z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodLiteral<"1.0.0">>;
    graphId: z.ZodString;
    generatedAt: z.ZodString;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            prompt: "prompt";
            selection: "selection";
            run: "run";
            code: "code";
            spec: "spec";
            test: "test";
            feedback: "feedback";
            metric: "metric";
            variant: "variant";
        }>;
        label: z.ZodString;
        createdAt: z.ZodString;
        artifact: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                asset: "asset";
                file: "file";
                material: "material";
                root_event: "root_event";
                runtime_trace: "runtime_trace";
                plugin_resource: "plugin_resource";
            }>;
            ref: z.ZodString;
            sha256: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        metrics: z.ZodDefault<z.ZodArray<z.ZodObject<{
            metric: z.ZodString;
            value: z.ZodNumber;
            unit: z.ZodOptional<z.ZodString>;
            direction: z.ZodDefault<z.ZodEnum<{
                target: "target";
                higher_is_better: "higher_is_better";
                lower_is_better: "lower_is_better";
            }>>;
            target: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>>;
        summary: z.ZodOptional<z.ZodString>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    edges: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            regressed: "regressed";
            fixed: "fixed";
            derivation: "derivation";
            evaluated_by: "evaluated_by";
            selected: "selected";
        }>;
        from: z.ZodString;
        to: z.ZodString;
        createdAt: z.ZodString;
        provenance: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                manual: "manual";
                asset: "asset";
                review: "review";
                cycle: "cycle";
                material: "material";
                root_event: "root_event";
                workflow: "workflow";
                runtime_trace: "runtime_trace";
                plugin: "plugin";
            }>;
            ref: z.ZodString;
            capturedAt: z.ZodString;
            actor: z.ZodOptional<z.ZodString>;
            digest: z.ZodOptional<z.ZodString>;
            summary: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        metricDelta: z.ZodOptional<z.ZodObject<{
            metric: z.ZodString;
            before: z.ZodOptional<z.ZodNumber>;
            after: z.ZodNumber;
            delta: z.ZodOptional<z.ZodNumber>;
            direction: z.ZodDefault<z.ZodEnum<{
                unknown: "unknown";
                regressed: "regressed";
                improved: "improved";
                unchanged: "unchanged";
            }>>;
        }, z.core.$strip>>;
        reason: z.ZodOptional<z.ZodString>;
        confidence: z.ZodOptional<z.ZodNumber>;
        extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    dashboard: z.ZodOptional<z.ZodObject<{
        nodeCount: z.ZodNumber;
        edgeCount: z.ZodNumber;
        variantCount: z.ZodNumber;
        selectedCount: z.ZodNumber;
        regressionCount: z.ZodNumber;
        fixedCount: z.ZodNumber;
        evaluatedVariantCount: z.ZodNumber;
        unevaluatedVariantCount: z.ZodNumber;
        orphanEdgeCount: z.ZodNumber;
        provenanceGapCount: z.ZodNumber;
    }, z.core.$strip>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type EvolutionGraph = z.infer<typeof evolutionGraph>;
export declare function deriveEvolutionGraphDashboardSummary(input: {
    nodes: readonly Pick<EvolutionGraphNode, 'id' | 'kind'>[];
    edges: readonly Pick<EvolutionGraphEdge, 'from' | 'to' | 'kind' | 'provenance'>[];
}): EvolutionGraphDashboardSummary;