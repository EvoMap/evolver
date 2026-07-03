import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { util } from '@evomap/evolver-core';
function isEvolverCliPackage(pkg) {
    return pkg.name === '@evomap/evolver-cli'
        || (typeof pkg.bin === 'object' && typeof pkg.bin['evolver'] === 'string');
}
/** Resolve the installed evolver CLI version from the nearest package metadata. */
export function getCliVersion() {
    return util.resolveRuntimeVersion({
        startDir: dirname(fileURLToPath(import.meta.url)),
        isPackage: isEvolverCliPackage,
    });
}