// The read-side trust/review gate moved into evolver-core (assetstore.reviewFilter) so the MCP recall tool can
// share the EXACT same gate (#mcp-recall). Re-exported here so the existing cli import sites stay unchanged.
import { assetstore } from '@evomap/evolver-core';
export const reviewLedgerForStore = assetstore.reviewLedgerForStore;
export const provenanceStoreForStore = assetstore.provenanceStoreForStore;
export async function listApprovedGenes(store, review, maxGenes, provenance = provenanceStoreForStore(store), options = {}) {
    // 调用方绑定的 context 优先；仅未传 context 时使用 CLI 的进程默认值。
    const benchmark = options.benchmark === undefined
        ? assetstore.benchmarkContext(process.env['EVOLVER_BENCHMARK_ID'])
        : assetstore.benchmarkContext(options.benchmark.benchmarkId);
    if (options.benchmark !== undefined && !benchmark)
        throw new Error('invalid_benchmark_id');
    if (benchmark && (!Number.isSafeInteger(maxGenes) || maxGenes < 1))
        throw new Error('invalid_benchmark_gene_limit');
    // Cursor与SessionStart共享八条收据预算；不改变普通生产模式的调用方上限。
    return assetstore.listApprovedGenes(store, review, benchmark ? Math.min(maxGenes, 8) : maxGenes, provenance, { ...options, ...(benchmark ? { benchmark } : {}) });
}
export const pendingReviewRecords = assetstore.pendingReviewRecords;
export const pendingGeneReviewRecords = assetstore.pendingGeneReviewRecords;