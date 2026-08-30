export interface ValidationCommand {
    cmd: string;
    label?: string;
}
/** 校验计划. allowlist **由用户项目声明**(批注#21), 不再内置 ['node']. */
export interface ValidationPlan {
    commands: readonly ValidationCommand[];
    allowlist: readonly string[];
}
export interface ValidationResult {
    label: string;
    cmd: string;
    allowed: boolean;
    exitCode: number | null;
    stdoutSummary: string;
    passed: boolean;
}
export interface RunOutput {
    exitCode: number;
    stdout: string;
}
export type CommandRunner = (cmd: string, signal?: AbortSignal) => Promise<RunOutput> | RunOutput;
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
/** 命令首 token(可执行名)是否在项目声明的 allowlist 内. */
export declare function isAllowed(cmd: string, allowlist: readonly string[]): boolean;
/** Extract the unambiguous script targeted by `node <script> ...`, or null for non-script/unsupported commands. */
export declare function validationScriptPath(cmd: string): string | null;
/** stdout 摘要 = 首行 + 末行(去 canary.js 隐形约定: 不找魔法字符串, 只留可读摘要). */
export declare function summarizeStdout(stdout: string): string;
/**
 * 跑校验(M4A-4). 判价值 = **exit code + stdout 摘要**, 不依赖 canary.js 魔法字符串(批注#22).
 * 不在 allowlist 的命令 auto-deny(不执行, allowed=false), 守无人值守安全.
 */
export declare function runValidation(plan: ValidationPlan, run: CommandRunner, signal?: AbortSignal): Promise<{
    results: ValidationResult[];
    passed: boolean;
    cancelled: boolean;
}>;
/**
 * 检查验证命令是否安全可作为 Gene.validation 条目使用（忠实移植 v1 policyCheck.isValidationCommandAllowed）。
 * Gene 验证命令只允许 `node …` 形式，不允许非 node 命令（如 pnpm/npm/echo 等）。
 * 安全条件：
 * 1. 必须以 `node ` 开头
 * 2. 不包含命令替换（` 或 $(）
 * 3. 不包含 shell 元字符（引号外）
 * 4. 不包含被阻止的 node 标志（-e/--eval/--print 等）
 */
export declare function isValidationCommandAllowed(cmd: string): boolean;