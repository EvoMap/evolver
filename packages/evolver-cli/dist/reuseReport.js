// `evolver reuse-report` (#268 slice C + Pha 2 v1) — surface the CROSS-RUNTIME keep/prune signal AND, with
// `--quarantine`, act on it under a HUMAN gate. Rolls up reuse outcomes from root_events (success from
// value.reuse_hit, failed/mismatched/stale/unsafe from value.reuse_outcome) per gene, and lists prune candidates
// (genes reused but never successfully) — across EVERY runtime, MCP-native agents included.
//
// Read-only by default. `--quarantine` is the operator-gated Pha 2 v1: for genes with a STRONG, PERSISTENT
// negative reuse signal it sets a ReviewLedger quarantine (which the review-first selection gate then excludes
// from the pool) — NEVER deletes (genes are content-addressed) and is reversible via `review --approve`. The
// operator runs it deliberately and a human still owns the final call, so it acts on a self-reported (weak)
// signal safely WITHOUT needing an A/B first. Autonomous (daemon, no human-per-gene) quarantine is a later step.
//
// `--promote` is the read-only counterpart for the PROBATION pool (#306): it lists every quarantined gene with its
// cycle evidence and whether it would auto-promote now (same bar the daemon acts on). It never mutates — it exists
// so an operator can watch the gated auto-promote machinery before flipping EVOLVER_GENE_PROBATION on.
//
// `--anti-gene` is the read-only operator view for #326: it surfaces local AntiGene assets, review state, shadow
// observations, and whether approved warnings have actually appeared in selection decisions.
import { events, ops, assetstore, algo } from '@evomap/evolver-core';
function parseFlags(argv) {
    let quarantine = false, promote = false, antiGene = false, minNegative = 3, minUnsafe = 1;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--quarantine')
            quarantine = true;
        else if (a === '--promote')
            promote = true;
        else if (a === '--anti-gene')
            antiGene = true;
        else if (a === '--min-negative') {
            const n = Number(argv[++i]);
            if (Number.isFinite(n) && n >= 1)
                minNegative = n;
        }
        else if (a === '--min-unsafe') {
            const n = Number(argv[++i]);
            if (Number.isFinite(n) && n >= 1)
                minUnsafe = n;
        }
    }
    return { quarantine, promote, antiGene, minNegative, minUnsafe };
}
/**
 * `--promote`: read-only visibility into the PROBATION pool (#306). Lists every quarantined gene with its cycle
 * evidence so far and whether it would auto-promote right now, against the SAME bar the daemon acts on
 * (scanProbationGenes). This NEVER promotes — the daemon's auto-promote tick does, when EVOLVER_GENE_PROBATION=1.
 * It exists so an operator can SEE the gated machinery working (and tune) before flipping the default on.
 */
async function reportProbation(deps, log) {
    const statuses = deps.scanProbation
        ? await deps.scanProbation()
        : await algo.scanProbationGenes(deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir()), new assetstore.ReviewLedger(events.assetsDir()));
    const first = statuses[0];
    if (!first) {
        log('probation: no genes on probation (none quarantined awaiting evidence).');
        return 0;
    }
    log(`probation: ${statuses.length} gene(s) on probation (promote bar: >=${first.minSuccess} clean success, 0 fail)`);
    for (const s of statuses) {
        const note = s.wouldPromote
            ? 'READY (auto-promotes on the next daemon tick when EVOLVER_GENE_PROBATION=1)'
            : s.failed > 0
                ? `blocked by ${s.failed} failure(s)`
                : `needs ${Math.max(1, s.minSuccess - s.success)} more clean success`;
        log(`  ${s.geneId}  success=${s.success} fail=${s.failed} inert=${s.inert} total=${s.total}  ${note}`);
    }
    const ready = statuses.filter((s) => s.wouldPromote).map((s) => s.geneId);
    log(ready.length > 0
        ? `ready to promote now: ${ready.join(', ')} (read-only view; the daemon performs the promotion)`
        : 'none ready to promote yet.');
    return 0;
}
function reviewState(review, assetId) {
    return reviewRecord(review, assetId)?.state ?? 'approved';
}
function reviewRecord(review, assetId) {
    return review?.get?.(assetId) ?? null;
}
function stringArray(value) {
    return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}
