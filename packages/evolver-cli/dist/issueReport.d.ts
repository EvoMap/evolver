interface IssueReportDeps {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
    now?: () => Date;
}
export declare function runIssueReportCommand(argv: readonly string[], deps?: IssueReportDeps): Promise<number>;
export {};