import { type EnvFingerprint } from '../bootstrap/envFingerprint.js';
export type IssueReportSource = 'cycle_failure' | 'doctor' | 'review' | 'event';
export type IssueDraftStatus = 'draft' | 'rejected' | 'submitted';
export declare function isIssueReportSource(value: unknown): value is IssueReportSource;
export interface IssueReportInput {
    source: IssueReportSource;
    errorClass: string;
    cycleIds?: readonly string[];
    eventIds?: readonly string[];
    traceIds?: readonly string[];
    reproductionSteps?: readonly string[];
    diagnosticCodes?: readonly string[];
    failureClass?: string;
    version?: string;
    platform?: string;
    arch?: string;
}
export interface IssueDraft {
    schemaVersion: 1;
    fingerprint: string;
    status: IssueDraftStatus;
    createdAt: string;
    updatedAt: string;
    title: string;
    body: string;
    source: IssueReportSource;
    errorClass: string;
    cycleIds: string[];
    eventIds: string[];
    traceRefs: string[];
    github?: {
        issueNumber: number;
        url: string;
    };
}
export interface IssueReporterOptions {
    rootDir: string;
    workspaceScope?: string;
    now?: () => Date;
    env?: Record<string, string | undefined>;
    envFingerprint?: Partial<EnvFingerprint>;
    dedupWindowMs?: number;
    rateLimitWindowMs?: number;
    maxSubmissionsPerWindow?: number;
    logger?: (entry: IssueReporterLogEntry) => void;
}
export interface IssueReporterLogEntry {
    fingerprint: string;
    status: 'draft_created' | 'duplicate' | 'rejected' | 'submitted' | 'submission_failed' | 'rate_limited';
    errorClass?: 'approval_required' | 'rate_limited' | 'transport_error' | 'invalid_response' | 'unsafe_draft' | 'local_finalize_error' | 'quota_persistence_error';
}
export interface GithubIssueTransport {
    listOpenIssues(input: {
        repo: string;
        page: number;
        perPage: number;
    }): Promise<{
        issues: Array<{
            number: number;
            url: string;
            body: string;
            isPullRequest: boolean;
        }>;
        hasNextPage: boolean;
    }>;
    createIssue(input: {
        repo: string;
        title: string;
        body: string;
    }): Promise<{
        number: number;
        url: string;
    }>;
}
export declare class GithubIssueTransportError extends Error {
    readonly outcome: 'not_created' | 'ambiguous';
    constructor(outcome: 'not_created' | 'ambiguous');
}
export interface SubmitIssueOptions {
    repo: string;
    approved: boolean;
    approvalSource?: 'human' | 'operator_policy';
    transport: GithubIssueTransport;
}
export type DraftResult = {
    status: 'created';
    draft: IssueDraft;
} | {
    status: 'duplicate';
    draft: IssueDraft;
};
export type SubmitResult = {
    status: 'submitted';
    draft: IssueDraft;
    errorClass?: 'local_finalize_error' | 'quota_persistence_error';
} | {
    status: 'already_submitted';
    draft: IssueDraft;
} | {
    status: 'approval_required';
    draft: IssueDraft;
} | {
    status: 'rejected';
    draft: IssueDraft;
} | {
    status: 'rate_limited';
    draft: IssueDraft;
    errorClass?: 'issue_report_submission_in_flight' | 'issue_report_submission_ambiguous';
} | {
    status: 'failed';
    draft: IssueDraft;
    errorClass: 'transport_error' | 'invalid_response' | 'unsafe_draft' | 'local_finalize_error';
};
export type IssueDraftConflictErrorClass = 'issue_report_submission_in_flight' | 'issue_report_submission_ambiguous';
export declare class IssueDraftConflictError extends Error {
    readonly errorClass: IssueDraftConflictErrorClass;
    constructor(errorClass: IssueDraftConflictErrorClass);
}
export declare function createIssueDraft(input: IssueReportInput, options: IssueReporterOptions): DraftResult;
export declare function rejectIssueDraft(draft: IssueDraft, options: IssueReporterOptions): IssueDraft;
export declare function submitIssueDraft(draft: IssueDraft, submit: SubmitIssueOptions, options: IssueReporterOptions): Promise<SubmitResult>;
export type IssueDraftLookupResult = {
    status: 'found';
    draft: IssueDraft;
} | {
    status: 'missing' | 'invalid';
};
export declare function lookupIssueDraft(rootDir: string, fingerprint: string): IssueDraftLookupResult;
export declare function loadIssueDraft(rootDir: string, fingerprint: string): IssueDraft | null;
export type IssueSubmissionResolution = {
    outcome: 'not_created' | 'abandoned';
} | {
    outcome: 'submitted';
    issueNumber: number;
    url: string;
    repo: string;
};
export declare function resolveIssueSubmission(fingerprint: string, resolution: IssueSubmissionResolution, options: IssueReporterOptions): IssueDraft;
export interface IssueReportEvent {
    type: string;
    eventId?: string;
    payload?: Record<string, unknown>;
}
export interface IssueReportDoctorCheck {
    name: string;
    status: 'pass' | 'warn' | 'fail';
}
export interface IssueReportReviewRecord {
    assetId: string;
    state: 'quarantined' | 'approved' | 'rejected';
}
export declare function issueReportInputFromCycle(events: readonly IssueReportEvent[], cycleId: string): IssueReportInput | null;
export declare function issueReportInputFromDoctor(checks: readonly IssueReportDoctorCheck[]): IssueReportInput | null;
export declare function issueReportInputFromReview(record: IssueReportReviewRecord): IssueReportInput | null;
export declare function issueReportInputFromEvent(event: IssueReportEvent): IssueReportInput | null;
export declare function createIssueDraftForEventBestEffort(event: IssueReportEvent, options: IssueReporterOptions): DraftResult | null;