function optionalString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function countLabel(value) {
    return Array.isArray(value) ? String(value.length) : '0';
}
function numberLabel(value) {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}
function reviewAuditLabel(record) {
    if (!record)
        return '';
    const parts = [];
    if (record.by)
        parts.push(`by=${record.by}`);
    if (record.reason)
        parts.push(`reason=${record.reason}`);
    if (record.at)
        parts.push(`at=${record.at}`);
    return parts.length > 0 ? `review ${parts.join(' ')}` : '';
}
async function listReviewVisibleAntiGenes(store, review) {
    const byAssetId = new Map();
    for (const asset of await store.list('AntiGene', 10_000))
        byAssetId.set(String(asset.asset_id), asset);
    for (const record of review?.records?.() ?? []) {
        if (byAssetId.has(record.assetId))
            continue;
        const asset = await store.get(record.assetId);
        if (asset?.type === 'AntiGene')
            byAssetId.set(record.assetId, asset);
    }
    return [...byAssetId.values()];
}
function antiWarningIdsFromDecision(event) {
    const payload = event.payload;
    const warnings = payload?.['antiWarnings'];
    if (!Array.isArray(warnings))
        return [];
    return warnings
        .map((warning) => warning && typeof warning === 'object' && !Array.isArray(warning)
        ? String(warning['antiGeneId'] ?? warning['assetId'] ?? '')
        : '')
        .filter(Boolean);
}
/**
 * `--anti-gene`: read-only visibility for the negative-memory side of #326. It intentionally does not approve,
 * reject, promote, quarantine, or alter selection. It only answers: what did shadow/enforce distill produce, what
 * is still pending review, and did approved warnings appear in real selection decisions yet?
 */
async function reportAntiGenes(deps, log) {
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = deps.review ?? new assetstore.ReviewLedger(events.assetsDir());
    const evts = (deps.readEvents ?? events.readEvents)();
    const assets = await listReviewVisibleAntiGenes(store, review);
    const injectedCounts = new Map();
    for (const event of evts.filter((e) => e.type === 'decision.gene_selected')) {
        for (const id of antiWarningIdsFromDecision(event)) {
            injectedCounts.set(id, (injectedCounts.get(id) ?? 0) + 1);
        }
    }
    const shadow = evts.filter((event) => event.type === 'anti_gene.distill_shadowed');
    const shadowCandidates = shadow.filter((event) => event.payload?.['status'] === 'candidate');
    const shadowDeclines = shadow.filter((event) => event.payload?.['status'] === 'declined');
    if (assets.length === 0 && shadow.length === 0) {
        log('anti-gene: no AntiGene assets or shadow observations recorded yet.');
        return 0;
    }
    const counts = { approved: 0, quarantined: 0, rejected: 0 };
    for (const asset of assets)
        counts[reviewState(review, String(asset.asset_id))] += 1;
    log(`anti-gene: ${assets.length} stored asset(s); review approved=${counts.approved} quarantined=${counts.quarantined} rejected=${counts.rejected}; shadow candidate=${shadowCandidates.length} declined=${shadowDeclines.length}`);
    for (const asset of assets) {
        const assetId = String(asset.asset_id);
        const id = typeof asset['id'] === 'string' ? String(asset['id']) : assetId;
        const record = reviewRecord(review, assetId);
        const state = record?.state ?? 'approved';
        const severity = optionalString(asset['severity']) ?? '-';
        const trigger = stringArray(asset['trigger']).slice(0, 6).join(',');
        const avoid = stringArray(asset['avoid']).slice(0, 2).join(' | ');
        const evidence = `failures=${numberLabel(asset['failure_count'])} clusters=${countLabel(asset['source_clusters'])} evidence=${countLabel(asset['evidence_capsules'])}`;
        const audit = reviewAuditLabel(record);
        const injected = (injectedCounts.get(id) ?? 0) + (id === assetId ? 0 : injectedCounts.get(assetId) ?? 0);
        const next = state === 'quarantined'
            ? 'approve with evolver review --approve before warning injection'
            : state === 'approved'
                ? (injected > 0 ? `observed in ${injected} decision(s)` : 'approved; waiting for matching selection')
                : 'rejected; withheld from warning injection';
        log(`  ${id}  {${state}} severity=${severity} trigger=${trigger || '-'} avoid=${avoid || '-'} ${evidence}${audit ? ` ${audit}` : ''}  ${next}`);
    }
    if (shadowCandidates.length > 0 || shadowDeclines.length > 0) {
        log(`shadow observations: candidate=${shadowCandidates.length} declined=${shadowDeclines.length} (shadow mode stores no AntiGene assets).`);
    }
    return 0;
}
/** Resolve a reuse-event id (logical `gene-a` OR content `sha256:…`) to the Gene's content asset_id, mirroring
 *  recall's resolveGene: a sha256 hits the index directly (guarded to a Gene), else a bounded Gene-only scan by
 *  logical id or asset_id. Returns null when no Gene matches. */
