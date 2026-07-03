export declare class MaterialBoundaryError extends Error {
    constructor(msg: string);
}
export declare function assertMaterialSource(m: {
    sourcePath: string;
    kind: string;
}): void;