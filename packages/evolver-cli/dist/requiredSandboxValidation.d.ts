import { verify } from '@evomap/evolver-core';
export type SandboxedValidationRunner = typeof verify.runSandboxedValidation;
type SandboxedValidationOptions = NonNullable<Parameters<SandboxedValidationRunner>[2]>;
export declare function runRequiredSandboxedValidation(commands: readonly string[], cwd: string, options?: SandboxedValidationOptions, runner?: SandboxedValidationRunner): ReturnType<SandboxedValidationRunner>;
export {};