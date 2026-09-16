import { createHash } from 'node:crypto';
import { redactString } from '../hub/sanitize.js';
import { computeAssetId } from '../wire/index.js';
export const SOURCE_QUALIFICATION_SCHEMA = 'benchmark-source-qualification.v1';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RESOURCE_KINDS = ['task_test', 'self_test', 'task_material', 'self_material', 'documentation', 'external_solution', 'external_test', 'unknown'];
const ACCESS_OUTCOMES = ['read', 'attempted', 'failed', 'blocked'];
/** root_event有4096B上限：公共context只记一次，原始run/event/trajectory从append-only provenance追溯。 */
export function compactQualificationReceipts(receipts) {
    if (receipts.length === 0)
        return {};
    const benchmarkId = receipts[0].benchmarkId;
    if (receipts.length > 8 || !identifier(benchmarkId))
        throw new Error('invalid_qualification_receipt');
    const references = receipts.map((receipt) => {
        if (!receipt.allowed || receipt.benchmarkId !== benchmarkId || !digest(receipt.assetId) || !digest(receipt.evidenceDigest)
            || receipt.state === 'not_applicable' || (receipt.reason !== 'qualified' && receipt.reason !== 'explicit_exception'))
            throw new Error('invalid_qualification_receipt');
        return { assetId: receipt.assetId, evidenceDigest: receipt.evidenceDigest, state: receipt.state, reason: receipt.reason, allowed: true };
    });
    return { sourceQualificationSchema: 'benchmark-source-references.v1', sourceBenchmarkId: benchmarkId, sourceQualifications: references };
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function identifier(value) {
    return typeof value === 'string' && ID.test(value) && redactString(value) === value;
}
function digest(value) { return typeof value === 'string' && DIGEST.test(value); }
function safeReason(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && redactString(value) === value;
}
/** composition层显式传入env值；core不自行读取进程环境，不改变普通运行。 */
export function benchmarkContext(value) {
    if (value === undefined)
        return undefined;
    if (!identifier(value))
        throw new Error('invalid_benchmark_id');
    return { benchmarkId: value };
}
export function parseSourceQualificationRequest(value) {
    const input = record(value);
    if (!input || !identifier(input['benchmarkId']) || !identifier(input['runId'])
        || !digest(input['trajectoryDigest']) || !digest(input['assetId']) || !digest(input['assetContentId'])
        || (input['coverage'] !== 'complete' && input['coverage'] !== 'partial')
        || !Array.isArray(input['events']) || input['events'].length > 64)
        return null;
    const events = [];
    const seen = new Set();
    for (const value of input['events']) {
        const event = record(value);
        if (!event || !identifier(event['callId']) || !digest(event['eventDigest']) || !digest(event['resourceDigest'])
            || !RESOURCE_KINDS.includes(event['kind'])
            || !ACCESS_OUTCOMES.includes(event['outcome'])
            || (event['resultDigest'] !== undefined && !digest(event['resultDigest'])))
            return null;
        const key = `${event['callId']}:${event['resourceDigest']}`;
        if (seen.has(key))
            return null;
        seen.add(key);
        events.push(Object.freeze({
            callId: event['callId'], eventDigest: event['eventDigest'], resourceDigest: event['resourceDigest'],
            kind: event['kind'], outcome: event['outcome'],
            ...(typeof event['resultDigest'] === 'string' ? { resultDigest: event['resultDigest'] } : {}),
        }));
    }
    return Object.freeze({
        benchmarkId: input['benchmarkId'], runId: input['runId'], trajectoryDigest: input['trajectoryDigest'],
        assetId: input['assetId'], assetContentId: input['assetContentId'], coverage: input['coverage'],
        events: Object.freeze(events),
    });
}
/** reward和普通approval不作为输入；未完成核查或缺少工具返回证据不能推断合格。 */
function qualificationState(input) {
    if (input.events.some((event) => event.outcome === 'read' && event.resultDigest
        && (event.kind === 'external_solution' || event.kind === 'external_test')))
        return 'ineligible';
    if (input.coverage !== 'complete' || input.events.length === 0
        || input.events.some((event) => !event.resultDigest || event.kind === 'unknown' || event.outcome === 'attempted'))
        return 'unknown';
    return 'eligible';
}
export function qualifySource(value, by, reason, at, exceptionReason) {
    const input = parseSourceQualificationRequest(value);
    if (!input || !identifier(by) || !safeReason(reason) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))
        || new Date(at).toISOString() !== at
        || (exceptionReason !== undefined && !safeReason(exceptionReason)))
        throw new Error('invalid_source_qualification');
    const evidenceDigest = `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
    return Object.freeze({
        ...input, schema: SOURCE_QUALIFICATION_SCHEMA, state: qualificationState(input), evidenceDigest, by, reason, at,
        ...(exceptionReason === undefined ? {} : { exception: Object.freeze({ by, reason: exceptionReason }) }),
    });
}
export function parseSourceQualification(value) {
    const input = record(value);
    if (!input || input['schema'] !== SOURCE_QUALIFICATION_SCHEMA)
        return null;
    const exception = input['exception'] === undefined ? undefined : record(input['exception']);
    if (input['exception'] !== undefined && (!exception || exception['by'] !== input['by'] || !safeReason(exception['reason'])))
        return null;
    try {
        const parsed = qualifySource(input, input['by'], input['reason'], input['at'], exception?.['reason']);
        if (parsed.state !== input['state'] || parsed.evidenceDigest !== input['evidenceDigest'])
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function parseSourceQualifications(value, assetId) {
    if (!Array.isArray(value) || value.length > 8)
        return null;
    const parsed = [];
    const seen = new Set();
    for (const row of value) {
        const qualification = parseSourceQualification(row);
        if (!qualification || qualification.assetId !== assetId || seen.has(qualification.benchmarkId))
            return null;
        seen.add(qualification.benchmarkId);
        parsed.push(qualification);
    }
    return Object.freeze(parsed);
}
/** 资格不取代既有trust/review；每次使用fresh provenance，撤销无需改asset内容。 */
export function assessSourceEligibility(asset, provenance, context) {
    if (!context)
        return { allowed: true, state: 'not_applicable', reason: 'standard_mode' };
    if (!identifier(context.benchmarkId))
        throw new Error('invalid_benchmark_id');
    const qualification = provenance?.sourceQualifications?.find((item) => item.benchmarkId === context.benchmarkId);
    if (!qualification)
        return { allowed: false, state: 'unknown', reason: 'missing_evidence' };
    const metadata = { evidenceDigest: qualification.evidenceDigest, trajectoryDigest: qualification.trajectoryDigest, runId: qualification.runId };
    if (qualification.assetId !== asset.asset_id || qualification.assetContentId !== computeAssetId(asset)) {
        return { ...metadata, allowed: false, state: 'unknown', reason: 'content_mismatch' };
    }
    if (qualification.exception)
        return { ...metadata, allowed: true, state: qualification.state, reason: 'explicit_exception' };
    return {
        ...metadata, state: qualification.state, allowed: qualification.state === 'eligible',
        reason: qualification.state === 'eligible' ? 'qualified' : qualification.state === 'ineligible' ? 'external_reference' : 'review_incomplete',
    };
}