export interface CredentialTextRange {
    start: number;
    end: number;
}
export interface CredentialTextEdit extends CredentialTextRange {
    replacementLength: number;
}
/** Move completed-scalar ownership through sorted edits whose replacements contain no raw input. */
export declare function remapCredentialTextRanges(ranges: CredentialTextRange[], edits: readonly CredentialTextEdit[]): void;
export declare function readQuotedCredentialValue(input: string, start: number): {
    end: number;
    quote: string;
    raw: string;
} | undefined;
/** Markers are value content; only a framed delimiter can end the value. */
export declare function readUnquotedCredentialValue(input: string, start: number): {
    end: number;
    quote: string;
    raw: string;
} | undefined;
/** Redact inside owned string values, not apostrophes paired across unrelated prose.
 * JSON escapes are decoded one scalar at a time; unchanged scalars keep their original bytes. */
export declare function redactQuotedCredentialText(input: string, redact: (text: string) => string, processed?: CredentialTextRange[]): string;
/** Never consume a following field's key as a partial Bearer token or its '=' as padding. */
export declare function redactBearerCredentials(input: string, replacement: string, credentialFields: ReadonlySet<number>, processed?: readonly CredentialTextRange[]): string;