import { EXPERIENCE_PAUSED, EXPERIENCE_REMOVED } from '../assetstore/experience.js';
import { redactString } from '../hub/sanitize.js';
import { normalizeProofOfWork, toolCallTraceOf } from '../schema/proofOfWork.js';
import { isHostObservedCapsule } from '../algo/hostObservedEvidence.js';
const TITLE_MAX = 140;
const GENERATION_ORIGINS = new Set(['distilled', 'evolved', 'manual']);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Identifiers are matched, never shown as prose, so they pass unchanged or not at all. */
export function printableId(value) {
    return typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value) ? value : null;
}
export function boundedText(value, max) {
    if (typeof value !== 'string')
        return null;
    const text = redactString(value.replace(/\s+/g, ' ').trim());
    if (!text)
        return null;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
/** The first line, then the first sentence of a summary, so a list row reads as a name rather than a paragraph. */
// Abbreviations such as "e.g." end in a period but not a sentence.
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|etc|vs|cf)\.)(?<=[.!?。！？])\s/i;
function geneTitle(summary, fallback) {
    const firstLine = typeof summary === 'string' ? summary.trim().split(/\r?\n/, 1)[0] ?? '' : '';
    const firstSentence = firstLine.split(SENTENCE_END, 1)[0] ?? '';
    return boundedText(firstSentence, TITLE_MAX) ?? boundedText(fallback, TITLE_MAX) ?? fallback;
}
function logicalIdOf(record) {
    const id = record['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
}
function originOf(gene, provenance) {
    if (provenance?.source === 'hub')
        return 'hub';
    const meta = gene['generation_meta'];
    const source = meta && typeof meta === 'object' ? meta['source'] : undefined;
    return typeof source === 'string' && GENERATION_ORIGINS.has(source) ? source : 'unknown';
}
export function familiesOf(genes, provenance) {
    const byKey = new Map();
    for (const gene of genes) {
        const key = logicalIdOf(gene) ?? gene.asset_id;
        const members = byKey.get(key);
        if (!members)
            byKey.set(key, [gene]);
        else if (!members.some((member) => member.asset_id === gene.asset_id))
            members.push(gene);
    }
    return [...byKey.entries()].map(([key, members], position) => {
        const first = members[0];
        const current = members[members.length - 1];
        return {
            key, members, position,
            logicalId: logicalIdOf(first),
            title: geneTitle(current['summary'], key),
            category: boundedText(current['category'], 40),
            origin: originOf(first, provenance.get(first.asset_id)),
        };
    });
}
/** Only reachable for rejected records: a pause or removal from the experience library keeps its own name. */
function rejectedState(record) {
    if (record.reason === EXPERIENCE_PAUSED)
        return 'paused';
    return record.reason === EXPERIENCE_REMOVED ? 'removed' : 'rejected';
}
export function stateOf(record, trusted) {
    if (record?.state === 'rejected')
        return rejectedState(record);
    if (!trusted)
        return 'untrusted';
    if (record?.state === 'quarantined')
        return 'trial';
    return record?.state === 'approved' ? 'approved' : 'eligible';
}
export function reviewTimelineKind(record) {
    if (record.state === 'quarantined')
        return 'trial';
    return record.state === 'approved' ? 'approved' : rejectedState(record);
}
export function reviewView(record) {
    return { state: record.state, at: record.at, by: boundedText(record.by, 80), reason: boundedText(record.reason, 240) };
}
export function memberOrigin(family, member, ordinal, reviewed, provenance) {
    if (provenance?.source === 'hub')
        return 'hub_import';
    if (family.logicalId?.startsWith('gene_reverified_'))
        return 'reverified';
    if (family.logicalId?.startsWith('gene_repaired_'))
        return 'repaired';
    // The curation publish re-stores the sanitized Gene under the same logical id without a review record;
    // a re-distilled version is quarantined like any new draft.
    if (ordinal > 1 && !reviewed)
        return 'sanitized_copy';
    return originOf(member, provenance);
}
export function capsuleKind(capsule) {
    const id = typeof capsule['id'] === 'string' ? capsule['id'] : '';
    if (id.startsWith('capsule_conversation_'))
        return 'distilled';
    if (id.startsWith('capsule_reverified_'))
        return 'reverified';
    if (capsule['source_type'] === 'reused' && isHostObservedCapsule(capsule))
        return 'observed_reuse';
    if (toolCallTraceOf(normalizeProofOfWork(capsule['proof_of_work']))?.ref === 'host-verified')
        return 'host_verified';
    return ULID.test(id) ? 'cycle' : 'other';
}
/** The logical id or content id a Capsule names as its Gene. */
export function capsuleGeneRef(capsule) {
    const gene = capsule['gene'];
    return typeof gene === 'string' && gene.length > 0 ? gene : null;
}