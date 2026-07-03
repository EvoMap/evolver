// Model price DATA loader (#112). The price table is a DATA FILE (modelPrices.json) the adapter loads and
// injects into core's value ledger as a PriceTable. Core hardcodes no price — so a price update is editing the
// JSON next to this file, never a core code change (acceptance criterion). This loader is the only code that
// reads the file; it tolerates a missing/corrupt file by degrading to an empty table (an unlisted model simply
// contributes no cost to the ledger — never a thrown error in a long-running daemon).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ops } from '@evomap/evolver-core';
/** Resolve the JSON data file next to this module (works from src under test and dist at runtime). */
function defaultPricesPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'modelPrices.json');
}
/**
 * Load the model→price map from the JSON data file. A missing or malformed file degrades to an empty map (no
 * prices) rather than throwing — the ledger then reports tokens saved without a cost figure, never crashes.
 * @param path override the data-file location (tests / alternate price sets); defaults to the bundled file.
 */
export function loadModelPriceMap(path = defaultPricesPath()) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const models = parsed.models;
        if (!models || typeof models !== 'object')
            return {};
        const out = {};
        for (const [model, price] of Object.entries(models)) {
            if (price && typeof price === 'object')
                out[model] = price;
        }
        return out;
    }
    catch {
        return {};
    }
}
/**
 * Build the injectable PriceTable from the JSON data file. This is what the composition layer hands to the
 * value ledger's derive functions. Updating prices = editing modelPrices.json; this function and core are
 * untouched.
 */
export function loadPriceTable(path) {
    return ops.priceTableFromMap(loadModelPriceMap(path));
}