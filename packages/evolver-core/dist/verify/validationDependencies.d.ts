export interface ProvidedDependencies {
    /** Canonical source dependency directories the sandbox must be able to read. */
    readRoots: string[];
    /** Canonical source venv, when explicitly mirrored into the copy. */
    venvRoot?: string;
    /** Remove owned entries; a failed entry stays registered for a later cleanup call. */
    cleanup(): void;
}
export declare function provideValidationDependencies(sourceRoot: string, copyRoot: string): ProvidedDependencies;