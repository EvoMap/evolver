export declare const recipeToolSchemas: {
    express: {
        type: string;
        properties: {
            inputPayload: {
                $ref: string;
            };
            requestKey: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            maxCredits: {
                type: string;
                minimum: number;
                maximum: number;
            };
            executionMode: {
                type: string;
                enum: string[];
            };
            ttl: {
                type: string;
                minimum: number;
                maximum: number;
            };
            recipeId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
        $defs: {
            __schema0: {
                anyOf: ({
                    type: string;
                    items?: undefined;
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    propertyNames: {
                        type: string;
                    };
                    additionalProperties: {
                        $ref: string;
                    };
                    items?: undefined;
                })[];
            };
        };
    };
    get: {
        type: string;
        properties: {
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
    list: {
        type: string;
        properties: {
            role: {
                type: string;
                enum: string[];
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
            };
            cursor: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: never[];
        additionalProperties: boolean;
    };
    task: {
        type: string;
        properties: {
            taskId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
    claim: {
        type: string;
        properties: {
            leaseId: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
    next: {
        type: string;
        properties: {
            leaseId: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            fence: {
                type: string;
                minimum: number;
                maximum: number;
            };
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
    report: {
        type: string;
        properties: {
            leaseId: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            fence: {
                type: string;
                minimum: number;
                maximum: number;
            };
            position: {
                type: string;
                minimum: number;
                maximum: number;
            };
            assetId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            output: {
                $ref: string;
            };
            evidence: {
                oneOf: ({
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        artifacts: {
                            minItems: number;
                            maxItems: number;
                            type: string;
                            items: {
                                type: string;
                                properties: {
                                    name: {
                                        type: string;
                                        minLength: number;
                                        maxLength: number;
                                    };
                                    sha256: {
                                        type: string;
                                        pattern: string;
                                    };
                                    bytes: {
                                        type: string;
                                        minimum: number;
                                        maximum: number;
                                    };
                                };
                                required: string[];
                                additionalProperties: boolean;
                            };
                        };
                        status?: undefined;
                        reason?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                } | {
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        artifacts?: undefined;
                        status?: undefined;
                        reason?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                } | {
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        status: {
                            type: string;
                            enum: string[];
                        };
                        reason: {
                            type: string;
                            minLength: number;
                            maxLength: number;
                        };
                        artifacts?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                })[];
            };
            requestKey: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
        $defs: {
            __schema0: {
                anyOf: ({
                    type: string;
                    items?: undefined;
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    propertyNames: {
                        type: string;
                    };
                    additionalProperties: {
                        $ref: string;
                    };
                    items?: undefined;
                })[];
            };
        };
    };
    finalize: {
        type: string;
        properties: {
            leaseId: {
                type: string;
                minLength: number;
                maxLength: number;
                pattern: string;
            };
            fence: {
                type: string;
                minimum: number;
                maximum: number;
            };
            output: {
                $ref: string;
            };
            evidence: {
                oneOf: ({
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        artifacts: {
                            minItems: number;
                            maxItems: number;
                            type: string;
                            items: {
                                type: string;
                                properties: {
                                    name: {
                                        type: string;
                                        minLength: number;
                                        maxLength: number;
                                    };
                                    sha256: {
                                        type: string;
                                        pattern: string;
                                    };
                                    bytes: {
                                        type: string;
                                        minimum: number;
                                        maximum: number;
                                    };
                                };
                                required: string[];
                                additionalProperties: boolean;
                            };
                        };
                        status?: undefined;
                        reason?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                } | {
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        artifacts?: undefined;
                        status?: undefined;
                        reason?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                } | {
                    type: string;
                    properties: {
                        type: {
                            type: string;
                            const: string;
                        };
                        input_digest: {
                            type: string;
                            pattern: string;
                        };
                        output_digest: {
                            type: string;
                            pattern: string;
                        };
                        status: {
                            type: string;
                            enum: string[];
                        };
                        reason: {
                            type: string;
                            minLength: number;
                            maxLength: number;
                        };
                        artifacts?: undefined;
                    };
                    required: string[];
                    additionalProperties: boolean;
                })[];
            };
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
        $defs: {
            __schema0: {
                anyOf: ({
                    type: string;
                    items?: undefined;
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    items: {
                        $ref: string;
                    };
                    propertyNames?: undefined;
                    additionalProperties?: undefined;
                } | {
                    type: string;
                    propertyNames: {
                        type: string;
                    };
                    additionalProperties: {
                        $ref: string;
                    };
                    items?: undefined;
                })[];
            };
        };
    };
    cancel: {
        type: string;
        properties: {
            organismId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
};