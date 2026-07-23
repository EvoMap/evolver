export type AutoExecRunner = 'claude' | 'codex' | 'cursor' | 'gemini';
export interface AutoExecConfig {
    allowedRoots: string[];
    pollMs: number;
    timeoutMs: number;
    runner: AutoExecRunner;
    workflowValidationProfiles: Record<string, string[]>;
}
/** Read <base>/config.json with deny-by-default workflow and autoexec safety settings. */
export declare function readAutoExecConfig(base: string): AutoExecConfig;