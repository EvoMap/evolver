// Read-union over one writable pool plus any number of read-only ones.
//
// Why a provider and not a helper: every evidence consumer already takes an AssetStoreProvider and calls
// `search`/`list` on it — aggregateLearningHistory, assessGenePublishEvidence, candidateAssembly,
// probationWouldPromote. Widening what they can see by threading a second store through each of them
// would fork four call chains and leave the next consumer to remember. Composing at the provider seam
// instead means they are untouched: whoever builds the store decides how wide the evidence pool is.
//
// Writes go to the primary and ONLY the primary. Reads merge, deduplicating by asset_id — records are
// content-addressed, so the same asset present in two pools is the same asset, and primary wins so a
// locally-verified record is never shadowed by a foreign copy.
const DEFAULT_LIMIT = 1000;
/**
 * Take from the queues one at a time in source order until `limit` is reached.
 *
 * Concatenating instead would let a mature primary fill every slot on its own — at the ~1000-record
 * limits the real callers pass (candidateAssembly, recall, reviewFilter), a local pool that size returns
 * ZERO foreign records and the union silently degrades back to the single-store blind spot it exists to
 * fix. Interleaving also refills: a source that runs out yields its remaining slots to the others, so a
 * small foreign pool never costs the result its cap.
 */
function interleave(queues, limit) {
    const out = [];
    for (let cursor = 0; out.length < limit; cursor += 1) {
        let advanced = false;
        for (const queue of queues) {
            const record = queue[cursor];
            if (record === undefined)
                continue;
            advanced = true;
            out.push(record);
            if (out.length >= limit)
                return out;
        }
        if (!advanced)
            return out;
    }
    return out;
}
export class UnionReadStore {
    primary;
    readOnly;
    // Mirrored as assigned-in-constructor properties rather than plain methods on purpose: the optional
    // write capabilities are feature-DETECTED by callers (`supportsAtomicConditionalPut`, and
    // `ingestUnverified`'s `putFrozen` probe). A method declared on the class is always present, so a
    // union wrapping a primary that lacks the capability would answer "supported" and then throw — the
    // undeclared-exception failure those probes exist to prevent. Assigning only when the primary has it
    // keeps the union exactly as capable as the pool it writes to.
    putConditional;
    putFrozen;
    putFrozenConditional;
    // Conditional for the same reason, on the read side: cliContracts.findLogicalAsset and
    // assetLineage.resolveAsset feature-detect this, and when it is absent fall back to a wide scan that
    // REPORTS truncation. Answering on behalf of a source that cannot resolve logical ids would strand
    // those callers on a narrow answer with no truncation signal — a silent "not found" where they would
    // otherwise have said "lookup is truncated; use an exact asset_id".
    findByLogicalId;
    /**
     * @param primary the writable pool this engine owns; every mutation lands here
     * @param readOnly additional pools to read, in precedence order after `primary`
     */
    constructor(primary, readOnly) {
        this.primary = primary;
        this.readOnly = readOnly;
        if ([primary, ...readOnly].every((source) => source.findByLogicalId)) {
            this.findByLogicalId = (id, limit = DEFAULT_LIMIT, kind) => this.merged((source) => source.findByLogicalId(id, limit, kind), limit);
        }
        const { putConditional, putFrozen, putFrozenConditional } = primary;
        if (putConditional)
            this.putConditional = (asset, options) => putConditional.call(primary, asset, options);
        if (putFrozen)
            this.putFrozen = (record) => putFrozen.call(primary, record);
        if (putFrozenConditional) {
            this.putFrozenConditional = (record, options) => putFrozenConditional.call(primary, record, options);
        }
    }
    get sources() {
        return [this.primary, ...this.readOnly];
    }
    /**
     * Merge one read across every source: deduplicate by asset_id with earlier sources winning, then fill
     * the result by {@link interleave} so every source gets a fair share of the cap.
     */
    async merged(read, limit) {
        const seen = new Set();
        const queues = [];
        for (const source of this.sources) {
            const unique = [];
            for (const record of await read(source)) {
                if (seen.has(record.asset_id))
                    continue;
                seen.add(record.asset_id);
                unique.push(record);
            }
            queues.push(unique);
        }
        return interleave(queues, limit);
    }
    async put(asset) {
        return this.primary.put(asset);
    }
    async get(assetId) {
        for (const source of this.sources) {
            const found = await source.get(assetId);
            if (found)
                return found;
        }
        return null;
    }
    async list(kind, limit = DEFAULT_LIMIT) {
        return this.merged((source) => source.list(kind, limit), limit);
    }
    async search(q) {
        return this.merged((source) => source.search(q), q.limit ?? DEFAULT_LIMIT);
    }
}