import { reference } from '@evomap/evolver-core';
export interface ReferenceCliDeps {
    env?: NodeJS.ProcessEnv;
    store?: reference.ReferenceStore;
    hub?: reference.ReferenceCapability;
    stdout?: (line: string) => void;
}
export declare function runReferenceCommand(argv: readonly string[], deps?: ReferenceCliDeps): Promise<number>;