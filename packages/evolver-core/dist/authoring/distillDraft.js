import { createHash } from 'node:crypto';
import { distillConversation } from '../hub/conversationDistiller.js';
import { SESSION_GENE_IR_VERSION, recordLinesOf } from '../hub/sessionGeneIr.js';
import { isValidationCommandAllowed } from '../verify/validation.js';
import { SCHEMA_VERSION, canonicalize, computeAssetId } from '../wire/index.js';
const MAX_AVOID = 8;
const MAX_TRIGGER = 12;
function firstText(records, kind, last = false) {
    const texts = records.filter((line) => line.kind === kind).map((line) => line.text.trim()).filter(Boolean);
    return (last ? texts.at(-1) : texts[0]) ?? '';
}
/** Each check's final run: a check that failed and then passed after a fix ended passing. Every run stays in the record. */
function reportedTrace(records) {
    const last = new Map();
    for (const line of records)
        if (line.kind === 'check' && Number.isInteger(line.exit)) {
            last.delete(line.text);
            last.set(line.text, line.exit);
        }
    return [...last].map(([command, exit]) => ({ command, exit, source: 'reported' }));
}
/** The distiller's own request, built only from what a desktop caller may state; it never asks to persist or publish. */
/** Without a stated plan, the replayable checks the record shows passing become the plan: still a plan, never proof. */
function plannedValidation(request, trace) {
    if (request.validation)
        return request.validation;
    const passing = trace.filter((row) => row.exit === 0).map((row) => row.command).filter(isValidationCommandAllowed).slice(0, 8);
    return passing.length > 0 ? passing : undefined;
}
function distillInputOf(request) {
    const records = recordLinesOf(request.records);
    const trace = reportedTrace(records);
    const validation = plannedValidation(request, trace);
    const userPrompt = request.userPrompt ?? firstText(records, 'prompt');
    const finalAnswer = request.finalAnswer ?? firstText(records, 'answer', true);
    return {
        ...(request.title ? { title: request.title } : {}),
        ...(request.summary ? { summary: request.summary } : {}),
        ...(request.transcript ? { transcript: request.transcript } : {}),
        ...(request.strategy ? { strategy: request.strategy } : {}),
        ...(request.signals ? { signals: request.signals } : {}),
        ...(request.preconditions ? { preconditions: request.preconditions } : {}),
        ...(validation ? { validation } : {}),
        ...(userPrompt ? { user_prompt: userPrompt } : {}),
        ...(finalAnswer ? { final_answer: finalAnswer } : {}),
        ...(trace.length > 0 ? { execution: { trace } } : {}),
        ...(request.ir !== undefined ? { ir_version: SESSION_GENE_IR_VERSION, ir: request.ir, record: records } : {}),
        platform: request.platform,
        persist: false,
        publish: false,
    };
}
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(text, identifier) {
    if (/^[\x20-\x7e]+$/.test(identifier))
        return new RegExp(`(?<![\\w$])${escaped(identifier)}(?![\\w$])`, 'i').test(text);
    return text.includes(identifier);
}
/**
 * Caller-declared project names are a denylist: any one of them on the portable surface or in a validation command marks the
 * draft `not_portable` with the names in `terms`, whatever else the gate found, as the distiller does for names a diff
 * declares. The draft is still returned so the person can edit the name out.
 */
function identifierTerms(gene, identifiers) {
    const meta = gene['generation_meta'] && typeof gene['generation_meta'] === 'object' ? gene['generation_meta'] : {};
    const list = (key) => (Array.isArray(gene[key]) ? gene[key].map(String) : []);
    const surface = [String(meta['title'] ?? ''), String(gene['summary'] ?? ''), ...list('signals_match'), ...list('preconditions'), ...list('strategy'),
        ...list('validation')];
    return identifiers.filter((identifier) => identifier.trim() && surface.some((text) => mentions(text, identifier.trim())));
}
function qualityOf(gate, reason) {
    if (!gate)
        return { ok: false, score: 0, threshold: 0, reasons: [], reason: reason ?? null };
    const { ok, score, threshold, reasons, terms, field } = gate;
    return { ok, score, threshold, reasons, reason: ok ? null : gate.reason ?? reason ?? null, ...(terms ? { terms } : {}), ...(field ? { field } : {}) };
}
function slug(text) {
    const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return ascii.length >= 4 ? ascii : `failure-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)}`;
}
/**
 * A failed attempt becomes a guardrail: its triggers and the steps that did not work, never steps to follow. The id carries a
 * content digest, so two failures with the same summary but different details never share one.
 */
function antiGeneFromFailedDraft(gene, distillId) {
    const strings = (key) => (Array.isArray(gene[key]) ? gene[key].map(String).filter(Boolean) : []);
    const summary = String(gene['summary'] ?? '');
    const notUse = strings('preconditions').filter((item) => /^do not use when/i.test(item));
    const body = {
        type: 'AntiGene',
        schema_version: SCHEMA_VERSION,
        id: '',
        summary,
        trigger: [...new Set(strings('signals_match'))].sort().slice(0, MAX_TRIGGER),
        avoid: [...new Set([...strings('strategy').map((step) => `Do not repeat without new evidence: ${step}`), ...notUse])].slice(0, MAX_AVOID),
        source_clusters: [`distill_${distillId}`],
        evidence_capsules: [],
        failure_count: 1,
        rationale: summary,
        severity: 'low',
        asset_id: '',
    };
    const { id: _id, asset_id: _assetId, ...content } = body;
    body.id = `anti_gene_${slug(summary)}_${createHash('sha256').update(canonicalize(content), 'utf8').digest('hex').slice(0, 8)}`;
    body.asset_id = computeAssetId(body) ?? '';
    return body;
}
/**
 * The same normalization, gate, portability and answer-leak checks as `distillConversation`, run with nothing stored,
 * published or sent to a model. A failed outcome yields an AntiGene in place of the Gene/Capsule pair.
 */
export async function distillDraft(request) {
    const result = await distillConversation(distillInputOf(request), { persist: false });
    if (!result.ok)
        return { status: 'skipped', quality: qualityOf(result.quality, result.reason), gene: null, capsule: null, antiGene: null };
    const denied = identifierTerms(result.gene, request.identifiers ?? []);
    const gate = denied.length > 0 ? { ...result.quality, ok: false, reason: 'not_portable', terms: denied.slice(0, 8) } : result.quality;
    const quality = qualityOf(gate);
    if (request.outcome === 'failed') {
        return { status: 'draft', quality, gene: null, capsule: null, antiGene: antiGeneFromFailedDraft(result.gene, result.distill_id) };
    }
    return { status: 'draft', quality, gene: result.gene, capsule: result.capsule, antiGene: null };
}