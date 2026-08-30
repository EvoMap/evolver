// Hub asset review (ported from v1 gep/hubReview.js). When an evolution cycle REUSED a hub asset, this submits
// a usage-verified review back to the hub after solidify — closing the quality-feedback loop so the hub can
// rank assets by whether reuse actually paid off (the evolver side of fetch→outcome attribution). Rating is
// derived from the cycle outcome: success → 4-5, failure → 1-2 (a constraint-violating reuse gets the worst
// rating, tying into the exec policy gate). Non-blocking: errors never affect solidify. Dedup via an injected
// history store. The hub POST is an injected ReviewSubmitter seam, so this is transport-agnostic and testable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** Derive a 1-5 rating from the cycle outcome. success→{5 if score≥0.85 else 4}; failure→{1 if constraint-violating else 2}. */
export function deriveRating(outcome, constraintCheck) {
    if (outcome && outcome.status === 'success') {
        const score = Number(outcome.score) || 0;
        return score >= 0.85 ? 5 : 4;
    }
    const violated = !!constraintCheck && Array.isArray(constraintCheck.violations) && constraintCheck.violations.length > 0;
    return violated ? 1 : 2;
}
/** Human-readable review body summarising the reuse outcome (capped 2000 chars). */
export function buildReviewContent({ outcome, gene, signals, blast, sourceType }) {
    const status = outcome?.status ?? 'unknown';
    const score = outcome && Number.isFinite(Number(outcome.score)) ? Number(outcome.score).toFixed(2) : '?';
    const parts = [`Outcome: ${status} (score: ${score})`, `Reuse mode: ${sourceType ?? 'unknown'}`];
    if (gene?.id)
        parts.push(`Gene: ${gene.id} (${gene.category ?? 'unknown'})`);
    if (Array.isArray(signals) && signals.length > 0)
        parts.push(`Signals: ${signals.slice(0, 6).join(', ')}`);
    if (blast)
        parts.push(`Blast radius: ${blast.files ?? 0} file(s), ${blast.lines ?? 0} line(s)`);
    parts.push(status === 'success'
        ? 'The fetched asset was successfully applied and solidified.'
        : 'The fetched asset did not lead to a successful evolution cycle.');
    return parts.join('\n').slice(0, 2000);
}
/**
 * Submit a usage-verified review for a reused hub asset. Skips when: not hub-sourced, no asset id, or already
 * reviewed. Never throws — a transport error is logged and swallowed (solidify must not be affected).
 */
export async function submitHubReview(deps, params) {
    const { reusedAssetId, sourceType, outcome, gene, signals, blast, constraintCheck, runId = null } = params;
    const now = deps.now ?? (() => Date.now());
    if (!reusedAssetId || typeof reusedAssetId !== 'string')
        return { submitted: false, reason: 'no_reused_asset_id' };
    if (sourceType !== 'reused' && sourceType !== 'reference')
        return { submitted: false, reason: 'not_hub_sourced' };
    if (deps.history?.has(reusedAssetId))
        return { submitted: false, reason: 'already_reviewed' };
    const rating = deriveRating(outcome, constraintCheck);
    const content = buildReviewContent({ outcome, gene, signals, blast, sourceType });
    try {
        const res = await deps.submit(reusedAssetId, { ...(deps.senderId ? { sender_id: deps.senderId } : {}), rating, content });
        if (res.ok) {
            deps.history?.mark(reusedAssetId, { rating, success: true, at: now() });
            deps.assetLog?.append({ run_id: runId, action: 'hub_review_submitted', asset_id: reusedAssetId, extra: { rating, outcome_status: outcome?.status } });
            return { submitted: true, rating, asset_id: reusedAssetId };
        }
        const errCode = res.error ?? `http_${res.status ?? 0}`;
        if (errCode === 'already_reviewed')
            deps.history?.mark(reusedAssetId, { rating, success: false, at: now() });
        deps.assetLog?.append({ run_id: runId, action: 'hub_review_rejected', asset_id: reusedAssetId, extra: { rating, error: errCode } });
        return { submitted: false, reason: errCode, rating };
    }
    catch (err) {
        const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'fetch_error';
        deps.assetLog?.append({ run_id: runId, action: 'hub_review_failed', asset_id: reusedAssetId, extra: { rating, reason, error: err instanceof Error ? err.message : String(err) } });
        return { submitted: false, reason, rating };
    }
}
const HISTORY_MAX = 500;
/** File-backed ReviewHistoryStore: a JSON map assetId → {at,rating,success}, capped to the most recent N (atomic write). */
export class FileReviewHistory {
    path;
    max;
    constructor(path, max = HISTORY_MAX) {
        this.path = path;
        this.max = max;
    }
    load() {
        try {
            if (!existsSync(this.path))
                return {};
            const raw = readFileSync(this.path, 'utf8').trim();
            return raw ? JSON.parse(raw) : {};
        }
        catch {
            return {};
        }
    }
    has(assetId) { return !!this.load()[assetId]; }
    mark(assetId, rec) {
        try {
            const history = this.load();
            history[assetId] = rec;
            const keys = Object.keys(history);
            if (keys.length > this.max) {
                const oldest = keys.map((k) => ({ k, t: history[k].at || 0 })).sort((a, b) => a.t - b.t).slice(0, keys.length - this.max);
                for (const { k } of oldest)
                    delete history[k];
            }
            mkdirSync(dirname(this.path), { recursive: true });
            const tmp = `${this.path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
            renameSync(tmp, this.path);
        }
        catch { /* non-fatal */ }
    }
}