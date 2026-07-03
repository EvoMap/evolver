import { ops } from '@evomap/evolver-core';
type ModelPrice = ops.ModelPrice;
type PriceTable = ops.PriceTable;
/**
 * Load the model→price map from the JSON data file. A missing or malformed file degrades to an empty map (no
 * prices) rather than throwing — the ledger then reports tokens saved without a cost figure, never crashes.
 * @param path override the data-file location (tests / alternate price sets); defaults to the bundled file.
 */
export declare function loadModelPriceMap(path?: string): Record<string, ModelPrice>;
/**
 * Build the injectable PriceTable from the JSON data file. This is what the composition layer hands to the
 * value ledger's derive functions. Updating prices = editing modelPrices.json; this function and core are
 * untouched.
 */
export declare function loadPriceTable(path?: string): PriceTable;
export {};