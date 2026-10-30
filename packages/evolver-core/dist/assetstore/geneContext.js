import { createHash } from 'node:crypto';
import { acquireContextRead } from './contextRead.js';
import { assessSourceEligibility } from './sourceQualification.js';
import { relatedQueryAborted, relatedQueryLimits } from './relatedCapsules.js';
import { redactString } from '../hub/sanitize.js';
import { isExecutionEligible } from '../reference/guard.js';
import { computeAssetId } from '../wire/index.js';
const CANONICAL_ID = /^sha256:[a-f0-9]{64}$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_FIELD_CHARS = 8000;
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function logicalId(asset) {
    const id = asset['id'];
    return typeof id === 'string' && LOGICAL_ID.test(id) && id !== 'ad-hoc' && !id.startsWith('sha256:') && redactString(id) === id ? id : undefined;
}
function safeText(value) {
    if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS)
        return '';
    // Never read paths or copy trace/diff/excerpt fields. Whitelisted text still needs secret and control redaction.
    const normalized = Array.from(value).filter((character) => {
        if (/\p{Cf}/u.test(character))
            return false;
        const point = character.codePointAt(0);
        return point === 9 || point === 10 || point === 13
            || (point >= 32 && !(point >= 127 && point <= 159) && !(point >= 0x202a && point <= 0x202e) && !(point >= 0x2066 && point <= 0x2069));
    }).join('').trim();
    // Normalization can join a split credential; redact the final character sequence.
    return redactString(normalized);
}
function safeSteps(value) {
    // Do not silently lose the tail of an oversized method or split a shell command.
    if (!Array.isArray(value) || value.length > 64 || value.some((step) => typeof step !== 'string' || step.length > MAX_FIELD_CHARS))
        return [];
    return value.map(safeText).filter(Boolean);
}
function rejectedPreconditions(value, safe) {
    // Undefined is genuinely missing; an explicit malformed list or any lost condition
    // cannot safely accompany a method. Keep this separate from legacy strategy projection.
    return value !== undefined && (!Array.isArray(value) || value.length !== safe.length);
}
/** Pure whitelist projection for real legacy producers (solidify/conversationDistiller/skill2gep).
 * No generic solution/validation assumption; content.excerpt, artifacts, execution_trace and diff are ignored.
 * New producers may use context_projection.schema=gene-context-projection.v1, but cannot assert verification.
 */
export function projectGeneContext(gene) {
    const preconditions = safeSteps(gene['preconditions']);
    return {
        assetId: CANONICAL_ID.test(gene.asset_id) ? gene.asset_id : '',
        ...(logicalId(gene) ? { logicalId: logicalId(gene) } : {}),
        summary: safeText(gene['summary']), strategy: safeSteps(gene['strategy']),
        preconditions, ...(rejectedPreconditions(gene['preconditions'], preconditions) ? { preconditionsRejected: true } : {}),
        validationPlan: safeSteps(gene['validation']), examples: [],
    };
}
export function projectCapsuleContext(capsule, relation) {
    const projection = object(object(capsule['a2a'])['context_projection'] ?? capsule['context_projection']);
    const versioned = projection['schema'] === 'gene-context-projection.v1' ? projection : {};
    const outcome = object(capsule['outcome'])['status'];
    return {
        assetId: CANONICAL_ID.test(capsule.asset_id) ? capsule.asset_id : '', relation,
        evidence: outcome === 'success'
            ? (capsule['resolution_status'] === 'resolved_by_evidence' ? 'recorded_resolved_by_evidence' : 'recorded_success')
            : outcome === 'failed' ? 'recorded_failed' : 'outcome_unknown',
        verification: 'not_verified_by_this_read',
        summary: safeText(versioned['summary']) || safeText(capsule['summary']),
        trigger: safeSteps(versioned['trigger'] ?? capsule['trigger']),
        strategy: safeSteps(versioned['strategy'] ?? capsule['strategy']),
    };
}
function bounded(value, fallback, maximum) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 0 || value > maximum)
        throw new Error('invalid_gene_context_budget');
    return value;
}
function budgetOf(input = {}) {
    return {
        maxChars: bounded(input.maxChars, 16000, 128000),
        maxExampleChars: bounded(input.maxExampleChars, 3000, 32000),
        maxExampleCharsPerGene: bounded(input.maxExampleCharsPerGene, 1200, 8000),
        maxExamplesPerGene: bounded(input.maxExamplesPerGene, 1, 3),
    };
}
function quote(text) { return text.split(/\r\n?|\n/).map((line) => `> ${line}`).join('\n'); }
function validateMode(mode) {
    if (!['summary', 'strategy', 'context'].includes(mode))
        throw new Error('invalid_gene_context_content_mode');
}
/** Pure deterministic renderer. Methods across ALL Genes have priority over any example.
 * Each strategy step is an atomic unit; no command, JSON line or code fence is sliced to fit.
 * Explicit summary/strategy modes intentionally never render examples (legacy caller support).
 */
