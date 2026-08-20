import { compatibility, exec, verify } from '@evomap/evolver-core';
export interface ModelCompatibilityReplayDeps {
    spawn?: typeof exec.spawnCapture;
    validation?: typeof verify.runSandboxedValidation;
    isolationAvailable?: () => boolean;
}
declare function claudeArgs(test: compatibility.ReplayCase): string[];
export declare function runModelCompatibilityReplay(argv: string[], deps?: ModelCompatibilityReplayDeps): Promise<number>;
export declare const modelCompatibilityClaudeArgs: typeof claudeArgs;
export {};