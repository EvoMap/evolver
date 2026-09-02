export declare const EXECUTION_REDACTION_POLICY_VERSION: "execution-redaction.v1";
export declare const EXECUTION_REDACTED: "[REDACTED]";
export type ExecutionRedactionReason = 'known_credential' | 'sensitive_assignment' | 'sensitive_flag' | 'high_entropy_value' | 'nested_command' | 'malformed_input' | 'input_too_large';
export interface ExecutionRedactionResult<T> {
    value: T;
    changed: boolean;
    /** A changed command is evidence only; it must never be executed or treated as verified. */
    blocked: boolean;
    policyVersion: typeof EXECUTION_REDACTION_POLICY_VERSION;
    reasons: ExecutionRedactionReason[];
}
export declare function sanitizeExecutionCommand(value: unknown): ExecutionRedactionResult<string>;
export declare function sanitizeExecutionDiagnostic(value: unknown): ExecutionRedactionResult<string>;
/**
 * Common safe outlet for verifier receipts, IPC responses, persisted execution evidence, logs, and Hub payloads.
 * Command changes propagate `blocked=true`; callers must not execute or promote that evidence after redaction.
 */
export declare function sanitizeExecutionPayload<T>(input: T): ExecutionRedactionResult<T>;