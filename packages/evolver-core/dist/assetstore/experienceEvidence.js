import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SCHEMA_VERSION, computeAssetId, validateWireDeep } from '../wire/index.js';
import { appendUtf8Durable, assertNoExperienceTransaction, ensureAssetStoreDirectory, readRegularBuffer, withAssetStoreLock } from './assetStoreStorage.js';
import { ExperienceError } from './experienceError.js';
export const EVIDENCE_FILE = 'experience-evidence.jsonl';
export const EVIDENCE_KINDS = ['trial', 'experiment'];
export const EVIDENCE_OUTCOMES = ['success', 'failed', 'unused'];
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 600;
const ASSET_ID = /^sha256:[a-f0-9]{64}$/;
const METRIC_KEYS = new Set(['durationMs', 'tokens', 'checkPassed']);
const invalid = (message) => { throw new ExperienceError('INPUT_INVALID', message); };
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value) => value === undefined || (Number.isSafeInteger(value) && value >= 0);
function metricsOf(raw) {
    if (raw === undefined)
        return {};
    if (!isRecord(raw) || Object.keys(raw).some((key) => !METRIC_KEYS.has(key)))
        return invalid('指标只支持 durationMs、tokens 和 checkPassed。');
    if (!count(raw['durationMs']) || !count(raw['tokens']) || (raw['checkPassed'] !== undefined && typeof raw['checkPassed'] !== 'boolean')) {
        return invalid('指标需要非负整数和布尔值。');
    }
    return {
        ...(raw['durationMs'] !== undefined ? { durationMs: raw['durationMs'] } : {}),
        ...(raw['tokens'] !== undefined ? { tokens: raw['tokens'] } : {}),
        ...(raw['checkPassed'] !== undefined ? { checkPassed: raw['checkPassed'] } : {}),
    };
}
/** Validates an `experience evidence` request at the boundary. */
export function evidenceInputOf(raw) {
    const assetId = typeof raw['assetId'] === 'string' && ASSET_ID.test(raw['assetId']) ? raw['assetId'] : invalid('请提供 sha256:… 资产 ID。');
    const kind = EVIDENCE_KINDS.includes(raw['kind']) ? raw['kind'] : invalid('kind 只能是 trial 或 experiment。');
    const outcome = EVIDENCE_OUTCOMES.includes(raw['outcome']) ? raw['outcome'] : invalid('outcome 只能是 success、failed 或 unused。');
    const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim() : '';
    if (!summary || summary.length > MAX_SUMMARY_CHARS || summary.includes('\0'))
        invalid(`请用 1–${MAX_SUMMARY_CHARS} 个字说明这次结果。`);
    const taskId = raw['taskId'];
    if (taskId !== undefined && !(typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 256 && !taskId.includes('\0')))
        invalid('taskId 格式不正确。');
    return { assetId, kind, outcome, summary, metrics: metricsOf(raw['metrics']), ...(typeof taskId === 'string' ? { taskId } : {}) };
}
/** The user-authored Capsule a trial yields, bound to the Gene's content id; an unused trial proves nothing, so it yields none. */
export function evidenceCapsule(gene, input, at) {
    if (input.outcome === 'unused')
        return null;
    const success = input.outcome === 'success';
    const signals = Array.isArray(gene['signals_match']) ? gene['signals_match'].map(String).filter(Boolean) : [];
    const digest = createHash('sha256').update(`${gene.asset_id}\n${input.kind}\n${at}\n${input.summary}`, 'utf8').digest('hex').slice(0, 16);
    const body = {
        type: 'Capsule',
        schema_version: SCHEMA_VERSION,
        id: `capsule_${input.kind}_${digest}`,
        trigger: signals.length > 0 ? signals : [String(gene['id'] ?? gene.asset_id)],
        gene: gene.asset_id,
        summary: input.summary,
        confidence: input.kind === 'experiment' ? 0.7 : 0.6,
        blast_radius: { files: 0, lines: 0 },
        outcome: { status: success ? 'success' : 'failed', score: success ? 0.82 : 0.35 },
        source_type: 'user_authored',
        content: { evidence_kind: input.kind, metrics: input.metrics },
        ...(input.metrics.tokens !== undefined ? { cost_tokens: input.metrics.tokens } : {}),
        asset_id: '',
    };
    body.asset_id = computeAssetId(body) ?? '';
    if (!validateWireDeep(body).ok)
        throw new ExperienceError('INPUT_INVALID', '这次结果生成的胶囊不符合格式。');
    return body;
}
function parseRow(line) {
    try {
        const row = JSON.parse(line);
        return row && row.schema === 1 && typeof row.evidenceId === 'string' && typeof row.assetId === 'string' ? row : null;
    }
    catch {
        return null;
    }
}
/** Trial and experiment evidence per Gene, plus the Capsule a capture brought along. */
export class ExperienceEvidence {
    baseDir;
    now;
    path;
    constructor(baseDir, now = Date.now) {
        this.baseDir = baseDir;
        this.now = now;
        this.path = join(baseDir, EVIDENCE_FILE);
    }
    list(assetId) {
        assertNoExperienceTransaction(this.baseDir);
        const raw = readRegularBuffer(this.path, MAX_FILE_BYTES)?.toString('utf8') ?? '';
        return raw.split('\n').filter((line) => line.trim()).map(parseRow)
            .filter((row) => row !== null && (assetId === undefined || row.assetId === assetId));
    }
    record(gene, input) {
        if (input.assetId !== gene.asset_id)
            throw new ExperienceError('INPUT_INVALID', '证据指向的经验与要记录的经验不一致。');
        const at = new Date(this.now()).toISOString();
        const row = {
            schema: 1, evidenceId: `evidence_${randomUUID()}`, assetId: gene.asset_id, kind: input.kind, outcome: input.outcome,
            summary: input.summary, metrics: input.metrics, ...(input.taskId ? { taskId: input.taskId } : {}), at,
            capsule: evidenceCapsule(gene, input, at),
        };
        ensureAssetStoreDirectory(this.baseDir);
        withAssetStoreLock(join(this.baseDir, '.assetstore.lock'), () => {
            assertNoExperienceTransaction(this.baseDir);
            const before = readRegularBuffer(this.path, MAX_FILE_BYTES);
            const line = `${JSON.stringify(row)}\n`;
            if ((before?.length ?? 0) + Buffer.byteLength(line) > MAX_FILE_BYTES)
                throw new ExperienceError('EXPERIENCE_WRITE_CAPACITY', '试用记录已满，请先清理旧记录。');
            appendUtf8Durable(this.path, line);
        });
        return row;
    }
}
/** The row a capture commits beside its Gene when the caller brought the Capsule distilled with it. */
export function captureEvidenceRow(capsule, assetId, operationId, at) {
    const outcome = capsule['outcome']?.['status'] === 'success' ? 'success' : 'failed';
    return { schema: 1, evidenceId: `evidence_${operationId}`, assetId, kind: 'capture', outcome, summary: String(capsule['summary'] ?? ''),
        metrics: {}, at, capsule, operationId };
}