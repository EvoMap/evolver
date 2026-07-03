// The read-side trust/review gate moved into evolver-core (assetstore.reviewFilter) so the MCP recall tool can
// share the EXACT same gate (#mcp-recall). Re-exported here so the existing cli import sites stay unchanged.
import { assetstore } from '@evomap/evolver-core';
export const reviewLedgerForStore = assetstore.reviewLedgerForStore;
export const provenanceStoreForStore = assetstore.provenanceStoreForStore;
export const listApprovedGenes = assetstore.listApprovedGenes;