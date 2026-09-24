export const recipeToolSchemas = {
    "express": {
        "type": "object",
        "properties": {
            "inputPayload": {
                "$ref": "#/$defs/__schema0"
            },
            "requestKey": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "maxCredits": {
                "type": "number",
                "minimum": 0,
                "maximum": 1000000000
            },
            "executionMode": {
                "type": "string",
                "enum": [
                    "caller",
                    "provider"
                ]
            },
            "ttl": {
                "type": "integer",
                "minimum": 1,
                "maximum": 86400
            },
            "recipeId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "requestKey",
            "maxCredits",
            "executionMode",
            "recipeId"
        ],
        "additionalProperties": false,
        "$defs": {
            "__schema0": {
                "anyOf": [
                    {
                        "type": "string"
                    },
                    {
                        "type": "number"
                    },
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    },
                    {
                        "type": "array",
                        "items": {
                            "$ref": "#/$defs/__schema0"
                        }
                    },
                    {
                        "type": "object",
                        "propertyNames": {
                            "type": "string"
                        },
                        "additionalProperties": {
                            "$ref": "#/$defs/__schema0"
                        }
                    }
                ]
            }
        }
    },
    "get": {
        "type": "object",
        "properties": {
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "organismId"
        ],
        "additionalProperties": false
    },
    "list": {
        "type": "object",
        "properties": {
            "role": {
                "type": "string",
                "enum": [
                    "participant",
                    "requester",
                    "executor"
                ]
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50
            },
            "cursor": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [],
        "additionalProperties": false
    },
    "task": {
        "type": "object",
        "properties": {
            "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "taskId"
        ],
        "additionalProperties": false
    },
    "claim": {
        "type": "object",
        "properties": {
            "leaseId": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "leaseId",
            "organismId"
        ],
        "additionalProperties": false
    },
    "next": {
        "type": "object",
        "properties": {
            "leaseId": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "fence": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "leaseId",
            "fence",
            "organismId"
        ],
        "additionalProperties": false
    },
    "report": {
        "type": "object",
        "properties": {
            "leaseId": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "fence": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "position": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "assetId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            },
            "output": {
                "$ref": "#/$defs/__schema0"
            },
            "evidence": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "artifact"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "artifacts": {
                                "minItems": 1,
                                "maxItems": 100,
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 512
                                        },
                                        "sha256": {
                                            "type": "string",
                                            "pattern": "^[a-f0-9]{64}$"
                                        },
                                        "bytes": {
                                            "type": "integer",
                                            "minimum": 0,
                                            "maximum": 9007199254740991
                                        }
                                    },
                                    "required": [
                                        "name",
                                        "sha256",
                                        "bytes"
                                    ],
                                    "additionalProperties": false
                                }
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "artifacts"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "tool_result"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "artifacts": {
                                "minItems": 1,
                                "maxItems": 100,
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 512
                                        },
                                        "sha256": {
                                            "type": "string",
                                            "pattern": "^[a-f0-9]{64}$"
                                        },
                                        "bytes": {
                                            "type": "integer",
                                            "minimum": 0,
                                            "maximum": 9007199254740991
                                        }
                                    },
                                    "required": [
                                        "name",
                                        "sha256",
                                        "bytes"
                                    ],
                                    "additionalProperties": false
                                }
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "artifacts"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "text_transform"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "failure"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "status": {
                                "type": "string",
                                "enum": [
                                    "failed",
                                    "refused",
                                    "unsupported"
                                ]
                            },
                            "reason": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "status",
                            "reason"
                        ],
                        "additionalProperties": false
                    }
                ]
            },
            "requestKey": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "leaseId",
            "fence",
            "position",
            "assetId",
            "output",
            "evidence",
            "requestKey",
            "organismId"
        ],
        "additionalProperties": false,
        "$defs": {
            "__schema0": {
                "anyOf": [
                    {
                        "type": "string"
                    },
                    {
                        "type": "number"
                    },
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    },
                    {
                        "type": "array",
                        "items": {
                            "$ref": "#/$defs/__schema0"
                        }
                    },
                    {
                        "type": "object",
                        "propertyNames": {
                            "type": "string"
                        },
                        "additionalProperties": {
                            "$ref": "#/$defs/__schema0"
                        }
                    }
                ]
            }
        }
    },
    "finalize": {
        "type": "object",
        "properties": {
            "leaseId": {
                "type": "string",
                "minLength": 8,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "fence": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "output": {
                "$ref": "#/$defs/__schema0"
            },
            "evidence": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "artifact"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "artifacts": {
                                "minItems": 1,
                                "maxItems": 100,
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 512
                                        },
                                        "sha256": {
                                            "type": "string",
                                            "pattern": "^[a-f0-9]{64}$"
                                        },
                                        "bytes": {
                                            "type": "integer",
                                            "minimum": 0,
                                            "maximum": 9007199254740991
                                        }
                                    },
                                    "required": [
                                        "name",
                                        "sha256",
                                        "bytes"
                                    ],
                                    "additionalProperties": false
                                }
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "artifacts"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "tool_result"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "artifacts": {
                                "minItems": 1,
                                "maxItems": 100,
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 512
                                        },
                                        "sha256": {
                                            "type": "string",
                                            "pattern": "^[a-f0-9]{64}$"
                                        },
                                        "bytes": {
                                            "type": "integer",
                                            "minimum": 0,
                                            "maximum": 9007199254740991
                                        }
                                    },
                                    "required": [
                                        "name",
                                        "sha256",
                                        "bytes"
                                    ],
                                    "additionalProperties": false
                                }
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "artifacts"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "text_transform"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest"
                        ],
                        "additionalProperties": false
                    },
                    {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "const": "failure"
                            },
                            "input_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "output_digest": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                            },
                            "status": {
                                "type": "string",
                                "enum": [
                                    "failed",
                                    "refused",
                                    "unsupported"
                                ]
                            },
                            "reason": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000
                            }
                        },
                        "required": [
                            "type",
                            "input_digest",
                            "output_digest",
                            "status",
                            "reason"
                        ],
                        "additionalProperties": false
                    }
                ]
            },
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "leaseId",
            "fence",
            "output",
            "evidence",
            "organismId"
        ],
        "additionalProperties": false,
        "$defs": {
            "__schema0": {
                "anyOf": [
                    {
                        "type": "string"
                    },
                    {
                        "type": "number"
                    },
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    },
                    {
                        "type": "array",
                        "items": {
                            "$ref": "#/$defs/__schema0"
                        }
                    },
                    {
                        "type": "object",
                        "propertyNames": {
                            "type": "string"
                        },
                        "additionalProperties": {
                            "$ref": "#/$defs/__schema0"
                        }
                    }
                ]
            }
        }
    },
    "cancel": {
        "type": "object",
        "properties": {
            "organismId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
            }
        },
        "required": [
            "organismId"
        ],
        "additionalProperties": false
    }
};