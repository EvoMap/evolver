/** Shell-free parsing shared by the validation policy, the observed-check normaliser and the runner. */
export declare const SHELL_METACHARS: RegExp;
/**
 * Parse one validation command without invoking a shell. Quotes group whitespace and backslash only escapes
 * whitespace, quotes, or another backslash; no variable expansion or command substitution is performed.
 * A null result means the command has an unterminated quote and must be rejected.
 */
export declare function tokenizeValidationCommand(command: string): string[] | null;
export declare const BLOCKED_NODE_FLAGS: Set<string>;
export declare function normalizeExecutableName(executable: string): string;
export declare function isNodeExecutable(executable: string): boolean;
export declare function nodeFlagViolation(executable: string, args: readonly string[]): string | null;
export type NodeValidationInvocation = {
    kind: 'script';
    script: string;
} | {
    kind: 'safe_no_script';
} | {
    kind: 'invalid';
    option?: string;
};
/**
 * 将 Node 命令限制为明确的脚本位置，防止带参数的选项吞掉下一个 token 后绕过脚本路径检查。
 * 验证只需要普通脚本、语法检查，以及兼容旧 Gene 的 version/help 身份检查；其他前置选项默认拒绝。
 */
export declare function classifyNodeValidationInvocation(executable: string, args: readonly string[]): NodeValidationInvocation;
export interface ValidationInvocation {
    /** Whitelisted environment prefix, applied by the runner to the child environment only. */
    env: Record<string, string>;
    executable: string;
    args: string[];
}
export declare const VALIDATION_ENV_PREFIX_ALLOW: ReadonlySet<string>;
/** Split a tokenized command into its whitelisted env prefix and the invocation proper. */
export declare function splitValidationInvocation(tokens: readonly string[]): ValidationInvocation | 'disallowed_env' | null;
/** Parse a validation command for execution, including its whitelisted env prefix. */
export declare function parseValidationInvocation(cmd: string): ValidationInvocation | null;