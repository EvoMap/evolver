export declare const GITHUB_PR_TIMEOUT_MS = 15000;
export declare const GITHUB_PR_MAX_BUFFER_BYTES: number;
export declare const GITHUB_PR_CACHE_TTL_MS = 45000;
export declare const GITHUB_PR_MAX_ITEMS = 50;
export interface GithubPrCheckCounts {
    total: number;
    passed: number;
    failed: number;
    pending: number;
}
export interface GithubPrDiagnosticRow {
    number: number;
    title: string;
    url: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';
    isDraft: boolean;
    head: string;
    base: string;
    updatedAt: string | null;
    reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'UNKNOWN' | null;
    checks: GithubPrCheckCounts;
}
export interface GithubPrDiagnosticData {
    prs: GithubPrDiagnosticRow[];
    truncated: boolean;
    refreshedAt: string;
}
export type GithubPrDiagnosticsResult = {
    available: true;
    data: GithubPrDiagnosticData;
} | {
    available: false;
    error: 'github_pr_unavailable' | 'github_pr_invalid_response';
};
export interface GithubPrRunnerOptions {
    cwd?: string;
    timeoutMs: number;
    maxBufferBytes: number;
    shell: false;
}
export interface GithubPrRunnerResult {
    code: number;
    stdout: string;
}
export type GithubPrRunner = (command: string, args: readonly string[], options: GithubPrRunnerOptions) => Promise<GithubPrRunnerResult>;
export interface GithubPrDiagnosticsProvider {
    read(): Promise<GithubPrDiagnosticsResult>;
}
export interface GithubPrDiagnosticsProviderOptions {
    cwd?: string;
    runner?: GithubPrRunner;
    now?: () => number;
    ttlMs?: number;
    maxItems?: number;
}
export declare const defaultGithubPrRunner: GithubPrRunner;
export declare function createGithubPrDiagnosticsProvider(options?: GithubPrDiagnosticsProviderOptions): GithubPrDiagnosticsProvider;