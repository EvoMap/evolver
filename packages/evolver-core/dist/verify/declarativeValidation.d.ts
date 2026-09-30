import type { ValidatorEvidence } from '../exec/executionBinding.js';
export interface DeclarativeValidationSpec {
    readonly version: 1;
    readonly files: readonly {
        readonly path: string;
        readonly sha256: string;
    }[];
}
export interface DeclarativeValidationResult {
    passed: boolean;
    score: number;
    validator: ValidatorEvidence;
}
/** Portable relative paths: no platform aliases or private Git/recovery metadata. */
export declare function declarativeValidationPath(value: unknown): string;
/** Freeze operator acceptance before dispatch; neither model output nor a changed spec can redefine success. */
export declare function parseDeclarativeValidationSpec(input: unknown): DeclarativeValidationSpec;
export declare function declarativeValidationDigest(spec: DeclarativeValidationSpec): `sha256:${string}`;
/** Check the real native backend and cleanup before claiming input or sending anything to the provider. */
export declare function assertDeclarativeValidationAvailable(cwd: string): void;
/**
 * Independently hash the final bytes. changedPaths MUST come from the trusted host's complete Git
 * enumeration (tracked/staged and all untracked, including ignored files), never from model claims.
 * This executes no repository code and therefore reports no process/OS sandbox or functional-test claim.
 */
export declare function runDeclarativeValidation(input: DeclarativeValidationSpec, cwd: string, changedPaths: readonly string[], signal?: AbortSignal): DeclarativeValidationResult;