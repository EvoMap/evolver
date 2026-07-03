// Capability candidate extraction (ported from v1 src/gep/candidates.js). Mines NEW capability proposals
// from agent behavior — repeated tool calls, active opportunity signals, and clusters of failed evolutions —
// to feed the innovation step. Candidates are ADVISORY (the agent runtime decides whether to act, exactly
// as in v1); this is the self-growth path v2 otherwise lacks (v2 only scores EXISTING genes). Pure +
// deterministic: callers pass already-extracted tool-call names / signals / failed capsules; no time/io here.
import { expandSignals } from '../signals/expand.js';
const TOOL_CALL_MIN = 3;
const FAILURE_CLUSTER_MIN = 2;
const TITLE_MAX = 120;
const EVIDENCE_MAX = 240;
/** Predefined signal → candidate-title map (ported v1): defensive + opportunity signals. */
const SIGNAL_CANDIDATES = [
    { signal: 'log_error', title: 'Repair recurring runtime errors' },
    { signal: 'protocol_drift', title: 'Prevent protocol drift and enforce auditable outputs' },
    { signal: 'windows_shell_incompatible', title: 'Avoid platform-specific shell assumptions (Windows compatibility)' },
    { signal: 'session_logs_missing', title: 'Harden session log detection and fallback behavior' },
    { signal: 'user_feature_request', title: 'Implement user-requested feature' },
    { signal: 'user_improvement_suggestion', title: 'Apply user improvement suggestion' },
    { signal: 'perf_bottleneck', title: 'Resolve performance bottleneck' },
    { signal: 'capability_gap', title: 'Fill capability gap' },
    { signal: 'stable_success_plateau', title: 'Explore new strategies during stability plateau' },
    { signal: 'external_opportunity', title: 'Evaluate external A2A asset for local adoption' },
];
/** Highest → lowest priority problem class used to pick a failure cluster's grouping key (ported v1). */
const PROBLEM_PRIORITY = ['problem:performance', 'problem:protocol', 'problem:reliability', 'problem:stagnation', 'problem:capability'];
/** FNV-1a 32-bit stable hash (ported v1 hash.js) — deterministic candidate ids. */
function stableHash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
/** Build the fixed five-question shape (ported v1): only title/params/evidence vary per candidate. */
function buildShape(title, signals, evidence) {
    const params = `Signals: ${signals.join(', ')}`.trim();
    return {
        title: clip(title, TITLE_MAX),
        input: 'Recent session transcript + memory snippets + user instructions',
        output: 'A safe, auditable evolution patch guided by GEP assets',
        invariants: 'Protocol order, small reversible patches, validation, append-only events',
        params: params || 'Signals: (none)',
        failure_points: 'Missing signals, over-broad changes, skipped validation, missing knowledge solidification',
        evidence: clip(evidence, EVIDENCE_MAX),
    };
}
function candidate(source, id, title, signals, evidence, tags) {
    return { type: 'CapabilityCandidate', id: `cand_${id}`, title, source, signals, tags, shape: buildShape(title, signals, evidence) };
}
function failureTitle(tags) {
    if (tags.includes('problem:performance'))
        return 'Resolve recurring performance regressions';
    if (tags.includes('problem:protocol'))
        return 'Prevent recurring protocol and validation regressions';
    if (tags.includes('problem:reliability'))
        return 'Repair recurring reliability failures';
    if (tags.includes('problem:stagnation'))
        return 'Break repeated stagnation loops with a new strategy';
    if (tags.includes('area:orchestration'))
        return 'Stabilize task and orchestration behavior';
    return 'Learn from recurring failed evolution paths';
}
/**
 * Mine capability candidates from three sources (ported v1): repeated tool calls (>=3), active opportunity
 * signals, and clusters of failed capsules (>=2 in the same dominant-problem group). Deduped by stable id.
 */
export function extractCapabilityCandidates(inp) {
    const signals = (inp.signals ?? []).map((s) => String(s));
    const signalTags = expandSignals(signals);
    const out = [];
    // A. Tool-call mining: a tool used >= TOOL_CALL_MIN times suggests a reusable capability.
    const freq = new Map();
    for (const t of inp.toolCalls ?? [])
        freq.set(t, (freq.get(t) ?? 0) + 1);
    for (const [tool, count] of freq) {
        if (count < TOOL_CALL_MIN)
            continue;
        const title = `Repeated tool usage: ${tool}`;
        out.push(candidate('transcript', stableHash(title), title, signals, `Observed ${count} occurrences of tool call ${tool}.`, signalTags));
    }
    // B. Signal-mapped candidates: predefined defensive/opportunity signals.
    for (const sc of SIGNAL_CANDIDATES) {
        if (!signals.some((s) => s === sc.signal || s.startsWith(sc.signal + ':')))
            continue;
        out.push(candidate('signals', stableHash(sc.signal), sc.title, signals, `Signal ${sc.signal} active.`, signalTags));
    }
    // C. Failure clustering: group failed capsules by dominant problem class.
    const groups = new Map();
    for (const fc of inp.failedCapsules ?? []) {
        if (fc.outcome?.status === 'success')
            continue;
        const reason = String(fc.failure_reason ?? '').trim();
        const failureTags = expandSignals([...(fc.trigger ?? []), ...signals], reason).filter((t) => /^(problem|risk|area|action):/.test(t));
        if (failureTags.length === 0)
            continue;
        let dominant = null;
        for (const p of PROBLEM_PRIORITY)
            if (failureTags.includes(p)) {
                dominant = p;
                break;
            }
        const grouping = dominant ? [dominant] : failureTags.filter((t) => t.startsWith('area:') || t.startsWith('risk:')).slice(0, 1);
        const key = grouping.join('|');
        if (!key)
            continue;
        const g = groups.get(key) ?? { count: 0, tags: failureTags, reasons: [] };
        g.count += 1;
        if (reason)
            g.reasons.push(reason);
        groups.set(key, g);
    }
    for (const [key, g] of groups) {
        if (g.count < FAILURE_CLUSTER_MIN)
            continue;
        const title = failureTitle(g.tags);
        const evidence = `${g.count} recurring failures${g.reasons.length ? ` (${g.reasons.slice(0, 2).join('; ')})` : ''}`;
        out.push(candidate('failed_capsules', stableHash('failed:' + key), title, signals, evidence, g.tags));
    }
    // Dedup by stable id (first occurrence wins).
    const seen = new Set();
    const deduped = [];
    for (const c of out) {
        if (seen.has(c.id))
            continue;
        seen.add(c.id);
        deduped.push(c);
    }
    return deduped;
}