export function renderGeneContext(projections, options = {}) {
    const mode = options.contentMode ?? 'context';
    validateMode(mode);
    const budget = budgetOf(options.budget);
    // The renderer is public too: do not rely on callers having obtained a projection through this module.
    projections = projections.map((gene) => {
        const preconditions = safeSteps(gene.preconditions);
        return { ...gene,
            summary: safeText(gene.summary), strategy: safeSteps(gene.strategy), preconditions,
            preconditionsRejected: gene.preconditionsRejected === true || rejectedPreconditions(gene.preconditions, preconditions),
            validationPlan: safeSteps(gene.validationPlan),
            examples: gene.examples.map((example) => ({ ...example, summary: safeText(example.summary),
                trigger: safeSteps(example.trigger), strategy: safeSteps(example.strategy),
            })),
        };
    });
    let text = '';
    const sections = [];
    const omissions = [];
    const geneAssetIds = [];
    const capsuleAssetIds = [];
    const append = (gene, kind, body, capsuleAssetId, itemIndex) => {
        const block = `${text ? '\n\n' : ''}${body}`;
        if (text.length + block.length > budget.maxChars)
            return false;
        const start = text.length;
        text += block;
        sections.push({ geneAssetId: gene.assetId, ...(capsuleAssetId ? { capsuleAssetId } : {}), ...(itemIndex === undefined ? {} : { itemIndex }), kind, start, end: text.length, digest: hash(block) });
        if (!geneAssetIds.includes(gene.assetId))
            geneAssetIds.push(gene.assetId);
        return true;
    };
    for (const gene of projections) {
        if (!CANONICAL_ID.test(gene.assetId)) {
            omissions.push({ reason: 'invalid_identity' });
            continue;
        }
        const label = gene.logicalId && LOGICAL_ID.test(gene.logicalId) && redactString(gene.logicalId) === gene.logicalId ? `${gene.logicalId} ` : '';
        const prefix = `Gene ${label}${gene.assetId}`;
        if (mode === 'context' && gene.preconditionsRejected) {
            omissions.push({ geneAssetId: gene.assetId, reason: 'preconditions_rejected' });
            if (gene.summary && !append(gene, 'summary', `${prefix}\nSummary (method omitted: recorded preconditions rejected):\n${quote(gene.summary)}`)) {
                omissions.push({ geneAssetId: gene.assetId, reason: 'method_budget' });
            }
            continue;
        }
        const primary = mode === 'summary' ? (gene.summary ? [gene.summary] : []) : gene.strategy;
        if (primary.length === 0) {
            if (!gene.summary) {
                omissions.push({ geneAssetId: gene.assetId, reason: 'empty_content' });
                continue;
            }
            if (!append(gene, 'summary', `${prefix}\nSummary (no method recorded):\n${quote(gene.summary)}`))
                omissions.push({ geneAssetId: gene.assetId, reason: 'method_budget' });
            continue;
        }
        const conditions = mode === 'context' && gene.preconditions.length > 0
            ? `${prefix}\nPreconditions:\n${gene.preconditions.map(quote).join('\n')}` : '';
        const methodBlocks = primary.map((step, index) => `${prefix}\nMethod step ${index + 1}:\n${quote(step)}`);
        const completeMethod = [...(conditions ? [conditions] : []), ...methodBlocks].join('\n\n');
        if (mode === 'context' && text.length + (text ? 2 : 0) + completeMethod.length > budget.maxChars) {
            omissions.push({ geneAssetId: gene.assetId, reason: 'method_budget' });
            if (gene.summary)
                append(gene, 'summary', `${prefix}\nSummary (complete method omitted by budget):\n${quote(gene.summary)}`);
            continue;
        }
        if (conditions)
            append(gene, 'preconditions', conditions);
        for (const [index, step] of primary.entries()) {
            const kind = mode === 'summary' ? 'summary' : 'strategy';
            const heading = kind === 'summary' ? 'Summary' : `Method step ${index + 1}`;
            if (!append(gene, kind, `${prefix}\n${heading}:\n${quote(step)}`, undefined, kind === 'strategy' ? index : undefined)) {
                omissions.push({ geneAssetId: gene.assetId, reason: 'method_budget' });
                if (index === 0 && mode !== 'summary' && gene.summary) {
                    append(gene, 'summary', `${prefix}\nSummary (method omitted by budget):\n${quote(gene.summary)}`);
                }
                break; // Never skip a prerequisite step and then display later commands.
            }
        }
    }
    // Secondary method metadata cannot crowd out any selected Gene's primary steps.
    if (mode === 'context')
        for (const gene of projections) {
            if (!geneAssetIds.includes(gene.assetId) || gene.preconditionsRejected)
                continue;
            const extras = [
                ['summary', 'Summary', gene.summary ? [gene.summary] : []],
                ['preconditions', 'Preconditions', gene.preconditions],
                ['validation_plan', 'Validation plan (NOT executed by this read)', gene.validationPlan],
            ];
            for (const [kind, label, values] of extras) {
                if (values.length === 0 || sections.some((section) => section.geneAssetId === gene.assetId && section.kind === kind))
                    continue;
                if (kind === 'preconditions' && gene.strategy.length > 0)
                    continue;
                if (!append(gene, kind, `Gene ${gene.assetId}\n${label}:\n${values.map(quote).join('\n')}`))
                    omissions.push({ geneAssetId: gene.assetId, reason: 'method_budget' });
            }
        }
    let exampleChars = 0;
    if (mode === 'context')
        for (const gene of projections) {
            if (!geneAssetIds.includes(gene.assetId) || gene.preconditionsRejected)
                continue;
            let count = 0;
            let geneChars = 0;
            for (const example of gene.examples) {
                if (!CANONICAL_ID.test(example.assetId)) {
                    omissions.push({ geneAssetId: gene.assetId, reason: 'invalid_identity' });
                    continue;
                }
                const omission = { geneAssetId: gene.assetId, capsuleAssetId: example.assetId };
                if (example.evidence !== 'recorded_success' && example.evidence !== 'recorded_resolved_by_evidence') {
                    omissions.push({ ...omission, reason: 'not_success' });
                    continue;
                }
                if (!example.summary) {
                    omissions.push({ ...omission, reason: 'empty_content' });
                    continue;
                }
                if (count >= budget.maxExamplesPerGene) {
                    omissions.push({ ...omission, reason: 'example_limit' });
                    continue;
                }
                const relation = example.relation === 'canonical' ? 'exact Gene content binding' : 'logical-id history; NOT evidence for the current Gene version';
                const body = `Gene ${gene.assetId}\nExample ${example.assetId} (${relation})\nEvidence: ${example.evidence}; historical record, NOT host-verified by this read; NOT a current test pass.\n${quote(example.summary)}${example.trigger.length ? `\nTrigger:\n${example.trigger.map(quote).join('\n')}` : ''}${example.strategy.length ? `\nRecorded method (not an execution trace):\n${example.strategy.map(quote).join('\n')}` : ''}`;
                const size = body.length + (text ? 2 : 0);
                if (exampleChars + size > budget.maxExampleChars || geneChars + size > budget.maxExampleCharsPerGene
                    || !append(gene, 'example', body, example.assetId)) {
                    omissions.push({ ...omission, reason: 'example_budget' });
                    continue;
                }
                exampleChars += size;
                geneChars += size;
                count++;
                if (!capsuleAssetIds.includes(example.assetId))
                    capsuleAssetIds.push(example.assetId);
            }
        }
    return { text, digest: hash(text), geneAssetIds, capsuleAssetIds, sections, omissions };
}
/** Shared render/recall gate. The caller must supply this asset's own source maps, including for a Capsule. */
export function assetContextEligibilityReason(asset, eligibility) {
    if (!isExecutionEligible(asset, eligibility.referenceScope))
        return 'reference_only';
    if (eligibility.provenance.get(asset.asset_id)?.trusted === false)
        return 'trust_rejected';
    const review = eligibility.review.get(asset.asset_id);
    if (review && review.state !== 'approved')
        return 'review_rejected';
    if (!assessSourceEligibility(asset, eligibility.provenance.get(asset.asset_id), eligibility.benchmark).allowed)
        return 'qualification_rejected';
    return undefined;
}
function receipt(asset, eligibility) {
    return eligibility.benchmark ? [{ ...assessSourceEligibility(asset, eligibility.provenance.get(asset.asset_id), eligibility.benchmark),
            assetId: asset.asset_id, benchmarkId: eligibility.benchmark.benchmarkId }] : [];
}
function exampleRelevance(example, task) {
    return example.trigger.slice(0, 16).reduce((hits, pattern) => {
        const aliases = pattern.split('|', 4).map((alias) => alias.trim().normalize('NFKC').toLowerCase());
        return hits + Number(aliases.some((alias) => alias.length >= 2 && alias.length <= 192 && task.includes(alias)));
    }, 0);
}
function examplesForGene(gene, result, eligibility, omissions, checkBudget, taskText = '') {
    checkBudget();
    const examples = [];
    const qualifications = [];
    const seen = new Set();
    const id = logicalId(gene);
    // If any source's identity coverage is unknown, logical matching cannot establish uniqueness.
    const identityComplete = result.sources.every((source) => { checkBudget(); return source.identityComplete; });
    // Intentional case-only tightening: a partial/unavailable source may conceal a
    // revoked duplicate, even for canonical bindings. Losing qualification knowledge
    // must never enlarge the injectable set. Complete Gene identities alone do not
    // prove Capsule coverage (maxCapsules can truncate independently).
    const qualificationComplete = identityComplete && result.sources.every((source) => { checkBudget(); return source.status === 'complete'; });
    const logicalVersions = new Set();
    for (const source of result.sources)
        for (const item of source.genes) {
            checkBudget();
            if (id && item['id'] === id)
                logicalVersions.add(item.asset_id);
        }
    for (const source of result.sources) {
        checkBudget();
        if (source.status === 'unavailable' || source.status === 'unsupported' || source.status === 'aborted')
            continue;
        const ownGene = source.genes.find((item) => {
            checkBudget();
            return item.asset_id === gene.asset_id && computeAssetId(item) === computeAssetId(gene);
        });
        for (const capsule of source.capsules) {
            checkBudget();
            const binding = capsule['gene'];
            if (binding !== gene.asset_id && (!id || binding !== id))
                continue;
            const omission = { geneAssetId: gene.asset_id, capsuleAssetId: CANONICAL_ID.test(capsule.asset_id) ? capsule.asset_id : undefined };
            if (binding === 'ad-hoc' || computeAssetId(gene) !== gene.asset_id) {
                omissions.push({ ...omission, reason: 'unbound_relation' });
                continue;
            }
            const relation = binding === gene.asset_id ? 'canonical' : 'logical_history';
            // An exact content address proves the binding even when a foreign pool stores only the Capsule.
            // A logical id cannot cross that boundary: require the selected version in the Capsule's own source.
            if (relation === 'logical_history' && !ownGene) {
                omissions.push({ ...omission, reason: 'unbound_relation' });
                continue;
            }
            if (relation === 'logical_history' && (!identityComplete || logicalVersions.size !== 1 || !logicalVersions.has(gene.asset_id))) {
                omissions.push({ ...omission, reason: 'ambiguous_relation' });
                continue;
            }
            if (capsule.type !== 'Capsule' || !CANONICAL_ID.test(capsule.asset_id) || computeAssetId(capsule) !== capsule.asset_id) {
                omissions.push({ ...omission, reason: 'invalid_identity' });
                continue;
            }
            const ownEligibility = { ...eligibility, provenance: source.provenance, review: source.review };
            const rejected = assetContextEligibilityReason(capsule, ownEligibility);
            checkBudget();
            if (rejected) {
                omissions.push({ ...omission, reason: rejected });
                continue;
            }
            if (!qualificationComplete) {
                omissions.push({ ...omission, reason: 'qualification_unavailable' });
                continue;
            }
            // Conflicting duplicate origins are not an opportunity to shop for a permissive sidecar.
            // This only withholds the optional example; ordinary UnionReadStore primary precedence is unchanged.
            const conflictingOrigin = result.sources.some((other) => {
                checkBudget();
                return other !== source && other.capsules.some((copy) => {
                    checkBudget();
                    return copy.asset_id === capsule.asset_id && (computeAssetId(copy) !== computeAssetId(capsule)
                        || assetContextEligibilityReason(copy, { ...eligibility, provenance: other.provenance, review: other.review }) !== undefined);
                });
            });
            checkBudget();
            if (conflictingOrigin) {
                omissions.push({ ...omission, reason: 'ambiguous_relation' });
                continue;
            }
            if (object(capsule['outcome'])['status'] !== 'success') {
                omissions.push({ ...omission, reason: 'not_success' });
                continue;
            }
            const example = projectCapsuleContext(capsule, relation);
            if (!example.summary) {
                omissions.push({ ...omission, reason: 'empty_content' });
                continue;
            }
            if (seen.has(example.assetId))
                continue;
            seen.add(example.assetId);
            examples.push(example);
            qualifications.push(...receipt(capsule, ownEligibility));
        }
    }
    checkBudget();
    const task = taskText.slice(0, 16000).normalize('NFKC').toLowerCase().slice(0, 16000);
    const relevance = new Map(examples.map((example) => { checkBudget(); return [example.assetId, exampleRelevance(example, task)]; }));
    // Relevance ranks only independently qualified cases; it cannot relax identity or source eligibility.
    examples.sort((a, b) => {
        checkBudget();
        return relevance.get(b.assetId) - relevance.get(a.assetId)
            || Number(b.relation === 'canonical') - Number(a.relation === 'canonical')
            || Number(b.evidence === 'recorded_resolved_by_evidence') - Number(a.evidence === 'recorded_resolved_by_evidence')
            || a.assetId.localeCompare(b.assetId);
    });
    checkBudget();
    return { examples, qualifications };
}
function validRelatedResult(value) {
    const sources = object(value)['sources'];
    return Array.isArray(sources) && sources.length <= 64 && sources.every((value) => {
        const source = object(value);
        return typeof source['sourceId'] === 'string'
            && ['complete', 'truncated', 'unavailable', 'aborted', 'unsupported'].includes(String(source['status']))
            && Number.isInteger(source['scanned']) && Number(source['scanned']) >= 0
            && typeof source['identityComplete'] === 'boolean'
            && Array.isArray(source['genes']) && source['genes'].length <= 256
            && Array.isArray(source['capsules']) && source['capsules'].length <= 1024
            && source['provenance'] instanceof Map && source['review'] instanceof Map
            && [...source['genes'], ...source['capsules']].every((row) => typeof object(row)['asset_id'] === 'string');
    });
}
/** A timed-out optional case read must be terminal before its caller returns.
 * An AbortSignal or Promise.race result alone does not stop an injected adapter.
 */
