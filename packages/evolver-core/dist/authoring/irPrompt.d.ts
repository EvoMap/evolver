export declare const IR_KINDS: readonly ["fix", "change", "investigate", "configure", "refactor"];
export type IrKind = (typeof IR_KINDS)[number];
export interface IrPromptRequest {
    records?: unknown;
    kind?: IrKind;
    focus?: string;
    outcome?: 'success' | 'failed';
}
/**
 * The `session-gene-ir-v1` prompt with the record numbered R1…Rn; the model answers 0 to MAX_IRS IR objects, one per
 * unrelated task, or a skip. A failed outcome asks for the attempt as a warning rather than a method.
 */
export declare function irPrompt(request?: IrPromptRequest): string;
/** JSON Schema (draft-07) of one IR object, mirroring the bounds `checkSessionGeneIr` enforces. */
export declare const IR_OUTPUT_SCHEMA: Readonly<{
    $schema: "http://json-schema.org/draft-07/schema#";
    $id: "https://evomap.ai/schemas/session-gene-ir-v1.json";
    title: "session-gene-ir-v1";
    type: "object";
    required: string[];
    properties: {
        title: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        capability_summary: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        kind: {
            type: string;
            enum: ("fix" | "change" | "investigate" | "configure" | "refactor")[];
        };
        scope: {
            type: string;
            required: string[];
            properties: {
                signals: {
                    uniqueItems: boolean;
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                use_when: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                do_not_use_when: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
            };
        };
        preconditions: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        procedure: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        failure_repairs: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        canonical_contracts: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        project_notes: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        unknowns: {
            type: string;
            items: object;
            minItems: number;
            maxItems: number;
        };
        portability: {
            type: string;
            required: string[];
            properties: {
                class: {
                    type: string;
                    enum: string[];
                };
                bound_identifiers: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
            };
        };
    };
}>;
/** The whole answer the prompt asks for, self-contained: up to MAX_IRS IR objects, or a one-sentence skip. */
export declare const IR_ANSWER_SCHEMA: Readonly<{
    $schema: "http://json-schema.org/draft-07/schema#";
    oneOf: ({
        type: string;
        maxItems: number;
        items: {
            title: "session-gene-ir-v1";
            type: "object";
            required: string[];
            properties: {
                title: {
                    type: string;
                    minLength: number;
                    maxLength: number;
                };
                capability_summary: {
                    type: string;
                    minLength: number;
                    maxLength: number;
                };
                kind: {
                    type: string;
                    enum: ("fix" | "change" | "investigate" | "configure" | "refactor")[];
                };
                scope: {
                    type: string;
                    required: string[];
                    properties: {
                        signals: {
                            uniqueItems: boolean;
                            type: string;
                            items: object;
                            minItems: number;
                            maxItems: number;
                        };
                        use_when: {
                            type: string;
                            items: object;
                            minItems: number;
                            maxItems: number;
                        };
                        do_not_use_when: {
                            type: string;
                            items: object;
                            minItems: number;
                            maxItems: number;
                        };
                    };
                };
                preconditions: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                procedure: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                failure_repairs: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                canonical_contracts: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                project_notes: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                unknowns: {
                    type: string;
                    items: object;
                    minItems: number;
                    maxItems: number;
                };
                portability: {
                    type: string;
                    required: string[];
                    properties: {
                        class: {
                            type: string;
                            enum: string[];
                        };
                        bound_identifiers: {
                            type: string;
                            items: object;
                            minItems: number;
                            maxItems: number;
                        };
                    };
                };
            };
        };
        required?: undefined;
        properties?: undefined;
        additionalProperties?: undefined;
    } | {
        type: string;
        required: string[];
        properties: {
            skip: {
                type: string;
            };
        };
        additionalProperties: boolean;
        maxItems?: undefined;
        items?: undefined;
    })[];
}>;