import { z } from 'zod';
export declare const EVOLUTION_GRAPH_SCHEMA_VERSION = "1.0.0";
export declare const evolutionGraphNodeKinds: readonly ["prompt", "code", "spec", "test", "feedback", "run", "metric", "variant", "selection"];
export declare const evolutionGraphEdgeKinds: readonly ["derivation", "evaluated_by", "regressed", "fixed", "selected"];
export declare const evolutionGraphProvenanceKinds: readonly ["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"];
export declare const evolutionGraphNodeKind: z.ZodEnum<["prompt", "code", "spec", "test", "feedback", "run", "metric", "variant", "selection"]>;
export declare const evolutionGraphEdgeKind: z.ZodEnum<["derivation", "evaluated_by", "regressed", "fixed", "selected"]>;
export declare const evolutionGraphProvenanceKind: z.ZodEnum<["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"]>;
export type EvolutionGraphNodeKind = z.infer<typeof evolutionGraphNodeKind>;
export type EvolutionGraphEdgeKind = z.infer<typeof evolutionGraphEdgeKind>;
export type EvolutionGraphProvenanceKind = z.infer<typeof evolutionGraphProvenanceKind>;
export declare const evolutionGraphNodeRef: z.ZodString;
export type EvolutionGraphNodeRef = z.infer<typeof evolutionGraphNodeRef>;
export declare const evolutionGraphArtifactRef: z.ZodObject<{
    kind: z.ZodEnum<["asset", "material", "root_event", "file", "runtime_trace", "plugin_resource"]>;
    ref: z.ZodString;
    sha256: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
    ref: string;
    sha256?: string | undefined;
}, {
    kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
    ref: string;
    sha256?: string | undefined;
}>;
export type EvolutionGraphArtifactRef = z.infer<typeof evolutionGraphArtifactRef>;
export declare const evolutionGraphMetricValue: z.ZodObject<{
    metric: z.ZodString;
    value: z.ZodNumber;
    unit: z.ZodOptional<z.ZodString>;
    direction: z.ZodDefault<z.ZodEnum<["higher_is_better", "lower_is_better", "target"]>>;
    target: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    value: number;
    metric: string;
    direction: "higher_is_better" | "lower_is_better" | "target";
    unit?: string | undefined;
    target?: number | undefined;
}, {
    value: number;
    metric: string;
    unit?: string | undefined;
    target?: number | undefined;
    direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
}>;
export type EvolutionGraphMetricValue = z.infer<typeof evolutionGraphMetricValue>;
export declare const evolutionGraphMetricDelta: z.ZodObject<{
    metric: z.ZodString;
    before: z.ZodOptional<z.ZodNumber>;
    after: z.ZodNumber;
    delta: z.ZodOptional<z.ZodNumber>;
    direction: z.ZodDefault<z.ZodEnum<["improved", "regressed", "unchanged", "unknown"]>>;
}, "strip", z.ZodTypeAny, {
    metric: string;
    direction: "unknown" | "regressed" | "improved" | "unchanged";
    after: number;
    before?: number | undefined;
    delta?: number | undefined;
}, {
    metric: string;
    after: number;
    direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
    before?: number | undefined;
    delta?: number | undefined;
}>;
export type EvolutionGraphMetricDelta = z.infer<typeof evolutionGraphMetricDelta>;
export declare const evolutionGraphNode: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["prompt", "code", "spec", "test", "feedback", "run", "metric", "variant", "selection"]>;
    label: z.ZodString;
    createdAt: z.ZodString;
    artifact: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<["asset", "material", "root_event", "file", "runtime_trace", "plugin_resource"]>;
        ref: z.ZodString;
        sha256: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
        ref: string;
        sha256?: string | undefined;
    }, {
        kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
        ref: string;
        sha256?: string | undefined;
    }>>;
    metrics: z.ZodDefault<z.ZodArray<z.ZodObject<{
        metric: z.ZodString;
        value: z.ZodNumber;
        unit: z.ZodOptional<z.ZodString>;
        direction: z.ZodDefault<z.ZodEnum<["higher_is_better", "lower_is_better", "target"]>>;
        target: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        value: number;
        metric: string;
        direction: "higher_is_better" | "lower_is_better" | "target";
        unit?: string | undefined;
        target?: number | undefined;
    }, {
        value: number;
        metric: string;
        unit?: string | undefined;
        target?: number | undefined;
        direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
    }>, "many">>;
    summary: z.ZodOptional<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
    extensions: Record<string, unknown>;
    id: string;
    label: string;
    createdAt: string;
    metrics: {
        value: number;
        metric: string;
        direction: "higher_is_better" | "lower_is_better" | "target";
        unit?: string | undefined;
        target?: number | undefined;
    }[];
    tags: string[];
    artifact?: {
        kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
        ref: string;
        sha256?: string | undefined;
    } | undefined;
    summary?: string | undefined;
}, {
    kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
    id: string;
    label: string;
    createdAt: string;
    extensions?: Record<string, unknown> | undefined;
    artifact?: {
        kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
        ref: string;
        sha256?: string | undefined;
    } | undefined;
    metrics?: {
        value: number;
        metric: string;
        unit?: string | undefined;
        target?: number | undefined;
        direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
    }[] | undefined;
    summary?: string | undefined;
    tags?: string[] | undefined;
}>;
export type EvolutionGraphNode = z.infer<typeof evolutionGraphNode>;
export declare const evolutionGraphProvenance: z.ZodObject<{
    kind: z.ZodEnum<["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"]>;
    ref: z.ZodString;
    capturedAt: z.ZodString;
    actor: z.ZodOptional<z.ZodString>;
    digest: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
    capturedAt: string;
    ref: string;
    summary?: string | undefined;
    actor?: string | undefined;
    digest?: string | undefined;
}, {
    kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
    capturedAt: string;
    ref: string;
    summary?: string | undefined;
    actor?: string | undefined;
    digest?: string | undefined;
}>;
export type EvolutionGraphProvenance = z.infer<typeof evolutionGraphProvenance>;
export declare const evolutionGraphEdge: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<["derivation", "evaluated_by", "regressed", "fixed", "selected"]>;
    from: z.ZodString;
    to: z.ZodString;
    createdAt: z.ZodString;
    provenance: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"]>;
        ref: z.ZodString;
        capturedAt: z.ZodString;
        actor: z.ZodOptional<z.ZodString>;
        digest: z.ZodOptional<z.ZodString>;
        summary: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
        capturedAt: string;
        ref: string;
        summary?: string | undefined;
        actor?: string | undefined;
        digest?: string | undefined;
    }, {
        kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
        capturedAt: string;
        ref: string;
        summary?: string | undefined;
        actor?: string | undefined;
        digest?: string | undefined;
    }>, "many">;
    metricDelta: z.ZodOptional<z.ZodObject<{
        metric: z.ZodString;
        before: z.ZodOptional<z.ZodNumber>;
        after: z.ZodNumber;
        delta: z.ZodOptional<z.ZodNumber>;
        direction: z.ZodDefault<z.ZodEnum<["improved", "regressed", "unchanged", "unknown"]>>;
    }, "strip", z.ZodTypeAny, {
        metric: string;
        direction: "unknown" | "regressed" | "improved" | "unchanged";
        after: number;
        before?: number | undefined;
        delta?: number | undefined;
    }, {
        metric: string;
        after: number;
        direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
        before?: number | undefined;
        delta?: number | undefined;
    }>>;
    reason: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodNumber>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
    extensions: Record<string, unknown>;
    id: string;
    createdAt: string;
    from: string;
    to: string;
    provenance: {
        kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
        capturedAt: string;
        ref: string;
        summary?: string | undefined;
        actor?: string | undefined;
        digest?: string | undefined;
    }[];
    metricDelta?: {
        metric: string;
        direction: "unknown" | "regressed" | "improved" | "unchanged";
        after: number;
        before?: number | undefined;
        delta?: number | undefined;
    } | undefined;
    reason?: string | undefined;
    confidence?: number | undefined;
}, {
    kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
    id: string;
    createdAt: string;
    from: string;
    to: string;
    provenance: {
        kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
        capturedAt: string;
        ref: string;
        summary?: string | undefined;
        actor?: string | undefined;
        digest?: string | undefined;
    }[];
    extensions?: Record<string, unknown> | undefined;
    metricDelta?: {
        metric: string;
        after: number;
        direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
        before?: number | undefined;
        delta?: number | undefined;
    } | undefined;
    reason?: string | undefined;
    confidence?: number | undefined;
}>;
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
}, "strip", z.ZodTypeAny, {
    nodeCount: number;
    edgeCount: number;
    variantCount: number;
    selectedCount: number;
    regressionCount: number;
    fixedCount: number;
    evaluatedVariantCount: number;
    unevaluatedVariantCount: number;
    orphanEdgeCount: number;
    provenanceGapCount: number;
}, {
    nodeCount: number;
    edgeCount: number;
    variantCount: number;
    selectedCount: number;
    regressionCount: number;
    fixedCount: number;
    evaluatedVariantCount: number;
    unevaluatedVariantCount: number;
    orphanEdgeCount: number;
    provenanceGapCount: number;
}>;
export type EvolutionGraphDashboardSummary = z.infer<typeof evolutionGraphDashboardSummary>;
export declare const evolutionGraph: z.ZodEffects<z.ZodObject<{
    schemaVersion: z.ZodDefault<z.ZodLiteral<"1.0.0">>;
    graphId: z.ZodString;
    generatedAt: z.ZodString;
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["prompt", "code", "spec", "test", "feedback", "run", "metric", "variant", "selection"]>;
        label: z.ZodString;
        createdAt: z.ZodString;
        artifact: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<["asset", "material", "root_event", "file", "runtime_trace", "plugin_resource"]>;
            ref: z.ZodString;
            sha256: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        }, {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        }>>;
        metrics: z.ZodDefault<z.ZodArray<z.ZodObject<{
            metric: z.ZodString;
            value: z.ZodNumber;
            unit: z.ZodOptional<z.ZodString>;
            direction: z.ZodDefault<z.ZodEnum<["higher_is_better", "lower_is_better", "target"]>>;
            target: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            value: number;
            metric: string;
            direction: "higher_is_better" | "lower_is_better" | "target";
            unit?: string | undefined;
            target?: number | undefined;
        }, {
            value: number;
            metric: string;
            unit?: string | undefined;
            target?: number | undefined;
            direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
        }>, "many">>;
        summary: z.ZodOptional<z.ZodString>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        extensions: Record<string, unknown>;
        id: string;
        label: string;
        createdAt: string;
        metrics: {
            value: number;
            metric: string;
            direction: "higher_is_better" | "lower_is_better" | "target";
            unit?: string | undefined;
            target?: number | undefined;
        }[];
        tags: string[];
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        summary?: string | undefined;
    }, {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        id: string;
        label: string;
        createdAt: string;
        extensions?: Record<string, unknown> | undefined;
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        metrics?: {
            value: number;
            metric: string;
            unit?: string | undefined;
            target?: number | undefined;
            direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
        }[] | undefined;
        summary?: string | undefined;
        tags?: string[] | undefined;
    }>, "many">;
    edges: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<["derivation", "evaluated_by", "regressed", "fixed", "selected"]>;
        from: z.ZodString;
        to: z.ZodString;
        createdAt: z.ZodString;
        provenance: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<["root_event", "asset", "material", "review", "cycle", "workflow", "runtime_trace", "plugin", "manual"]>;
            ref: z.ZodString;
            capturedAt: z.ZodString;
            actor: z.ZodOptional<z.ZodString>;
            digest: z.ZodOptional<z.ZodString>;
            summary: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }, {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }>, "many">;
        metricDelta: z.ZodOptional<z.ZodObject<{
            metric: z.ZodString;
            before: z.ZodOptional<z.ZodNumber>;
            after: z.ZodNumber;
            delta: z.ZodOptional<z.ZodNumber>;
            direction: z.ZodDefault<z.ZodEnum<["improved", "regressed", "unchanged", "unknown"]>>;
        }, "strip", z.ZodTypeAny, {
            metric: string;
            direction: "unknown" | "regressed" | "improved" | "unchanged";
            after: number;
            before?: number | undefined;
            delta?: number | undefined;
        }, {
            metric: string;
            after: number;
            direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
            before?: number | undefined;
            delta?: number | undefined;
        }>>;
        reason: z.ZodOptional<z.ZodString>;
        confidence: z.ZodOptional<z.ZodNumber>;
        extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        extensions: Record<string, unknown>;
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        metricDelta?: {
            metric: string;
            direction: "unknown" | "regressed" | "improved" | "unchanged";
            after: number;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }, {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        extensions?: Record<string, unknown> | undefined;
        metricDelta?: {
            metric: string;
            after: number;
            direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }>, "many">;
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
    }, "strip", z.ZodTypeAny, {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    }, {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    }>>;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    extensions: Record<string, unknown>;
    schemaVersion: "1.0.0";
    graphId: string;
    generatedAt: string;
    nodes: {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        extensions: Record<string, unknown>;
        id: string;
        label: string;
        createdAt: string;
        metrics: {
            value: number;
            metric: string;
            direction: "higher_is_better" | "lower_is_better" | "target";
            unit?: string | undefined;
            target?: number | undefined;
        }[];
        tags: string[];
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        summary?: string | undefined;
    }[];
    edges: {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        extensions: Record<string, unknown>;
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        metricDelta?: {
            metric: string;
            direction: "unknown" | "regressed" | "improved" | "unchanged";
            after: number;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }[];
    dashboard?: {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    } | undefined;
}, {
    graphId: string;
    generatedAt: string;
    nodes: {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        id: string;
        label: string;
        createdAt: string;
        extensions?: Record<string, unknown> | undefined;
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        metrics?: {
            value: number;
            metric: string;
            unit?: string | undefined;
            target?: number | undefined;
            direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
        }[] | undefined;
        summary?: string | undefined;
        tags?: string[] | undefined;
    }[];
    edges: {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        extensions?: Record<string, unknown> | undefined;
        metricDelta?: {
            metric: string;
            after: number;
            direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }[];
    extensions?: Record<string, unknown> | undefined;
    schemaVersion?: "1.0.0" | undefined;
    dashboard?: {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    } | undefined;
}>, {
    extensions: Record<string, unknown>;
    schemaVersion: "1.0.0";
    graphId: string;
    generatedAt: string;
    nodes: {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        extensions: Record<string, unknown>;
        id: string;
        label: string;
        createdAt: string;
        metrics: {
            value: number;
            metric: string;
            direction: "higher_is_better" | "lower_is_better" | "target";
            unit?: string | undefined;
            target?: number | undefined;
        }[];
        tags: string[];
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        summary?: string | undefined;
    }[];
    edges: {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        extensions: Record<string, unknown>;
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        metricDelta?: {
            metric: string;
            direction: "unknown" | "regressed" | "improved" | "unchanged";
            after: number;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }[];
    dashboard?: {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    } | undefined;
}, {
    graphId: string;
    generatedAt: string;
    nodes: {
        kind: "code" | "prompt" | "spec" | "test" | "feedback" | "run" | "metric" | "variant" | "selection";
        id: string;
        label: string;
        createdAt: string;
        extensions?: Record<string, unknown> | undefined;
        artifact?: {
            kind: "file" | "root_event" | "asset" | "material" | "runtime_trace" | "plugin_resource";
            ref: string;
            sha256?: string | undefined;
        } | undefined;
        metrics?: {
            value: number;
            metric: string;
            unit?: string | undefined;
            target?: number | undefined;
            direction?: "higher_is_better" | "lower_is_better" | "target" | undefined;
        }[] | undefined;
        summary?: string | undefined;
        tags?: string[] | undefined;
    }[];
    edges: {
        kind: "derivation" | "evaluated_by" | "regressed" | "fixed" | "selected";
        id: string;
        createdAt: string;
        from: string;
        to: string;
        provenance: {
            kind: "root_event" | "asset" | "material" | "review" | "cycle" | "workflow" | "runtime_trace" | "plugin" | "manual";
            capturedAt: string;
            ref: string;
            summary?: string | undefined;
            actor?: string | undefined;
            digest?: string | undefined;
        }[];
        extensions?: Record<string, unknown> | undefined;
        metricDelta?: {
            metric: string;
            after: number;
            direction?: "unknown" | "regressed" | "improved" | "unchanged" | undefined;
            before?: number | undefined;
            delta?: number | undefined;
        } | undefined;
        reason?: string | undefined;
        confidence?: number | undefined;
    }[];
    extensions?: Record<string, unknown> | undefined;
    schemaVersion?: "1.0.0" | undefined;
    dashboard?: {
        nodeCount: number;
        edgeCount: number;
        variantCount: number;
        selectedCount: number;
        regressionCount: number;
        fixedCount: number;
        evaluatedVariantCount: number;
        unevaluatedVariantCount: number;
        orphanEdgeCount: number;
        provenanceGapCount: number;
    } | undefined;
}>;
export type EvolutionGraph = z.infer<typeof evolutionGraph>;
export declare function deriveEvolutionGraphDashboardSummary(input: {
    nodes: readonly Pick<EvolutionGraphNode, 'id' | 'kind'>[];
    edges: readonly Pick<EvolutionGraphEdge, 'from' | 'to' | 'kind' | 'provenance'>[];
}): EvolutionGraphDashboardSummary;