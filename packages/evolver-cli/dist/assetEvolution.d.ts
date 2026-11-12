import { ops } from '@evomap/evolver-core';
export interface AssetEvolutionDeps {
    assetsDir?: string;
    readEvents?: () => readonly ops.EvolutionRootEvent[];
    now?: () => number;
    stdout?: (text: string) => void;
}
/** `evolver asset-evolution`: the local reuse/evolution read model as one versioned JSON envelope. */
export declare function runAssetEvolutionCommand(argv: readonly string[], deps?: AssetEvolutionDeps): Promise<number>;