// Local root-cause triage for cycle failures (ported from v1 src/gep/issueReporter.js: classifyFailure, V1 PR #279).
//
// V1 #279 split signal-side (zero-blast cycles no longer feed failure-loop) from issue-reporter-side (triage host vs.
// evolver faults before opening a public issue). V2 #216 already ported the signal-side via the inert-gene path
// (producedValue===false → 'inert' in confidence/inertBan). This module is the missing issue-reporter half: it
// classifies a cycle failure into one of four buckets so downstream consumers (CLI/issue-reporter, hub UI, telemetry)
// can split confidently-host-side failures from genuine local-gene failures.
//
// Pure function — same input shape V1 used (signals, recentEvents, sessionLog). Inert-handling in cycleEngine
// (#216) is untouched; if the cycle engine threads context here at the failed-write site, the classification is
// written to the cycle.failed event payload as `failure_class`. Otherwise it is purely opt-in / advisory.
import { isDistilledGeneId } from './geneIntake.js';
// "[NO SESSION LOGS FOUND]" et al. — the host gave evolver nothing to evolve from.
const HOST_NO_TRANSCRIPT_RE = /\[no session logs? found\]|no session log|no transcript/i;
// Host LLM-provider errors. None of these strings are emitted by evolver core (v1 #279 verified the same;
// keeping the regex byte-for-byte equivalent), so their presence means the host Agent's provider call failed.
const HOST_PROVIDER_ERR_RE = /\bLLM ERROR\b|\bMaxTokens\b|field MaxTokens|max_tokens[^\n]{0,24}invalid|insufficient_quota|invalid_api_key|\brate limit(?:ed| exceeded)?\b|quota exceeded|context length exceeded|maximum context length/i;
// Locality prefixes a "locally-generated" gene id can carry:
//  - `gene_distilled_` — the ONLY prefix V2 actually mints (geneIntake.DISTILLED_ID_PREFIX,
//    surfaced via isDistilledGeneId). Without this the whole `local_gene_no_blast` bucket never
//    fired for real V2 genes (they all carry this prefix). Reuse the single-source-of-truth helper.
//  - `gene_auto_` — V1-only legacy form (V2 never produces it); kept so V1-shaped inputs still match.
//  - `sha256:` — a content asset_id (not a logical gene id); kept for back-compat / loose callers.
function isLocalGeneratedGene(geneId) {
    return isDistilledGeneId(geneId) || /^sha256:/.test(geneId) || /^gene_auto_/.test(geneId);
}
function eventBlast(e) {
    return e.blast_radius ?? e.blastRadius;
}
function isZeroBlast(e) {
    const br = eventBlast(e);
    return Boolean(e.meta?.empty_cycle) || (br !== undefined && br.files === 0 && br.lines === 0);
}
// NB: blast={files:0,lines:0} only means "real no-op" when it came from a git_diff proof. solidify.ts forces
// blast to {0,0} for non-git_diff proofs (artifact_hash/external_receipt/tool_call_trace), where it signals
// "blast unknown", not "no change". The cycleEngine guard only forwards blastRadius for git_diff proofs, so by
// the time we see a defined br here it is a true measured zero. If a caller ever passes a non-git_diff blast
// directly, this would mis-classify a productive run as no-op — keep the git_diff guard at the call site.
function blastIsZero(br) {
    return br !== undefined && br.files === 0 && br.lines === 0;
}
function localNoBlastReason(geneId) {
    return {
        failureClass: 'local_gene_no_blast',
        reason: `locally-generated gene ${geneId.slice(0, 20)}… produces no blast radius`,
    };
}
/**
 * Triage a cycle failure into a root-cause bucket. Default-open: if no rule fires, returns 'unclassified',
 * which means "treat this as a real evolver bug" (so unclassified faults are never hidden).
 *
 * Pure — does not read filesystem, env, or events store.
 */
export function classifyCycleFailure(opts) {
    const signals = Array.isArray(opts?.signals) ? opts.signals : [];
    const events = Array.isArray(opts?.recentEvents) ? opts.recentEvents : [];
    const hasSessionLog = typeof opts?.sessionLog === 'string';
    const log = hasSessionLog ? opts.sessionLog : undefined;
    // (a) No transcript -> the host gave evolver nothing to evolve from.
    if (hasSessionLog && (!log.trim() || HOST_NO_TRANSCRIPT_RE.test(log))) {
        return { failureClass: 'host_no_transcript', reason: 'no session transcript to evolve from' };
    }
    // (b) Host LLM-provider error surfaced in the transcript.
    const prov = hasSessionLog ? log.match(HOST_PROVIDER_ERR_RE) : null;
    if (prov) {
        return { failureClass: 'host_provider_error', reason: `host LLM-provider error: ${String(prov[0]).slice(0, 60)}` };
    }
    // (c-v2) V2 hard-bans/filters local no-op genes instead of emitting a soft ban_gene signal. Use the current
    // failed gene + current blast radius when the engine supplies them, while keeping the legacy ban_gene branch below.
    const currentGeneId = typeof opts?.geneId === 'string' ? opts.geneId : undefined;
    if (currentGeneId && isLocalGeneratedGene(currentGeneId)) {
        if (blastIsZero(opts?.blastRadius))
            return localNoBlastReason(currentGeneId);
        const failedForGene = events.filter((e) => e.outcome?.status === 'failed' && (e.gene === undefined || e.gene === currentGeneId));
        if (failedForGene.length > 0 && failedForGene.every(isZeroBlast))
            return localNoBlastReason(currentGeneId);
    }
    if (!currentGeneId) {
        const failedLocalEvents = events.filter((e) => e.outcome?.status === 'failed' && typeof e.gene === 'string' && isLocalGeneratedGene(e.gene));
        for (const e of failedLocalEvents) {
            if (e.gene && isZeroBlast(e))
                return localNoBlastReason(e.gene);
        }
    }
    // (c) The banned gene is locally generated AND every recent failing cycle changed nothing — a no-op gene,
    //     not an evolver bug. (V2 #216 already drops such genes via the inert ban; this is the issue-reporter
    //     analogue, classifying after a failure_loop fires anyway.)
    const banned = signals.find((s) => typeof s === 'string' && s.startsWith('ban_gene:'));
    if (banned) {
        const geneId = banned.replace('ban_gene:', '');
        const failed = events.filter((e) => e?.outcome?.status === 'failed');
        const allZeroBlast = failed.length > 0 && failed.every(isZeroBlast);
        if (isLocalGeneratedGene(geneId) && allZeroBlast) {
            return localNoBlastReason(geneId);
        }
    }
    return { failureClass: 'unclassified', reason: '' };
}
/** Buckets we are confident are host-side; everything else is default-open (filed / surfaced). */
export const HOST_SUPPRESS_CLASSES = new Set([
    'host_no_transcript',
    'host_provider_error',
    'local_gene_no_blast',
]);