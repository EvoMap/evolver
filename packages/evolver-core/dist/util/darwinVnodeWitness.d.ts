export declare class DarwinVnodeWitnessError extends Error {
    readonly code: 'changed' | 'unavailable' | 'unconfirmed' | 'cleanup_failed';
    constructor(code: 'changed' | 'unavailable' | 'unconfirmed' | 'cleanup_failed', options?: ErrorOptions);
}
export interface DarwinVnodeBinding {
    path: string;
    dev: bigint;
    ino: bigint;
}
export interface DarwinVnodeWitness {
    assertUnchanged(): void;
    close(): void;
}
/** Zero-time kernel observations of the actual bound inodes; no FSEvents latency or timestamp inference. */
export declare function createDarwinVnodeWitness(bindings: readonly DarwinVnodeBinding[]): DarwinVnodeWitness;