export interface CliProcessLike {
    exitCode?: string | number | null;
    stderr: {
        write(chunk: string): unknown;
    };
}
export declare function settleCliProcess(run: () => Promise<number>, proc?: CliProcessLike): Promise<void>;