async function queryBeforeDeadline(store, query, assertPromptAdapter) {
    if (query.signal?.aborted)
        return 'cancelled';
    if (relatedQueryAborted(query))
        return 'timeout';
    assertPromptAdapter?.();
    const begin = store.beginPromptRelatedCapsulesV1?.bind(store);
    if (!begin)
        return 'failed';
    const controller = new AbortController();
    let release;
    let started = false;
    let terminal = false;
    let operation;
    let timer;
    let onAbort;
    try {
        if (query.signal?.aborted)
            return 'cancelled';
        if (relatedQueryAborted(query))
            return 'timeout';
        assertPromptAdapter?.();
        release = acquireContextRead(store);
        started = true;
        operation = begin({ ...query, signal: controller.signal });
        if (operation?.version !== 1 || !operation.result || typeof operation.result.then !== 'function'
            || typeof operation.cancelAndSettle !== 'function')
            throw new Error('invalid_context_read_operation_v1');
        const outcome = await Promise.race([
            operation.result.then(value => ({ kind: 'result', value })),
            new Promise(resolve => {
                timer = setTimeout(() => { controller.abort(); resolve({ kind: 'timeout' }); }, Math.max(0, query.deadlineAt - Date.now()));
                onAbort = () => { controller.abort(); resolve({ kind: 'cancelled' }); };
                query.signal?.addEventListener('abort', onAbort, { once: true });
                if (query.signal?.aborted)
                    onAbort();
            }),
        ]);
        if (outcome.kind !== 'result') {
            await operation.cancelAndSettle();
            terminal = true;
            return outcome.kind;
        }
        await operation.cancelAndSettle();
        terminal = true;
        if (query.signal?.aborted)
            return 'cancelled';
        if (controller.signal.aborted || relatedQueryAborted(query))
            return 'timeout';
        return validRelatedResult(outcome.value) ? outcome.value : 'failed';
    }
    catch {
        // A rejected operation may still have a worker. Join its actual termination
        // before allowing another dispatch; malformed/missing proof retains owner.
        if (operation && typeof operation.cancelAndSettle === 'function') {
            try {
                await operation.cancelAndSettle();
                terminal = true;
            }
            catch { /* retain owner */ }
        }
        return query.signal?.aborted ? 'cancelled' : controller.signal.aborted || relatedQueryAborted(query) ? 'timeout' : 'failed';
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (onAbort)
            query.signal?.removeEventListener('abort', onAbort);
        controller.abort();
        if (!started || terminal)
            release?.();
    }
}
// An expired optional-case budget still permits a small, selected Gene-only fallback,
// not an unbounded reference-tree traversal or benchmark content hash. Share this work
// ceiling across the entire (already capped at 64) selection. Normal reads are unchanged.
function expiredFallbackWork() {
    let nodes = 65536;
    let chars = 8 * 1024 * 1024;
    const ancestors = new Set();
    const fits = (value, depth = 0) => {
        if (--nodes < 0 || depth > 64)
            return false;
        if (typeof value === 'string') {
            chars -= value.length;
            return chars >= 0;
        }
        if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number')
            return true;
        if (typeof value !== 'object' || ancestors.has(value))
            return false;
        if (Array.isArray(value) && value.length > nodes)
            return false;
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
            return false;
        ancestors.add(value);
        try {
            for (const key in value) {
                if (!Object.hasOwn(value, key))
                    continue;
                chars -= key.length;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (chars < 0 || !descriptor || !('value' in descriptor) || !fits(descriptor.value, depth + 1))
                    return false;
            }
            return true;
        }
        finally {
            ancestors.delete(value);
        }
    };
    return fits;
}
/** Assemble already-selected Genes without changing their selection order or reading remote assets.
 * @example
 * const result = await assetstore.assembleGeneContext({
 *   selectedGenes, store,
 *   eligibility: { provenance: provenance.snapshot(), review: review.snapshot(), benchmark, referenceScope: store.referenceScope },
 *   contentMode: 'context', privacyMode: 'enforce',
 *   budget: { maxChars: 16000, maxExampleChars: 3000, maxExamplesPerGene: 1 },
 *   signal, deadlineAt: outerDeadline,
 * });
 * // Only result.text is prompt material. Log result.digest/sections/IDs/omissions, not raw records.
 * // summary/strategy skip the example query; off/shadow return no prompt material or candidate body digest.
 * // This read never executes validation plans, follows artifact paths, or establishes host verification.
 */
