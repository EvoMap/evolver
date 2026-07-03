// Ban genes that have repeatedly failed on the SAME signals (ported from v1 selector.js
// banGenesFromFailedCapsules). Complements epigenetic suppression (which is per-environment): this is a
// hard, signal-overlap-based exclusion — a gene with >=2 failed capsules whose trigger covers the current
// signals is dropped from the candidate set, so a strategy that keeps failing here is not resurrected.
const BAN_THRESHOLD = 2;
const OVERLAP_MIN = 0.6;
/** Fraction of the current signals covered by a failure's trigger (how much it is "the same problem"). */
function signalCoverage(signals, trigger) {
    if (signals.length === 0)
        return 0;
    const t = new Set(trigger.map((s) => String(s)));
    let hit = 0;
    for (const s of signals)
        if (t.has(s))
            hit += 1;
    return hit / signals.length;
}
/** Gene ids with >=2 failed capsules whose trigger covers >=60% of the current signals. */
export function bannedGenesFromFailures(failures, signals) {
    const counts = new Map();
    for (const fc of failures) {
        if (!fc.gene)
            continue;
        if (signalCoverage(signals, fc.trigger ?? []) < OVERLAP_MIN)
            continue;
        counts.set(fc.gene, (counts.get(fc.gene) ?? 0) + 1);
    }
    const banned = new Set();
    for (const [gene, c] of counts)
        if (c >= BAN_THRESHOLD)
            banned.add(gene);
    return banned;
}