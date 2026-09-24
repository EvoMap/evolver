import { z } from 'zod';
export declare const recipeIpcBodyLimits: Readonly<{
    'POST /recipe/express': number;
    'POST /recipe/report': number;
    'POST /recipe/finalize': number;
}>;
export type RecipeJson = null | boolean | number | string | RecipeJson[] | {
    [key: string]: RecipeJson;
};
export declare const recipeEvidenceSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    artifacts: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        sha256: string;
        name: string;
        bytes: number;
    }, {
        sha256: string;
        name: string;
        bytes: number;
    }>, "many">;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"artifact">;
}, "strict", z.ZodTypeAny, {
    type: "artifact";
    artifacts: {
        sha256: string;
        name: string;
        bytes: number;
    }[];
    input_digest: string;
    output_digest: string;
}, {
    type: "artifact";
    artifacts: {
        sha256: string;
        name: string;
        bytes: number;
    }[];
    input_digest: string;
    output_digest: string;
}>, z.ZodObject<{
    artifacts: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        sha256: string;
        name: string;
        bytes: number;
    }, {
        sha256: string;
        name: string;
        bytes: number;
    }>, "many">;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"tool_result">;
}, "strict", z.ZodTypeAny, {
    type: "tool_result";
    artifacts: {
        sha256: string;
        name: string;
        bytes: number;
    }[];
    input_digest: string;
    output_digest: string;
}, {
    type: "tool_result";
    artifacts: {
        sha256: string;
        name: string;
        bytes: number;
    }[];
    input_digest: string;
    output_digest: string;
}>, z.ZodObject<{
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"text_transform">;
}, "strict", z.ZodTypeAny, {
    type: "text_transform";
    input_digest: string;
    output_digest: string;
}, {
    type: "text_transform";
    input_digest: string;
    output_digest: string;
}>, z.ZodObject<{
    status: z.ZodEnum<["failed", "refused", "unsupported"]>;
    reason: z.ZodString;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"failure">;
}, "strict", z.ZodTypeAny, {
    type: "failure";
    status: "failed" | "refused" | "unsupported";
    reason: string;
    input_digest: string;
    output_digest: string;
}, {
    type: "failure";
    status: "failed" | "refused" | "unsupported";
    reason: string;
    input_digest: string;
    output_digest: string;
}>]>;
export declare const recipeExecutionSchemas: {
    express: z.ZodObject<{
        recipeId: z.ZodString;
        inputPayload: z.ZodOptional<z.ZodEffects<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>, RecipeJson, RecipeJson>>;
        requestKey: z.ZodString;
        maxCredits: z.ZodNumber;
        executionMode: z.ZodEnum<["caller", "provider"]>;
        ttl: z.ZodOptional<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        recipeId: string;
        requestKey: string;
        maxCredits: number;
        executionMode: "provider" | "caller";
        inputPayload?: RecipeJson | undefined;
        ttl?: number | undefined;
    }, {
        recipeId: string;
        requestKey: string;
        maxCredits: number;
        executionMode: "provider" | "caller";
        inputPayload?: RecipeJson | undefined;
        ttl?: number | undefined;
    }>;
    get: z.ZodObject<{
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        organismId: string;
    }, {
        organismId: string;
    }>;
    list: z.ZodObject<{
        role: z.ZodOptional<z.ZodEnum<["participant", "requester", "executor"]>>;
        limit: z.ZodOptional<z.ZodNumber>;
        cursor: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        cursor?: string | undefined;
        limit?: number | undefined;
        role?: "participant" | "requester" | "executor" | undefined;
    }, {
        cursor?: string | undefined;
        limit?: number | undefined;
        role?: "participant" | "requester" | "executor" | undefined;
    }>;
    task: z.ZodObject<{
        taskId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        taskId: string;
    }, {
        taskId: string;
    }>;
    claim: z.ZodObject<{
        leaseId: z.ZodString;
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        organismId: string;
        leaseId: string;
    }, {
        organismId: string;
        leaseId: string;
    }>;
    next: z.ZodObject<{
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        organismId: string;
        leaseId: string;
        fence: number;
    }, {
        organismId: string;
        leaseId: string;
        fence: number;
    }>;
    report: z.ZodObject<{
        position: z.ZodNumber;
        assetId: z.ZodString;
        output: z.ZodEffects<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>, RecipeJson, RecipeJson>;
        evidence: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                sha256: string;
                name: string;
                bytes: number;
            }, {
                sha256: string;
                name: string;
                bytes: number;
            }>, "many">;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"artifact">;
        }, "strict", z.ZodTypeAny, {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }, {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                sha256: string;
                name: string;
                bytes: number;
            }, {
                sha256: string;
                name: string;
                bytes: number;
            }>, "many">;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"tool_result">;
        }, "strict", z.ZodTypeAny, {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }, {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"text_transform">;
        }, "strict", z.ZodTypeAny, {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        }, {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            status: z.ZodEnum<["failed", "refused", "unsupported"]>;
            reason: z.ZodString;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"failure">;
        }, "strict", z.ZodTypeAny, {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        }, {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        }>]>;
        requestKey: z.ZodString;
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        assetId: string;
        output: RecipeJson;
        evidence: {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        } | {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        };
        requestKey: string;
        organismId: string;
        leaseId: string;
        fence: number;
        position: number;
    }, {
        assetId: string;
        output: RecipeJson;
        evidence: {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        } | {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        };
        requestKey: string;
        organismId: string;
        leaseId: string;
        fence: number;
        position: number;
    }>;
    finalize: z.ZodObject<{
        output: z.ZodEffects<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>, RecipeJson, RecipeJson>;
        evidence: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                sha256: string;
                name: string;
                bytes: number;
            }, {
                sha256: string;
                name: string;
                bytes: number;
            }>, "many">;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"artifact">;
        }, "strict", z.ZodTypeAny, {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }, {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                sha256: string;
                name: string;
                bytes: number;
            }, {
                sha256: string;
                name: string;
                bytes: number;
            }>, "many">;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"tool_result">;
        }, "strict", z.ZodTypeAny, {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }, {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"text_transform">;
        }, "strict", z.ZodTypeAny, {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        }, {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        }>, z.ZodObject<{
            status: z.ZodEnum<["failed", "refused", "unsupported"]>;
            reason: z.ZodString;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"failure">;
        }, "strict", z.ZodTypeAny, {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        }, {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        }>]>;
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        output: RecipeJson;
        evidence: {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        } | {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        };
        organismId: string;
        leaseId: string;
        fence: number;
    }, {
        output: RecipeJson;
        evidence: {
            type: "artifact";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "tool_result";
            artifacts: {
                sha256: string;
                name: string;
                bytes: number;
            }[];
            input_digest: string;
            output_digest: string;
        } | {
            type: "text_transform";
            input_digest: string;
            output_digest: string;
        } | {
            type: "failure";
            status: "failed" | "refused" | "unsupported";
            reason: string;
            input_digest: string;
            output_digest: string;
        };
        organismId: string;
        leaseId: string;
        fence: number;
    }>;
    cancel: z.ZodObject<{
        organismId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        organismId: string;
    }, {
        organismId: string;
    }>;
};
export type RecipeExecutionOperation = keyof typeof recipeExecutionSchemas;
export type RecipeExecutionInputs = {
    [K in RecipeExecutionOperation]: z.infer<typeof recipeExecutionSchemas[K]>;
};
export declare const recipePrivateExpressionSchema: z.ZodObject<{
    id: z.ZodString;
    recipe_id: z.ZodString;
    status: z.ZodString;
    ttl: z.ZodNumber;
    born_at: z.ZodString;
    died_at: z.ZodNullable<z.ZodString>;
    total_duration: z.ZodNullable<z.ZodNumber>;
    genes_expressed: z.ZodNumber;
    genes_total_count: z.ZodNumber;
    created_at: z.ZodString;
    requester_node_id: z.ZodNullable<z.ZodString>;
    executor_node_id: z.ZodNullable<z.ZodString>;
    execution_mode: z.ZodString;
    billing_mode: z.ZodString;
    request_key: z.ZodNullable<z.ZodString>;
    cause_of_death: z.ZodNullable<z.ZodString>;
    input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
    output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
    expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
    capsule_ids: z.ZodArray<z.ZodString, "many">;
    task_id: z.ZodNullable<z.ZodString>;
    bounty_id: z.ZodNullable<z.ZodString>;
    manifest: z.ZodNullable<z.ZodObject<{
        schema: z.ZodLiteral<"recipe_execution.v1">;
        recipeId: z.ZodString;
        version: z.ZodNumber;
        ownerNodeId: z.ZodString;
        title: z.ZodString;
        price: z.ZodNumber;
        inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        digest: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            geneAssetId: z.ZodString;
            assetType: z.ZodString;
            condition: z.ZodNullable<z.ZodString>;
            parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            optional: z.ZodBoolean;
            fallbackGeneId: z.ZodNullable<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }, {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }>, "many">;
        assets: z.ZodRecord<z.ZodString, z.ZodObject<{
            assetId: z.ZodString;
            assetType: z.ZodString;
            payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
            triggerText: z.ZodString;
            digest: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }>>;
    }, "strip", z.ZodTypeAny, {
        digest: string;
        assets: Record<string, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }>;
        version: number;
        title: string;
        schema: "recipe_execution.v1";
        steps: {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }[];
        recipeId: string;
        ownerNodeId: string;
        price: number;
        inputSchema: RecipeJson;
        outputSchema: RecipeJson;
    }, {
        digest: string;
        assets: Record<string, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }>;
        version: number;
        title: string;
        schema: "recipe_execution.v1";
        steps: {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }[];
        recipeId: string;
        ownerNodeId: string;
        price: number;
        inputSchema: RecipeJson;
        outputSchema: RecipeJson;
    }>>;
    completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
    execution_fence: z.ZodNumber;
    lease_expires_at: z.ZodNullable<z.ZodString>;
    assurance: z.ZodString;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        position: z.ZodNumber;
        asset_id: z.ZodString;
        status: z.ZodString;
        output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        input_digest: z.ZodNullable<z.ZodString>;
        attempt: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        status: string;
        asset_id: string;
        output: RecipeJson;
        evidence: RecipeJson;
        attempt: number;
        input_digest: string | null;
        position: number;
    }, {
        status: string;
        asset_id: string;
        output: RecipeJson;
        evidence: RecipeJson;
        attempt: number;
        input_digest: string | null;
        position: number;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    status: string;
    id: string;
    created_at: string;
    bounty_id: string | null;
    task_id: string | null;
    lease_expires_at: string | null;
    capsule_ids: string[];
    ttl: number;
    recipe_id: string;
    born_at: string;
    died_at: string | null;
    total_duration: number | null;
    genes_expressed: number;
    genes_total_count: number;
    requester_node_id: string | null;
    executor_node_id: string | null;
    execution_mode: string;
    billing_mode: string;
    request_key: string | null;
    cause_of_death: string | null;
    input_payload: RecipeJson;
    output_payload: RecipeJson;
    expression_log: RecipeJson;
    manifest: {
        digest: string;
        assets: Record<string, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }>;
        version: number;
        title: string;
        schema: "recipe_execution.v1";
        steps: {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }[];
        recipeId: string;
        ownerNodeId: string;
        price: number;
        inputSchema: RecipeJson;
        outputSchema: RecipeJson;
    } | null;
    completion_evidence: RecipeJson;
    execution_fence: number;
    assurance: string;
    steps?: {
        status: string;
        asset_id: string;
        output: RecipeJson;
        evidence: RecipeJson;
        attempt: number;
        input_digest: string | null;
        position: number;
    }[] | undefined;
}, {
    status: string;
    id: string;
    created_at: string;
    bounty_id: string | null;
    task_id: string | null;
    lease_expires_at: string | null;
    capsule_ids: string[];
    ttl: number;
    recipe_id: string;
    born_at: string;
    died_at: string | null;
    total_duration: number | null;
    genes_expressed: number;
    genes_total_count: number;
    requester_node_id: string | null;
    executor_node_id: string | null;
    execution_mode: string;
    billing_mode: string;
    request_key: string | null;
    cause_of_death: string | null;
    input_payload: RecipeJson;
    output_payload: RecipeJson;
    expression_log: RecipeJson;
    manifest: {
        digest: string;
        assets: Record<string, {
            payload: RecipeJson;
            digest: string;
            assetId: string;
            assetType: string;
            triggerText: string;
        }>;
        version: number;
        title: string;
        schema: "recipe_execution.v1";
        steps: {
            assetType: string;
            position: number;
            geneAssetId: string;
            condition: string | null;
            parameters: RecipeJson;
            optional: boolean;
            fallbackGeneId: string | null;
        }[];
        recipeId: string;
        ownerNodeId: string;
        price: number;
        inputSchema: RecipeJson;
        outputSchema: RecipeJson;
    } | null;
    completion_evidence: RecipeJson;
    execution_fence: number;
    assurance: string;
    steps?: {
        status: string;
        asset_id: string;
        output: RecipeJson;
        evidence: RecipeJson;
        attempt: number;
        input_digest: string | null;
        position: number;
    }[] | undefined;
}>;
export declare const recipeExecutionResponses: {
    express: z.ZodObject<{
        status: z.ZodLiteral<"accepted">;
        organism: z.ZodObject<{
            id: z.ZodString;
            recipe_id: z.ZodString;
            status: z.ZodString;
            ttl: z.ZodNumber;
            born_at: z.ZodString;
            died_at: z.ZodNullable<z.ZodString>;
            total_duration: z.ZodNullable<z.ZodNumber>;
            genes_expressed: z.ZodNumber;
            genes_total_count: z.ZodNumber;
            created_at: z.ZodString;
            requester_node_id: z.ZodNullable<z.ZodString>;
            executor_node_id: z.ZodNullable<z.ZodString>;
            execution_mode: z.ZodString;
            billing_mode: z.ZodString;
            request_key: z.ZodNullable<z.ZodString>;
            cause_of_death: z.ZodNullable<z.ZodString>;
            input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
            capsule_ids: z.ZodArray<z.ZodString, "many">;
            task_id: z.ZodNullable<z.ZodString>;
            bounty_id: z.ZodNullable<z.ZodString>;
            manifest: z.ZodNullable<z.ZodObject<{
                schema: z.ZodLiteral<"recipe_execution.v1">;
                recipeId: z.ZodString;
                version: z.ZodNumber;
                ownerNodeId: z.ZodString;
                title: z.ZodString;
                price: z.ZodNumber;
                inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                digest: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    position: z.ZodNumber;
                    geneAssetId: z.ZodString;
                    assetType: z.ZodString;
                    condition: z.ZodNullable<z.ZodString>;
                    parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                    optional: z.ZodBoolean;
                    fallbackGeneId: z.ZodNullable<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }, {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }>, "many">;
                assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                    assetId: z.ZodString;
                    assetType: z.ZodString;
                    payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                    triggerText: z.ZodString;
                    digest: z.ZodString;
                }, "strip", z.ZodTypeAny, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>>;
            }, "strip", z.ZodTypeAny, {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            }, {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            }>>;
            completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            execution_fence: z.ZodNumber;
            lease_expires_at: z.ZodNullable<z.ZodString>;
            assurance: z.ZodString;
            steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                asset_id: z.ZodString;
                status: z.ZodString;
                output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                input_digest: z.ZodNullable<z.ZodString>;
                attempt: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }, {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }>, "many">>;
        }, "strip", z.ZodTypeAny, {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }, {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        status: "accepted";
        organism: {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        };
    }, {
        status: "accepted";
        organism: {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        };
    }>;
    get: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        capsule_ids: z.ZodArray<z.ZodString, "many">;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }>, "many">;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }>;
    list: z.ZodObject<{
        organisms: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            recipe_id: z.ZodString;
            status: z.ZodString;
            ttl: z.ZodNumber;
            born_at: z.ZodString;
            died_at: z.ZodNullable<z.ZodString>;
            total_duration: z.ZodNullable<z.ZodNumber>;
            genes_expressed: z.ZodNumber;
            genes_total_count: z.ZodNumber;
            created_at: z.ZodString;
            requester_node_id: z.ZodNullable<z.ZodString>;
            executor_node_id: z.ZodNullable<z.ZodString>;
            execution_mode: z.ZodString;
            billing_mode: z.ZodString;
            request_key: z.ZodNullable<z.ZodString>;
            cause_of_death: z.ZodNullable<z.ZodString>;
            input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
            capsule_ids: z.ZodArray<z.ZodString, "many">;
            task_id: z.ZodNullable<z.ZodString>;
            bounty_id: z.ZodNullable<z.ZodString>;
            manifest: z.ZodNullable<z.ZodObject<{
                schema: z.ZodLiteral<"recipe_execution.v1">;
                recipeId: z.ZodString;
                version: z.ZodNumber;
                ownerNodeId: z.ZodString;
                title: z.ZodString;
                price: z.ZodNumber;
                inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                digest: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    position: z.ZodNumber;
                    geneAssetId: z.ZodString;
                    assetType: z.ZodString;
                    condition: z.ZodNullable<z.ZodString>;
                    parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                    optional: z.ZodBoolean;
                    fallbackGeneId: z.ZodNullable<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }, {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }>, "many">;
                assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                    assetId: z.ZodString;
                    assetType: z.ZodString;
                    payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                    triggerText: z.ZodString;
                    digest: z.ZodString;
                }, "strip", z.ZodTypeAny, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>>;
            }, "strip", z.ZodTypeAny, {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            }, {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            }>>;
            completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            execution_fence: z.ZodNumber;
            lease_expires_at: z.ZodNullable<z.ZodString>;
            assurance: z.ZodString;
            steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                asset_id: z.ZodString;
                status: z.ZodString;
                output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                input_digest: z.ZodNullable<z.ZodString>;
                attempt: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }, {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }>, "many">>;
        }, "strip", z.ZodTypeAny, {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }, {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }>, "many">;
        next_cursor: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        next_cursor: string | null;
        organisms: {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }[];
    }, {
        next_cursor: string | null;
        organisms: {
            status: string;
            id: string;
            created_at: string;
            bounty_id: string | null;
            task_id: string | null;
            lease_expires_at: string | null;
            capsule_ids: string[];
            ttl: number;
            recipe_id: string;
            born_at: string;
            died_at: string | null;
            total_duration: number | null;
            genes_expressed: number;
            genes_total_count: number;
            requester_node_id: string | null;
            executor_node_id: string | null;
            execution_mode: string;
            billing_mode: string;
            request_key: string | null;
            cause_of_death: string | null;
            input_payload: RecipeJson;
            output_payload: RecipeJson;
            expression_log: RecipeJson;
            manifest: {
                digest: string;
                assets: Record<string, {
                    payload: RecipeJson;
                    digest: string;
                    assetId: string;
                    assetType: string;
                    triggerText: string;
                }>;
                version: number;
                title: string;
                schema: "recipe_execution.v1";
                steps: {
                    assetType: string;
                    position: number;
                    geneAssetId: string;
                    condition: string | null;
                    parameters: RecipeJson;
                    optional: boolean;
                    fallbackGeneId: string | null;
                }[];
                recipeId: string;
                ownerNodeId: string;
                price: number;
                inputSchema: RecipeJson;
                outputSchema: RecipeJson;
            } | null;
            completion_evidence: RecipeJson;
            execution_fence: number;
            assurance: string;
            steps?: {
                status: string;
                asset_id: string;
                output: RecipeJson;
                evidence: RecipeJson;
                attempt: number;
                input_digest: string | null;
                position: number;
            }[] | undefined;
        }[];
    }>;
    task: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        capsule_ids: z.ZodArray<z.ZodString, "many">;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }>, "many">;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }>>;
    claim: z.ZodObject<{
        organism_id: z.ZodString;
        lease_id: z.ZodString;
        fence: z.ZodNumber;
        lease_expires_at: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        lease_id: string;
        lease_expires_at: string;
        fence: number;
        organism_id: string;
    }, {
        lease_id: string;
        lease_expires_at: string;
        fence: number;
        organism_id: string;
    }>;
    next: z.ZodDiscriminatedUnion<"done", [z.ZodObject<{
        organism_id: z.ZodString;
        done: z.ZodLiteral<true>;
        finalization_input_digest: z.ZodString;
        output_schema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
    }, "strip", z.ZodTypeAny, {
        done: true;
        organism_id: string;
        finalization_input_digest: string;
        output_schema: RecipeJson;
    }, {
        done: true;
        organism_id: string;
        finalization_input_digest: string;
        output_schema: RecipeJson;
    }>, z.ZodObject<{
        organism_id: z.ZodString;
        done: z.ZodLiteral<false>;
        position: z.ZodNumber;
        asset_id: z.ZodString;
        asset_type: z.ZodString;
        asset_payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        input: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        input_digest: z.ZodString;
        optional: z.ZodBoolean;
        fence: z.ZodNumber;
        assurance: z.ZodLiteral<"executor_reported">;
    }, "strip", z.ZodTypeAny, {
        asset_id: string;
        asset_type: string;
        done: false;
        input: RecipeJson;
        input_digest: string;
        fence: number;
        position: number;
        optional: boolean;
        assurance: "executor_reported";
        organism_id: string;
        asset_payload: RecipeJson;
    }, {
        asset_id: string;
        asset_type: string;
        done: false;
        input: RecipeJson;
        input_digest: string;
        fence: number;
        position: number;
        optional: boolean;
        assurance: "executor_reported";
        organism_id: string;
        asset_payload: RecipeJson;
    }>]>;
    report: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        capsule_ids: z.ZodArray<z.ZodString, "many">;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }>, "many">;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }>;
    finalize: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        capsule_ids: z.ZodArray<z.ZodString, "many">;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }>, "many">;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }>;
    cancel: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        expression_log: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
        capsule_ids: z.ZodArray<z.ZodString, "many">;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }, {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }>, "many">;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>>;
        }, "strip", z.ZodTypeAny, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }, {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        }>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, z.ZodTypeDef, RecipeJson>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }, {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }, {
        status: string;
        id: string;
        created_at: string;
        bounty_id: string | null;
        task_id: string | null;
        lease_expires_at: string | null;
        capsule_ids: string[];
        ttl: number;
        recipe_id: string;
        born_at: string;
        died_at: string | null;
        total_duration: number | null;
        genes_expressed: number;
        genes_total_count: number;
        requester_node_id: string | null;
        executor_node_id: string | null;
        execution_mode: string;
        billing_mode: string;
        request_key: string | null;
        cause_of_death: string | null;
        input_payload: RecipeJson;
        output_payload: RecipeJson;
        expression_log: RecipeJson;
        manifest: {
            digest: string;
            assets: Record<string, {
                payload: RecipeJson;
                digest: string;
                assetId: string;
                assetType: string;
                triggerText: string;
            }>;
            version: number;
            title: string;
            schema: "recipe_execution.v1";
            steps: {
                assetType: string;
                position: number;
                geneAssetId: string;
                condition: string | null;
                parameters: RecipeJson;
                optional: boolean;
                fallbackGeneId: string | null;
            }[];
            recipeId: string;
            ownerNodeId: string;
            price: number;
            inputSchema: RecipeJson;
            outputSchema: RecipeJson;
        } | null;
        completion_evidence: RecipeJson;
        execution_fence: number;
        assurance: string;
        steps?: {
            status: string;
            asset_id: string;
            output: RecipeJson;
            evidence: RecipeJson;
            attempt: number;
            input_digest: string | null;
            position: number;
        }[] | undefined;
    }>;
};
export type RecipeExecutionOutputs = {
    [K in RecipeExecutionOperation]: z.infer<typeof recipeExecutionResponses[K]>;
};
export type RecipeExecutionSendState = 'not_sent' | 'unknown';
export interface PreparedRecipeExecution<K extends RecipeExecutionOperation> {
    invoke(): Promise<RecipeExecutionOutputs[K]>;
}
export declare class RecipeExecutionError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryAfterMs?: number | undefined;
    readonly commitState: 'rejected' | 'unknown';
    readonly sendState: RecipeExecutionSendState;
    constructor(code: string, status: number, retryAfterMs?: number | undefined, commitState?: 'rejected' | 'unknown', sendState?: RecipeExecutionSendState);
}
export interface RecipeExecutionCapability {
    readonly protocolVersion: 1;
    scope(): string;
    prepare?<K extends RecipeExecutionOperation>(operation: K, input: RecipeExecutionInputs[K], expectedScope?: string): Promise<PreparedRecipeExecution<K>>;
    invoke<K extends RecipeExecutionOperation>(operation: K, input: RecipeExecutionInputs[K], expectedScope?: string): Promise<RecipeExecutionOutputs[K]>;
}
export declare function parseRecipeExecutionInput<K extends RecipeExecutionOperation>(operation: K, input: unknown): RecipeExecutionInputs[K];
export declare function requireRecipeExecution(capability: RecipeExecutionCapability | undefined): RecipeExecutionCapability;