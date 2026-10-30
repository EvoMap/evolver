/** Recall tokens: lower-cased Latin words without stopwords (plural `s` folded), Han text as character bigrams. */
export declare function recallTokens(text: string): string[];
/** The prompt without the paths and file names it lists: they name this project's files, not the kind of task. */
export declare function withoutFileNames(text: string): string;
/** A token that names something on its own: Han text, or a Latin word of three or more characters that is not a number. */
export declare function isContentToken(token: string): boolean;
export declare class InverseDocumentFrequency {
    private readonly documentFrequency;
    private readonly documents;
    constructor(documents: readonly ReadonlySet<string>[]);
    weight(token: string): number;
    /** Weight relative to a token no indexed document contains, in (0, 1]. */
    specificity(token: string): number;
}
export declare function cosineSimilarity(left: readonly string[], right: readonly string[], idf: InverseDocumentFrequency): number;
export declare function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number;