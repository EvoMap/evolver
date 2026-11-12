import { authoring } from '@evomap/evolver-core';
export type JsonCommandCode = 'INPUT_INVALID' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INTERNAL';
export declare class JsonCommandError extends Error {
    readonly code: JsonCommandCode;
    constructor(code: JsonCommandCode, message: string);
}
export declare const SMALL_REQUEST_BYTES: number;
export declare const LARGE_REQUEST_BYTES: number;
export type Request = Record<string, unknown>;
export type Locale = authoring.AuthoringLocale;
export interface JsonCommandIo {
    stdin?: NodeJS.ReadableStream & {
        isTTY?: boolean;
    };
    stdout?: (text: string) => void;
    env?: NodeJS.ProcessEnv;
}
export declare function requestLocale(request: Request, io: JsonCommandIo): Locale;
export declare function inputError(locale: Locale, zh: string, en: string): JsonCommandError;
/** One JSON object on stdin (an interactive terminal counts as `{}`), bounded before it is parsed. */
export declare function readJsonRequest(limit: number, io: JsonCommandIo): Promise<Request>;
/** The versioned envelope every Desktop-facing command shares: one line of JSON, exit 0 when ok and 1 otherwise. */
export declare function runJsonCommand(schema: string, operation: string, io: JsonCommandIo, run: () => Promise<object>): Promise<number>;
export declare function optionalString(request: Request, key: string, locale: Locale, maxChars?: number): string | undefined;
export declare function requiredString(request: Request, key: string, locale: Locale, maxChars?: number): string;
export declare function optionalStrings(request: Request, key: string, locale: Locale, maxItems?: number, maxChars?: number): string[] | undefined;
export declare function optionalEnum<T extends string>(request: Request, key: string, values: readonly T[], locale: Locale): T | undefined;
export declare function requiredEnum<T extends string>(request: Request, key: string, values: readonly T[], locale: Locale): T;
export declare function requiredObject(request: Request, key: string, locale: Locale): Record<string, unknown>;
/** The operation word and that the remaining flags are only `--json`; anything else is an input error. */
export declare function operationOf(argv: readonly string[], operations: readonly string[], io: JsonCommandIo): {
    operation: string;
    error?: JsonCommandError;
};