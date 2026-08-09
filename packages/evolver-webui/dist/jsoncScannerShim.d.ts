export interface JsoncScanner {
    scan(): number;
    getTokenOffset(): number;
    getTokenLength(): number;
    getTokenValue(): string;
}
export declare const createScanner: (text: string, ignoreTrivia?: boolean) => JsoncScanner;