async function resolveGeneAssetId(store, id) {
    let g = id.startsWith('sha256:') ? await store.get(id) : null;
    if (g && g.type !== 'Gene')
        g = null;
    if (!g) {
        const genes = await store.list('Gene', 1000);
        g = genes.find((x) => String(x['id']) === id || String(x.asset_id) === id) ?? null;
    }
    return g ? String(g.asset_id) : null;
}
export async function runReuseReport(argv, deps = {}) {
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = (s) => { process.stderr.write(`${s}\n`); };
    const flags = parseFlags(argv);
    // `--promote` is a standalone, read-only probation view (review-ledger + cycle evidence), not derived from the
    // reuse-outcome rollup below — handle it first and return.
    if (flags.promote)
        return reportProbation(deps, log);
    if (flags.antiGene)
        return reportAntiGenes(deps, log);
    const evts = (deps.readEvents ?? events.readEvents)();
    const sum = ops.summarizeReuseOutcomes(evts);
    if (sum.total === 0) {
        log('reuse-report: no reuse outcomes recorded yet (agents report via evolver_asset_reuse_result).');
        return 0;
    }
    log(`reuse-report: ${sum.total} reuse outcome(s) across ${sum.perGene.length} gene(s)`);
    for (const g of sum.perGene) {
        const neg = Object.entries(g.byOutcome).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ');
        log(`  ${g.assetId}  success=${g.success} negative=${g.negative}${neg ? `  [${neg}]` : ''}`);
    }
    if (sum.pruneCandidates.length > 0) {
        log(`prune candidates (reused but never succeeded): ${sum.pruneCandidates.join(', ')}`);
    }
    if (!flags.quarantine)
        return 0;
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = deps.review ?? new assetstore.ReviewLedger(events.assetsDir());
    const meetsMargin = (c) => c.success === 0 && (c.negative >= flags.minNegative || c.unsafe >= flags.minUnsafe);
    // COMBINE counts per RESOLVED gene before applying the margin (#273 Bugbot): a gene's events can split across
    // its logical id and content asset_id, so judging each summary entry alone would quarantine a gene that actually
    // succeeded under its other id. Resolve every summary id to the Gene's asset_id, group + sum, THEN decide.
    const byGene = new Map();
    for (const g of sum.perGene) {
        const assetId = await resolveGeneAssetId(store, g.assetId);
        if (!assetId) {
            // Only warn for an id that WOULD have been a candidate on its own, so a real prune target isn't lost silently.
            if (meetsMargin({ success: g.success, negative: g.negative, unsafe: g.byOutcome.unsafe })) {
                err(`quarantine: gene not found in local store, skipped: ${g.assetId}`);
            }
            continue;
        }
        const agg = byGene.get(assetId) ?? { success: 0, negative: 0, unsafe: 0, ids: [] };
        agg.success += g.success;
        agg.negative += g.negative;
        agg.unsafe += g.byOutcome.unsafe;
        agg.ids.push(g.assetId);
        byGene.set(assetId, agg);
    }
    // Pha 2 v1 (operator-gated): quarantine genes with a STRONG, PERSISTENT negative signal — never on a single
    // failure. `success === 0` AND (negative >= minNegative OR unsafe >= minUnsafe); `unsafe` fires on a lower bar
    // because one unsafe reuse is a stronger signal than several plain failures.
    let quarantined = 0;
    for (const [assetId, c] of byGene) {
        if (!meetsMargin(c))
            continue;
        review.quarantine(assetId, `reuse-prune: 0 success / ${c.negative} negative (unsafe=${c.unsafe})`);
        quarantined += 1;
        log(`quarantined ${assetId} (from ${c.ids.join(', ')})`);
    }
    log(quarantined > 0
        ? `quarantine: ${quarantined} gene(s) sent to review (reversible via 'evolver review --approve').`
        : `quarantine: no gene meets the threshold (success=0 AND negative>=${flags.minNegative} OR unsafe>=${flags.minUnsafe}).`);
    return 0;
}
/** Registry-shaped handler (argv -> exit code). */
export const runReuseReportCommand = (argv) => runReuseReport(argv);