type CompatHandler = (argv: readonly string[]) => Promise<number>;
type WebuiCompatHandler = (argv: readonly string[], options: {
    eaddrinusePortAttempts: number;
}) => Promise<number>;
export interface V1CompatDeps {
    autoexec?: CompatHandler;
    cycle?: CompatHandler;
    dashboard?: WebuiCompatHandler;
    skill?: CompatHandler;
    cwd?: () => string;
    env?: NodeJS.ProcessEnv;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export declare const V1_COMPAT_LIFECYCLE: {
    readonly supportedThrough: "2.x";
    readonly earliestRemoval: "3.0.0";
    readonly removalNotice: "at least one public 2.x release";
};
export declare function runV1RunCompat(argv: readonly string[], deps?: V1CompatDeps): Promise<number>;
export declare function runV1SolidifyCompat(argv: readonly string[], deps?: V1CompatDeps): Promise<number>;
export declare function runV1FetchCompat(argv: readonly string[], deps?: V1CompatDeps): Promise<number>;
export declare function runV1WebuiCompat(argv: readonly string[], deps?: V1CompatDeps): Promise<number>;
export declare function runV1ExecCompat(argv: readonly string[], deps?: V1CompatDeps): Promise<number>;
export {};