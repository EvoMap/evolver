import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ensureAssetStoreDirectory, readRegularBuffer, replaceUtf8Durable, } from '../assetstore/assetStoreStorage.js';
import { captureEnvFingerprint } from '../bootstrap/envFingerprint.js';
import { fullLeakCheck, redactString } from '../hub/sanitize.js';
import { acquireLock, LockReleaseError, releaseLock } from '../util/fileLock.js';
const STATE_VERSION = 1;
const DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SUBMISSIONS = 2;
const PENDING_RESOLUTION_GRACE_MS = 5 * 60 * 1000;
const MAX_IDS = 5;
const MAX_REMOTE_RECONCILE_PAGES = 10;
const REMOTE_RECONCILE_PAGE_SIZE = 100;
const MAX_REMOTE_ISSUE_BODY_CHARS = 1_000_000;
const MAX_UNTRUSTED_FIELD_CHARS = 512;
const MAX_SUBMISSION_GUARD_BYTES = 4 * 1024;
const MAX_SUBMISSION_QUOTA_INDEX_BYTES = 256 * 1024;
const MAX_SUBMISSION_QUOTA_ENTRIES = 1_024;
const OPAQUE_REF_RE = /^(cycle|event|trace):[a-f0-9]{16}$/;
const INTERNAL_FINGERPRINT_RE = /^[a-f0-9]{20}$/;
const ATTEMPT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_CLASS_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_STEP_KEYS = new Set(['retry_cycle', 'run_doctor', 'inspect_cycle', 'inspect_event', 'review_local_draft']);
const ISSUE_REPORT_SOURCES = new Set(['cycle_failure', 'doctor', 'review', 'event']);
const CYCLE_FAILURE_CLASSES = new Set([
    'host_no_transcript', 'host_provider_error', 'local_gene_no_blast', 'unclassified',
]);
const ERROR_CLASSES = {
    cycle_failure: new Set(['cycle_failed', 'provider_timeout', 'schema_validation', ...CYCLE_FAILURE_CLASSES]),
    doctor: new Set(['doctor_failed', 'doctor_warning']),
    review: new Set(['review_rejected']),
    event: new Set(['cycle_aborted', 'observer_quarantined', 'observer_dead_letter']),
};
const DIAGNOSTIC_CODES = {
    cycle_failure: new Set(['cycle_failed', 'provider_timeout', 'schema_validation', ...CYCLE_FAILURE_CLASSES]),
    doctor: new Set([
        'env-file', 'config-no-secrets', 'no-proxy-loopback', 'proxy-loopback', 'memory-graph', 'phub-mode', 'phub-url',
        'phub-token', 'phub-subject', 'phub-adapter', 'phub-proxy', 'phub-reuse', 'phub-live-smoke',
    ]),
    review: new Set(['review_rejected']),
    event: new Set(['cycle_aborted', 'observer_quarantined', 'observer_dead_letter']),
};
export function isIssueReportSource(value) {
    return typeof value === 'string' && ISSUE_REPORT_SOURCES.has(value);
}
export class GithubIssueTransportError extends Error {
    outcome;
    constructor(outcome) {
        super(`github_issue_transport_${outcome}`);
        this.name = 'GithubIssueTransportError';
        this.outcome = outcome;
    }
}
export class IssueDraftConflictError extends Error {
    errorClass;
    constructor(errorClass) {
        super(errorClass);
        this.name = 'IssueDraftConflictError';
        this.errorClass = errorClass;
    }
}
function safeToken(value, fallback) {
    if (value && value.length > MAX_UNTRUSTED_FIELD_CHARS)
        return fallback;
    if (!value || redactString(value) !== value || fullLeakCheck(value, {}).found)
        return fallback;
    const normalized = value?.trim().toLowerCase();
    return normalized && SAFE_CLASS_RE.test(normalized) ? normalized : fallback;
}
function safeCode(value, fallback) {
    if (value && value.length > MAX_UNTRUSTED_FIELD_CHARS)
        return fallback;
    if (!value || redactString(value) !== value || fullLeakCheck(value, {}).found)
        return fallback;
    const normalized = value.trim().toLowerCase();
    return SAFE_CODE_RE.test(normalized) ? normalized : fallback;
}
function safeMetadata(value, fallback) {
    if (value && value.length > MAX_UNTRUSTED_FIELD_CHARS)
        return fallback;
    const normalized = value?.trim();
    return normalized
        && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(normalized)
        && redactString(normalized) === normalized
        && !fullLeakCheck(normalized, {}).found
        ? normalized
        : fallback;
}
function opaqueReference(domain, value) {
    if (value.length === 0 || value.length > MAX_UNTRUSTED_FIELD_CHARS)
        return null;
    const digest = createHash('sha256')
        .update(`evolver-issue-reference:v1:${domain}\0`, 'utf8')
        .update(value, 'utf8')
        .digest('hex')
        .slice(0, 16);
    return `${domain}:${digest}`;
}
function safeReferenceIds(domain, values) {
    return [...new Set((values ?? [])
            .filter((value) => typeof value === 'string')
            .map((value) => opaqueReference(domain, value))
            .filter((value) => value !== null))].slice(0, MAX_IDS);
}
function safeSteps(values) {
    return [...new Set((values ?? []).filter((value) => SAFE_STEP_KEYS.has(value)))].slice(0, MAX_IDS);
}
function allowlistedToken(value, allowed, fallback) {
    const token = safeToken(value, '');
    return token && allowed.has(token) ? token : fallback;
}
function isAllowlistedErrorClass(source, value) {
    return isIssueReportSource(source)
        && typeof value === 'string'
        && (value === 'unknown' || ERROR_CLASSES[source].has(value));
}
function safeDiagnosticCodes(source, values) {
    const allowed = DIAGNOSTIC_CODES[source];
    return [...new Set((values ?? [])
            .map((value) => safeCode(value, ''))
            .filter((value) => allowed.has(value)))].sort().slice(0, MAX_IDS);
}
function stableFingerprint(input) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 20);
}
function canonicalPath(path) {
    const absolute = resolve(path);
    try {
        return realpathSync.native(absolute);
    }
    catch {
        return absolute;
    }
}
function canonicalWorkspaceScope(options) {
    const configured = options.env?.['EVOLVER_REPO_ROOT']?.trim();
    if (configured)
        return canonicalPath(configured);
    const start = canonicalPath(options.workspaceScope ?? process.cwd());
    try {
        const root = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (root)
            return canonicalPath(root);
    }
    catch {
        // Non-Git callers are scoped to the canonical current directory.
    }
    return start;
}
function fingerprintMarker(fingerprint) {
    return `<!-- evolver-issue-fingerprint:${fingerprint} -->`;
}
function issueReporterStorageError(cause) {
    const error = new Error('issue_report_storage_error');
    error.cause = cause;
    return error;
}
function atomicWriteJson(rootDir, path, value) {
    try {
        ensureAssetStoreDirectory(rootDir);
        ensureAssetStoreDirectory(dirname(path));
        replaceUtf8Durable(path, `${JSON.stringify(value, null, 2)}\n`);
    }
    catch (error) {
        throw issueReporterStorageError(error);
    }
}
function issueDraftFromDisk(rootDir, expectedFingerprint) {
    let value;
    try {
        ensureAssetStoreDirectory(rootDir);
        ensureAssetStoreDirectory(join(rootDir, 'drafts'));
        const encoded = readRegularBuffer(draftPath(rootDir, expectedFingerprint));
        if (encoded === null)
            return null;
        value = JSON.parse(encoded.toString('utf8'));
    }
    catch {
        throw new TypeError('invalid_issue_draft');
    }
    const draft = canonicalIssueDraft(value, expectedFingerprint);
    if (draft)
        return draft;
    throw new TypeError('invalid_issue_draft');
}
function safeEnvironment(options) {
    const captured = captureEnvFingerprint({ env: options.env ?? {} });
    const supplied = options.envFingerprint ?? {};
    return {
        node_version: safeMetadata(supplied.node_version ?? captured.node_version, 'unknown'),
        platform: safeMetadata(supplied.platform ?? captured.platform, 'unknown'),
        arch: safeMetadata(supplied.arch ?? captured.arch, 'unknown'),
        container: supplied.container ?? captured.container,
    };
}
function renderDraft(input, options, fingerprint, createdAt) {
    const errorClass = allowlistedToken(input.errorClass, ERROR_CLASSES[input.source], 'unknown');
    const failureClass = input.source === 'cycle_failure'
        ? allowlistedToken(input.failureClass, CYCLE_FAILURE_CLASSES, 'unclassified')
        : 'unclassified';
    const cycleIds = safeReferenceIds('cycle', input.cycleIds);
    const eventIds = safeReferenceIds('event', input.eventIds);
    const traceRefs = safeReferenceIds('trace', input.traceIds);
    const steps = safeSteps(input.reproductionSteps);
    const diagnosticCodes = safeDiagnosticCodes(input.source, input.diagnosticCodes);
    const environment = safeEnvironment(options);
    const version = safeMetadata(input.version, 'unknown');
    const title = `[${input.source}] ${errorClass}`;
    const body = [
        '## Summary',
        `- Source: \`${input.source}\``,
        `- Sanitized error class: \`${errorClass}\``,
        `- Failure class: \`${failureClass}\``,
        `- Fingerprint: \`${fingerprint}\``,
        '',
        '## Environment',
        `- Evolver version: \`${version}\``,
        `- Node.js: \`${environment.node_version}\``,
        `- Platform: \`${environment.platform}\` / \`${environment.arch}\``,
        `- Container: \`${environment.container ? 'yes' : 'no'}\``,
        '',
        '## Reproduction',
        ...(steps.length > 0 ? steps.map((step, index) => `${index + 1}. ${step}`) : ['1. review_local_draft']),
        '',
        '## Correlation',
        `- Cycle refs: ${cycleIds.length > 0 ? cycleIds.map((id) => `\`${id}\``).join(', ') : 'none'}`,
        `- Event refs: ${eventIds.length > 0 ? eventIds.map((id) => `\`${id}\``).join(', ') : 'none'}`,
        `- Trace refs: ${traceRefs.length > 0 ? traceRefs.map((id) => `\`${id}\``).join(', ') : 'none'}`,
        '',
        '## Limited diagnostics',
        diagnosticCodes.length > 0 ? diagnosticCodes.map((code) => `- \`${code}\``).join('\n') : '- none',
        '',
        fingerprintMarker(fingerprint),
        '',
        '> This draft intentionally excludes transcripts, prompts, raw errors, filesystem paths, environment values, credentials, and request headers.',
    ].join('\n');
    return {
        schemaVersion: STATE_VERSION,
        fingerprint,
        status: 'draft',
        createdAt,
        updatedAt: createdAt,
        title,
        body,
        source: input.source,
        errorClass,
        cycleIds,
        eventIds,
        traceRefs,
    };
}
function statePath(rootDir) {
    return join(rootDir, 'state.json');
}
function submissionGuardDirectory(rootDir) {
    return join(rootDir, 'submission-guards');
}
function submissionGuardPath(rootDir, fingerprint) {
    if (!INTERNAL_FINGERPRINT_RE.test(fingerprint))
        throw new TypeError('invalid_issue_draft');
    return join(submissionGuardDirectory(rootDir), `${fingerprint}.json`);
}
function submissionQuotaDirectory(rootDir) {
    return join(rootDir, 'submission-quota');
}
function submissionQuotaIndexPath(rootDir) {
    return join(submissionQuotaDirectory(rootDir), 'recent.json');
}
function draftPath(rootDir, fingerprint) {
    if (!INTERNAL_FINGERPRINT_RE.test(fingerprint))
        throw new TypeError('invalid_issue_draft');
    return join(rootDir, 'drafts', `${fingerprint}.json`);
}
function emptyState() {
    return { version: STATE_VERSION, submissions: [], rejections: [], attempts: [], reservations: [] };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function isTimestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function isInternalFingerprint(value) {
    return typeof value === 'string' && INTERNAL_FINGERPRINT_RE.test(value);
}
function isSafeGitHubIssueUrl(value, issueNumber, expectedRepo) {
    if (typeof value !== 'string'
        || value.length > MAX_UNTRUSTED_FIELD_CHARS
        || typeof issueNumber !== 'number'
        || !Number.isInteger(issueNumber)
        || issueNumber <= 0) {
        return false;
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    if (parsed.origin !== 'https://github.com'
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.search !== ''
        || parsed.hash !== '') {
        return false;
    }
    const segments = parsed.pathname.split('/').slice(1);
    if (segments.length !== 4
        || !/^[A-Za-z0-9_.-]+$/.test(segments[0] ?? '')
        || !/^[A-Za-z0-9_.-]+$/.test(segments[1] ?? '')
        || segments[2] !== 'issues'
        || segments[3] !== String(issueNumber)) {
        return false;
    }
    if (segments.slice(0, 2).some((segment) => redactString(segment) !== segment || fullLeakCheck(segment, {}).found)) {
        return false;
    }
    return expectedRepo === undefined
        || `${segments[0]}/${segments[1]}`.toLowerCase() === expectedRepo.toLowerCase();
}
function isSafeGitHubRepo(value, env) {
    if (value.length > MAX_UNTRUSTED_FIELD_CHARS)
        return false;
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
    if (!match)
        return false;
    return match.slice(1).every((segment) => segment !== '.'
        && segment !== '..'
        && redactString(segment) === segment
        && !fullLeakCheck(segment, env).found);
}
function isSafeDraftIdArray(value, domain) {
    return Array.isArray(value)
        && value.length <= MAX_IDS
        && value.every((entry) => typeof entry === 'string'
            && entry.startsWith(`${domain}:`)
            && OPAQUE_REF_RE.test(entry));
}
function canonicalIssueDraft(value, expectedFingerprint) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'schemaVersion', 'fingerprint', 'status', 'createdAt', 'updatedAt', 'title', 'body',
            'source', 'errorClass', 'cycleIds', 'eventIds', 'traceRefs', 'github',
        ])
        || value['schemaVersion'] !== STATE_VERSION
        || !isInternalFingerprint(value['fingerprint'])
        || (expectedFingerprint !== undefined && value['fingerprint'] !== expectedFingerprint)
        || (value['status'] !== 'draft' && value['status'] !== 'rejected' && value['status'] !== 'submitted')
        || !isTimestamp(value['createdAt'])
        || !isTimestamp(value['updatedAt'])
        || typeof value['title'] !== 'string'
        || value['title'].length > 256
        || typeof value['body'] !== 'string'
        || value['body'].length > 16_384
        || !isIssueReportSource(value['source'])
        || !isAllowlistedErrorClass(value['source'], value['errorClass'])
        || value['title'] !== `[${value['source']}] ${value['errorClass']}`
        || !value['body'].includes(fingerprintMarker(value['fingerprint']))
        || Date.parse(value['updatedAt']) < Date.parse(value['createdAt'])
        || !isSafeDraftIdArray(value['cycleIds'], 'cycle')
        || !isSafeDraftIdArray(value['eventIds'], 'event')
        || !isSafeDraftIdArray(value['traceRefs'], 'trace')) {
        return null;
    }
    const draft = {
        schemaVersion: STATE_VERSION,
        fingerprint: value['fingerprint'],
        status: value['status'],
        createdAt: value['createdAt'],
        updatedAt: value['updatedAt'],
        title: value['title'],
        body: value['body'],
        source: value['source'],
        errorClass: value['errorClass'],
        cycleIds: [...value['cycleIds']],
        eventIds: [...value['eventIds']],
        traceRefs: [...value['traceRefs']],
    };
    if (value['status'] === 'submitted') {
        const github = value['github'];
        if (!isRecord(github) || !isSafeGitHubIssueUrl(github['url'], github['issueNumber']))
            return null;
        draft.github = { issueNumber: github['issueNumber'], url: github['url'] };
    }
    else if (value['github'] !== undefined) {
        return null;
    }
    return draft;
}
function requireCanonicalIssueDraft(value) {
    const draft = canonicalIssueDraft(value);
    if (!draft)
        throw new TypeError('invalid_issue_draft');
    return draft;
}
function isSubmissionRecord(value) {
    return isRecord(value)
        && hasOnlyKeys(value, ['fingerprint', 'submittedAt', 'issueNumber', 'url'])
        && isInternalFingerprint(value['fingerprint'])
        && isTimestamp(value['submittedAt'])
        && isSafeGitHubIssueUrl(value['url'], value['issueNumber']);
}
function isRejectionRecord(value) {
    return isRecord(value)
        && hasOnlyKeys(value, ['fingerprint', 'rejectedAt'])
        && isInternalFingerprint(value['fingerprint'])
        && isTimestamp(value['rejectedAt']);
}
function isAttemptRecord(value) {
    return isRecord(value)
        && hasOnlyKeys(value, ['fingerprint', 'attemptedAt'])
        && isInternalFingerprint(value['fingerprint'])
        && isTimestamp(value['attemptedAt']);
}
function isReservationRecord(value) {
    return isRecord(value)
        && hasOnlyKeys(value, ['fingerprint', 'attemptId', 'reservedAt', 'status'])
        && isInternalFingerprint(value['fingerprint'])
        && typeof value['attemptId'] === 'string'
        && ATTEMPT_ID_RE.test(value['attemptId'])
        && isTimestamp(value['reservedAt'])
        && (value['status'] === undefined || value['status'] === 'pending' || value['status'] === 'ambiguous');
}
function isSubmissionGuardRecord(value, expectedFingerprint) {
    return isRecord(value)
        && hasOnlyKeys(value, ['version', 'fingerprint', 'attemptId', 'reservedAt', 'status'])
        && value['version'] === STATE_VERSION
        && value['fingerprint'] === expectedFingerprint
        && isInternalFingerprint(value['fingerprint'])
        && typeof value['attemptId'] === 'string'
        && ATTEMPT_ID_RE.test(value['attemptId'])
        && isTimestamp(value['reservedAt'])
        && (value['status'] === 'preparing'
            || value['status'] === 'cancelled'
            || value['status'] === 'pending'
            || value['status'] === 'ambiguous'
            || value['status'] === 'submitted');
}
function isSubmissionQuotaEntry(value) {
    return isRecord(value)
        && hasOnlyKeys(value, ['fingerprint', 'attemptId', 'countedAt'])
        && isInternalFingerprint(value['fingerprint'])
        && typeof value['attemptId'] === 'string'
        && ATTEMPT_ID_RE.test(value['attemptId'])
        && isTimestamp(value['countedAt']);
}
function isSubmissionQuotaIndex(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['kind', 'version', 'entries'])
        || value['kind'] !== 'issue_report_submission_quota'
        || value['version'] !== STATE_VERSION
        || !Array.isArray(value['entries'])
        || value['entries'].length > MAX_SUBMISSION_QUOTA_ENTRIES
        || !value['entries'].every(isSubmissionQuotaEntry)) {
        return false;
    }
    const fingerprints = new Set();
    for (const entry of value['entries']) {
        if (fingerprints.has(entry.fingerprint))
            return false;
        fingerprints.add(entry.fingerprint);
    }
    return true;
}
function invalidState(cause) {
    const error = new Error('invalid_issue_reporter_state');
    if (cause !== undefined)
        error.cause = cause;
    return error;
}
function readState(rootDir) {
    let raw;
    try {
        ensureAssetStoreDirectory(rootDir);
        const encoded = readRegularBuffer(statePath(rootDir));
        if (encoded === null)
            return emptyState();
        raw = encoded.toString('utf8');
    }
    catch (error) {
        throw invalidState(error);
    }
    let state;
    try {
        state = JSON.parse(raw);
    }
    catch (error) {
        throw invalidState(error);
    }
    if (!isRecord(state)
        || !hasOnlyKeys(state, ['version', 'submissions', 'rejections', 'attempts', 'reservations'])
        || state['version'] !== STATE_VERSION
        || !Array.isArray(state['submissions']) || !state['submissions'].every(isSubmissionRecord)
        || !Array.isArray(state['rejections']) || !state['rejections'].every(isRejectionRecord)
        || !Array.isArray(state['attempts']) || !state['attempts'].every(isAttemptRecord)
        || (state['reservations'] !== undefined
            && (!Array.isArray(state['reservations']) || !state['reservations'].every(isReservationRecord)))) {
        throw invalidState();
    }
    const reservations = (state['reservations'] ?? []);
    return {
        version: STATE_VERSION,
        submissions: state['submissions'],
        rejections: state['rejections'],
        attempts: state['attempts'],
        reservations: reservations.map((record) => ({ ...record, status: record.status ?? 'pending' })),
    };
}
function readSubmissionGuard(rootDir, fingerprint) {
    let encoded;
    try {
        ensureAssetStoreDirectory(submissionGuardDirectory(rootDir));
        encoded = readRegularBuffer(submissionGuardPath(rootDir, fingerprint), MAX_SUBMISSION_GUARD_BYTES);
    }
    catch (error) {
        throw invalidState(error);
    }
    if (encoded === null)
        return null;
    let value;
    try {
        value = JSON.parse(encoded.toString('utf8'));
    }
    catch (error) {
        throw invalidState(error);
    }
    if (!isSubmissionGuardRecord(value, fingerprint))
        throw invalidState();
    return value;
}
function readSubmissionQuotaIndex(rootDir) {
    let encoded;
    try {
        ensureAssetStoreDirectory(submissionQuotaDirectory(rootDir));
        encoded = readRegularBuffer(submissionQuotaIndexPath(rootDir), MAX_SUBMISSION_QUOTA_INDEX_BYTES);
    }
    catch (error) {
        throw invalidState(error);
    }
    if (encoded === null) {
        return { kind: 'issue_report_submission_quota', version: STATE_VERSION, entries: [] };
    }
    let value;
    try {
        value = JSON.parse(encoded.toString('utf8'));
    }
    catch (error) {
        throw invalidState(error);
    }
    if (!isSubmissionQuotaIndex(value))
        throw invalidState();
    return {
        kind: 'issue_report_submission_quota',
        version: STATE_VERSION,
        entries: value.entries.map((entry) => ({ ...entry })),
    };
}
function writeState(rootDir, state) {
    atomicWriteJson(rootDir, statePath(rootDir), state);
}
function writeSubmissionGuard(rootDir, guard) {
    try {
        ensureAssetStoreDirectory(submissionGuardDirectory(rootDir));
        replaceUtf8Durable(submissionGuardPath(rootDir, guard.fingerprint), `${JSON.stringify(guard, null, 2)}\n`);
    }
    catch (error) {
        throw issueReporterStorageError(error);
    }
}
function writeSubmissionQuotaIndex(rootDir, index) {
    if (!isSubmissionQuotaIndex(index))
        throw issueReporterStorageError(new Error('invalid submission quota index'));
    const encoded = `${JSON.stringify(index, null, 2)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_SUBMISSION_QUOTA_INDEX_BYTES) {
        throw issueReporterStorageError(new Error('submission quota index exceeds write limit'));
    }
    try {
        ensureAssetStoreDirectory(submissionQuotaDirectory(rootDir));
        replaceUtf8Durable(submissionQuotaIndexPath(rootDir), encoded);
    }
    catch (error) {
        throw issueReporterStorageError(error);
    }
}
function removeReservationEvidence(state, index, guard) {
    const reservationsBefore = state.reservations.length;
    const attemptsBefore = state.attempts.length;
    const quotaEntriesBefore = index.entries.length;
    state.reservations = state.reservations.filter((record) => !(record.fingerprint === guard.fingerprint
        && record.attemptId === guard.attemptId
        && record.reservedAt === guard.reservedAt));
    state.attempts = state.attempts.filter((record) => !(record.fingerprint === guard.fingerprint
        && record.attemptedAt === guard.reservedAt));
    index.entries = index.entries.filter((entry) => !(entry.fingerprint === guard.fingerprint
        && entry.attemptId === guard.attemptId
        && entry.countedAt === guard.reservedAt));
    return {
        stateChanged: state.reservations.length !== reservationsBefore
            || state.attempts.length !== attemptsBefore,
        quotaChanged: index.entries.length !== quotaEntriesBefore,
    };
}
function recoverPreparingReservation(rootDir, state, index, guard) {
    if (guard?.status !== 'preparing')
        return guard;
    const { stateChanged, quotaChanged } = removeReservationEvidence(state, index, guard);
    if (stateChanged)
        writeState(rootDir, state);
    if (quotaChanged)
        writeSubmissionQuotaIndex(rootDir, index);
    const cancelled = { ...guard, status: 'cancelled' };
    writeSubmissionGuard(rootDir, cancelled);
    return cancelled;
}
function rollbackReservationBestEffort(rootDir, state, index, guard) {
    const preparing = { ...guard, status: 'preparing' };
    try {
        writeSubmissionGuard(rootDir, preparing);
    }
    catch {
        // Continue rolling back the independently persisted state and quota evidence.
    }
    const { stateChanged, quotaChanged } = removeReservationEvidence(state, index, preparing);
    let cleanupSucceeded = true;
    if (stateChanged) {
        try {
            writeState(rootDir, state);
        }
        catch {
            cleanupSucceeded = false;
        }
    }
    if (quotaChanged) {
        try {
            writeSubmissionQuotaIndex(rootDir, index);
        }
        catch {
            cleanupSucceeded = false;
        }
    }
    try {
        writeSubmissionGuard(rootDir, {
            ...preparing,
            status: cleanupSucceeded ? 'cancelled' : 'preparing',
        });
    }
    catch {
        // Preserve the primary preflight failure; clean evidence or a preparing marker remains when possible.
    }
}
function compactSubmissionQuotaIndex(index, nowMs, rateWindow) {
    const active = index.entries.filter((entry) => nowMs - Date.parse(entry.countedAt) < rateWindow);
    if (active.length === index.entries.length)
        return false;
    index.entries = active;
    return true;
}
function upsertSubmissionQuotaEntry(index, entry) {
    const existing = index.entries.find((candidate) => candidate.fingerprint === entry.fingerprint);
    if (existing) {
        existing.attemptId = entry.attemptId;
        existing.countedAt = entry.countedAt;
        return true;
    }
    if (index.entries.length >= MAX_SUBMISSION_QUOTA_ENTRIES)
        return false;
    index.entries.push(entry);
    return true;
}
function withReporterLock(rootDir, operation) {
    const lockPath = join(rootDir, '.issue-reporter.lock');
    try {
        ensureAssetStoreDirectory(rootDir);
        acquireLock(lockPath);
    }
    catch (error) {
        throw issueReporterStorageError(error);
    }
    let operationResult;
    let operationError;
    let operationFailed = false;
    try {
        operationResult = operation();
    }
    catch (error) {
        operationFailed = true;
        operationError = error;
    }
    let released;
    try {
        released = releaseLock(lockPath);
    }
    catch (error) {
        if (operationFailed)
            throw operationError;
        throw issueReporterStorageError(error);
    }
    if (operationFailed)
        throw operationError;
    if (!released.released)
        throw issueReporterStorageError(new LockReleaseError(released.reason));
    return operationResult;
}
function advanceSubmissionQuotaTimestamp(rootDir, fingerprint, attemptId, countedAt, rateWindow) {
    try {
        return withReporterLock(rootDir, () => {
            const index = readSubmissionQuotaIndex(rootDir);
            compactSubmissionQuotaIndex(index, Date.parse(countedAt), rateWindow);
            if (!upsertSubmissionQuotaEntry(index, { fingerprint, attemptId, countedAt }))
                return false;
            writeSubmissionQuotaIndex(rootDir, index);
            return true;
        });
    }
    catch {
        return false;
    }
}
function markReservationAmbiguousInState(state, fingerprint, attemptId, reservedAt) {
    let reservation = state.reservations.find((record) => record.fingerprint === fingerprint && record.attemptId === attemptId);
    reservation ??= state.reservations.find((record) => record.fingerprint === fingerprint);
    if (!reservation) {
        reservation = { fingerprint, attemptId, reservedAt, status: 'ambiguous' };
        state.reservations.push(reservation);
    }
    if (!state.attempts.some((record) => record.fingerprint === fingerprint)) {
        state.attempts.push({ fingerprint, attemptedAt: reservedAt });
    }
    reservation.status = 'ambiguous';
}
function markReservationAmbiguous(rootDir, fingerprint, attemptId, reservedAt) {
    withReporterLock(rootDir, () => {
        const state = readState(rootDir);
        if (latestSubmission(state, fingerprint) || latestRejection(state, fingerprint))
            return;
        markReservationAmbiguousInState(state, fingerprint, attemptId, reservedAt);
        writeState(rootDir, state);
        writeSubmissionGuard(rootDir, {
            version: STATE_VERSION,
            fingerprint,
            attemptId,
            reservedAt,
            status: 'ambiguous',
        });
    });
}
function markReservationAmbiguousBestEffort(rootDir, fingerprint, attemptId, reservedAt) {
    try {
        markReservationAmbiguous(rootDir, fingerprint, attemptId, reservedAt);
    }
    catch {
        try {
            writeSubmissionGuard(rootDir, {
                version: STATE_VERSION,
                fingerprint,
                attemptId,
                reservedAt,
                status: 'ambiguous',
            });
        }
        catch {
            // The pending guard was persisted before transport and remains fail-closed.
        }
    }
}
function cancelConfirmedNotCreatedAttempt(rootDir, fingerprint, attemptId) {
    withReporterLock(rootDir, () => {
        const state = readState(rootDir);
        const index = readSubmissionQuotaIndex(rootDir);
        const reservation = state.reservations.find((record) => record.fingerprint === fingerprint && record.attemptId === attemptId);
        const guard = readSubmissionGuard(rootDir, fingerprint);
        if (!reservation && guard?.attemptId !== attemptId)
            return;
        const reservedAt = reservation?.reservedAt ?? guard.reservedAt;
        writeSubmissionGuard(rootDir, {
            version: STATE_VERSION,
            fingerprint,
            attemptId,
            reservedAt,
            status: 'cancelled',
        });
        state.reservations = state.reservations.filter((record) => !(record.fingerprint === fingerprint && record.attemptId === attemptId));
        state.attempts = state.attempts.filter((record) => !(record.fingerprint === fingerprint && record.attemptedAt === reservedAt));
        index.entries = index.entries.filter((entry) => !(entry.fingerprint === fingerprint && entry.attemptId === attemptId));
        writeState(rootDir, state);
        writeSubmissionQuotaIndex(rootDir, index);
    });
}
function durableOutcome(rootDir, fingerprint) {
    let state;
    try {
        state = readState(rootDir);
    }
    catch {
        // The independently persisted draft or guard can still classify the outcome.
    }
    if (state) {
        if (latestRejection(state, fingerprint))
            return 'rejected';
        if (latestSubmission(state, fingerprint))
            return 'submitted';
    }
    try {
        const draft = issueDraftFromDisk(rootDir, fingerprint);
        if (draft?.status === 'rejected')
            return 'rejected';
        if (draft?.status === 'submitted')
            return 'submitted';
    }
    catch {
        // A strict same-fingerprint guard can still preserve the remote outcome.
    }
    if (state?.reservations.some((record) => (record.fingerprint === fingerprint && record.status === 'ambiguous')))
        return 'submitted';
    try {
        const status = readSubmissionGuard(rootDir, fingerprint)?.status;
        return status === 'ambiguous' || status === 'submitted' ? 'submitted' : 'none';
    }
    catch {
        return 'none';
    }
}
function persistSubmittedDraftFallback(rootDir, draft, attemptId, reservedAt) {
    try {
        return withReporterLock(rootDir, () => {
            let state;
            try {
                state = readState(rootDir);
            }
            catch {
                // A validated remote receipt remains the only durable fallback when the state ledger is unavailable.
            }
            if (state && latestRejection(state, draft.fingerprint))
                return 'rejected';
            const hasSubmission = state ? latestSubmission(state, draft.fingerprint) !== undefined : false;
            let persistedDraft = null;
            try {
                persistedDraft = issueDraftFromDisk(rootDir, draft.fingerprint);
            }
            catch {
                // A validated receipt may safely replace a corrupt regular draft through the no-follow writer.
            }
            if (persistedDraft?.status === 'rejected')
                return 'rejected';
            writeSubmissionGuard(rootDir, {
                version: STATE_VERSION,
                fingerprint: draft.fingerprint,
                attemptId,
                reservedAt,
                status: 'submitted',
            });
            if (state && !hasSubmission) {
                markReservationAmbiguousInState(state, draft.fingerprint, attemptId, reservedAt);
                try {
                    writeState(rootDir, state);
                }
                catch {
                    // The terminal guard already preserves the validated remote outcome.
                }
            }
            if (persistedDraft?.status !== 'submitted') {
                try {
                    persistDraft(rootDir, draft);
                }
                catch {
                    // The terminal guard preserves the validated remote outcome across draft repair failure.
                }
            }
            return 'submitted';
        });
    }
    catch {
        return 'none';
    }
}
function log(options, entry) {
    try {
        options.logger?.(entry);
    }
    catch {
        // Reporter state and remote outcomes must not depend on telemetry availability.
    }
}
function safeIsoNow(now) {
    try {
        const value = (now ?? (() => new Date()))();
        if (Number.isFinite(value.getTime()))
            return value.toISOString();
    }
    catch {
        // Fall through to the system clock after an injected clock failure.
    }
    return new Date().toISOString();
}
function pendingSubmissionIsLive(reservedAt, nowMs) {
    const reservedAtMs = Date.parse(reservedAt);
    return !Number.isFinite(reservedAtMs)
        || nowMs - reservedAtMs < PENDING_RESOLUTION_GRACE_MS;
}
function latestSubmission(state, fingerprint) {
    for (let index = state.submissions.length - 1; index >= 0; index -= 1) {
        const record = state.submissions[index];
        if (record?.fingerprint === fingerprint)
            return record;
    }
    return undefined;
}
function latestRejection(state, fingerprint) {
    for (let index = state.rejections.length - 1; index >= 0; index -= 1) {
        const record = state.rejections[index];
        if (record?.fingerprint === fingerprint)
            return record;
    }
    return undefined;
}
function issueDraftConflict(state, fingerprint, guard, quotaEntry) {
    if (latestSubmission(state, fingerprint) || latestRejection(state, fingerprint))
        return undefined;
    const reservation = state.reservations.find((record) => record.fingerprint === fingerprint);
    if (reservation?.status === 'ambiguous'
        || guard?.status === 'ambiguous'
        || guard?.status === 'submitted') {
        return 'issue_report_submission_ambiguous';
    }
    if (reservation || guard?.status === 'pending')
        return 'issue_report_submission_in_flight';
    return state.attempts.some((record) => record.fingerprint === fingerprint) || quotaEntry !== undefined
        ? 'issue_report_submission_ambiguous'
        : undefined;
}
function terminalDraftFromState(draft, state) {
    const submission = latestSubmission(state, draft.fingerprint);
    if (submission) {
        return {
            ...draft,
            status: 'submitted',
            github: { issueNumber: submission.issueNumber, url: submission.url },
        };
    }
    const rejection = latestRejection(state, draft.fingerprint);
    if (rejection) {
        const { github: _github, ...base } = draft;
        return { ...base, status: 'rejected' };
    }
    return undefined;
}
function persistDraft(rootDir, draft) {
    atomicWriteJson(rootDir, draftPath(rootDir, draft.fingerprint), draft);
}
function submittedResult(draft, alreadySubmitted) {
    return { status: alreadySubmitted ? 'already_submitted' : 'submitted', draft };
}
async function reconcileOpenRemoteIssue(transport, repo, fingerprint) {
    const marker = fingerprintMarker(fingerprint);
    for (let page = 1; page <= MAX_REMOTE_RECONCILE_PAGES; page += 1) {
        const result = await transport.listOpenIssues({
            repo,
            page,
            perPage: REMOTE_RECONCILE_PAGE_SIZE,
        });
        if (!isRecord(result)
            || !Array.isArray(result['issues'])
            || typeof result['hasNextPage'] !== 'boolean') {
            throw new GithubIssueTransportError('not_created');
        }
        for (const candidate of result['issues']) {
            if (!isRecord(candidate)
                || typeof candidate['isPullRequest'] !== 'boolean'
                || typeof candidate['body'] !== 'string'
                || candidate['body'].length > MAX_REMOTE_ISSUE_BODY_CHARS) {
                throw new GithubIssueTransportError('not_created');
            }
            if (candidate['isPullRequest'] || !candidate['body'].includes(marker))
                continue;
            if (!isSafeGitHubIssueUrl(candidate['url'], candidate['number'], repo)) {
                throw new GithubIssueTransportError('not_created');
            }
            return { issueNumber: candidate['number'], url: candidate['url'] };
        }
        if (!result['hasNextPage'])
            return null;
    }
    throw new GithubIssueTransportError('not_created');
}
function persistReconciledRemoteIssue(draft, receipt, options) {
    return withReporterLock(options.rootDir, () => {
        const current = issueDraftFromDisk(options.rootDir, draft.fingerprint) ?? draft;
        const state = readState(options.rootDir);
        const terminal = terminalDraftFromState(current, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return terminal;
        }
        if (current.status !== 'draft')
            return current;
        const submittedAt = safeIsoNow(options.now);
        const submitted = {
            ...current,
            status: 'submitted',
            updatedAt: submittedAt,
            github: { issueNumber: receipt.issueNumber, url: receipt.url },
        };
        const guard = readSubmissionGuard(options.rootDir, draft.fingerprint);
        writeSubmissionGuard(options.rootDir, {
            version: STATE_VERSION,
            fingerprint: draft.fingerprint,
            attemptId: guard?.attemptId ?? randomUUID(),
            reservedAt: guard?.reservedAt ?? submittedAt,
            status: 'submitted',
        });
        state.submissions.push({
            fingerprint: draft.fingerprint,
            submittedAt,
            issueNumber: receipt.issueNumber,
            url: receipt.url,
        });
        state.reservations = state.reservations.filter((record) => record.fingerprint !== draft.fingerprint);
        writeState(options.rootDir, state);
        persistDraft(options.rootDir, submitted);
        return submitted;
    });
}
function validateDraftSafety(draft, env) {
    const content = [
        draft.title,
        draft.body,
        draft.source,
        draft.errorClass,
        ...draft.cycleIds,
        ...draft.eventIds,
        ...draft.traceRefs,
    ].join('\n');
    if (content.includes('/Users/') || content.includes('/home/') || /[A-Za-z]:\\Users\\/.test(content))
        return false;
    if (/authorization|cookie|transcript|full prompt|environment variable value/i.test(draft.title))
        return false;
    return !fullLeakCheck(content, env).found && redactString(content) === content;
}
export function createIssueDraft(input, options) {
    if (!isIssueReportSource(input.source))
        throw new TypeError('invalid issue report source');
    const errorClass = allowlistedToken(input.errorClass, ERROR_CLASSES[input.source], 'unknown');
    const failureClass = input.source === 'cycle_failure'
        ? allowlistedToken(input.failureClass, CYCLE_FAILURE_CLASSES, 'unclassified')
        : 'unclassified';
    const diagnosticCodes = safeDiagnosticCodes(input.source, input.diagnosticCodes);
    const workspaceScope = createHash('sha256').update(canonicalWorkspaceScope(options)).digest('hex').slice(0, 16);
    const fingerprint = stableFingerprint({ source: input.source, errorClass, failureClass, diagnosticCodes, workspaceScope });
    const now = (options.now ?? (() => new Date()))();
    const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    const draft = renderDraft(input, options, fingerprint, now.toISOString());
    if (!validateDraftSafety(draft, options.env ?? {}))
        throw new TypeError('unsafe_issue_draft');
    const result = withReporterLock(options.rootDir, () => {
        const state = readState(options.rootDir);
        const existing = issueDraftFromDisk(options.rootDir, fingerprint);
        if (existing && !validateDraftSafety(existing, options.env ?? {}))
            throw new TypeError('unsafe_issue_draft');
        const terminal = terminalDraftFromState(existing ?? draft, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return { status: 'duplicate', draft: terminal };
        }
        if (existing && existing.status !== 'draft')
            return { status: 'duplicate', draft: existing };
        const rateWindow = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
        const quotaIndex = readSubmissionQuotaIndex(options.rootDir);
        const guard = recoverPreparingReservation(options.rootDir, state, quotaIndex, readSubmissionGuard(options.rootDir, fingerprint));
        if (compactSubmissionQuotaIndex(quotaIndex, now.getTime(), rateWindow)) {
            writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
        }
        const conflict = issueDraftConflict(state, fingerprint, guard, quotaIndex.entries.find((entry) => entry.fingerprint === fingerprint));
        if (conflict) {
            if (!existing)
                persistDraft(options.rootDir, draft);
            return { status: 'duplicate', draft: existing ?? draft };
        }
        if (existing && now.getTime() - Date.parse(existing.createdAt) < dedupWindowMs) {
            return { status: 'duplicate', draft: existing };
        }
        persistDraft(options.rootDir, draft);
        return { status: 'created', draft };
    });
    log(options, { fingerprint, status: result.status === 'created' ? 'draft_created' : 'duplicate' });
    return result;
}
export function rejectIssueDraft(draft, options) {
    const inputDraft = requireCanonicalIssueDraft(draft);
    if (!validateDraftSafety(inputDraft, options.env ?? {}))
        throw new TypeError('unsafe_issue_draft');
    const nowDate = (options.now ?? (() => new Date()))();
    const now = nowDate.toISOString();
    const rejected = withReporterLock(options.rootDir, () => {
        const current = issueDraftFromDisk(options.rootDir, inputDraft.fingerprint) ?? inputDraft;
        if (!validateDraftSafety(current, options.env ?? {}))
            throw new TypeError('unsafe_issue_draft');
        const state = readState(options.rootDir);
        const terminal = terminalDraftFromState(current, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return terminal;
        }
        if (current.status !== 'draft')
            return current;
        const quotaIndex = readSubmissionQuotaIndex(options.rootDir);
        const guard = recoverPreparingReservation(options.rootDir, state, quotaIndex, readSubmissionGuard(options.rootDir, current.fingerprint));
        if (compactSubmissionQuotaIndex(quotaIndex, nowDate.getTime(), options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS)) {
            writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
        }
        const conflict = issueDraftConflict(state, current.fingerprint, guard, quotaIndex.entries.find((entry) => entry.fingerprint === current.fingerprint));
        if (conflict)
            throw new IssueDraftConflictError(conflict);
        const result = { ...current, status: 'rejected', updatedAt: now };
        state.rejections.push({ fingerprint: current.fingerprint, rejectedAt: now });
        writeState(options.rootDir, state);
        persistDraft(options.rootDir, result);
        return result;
    });
    log(options, {
        fingerprint: inputDraft.fingerprint,
        status: rejected.status === 'submitted' ? 'submitted'
            : rejected.status === 'rejected' ? 'rejected' : 'submission_failed',
    });
    return rejected;
}
export async function submitIssueDraft(draft, submit, options) {
    const inputDraft = requireCanonicalIssueDraft(draft);
    const rateWindow = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const reconciliationCandidate = withReporterLock(options.rootDir, () => {
        const current = issueDraftFromDisk(options.rootDir, inputDraft.fingerprint) ?? inputDraft;
        const state = readState(options.rootDir);
        if (!validateDraftSafety(current, options.env ?? {})) {
            return { kind: 'result', result: { status: 'failed', draft: current, errorClass: 'unsafe_draft' } };
        }
        const terminal = terminalDraftFromState(current, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return {
                kind: 'result',
                result: terminal.status === 'submitted'
                    ? submittedResult(terminal, true)
                    : { status: 'rejected', draft: terminal },
            };
        }
        if (current.status === 'submitted')
            return { kind: 'result', result: submittedResult(current, true) };
        if (current.status === 'rejected')
            return { kind: 'result', result: { status: 'rejected', draft: current } };
        if (!submit.approved || (submit.approvalSource !== 'human' && submit.approvalSource !== 'operator_policy')) {
            return { kind: 'result', result: { status: 'approval_required', draft: current } };
        }
        if (!isSafeGitHubRepo(submit.repo, options.env ?? {})) {
            return { kind: 'result', result: { status: 'failed', draft: current, errorClass: 'invalid_response' } };
        }
        return { kind: 'candidate', draft: current };
    });
    if (reconciliationCandidate.kind === 'result') {
        return reconciliationCandidate.result;
    }
    let remoteReceipt;
    try {
        remoteReceipt = await reconcileOpenRemoteIssue(submit.transport, submit.repo, reconciliationCandidate.draft.fingerprint);
    }
    catch {
        log(options, {
            fingerprint: reconciliationCandidate.draft.fingerprint,
            status: 'submission_failed',
            errorClass: 'transport_error',
        });
        return {
            status: 'failed',
            draft: reconciliationCandidate.draft,
            errorClass: 'transport_error',
        };
    }
    if (remoteReceipt) {
        const reconciled = persistReconciledRemoteIssue(reconciliationCandidate.draft, remoteReceipt, options);
        if (reconciled.status === 'rejected') {
            log(options, { fingerprint: reconciled.fingerprint, status: 'rejected' });
            return { status: 'rejected', draft: reconciled };
        }
        log(options, { fingerprint: reconciled.fingerprint, status: 'submitted' });
        return submittedResult(reconciled, true);
    }
    const prepared = withReporterLock(options.rootDir, () => {
        const current = issueDraftFromDisk(options.rootDir, inputDraft.fingerprint) ?? inputDraft;
        const state = readState(options.rootDir);
        if (!validateDraftSafety(current, options.env ?? {})) {
            return {
                kind: 'result',
                result: { status: 'failed', draft: current, errorClass: 'unsafe_draft' },
            };
        }
        const terminal = terminalDraftFromState(current, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return {
                kind: 'result',
                result: terminal.status === 'submitted'
                    ? submittedResult(terminal, true)
                    : { status: 'rejected', draft: terminal },
            };
        }
        if (current.status === 'submitted') {
            return { kind: 'result', result: submittedResult(current, true) };
        }
        if (current.status === 'rejected') {
            return { kind: 'result', result: { status: 'rejected', draft: current } };
        }
        if (!submit.approved || (submit.approvalSource !== 'human' && submit.approvalSource !== 'operator_policy')) {
            return { kind: 'result', result: { status: 'approval_required', draft: current } };
        }
        if (!isSafeGitHubRepo(submit.repo, options.env ?? {})) {
            return {
                kind: 'result',
                result: { status: 'failed', draft: current, errorClass: 'invalid_response' },
            };
        }
        const now = (options.now ?? (() => new Date()))();
        const quotaIndex = readSubmissionQuotaIndex(options.rootDir);
        const guard = recoverPreparingReservation(options.rootDir, state, quotaIndex, readSubmissionGuard(options.rootDir, current.fingerprint));
        const quotaCompacted = compactSubmissionQuotaIndex(quotaIndex, now.getTime(), rateWindow);
        const conflict = issueDraftConflict(state, current.fingerprint, guard, quotaIndex.entries.find((entry) => entry.fingerprint === current.fingerprint));
        if (conflict) {
            if (quotaCompacted)
                writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
            return {
                kind: 'result',
                result: {
                    status: 'rate_limited',
                    draft: current,
                    errorClass: conflict,
                },
            };
        }
        const quotaFingerprints = new Set();
        for (const record of state.submissions) {
            if (now.getTime() - Date.parse(record.submittedAt) < rateWindow) {
                quotaFingerprints.add(record.fingerprint);
            }
        }
        for (const record of state.attempts) {
            if (now.getTime() - Date.parse(record.attemptedAt) < rateWindow) {
                quotaFingerprints.add(record.fingerprint);
            }
        }
        for (const record of state.reservations) {
            if (now.getTime() - Date.parse(record.reservedAt) < rateWindow) {
                quotaFingerprints.add(record.fingerprint);
            }
        }
        for (const entry of quotaIndex.entries)
            quotaFingerprints.add(entry.fingerprint);
        const maxSubmissions = Math.min(options.maxSubmissionsPerWindow ?? DEFAULT_MAX_SUBMISSIONS, MAX_SUBMISSION_QUOTA_ENTRIES);
        if (quotaFingerprints.size >= maxSubmissions) {
            if (quotaCompacted)
                writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
            return { kind: 'result', result: { status: 'rate_limited', draft: current } };
        }
        const attemptedAt = now.toISOString();
        const attemptId = randomUUID();
        if (!upsertSubmissionQuotaEntry(quotaIndex, {
            fingerprint: current.fingerprint,
            attemptId,
            countedAt: attemptedAt,
        })) {
            if (quotaCompacted)
                writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
            return { kind: 'result', result: { status: 'rate_limited', draft: current } };
        }
        // Transport is allowed only after this marker advances from recoverable preparation to pending.
        const guardRecord = {
            version: STATE_VERSION,
            fingerprint: current.fingerprint,
            attemptId,
            reservedAt: attemptedAt,
            status: 'preparing',
        };
        try {
            writeSubmissionGuard(options.rootDir, guardRecord);
            state.attempts.push({ fingerprint: current.fingerprint, attemptedAt });
            state.reservations.push({
                fingerprint: current.fingerprint,
                attemptId,
                reservedAt: attemptedAt,
                status: 'pending',
            });
            writeState(options.rootDir, state);
            writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
            writeSubmissionGuard(options.rootDir, { ...guardRecord, status: 'pending' });
        }
        catch (error) {
            rollbackReservationBestEffort(options.rootDir, state, quotaIndex, guardRecord);
            throw error;
        }
        return { kind: 'reserved', attemptId, reservedAt: attemptedAt, draft: current };
    });
    if (prepared.kind === 'result') {
        const status = prepared.result.status === 'failed' || prepared.result.status === 'approval_required'
            ? 'submission_failed'
            : prepared.result.status === 'already_submitted' ? 'submitted' : prepared.result.status;
        log(options, {
            fingerprint: draft.fingerprint,
            status,
            ...(prepared.result.status === 'failed' ? { errorClass: prepared.result.errorClass } : {}),
        });
        return prepared.result;
    }
    let result;
    try {
        result = await submit.transport.createIssue({
            repo: submit.repo,
            title: prepared.draft.title,
            body: prepared.draft.body,
        });
    }
    catch (error) {
        if (error instanceof GithubIssueTransportError && error.outcome === 'not_created') {
            try {
                cancelConfirmedNotCreatedAttempt(options.rootDir, prepared.draft.fingerprint, prepared.attemptId);
            }
            catch {
                markReservationAmbiguousBestEffort(options.rootDir, prepared.draft.fingerprint, prepared.attemptId, prepared.reservedAt);
            }
            log(options, { fingerprint: draft.fingerprint, status: 'submission_failed', errorClass: 'transport_error' });
            return { status: 'failed', draft: prepared.draft, errorClass: 'transport_error' };
        }
        markReservationAmbiguousBestEffort(options.rootDir, prepared.draft.fingerprint, prepared.attemptId, prepared.reservedAt);
        log(options, { fingerprint: draft.fingerprint, status: 'submission_failed', errorClass: 'transport_error' });
        return { status: 'failed', draft: prepared.draft, errorClass: 'transport_error' };
    }
    if (!isSafeGitHubIssueUrl(result.url, result.number, submit.repo)) {
        markReservationAmbiguousBestEffort(options.rootDir, prepared.draft.fingerprint, prepared.attemptId, prepared.reservedAt);
        log(options, { fingerprint: draft.fingerprint, status: 'submission_failed', errorClass: 'invalid_response' });
        return { status: 'failed', draft: prepared.draft, errorClass: 'invalid_response' };
    }
    const submittedAt = safeIsoNow(options.now);
    const quotaTimestampPersisted = advanceSubmissionQuotaTimestamp(options.rootDir, prepared.draft.fingerprint, prepared.attemptId, submittedAt, rateWindow);
    let finalized;
    let remoteOutcomePersisted = false;
    try {
        finalized = withReporterLock(options.rootDir, () => {
            const state = readState(options.rootDir);
            const priorRejection = latestRejection(state, prepared.draft.fingerprint);
            if (priorRejection) {
                persistDraft(options.rootDir, {
                    ...prepared.draft,
                    status: 'rejected',
                    updatedAt: priorRejection.rejectedAt,
                });
                const submittedGuard = {
                    version: STATE_VERSION,
                    fingerprint: prepared.draft.fingerprint,
                    attemptId: prepared.attemptId,
                    reservedAt: prepared.reservedAt,
                    status: 'submitted',
                };
                writeSubmissionGuard(options.rootDir, submittedGuard);
                state.reservations = state.reservations.filter((record) => !(record.fingerprint === prepared.draft.fingerprint
                    && record.attemptId === prepared.attemptId
                    && record.reservedAt === prepared.reservedAt));
                writeState(options.rootDir, state);
                throw new Error('issue_report_rejected_before_finalize');
            }
            const priorSubmission = latestSubmission(state, prepared.draft.fingerprint);
            if (priorSubmission) {
                const terminal = terminalDraftFromState(prepared.draft, state);
                writeSubmissionGuard(options.rootDir, {
                    version: STATE_VERSION,
                    fingerprint: prepared.draft.fingerprint,
                    attemptId: prepared.attemptId,
                    reservedAt: prepared.reservedAt,
                    status: 'submitted',
                });
                remoteOutcomePersisted = true;
                persistDraft(options.rootDir, terminal);
                return submittedResult(terminal, true);
            }
            const reservation = state.reservations.find((record) => record.fingerprint === prepared.draft.fingerprint
                && record.attemptId === prepared.attemptId);
            if (!reservation)
                throw new Error('issue_report_reservation_lost_after_submit');
            const current = prepared.draft;
            const saved = {
                ...current,
                status: 'submitted',
                updatedAt: submittedAt,
                github: { issueNumber: result.number, url: result.url },
            };
            writeSubmissionGuard(options.rootDir, {
                version: STATE_VERSION,
                fingerprint: prepared.draft.fingerprint,
                attemptId: prepared.attemptId,
                reservedAt: prepared.reservedAt,
                status: 'submitted',
            });
            remoteOutcomePersisted = true;
            state.submissions.push({
                fingerprint: saved.fingerprint,
                submittedAt,
                issueNumber: result.number,
                url: result.url,
            });
            state.reservations = state.reservations.filter((record) => !(record.fingerprint === prepared.draft.fingerprint
                && record.attemptId === prepared.attemptId
                && record.reservedAt === prepared.reservedAt));
            writeState(options.rootDir, state);
            persistDraft(options.rootDir, saved);
            return submittedResult(saved, false);
        });
    }
    catch {
        const submittedDraft = {
            ...prepared.draft,
            status: 'submitted',
            updatedAt: submittedAt,
            github: { issueNumber: result.number, url: result.url },
        };
        let outcome = remoteOutcomePersisted
            ? 'submitted'
            : durableOutcome(options.rootDir, prepared.draft.fingerprint);
        if (outcome === 'none') {
            outcome = persistSubmittedDraftFallback(options.rootDir, submittedDraft, prepared.attemptId, prepared.reservedAt);
        }
        if (outcome === 'none') {
            markReservationAmbiguousBestEffort(options.rootDir, prepared.draft.fingerprint, prepared.attemptId, prepared.reservedAt);
            outcome = durableOutcome(options.rootDir, prepared.draft.fingerprint);
        }
        if (outcome !== 'submitted') {
            log(options, {
                fingerprint: prepared.draft.fingerprint,
                status: 'submission_failed',
                errorClass: 'local_finalize_error',
            });
            return {
                status: 'failed',
                draft: prepared.draft,
                errorClass: 'local_finalize_error',
            };
        }
        const fallback = {
            status: 'submitted',
            draft: submittedDraft,
            errorClass: 'local_finalize_error',
        };
        log(options, {
            fingerprint: submittedDraft.fingerprint,
            status: 'submitted',
            errorClass: 'local_finalize_error',
        });
        return fallback;
    }
    if (!quotaTimestampPersisted) {
        const degraded = {
            status: 'submitted',
            draft: finalized.draft,
            errorClass: 'quota_persistence_error',
        };
        log(options, {
            fingerprint: prepared.draft.fingerprint,
            status: 'submitted',
            errorClass: 'quota_persistence_error',
        });
        return degraded;
    }
    log(options, { fingerprint: prepared.draft.fingerprint, status: 'submitted' });
    return finalized;
}
export function lookupIssueDraft(rootDir, fingerprint) {
    if (!INTERNAL_FINGERPRINT_RE.test(fingerprint))
        return { status: 'invalid' };
    try {
        const draft = issueDraftFromDisk(rootDir, fingerprint);
        return draft ? { status: 'found', draft } : { status: 'missing' };
    }
    catch {
        return { status: 'invalid' };
    }
}
export function loadIssueDraft(rootDir, fingerprint) {
    const result = lookupIssueDraft(rootDir, fingerprint);
    return result.status === 'found' ? result.draft : null;
}
export function resolveIssueSubmission(fingerprint, resolution, options) {
    if (!INTERNAL_FINGERPRINT_RE.test(fingerprint))
        throw new TypeError('invalid_issue_draft');
    if (resolution.outcome === 'submitted'
        && (!isSafeGitHubRepo(resolution.repo, options.env ?? {})
            || !isSafeGitHubIssueUrl(resolution.url, resolution.issueNumber, resolution.repo))) {
        throw new TypeError('invalid_issue_resolution');
    }
    return withReporterLock(options.rootDir, () => {
        const draft = issueDraftFromDisk(options.rootDir, fingerprint);
        if (!draft)
            throw new TypeError('invalid_issue_draft');
        const state = readState(options.rootDir);
        const terminal = terminalDraftFromState(draft, state);
        if (terminal) {
            persistDraft(options.rootDir, terminal);
            return terminal;
        }
        if (draft.status !== 'draft')
            return draft;
        const quotaIndex = readSubmissionQuotaIndex(options.rootDir);
        const storedGuard = readSubmissionGuard(options.rootDir, fingerprint);
        const guard = recoverPreparingReservation(options.rootDir, state, quotaIndex, storedGuard);
        const reservations = state.reservations.filter((record) => record.fingerprint === fingerprint);
        const timestamp = safeIsoNow(options.now);
        const nowMs = Date.parse(timestamp);
        if ((guard?.status === 'pending' && pendingSubmissionIsLive(guard.reservedAt, nowMs))
            || reservations.some((record) => (record.status === 'pending' && pendingSubmissionIsLive(record.reservedAt, nowMs)))) {
            throw new IssueDraftConflictError('issue_report_submission_in_flight');
        }
        if (guard?.status === 'submitted' && resolution.outcome !== 'submitted') {
            throw new IssueDraftConflictError('issue_report_submission_ambiguous');
        }
        const reservation = reservations.filter((record) => record.status === 'ambiguous' || record.status === 'pending').at(-1);
        const quotaEntry = quotaIndex.entries.filter((entry) => entry.fingerprint === fingerprint).at(-1);
        const attempt = state.attempts.filter((record) => record.fingerprint === fingerprint).at(-1);
        const guardEvidence = guard?.status === 'ambiguous'
            || (guard?.status === 'submitted' && resolution.outcome === 'submitted')
            || guard?.status === 'pending'
            ? guard
            : storedGuard?.status === 'preparing' ? storedGuard : undefined;
        if (!guardEvidence && !reservation && !quotaEntry && !attempt) {
            throw new IssueDraftConflictError('issue_report_submission_ambiguous');
        }
        const attemptId = guardEvidence?.attemptId
            ?? reservation?.attemptId
            ?? quotaEntry?.attemptId
            ?? randomUUID();
        const reservedAt = guardEvidence?.reservedAt
            ?? reservation?.reservedAt
            ?? quotaEntry?.countedAt
            ?? attempt.attemptedAt;
        if (resolution.outcome === 'submitted') {
            const submitted = {
                ...draft,
                status: 'submitted',
                updatedAt: timestamp,
                github: { issueNumber: resolution.issueNumber, url: resolution.url },
            };
            writeSubmissionGuard(options.rootDir, {
                version: STATE_VERSION,
                fingerprint,
                attemptId,
                reservedAt,
                status: 'submitted',
            });
            state.submissions.push({
                fingerprint,
                submittedAt: timestamp,
                issueNumber: resolution.issueNumber,
                url: resolution.url,
            });
            state.reservations = state.reservations.filter((record) => record.fingerprint !== fingerprint);
            writeState(options.rootDir, state);
            persistDraft(options.rootDir, submitted);
            return submitted;
        }
        writeSubmissionGuard(options.rootDir, {
            version: STATE_VERSION,
            fingerprint,
            attemptId,
            reservedAt,
            status: 'cancelled',
        });
        state.reservations = state.reservations.filter((record) => record.fingerprint !== fingerprint);
        state.attempts = state.attempts.filter((record) => !(record.fingerprint === fingerprint
            && (reservations.some((reservation) => reservation.reservedAt === record.attemptedAt)
                || record.attemptedAt === reservedAt)));
        quotaIndex.entries = quotaIndex.entries.filter((entry) => entry.fingerprint !== fingerprint);
        if (resolution.outcome === 'abandoned') {
            const rejected = { ...draft, status: 'rejected', updatedAt: timestamp };
            state.rejections.push({ fingerprint, rejectedAt: timestamp });
            writeState(options.rootDir, state);
            writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
            persistDraft(options.rootDir, rejected);
            return rejected;
        }
        writeState(options.rootDir, state);
        writeSubmissionQuotaIndex(options.rootDir, quotaIndex);
        persistDraft(options.rootDir, draft);
        return draft;
    });
}
function structuredTraceIds(payload) {
    if (!payload)
        return [];
    return [payload['traceId'], payload['trace_id']]
        .filter((value) => typeof value === 'string' && value.length > 0);
}
export function issueReportInputFromCycle(events, cycleId) {
    if (cycleId.length === 0 || cycleId.length > MAX_UNTRUSTED_FIELD_CHARS)
        return null;
    const related = events.filter((event) => event.payload?.['cycleId'] === cycleId);
    const terminal = [...related].reverse().find((event) => event.type === 'cycle.failed');
    if (!terminal)
        return null;
    const failureClass = allowlistedToken(typeof terminal.payload?.['failure_class'] === 'string' ? terminal.payload['failure_class'] : undefined, CYCLE_FAILURE_CLASSES, 'unclassified');
    return {
        source: 'cycle_failure',
        errorClass: failureClass === 'unclassified' ? 'cycle_failed' : failureClass,
        failureClass,
        cycleIds: [cycleId],
        eventIds: related.map((event) => event.eventId).filter((id) => typeof id === 'string'),
        traceIds: related.flatMap((event) => structuredTraceIds(event.payload)),
        reproductionSteps: ['inspect_cycle', 'run_doctor', 'retry_cycle'],
        diagnosticCodes: ['cycle_failed', failureClass],
    };
}
export function issueReportInputFromDoctor(checks) {
    const failing = checks.filter((check) => check.status !== 'pass')
        .map((check) => safeCode(check.name, ''))
        .filter((code) => DIAGNOSTIC_CODES.doctor.has(code));
    if (failing.length === 0)
        return null;
    return {
        source: 'doctor',
        errorClass: checks.some((check) => check.status === 'fail') ? 'doctor_failed' : 'doctor_warning',
        reproductionSteps: ['run_doctor', 'review_local_draft'],
        diagnosticCodes: failing,
    };
}
export function issueReportInputFromReview(record) {
    if (!record.assetId || record.assetId.length > MAX_UNTRUSTED_FIELD_CHARS || record.state !== 'rejected')
        return null;
    return {
        source: 'review',
        errorClass: 'review_rejected',
        reproductionSteps: ['review_local_draft'],
        diagnosticCodes: ['review_rejected'],
        eventIds: [record.assetId],
    };
}
export function issueReportInputFromEvent(event) {
    const mapping = {
        'cycle.aborted': 'cycle_aborted',
        'observer.quarantined': 'observer_quarantined',
        'observer.dead_letter': 'observer_dead_letter',
    };
    const errorClass = mapping[event.type];
    if (!errorClass)
        return null;
    const cycleId = typeof event.payload?.['cycleId'] === 'string' ? event.payload['cycleId'] : undefined;
    return {
        source: 'event',
        errorClass,
        ...(cycleId ? { cycleIds: [cycleId] } : {}),
        ...(event.eventId ? { eventIds: [event.eventId] } : {}),
        traceIds: structuredTraceIds(event.payload),
        reproductionSteps: ['inspect_event', 'review_local_draft'],
        diagnosticCodes: [errorClass],
    };
}
export function createIssueDraftForEventBestEffort(event, options) {
    try {
        let input;
        if (event.type === 'cycle.failed') {
            const cycleId = typeof event.payload?.['cycleId'] === 'string' ? event.payload['cycleId'] : undefined;
            input = cycleId ? issueReportInputFromCycle([event], cycleId) : null;
        }
        else if (event.type === 'actor.human.review.reject') {
            const assetId = typeof event.payload?.['assetId'] === 'string' ? event.payload['assetId'] : undefined;
            input = assetId ? issueReportInputFromReview({ assetId, state: 'rejected' }) : null;
            if (input)
                input.traceIds = structuredTraceIds(event.payload);
        }
        else {
            input = issueReportInputFromEvent(event);
        }
        return input ? createIssueDraft(input, options) : null;
    }
    catch {
        return null;
    }
}