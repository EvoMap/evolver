export declare function rewriteModel<T extends {
    model?: unknown;
}>(body: T, newModel: string): T;