export { BLOCKED_NODE_FLAGS, SHELL_METACHARS, isNodeExecutable, nodeFlagViolation, normalizeExecutableName } from './validationSyntax.js';
export { isValidationCommandAllowed } from './validationCommandPolicy.js';
export interface ValidationCommand {
    cmd: string;
    label?: string; /** Directory relative to the validation root. */
    cwd?: string;
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
export type CommandRunner = (cmd: string, signal?: AbortSignal, cwd?: string) => Promise<RunOutput> | RunOutput;
/** 命令可执行名（跳过白名单环境变量前缀）是否在项目声明的 allowlist 内. */
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