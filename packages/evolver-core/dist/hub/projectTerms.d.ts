/**
 * What only this project has, judged by where a word comes from rather than by its shape: the files the session
 * changed and the names its diff declared. `npm test`, `JSON.parse` or `node_modules` are not declared by any project,
 * so they never count; `src/billing/invoice.ts` or a new `invoiceTotal` do.
 */
export interface ProjectProvenance {
    readonly paths: readonly string[];
    readonly identifiers: ReadonlySet<string>;
}
export interface PortabilityFindings {
    /** Absolute, home and tool-directory paths, and this project's own paths: none may stay on a portable surface. */
    readonly local: string[];
    /** Names this project's diff declared that the surface repeats. */
    readonly identifiers: string[];
}
export declare const MAX_PROJECT_IDENTIFIERS = 2;
export declare function projectProvenance(input: {
    diff?: unknown;
    editedPaths?: readonly string[];
    root?: unknown;
}): ProjectProvenance;
/**
 * `verbatim` texts (an IR's exact contracts) keep the project's own paths and names, as a command must, but still may not
 * name this machine.
 */
export declare function portabilityFindings(texts: readonly string[], provenance: ProjectProvenance, verbatim?: readonly string[]): PortabilityFindings;