export async function assembleGeneContext(options) {
    const contentMode = options.contentMode ?? 'context';
    const privacyMode = options.privacyMode ?? 'enforce';
    validateMode(contentMode);
    if (!['off', 'shadow', 'enforce'].includes(privacyMode))
        throw new Error('invalid_gene_context_privacy_mode');
    const budget = budgetOf(options.budget);
    // Invalid caller options are request errors, not optional source failures.
    // Capture both primitive limits before eligibility/provider callbacks can mutate them.
    const queryBudget = Object.freeze(relatedQueryLimits({ ...options.queryBudget, genes: [] }));
    const timeoutMs = bounded(options.timeoutMs, 1000, 60000);
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
        throw new Error('invalid_gene_context_deadline');
    const deadlineAt = Math.min(Date.now() + timeoutMs, options.deadlineAt ?? Infinity);
    const empty = () => ({ ...renderGeneContext([], { contentMode, budget }), contentMode, privacyMode,
        projections: [], qualifications: [], coverage: [], counts: { selected: options.selectedGenes.length, eligible: 0, rendered: 0, examples: 0 } });
    if (privacyMode !== 'enforce') {
        const result = empty();
        result.omissions.push({ reason: privacyMode === 'off' ? 'privacy_off' : 'privacy_shadow' });
        return result; // No capsule I/O or data-bearing shadow projection.
    }
    if (options.selectedGenes.length > 64)
        throw new Error('gene_context_selection_limit');
    if (options.signal?.aborted) {
        const result = empty();
        result.omissions.push({ reason: 'cancelled' });
        return result;
    }
    const fallbackFits = expiredFallbackWork();
    const omissions = [];
    const genes = [];
    const seen = new Set();
    const qualifications = [];
    for (const gene of options.selectedGenes) {
        if (gene.type !== 'Gene' || !CANONICAL_ID.test(gene.asset_id)) {
            omissions.push({ reason: 'invalid_identity' });
            continue;
        }
        if (seen.has(gene.asset_id))
            continue;
        seen.add(gene.asset_id);
        try {
            if (Date.now() >= deadlineAt && (!fallbackFits(gene)
                || !fallbackFits(options.eligibility.provenance.get(gene.asset_id))
                || !fallbackFits(options.eligibility.review.get(gene.asset_id)))) {
                // This record was not evaluated within the expired work allowance. It must stay omitted,
                // but it is not a broken eligibility authority that invalidates already-qualified methods.
                omissions.push({ geneAssetId: gene.asset_id, reason: 'timeout' });
                continue;
            }
            const reason = assetContextEligibilityReason(gene, options.eligibility);
            if (reason) {
                omissions.push({ geneAssetId: gene.asset_id, reason });
                continue;
            }
            qualifications.push(...receipt(gene, options.eligibility));
            genes.push(gene);
        }
        catch {
            omissions.push({ geneAssetId: gene.asset_id, reason: 'qualification_unavailable' });
        }
    }
    // Prepare the Gene-only fallback BEFORE optional I/O. A timed-out example query must not
    // restart the budget/deadline for projection or rendering.
    const projections = genes.map((gene) => {
        const projection = projectGeneContext(gene);
        if ((typeof gene['summary'] === 'string' && gene['summary'].length > MAX_FIELD_CHARS)
            || (Array.isArray(gene['strategy']) && gene['strategy'].length > 0 && projection.strategy.length === 0)) {
            omissions.push({ geneAssetId: gene.asset_id, reason: 'unsafe_or_oversize_field' });
        }
        return projection;
    });
    const methodRendered = renderGeneContext(projections, { contentMode, budget });
    let related = { sources: [] };
    if (contentMode === 'context' && genes.length > 0 && budget.maxExamplesPerGene > 0 && budget.maxExampleChars > 0 && budget.maxChars > 0) {
        options.assertPromptAdapter?.();
        if (!options.store?.beginPromptRelatedCapsulesV1)
            omissions.push({ reason: 'unsupported_provider' });
        else {
            const query = await queryBeforeDeadline(options.store, { ...queryBudget, genes: genes.map((gene) => ({ assetId: gene.asset_id, logicalId: logicalId(gene) })), deadlineAt, ...(options.signal ? { signal: options.signal } : {}) }, options.assertPromptAdapter);
            if (typeof query === 'string')
                omissions.push({ reason: query === 'failed' ? 'source_unavailable' : query });
            else
                related = query;
        }
    }
    for (const source of related.sources) {
        if (source.status !== 'complete')
            omissions.push({ reason: source.status === 'truncated' ? 'query_truncated'
                    : source.status === 'unsupported' ? 'unsupported_provider' : source.status === 'aborted' ? (options.signal?.aborted ? 'cancelled' : 'timeout') : 'source_unavailable' });
    }
    // Optional case work shares the original deadline, including its synchronous
    // identity/qualification loops. Timer callbacks cannot interrupt these loops.
    const exampleBudgetExpired = new Error('gene_context_example_budget_expired');
    const checkExampleBudget = () => {
        if (options.signal?.aborted || Date.now() >= deadlineAt)
            throw exampleBudgetExpired;
    };
    // Optional case failures never discard an already-qualified method. No new timeout is started here.
    for (const [index, gene] of genes.entries()) {
        try {
            checkExampleBudget();
            const selected = examplesForGene(gene, related, options.eligibility, omissions, checkExampleBudget, options.taskText);
            const method = new Set(projections[index].strategy);
            projections[index].examples = selected.examples.map((example) => ({ ...example, strategy: example.strategy.filter((step) => !method.has(step)) }));
            qualifications.push(...selected.qualifications);
        }
        catch (error) {
            if (error === exampleBudgetExpired)
                break;
            omissions.push({ geneAssetId: gene.asset_id, reason: 'source_unavailable' });
        }
    }
    const expired = options.signal?.aborted ? 'cancelled' : Date.now() >= deadlineAt ? 'timeout' : undefined;
    if (expired && !omissions.some((item) => item.reason === expired))
        omissions.push({ reason: expired });
    const rendered = expired ? methodRendered : renderGeneContext(projections, { contentMode, budget });
    const renderedIds = new Set([...rendered.geneAssetIds, ...rendered.capsuleAssetIds]);
    const visible = projections.filter((projection) => rendered.geneAssetIds.includes(projection.assetId)).map((projection) => {
        const sections = rendered.sections.filter((section) => section.geneAssetId === projection.assetId);
        return { ...projection,
            summary: sections.some((section) => section.kind === 'summary') ? projection.summary : '',
            strategy: projection.strategy.filter((_, index) => sections.some((section) => section.kind === 'strategy' && section.itemIndex === index)),
            preconditions: sections.some((section) => section.kind === 'preconditions') ? projection.preconditions : [],
            validationPlan: sections.some((section) => section.kind === 'validation_plan') ? projection.validationPlan : [],
            examples: projection.examples.filter((example) => sections.some((section) => section.capsuleAssetId === example.assetId)),
        };
    });
    return { ...rendered, omissions: [...omissions, ...rendered.omissions], contentMode, privacyMode, projections: visible,
        qualifications: qualifications.filter((item) => renderedIds.has(item.assetId)),
        coverage: related.sources.map(({ status, scanned, identityComplete }) => ({ status, scanned, identityComplete })),
        counts: { selected: options.selectedGenes.length, eligible: genes.length, rendered: rendered.geneAssetIds.length, examples: rendered.capsuleAssetIds.length } };
}