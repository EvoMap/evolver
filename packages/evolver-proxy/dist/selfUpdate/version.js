// Current-version reader (ported from v1 forceUpdate.js getCurrentVersion). Reads package metadata so the daemon can:
// (a) report it on heartbeat (the hub sees each node's version), and (b) feed it to decideUpdate as `current`.
// Private workspace package.json files intentionally keep version 0.0.0; in that case we append git metadata so
// fleet inventory can still distinguish deployed builds. Best-effort fallback remains 0.0.0 and never throws.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { util } from '@evomap/evolver-core';
/** Resolve EVOLVER's own version. Walks up from this module to the nearest package.json named @evomap/evolver-proxy. */
export function getCurrentVersion() {
    return util.resolveRuntimeVersion({
        startDir: dirname(fileURLToPath(import.meta.url)),
        isPackage: (pkg) => pkg.name === '@evomap/evolver-proxy' || pkg.name === '@evomap/evolver',
    });
}