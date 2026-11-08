export interface ObservedCheck {
    command: string;
    /** Directory relative to the project root; absent for the root itself. */
    cwd?: string;
}
/**
 * Reduce a check command a host observed (`cd pkg && CI=1 timeout 600 pnpm test`) to the single invocation the
 * sandbox runs plus its working directory. Anything that needs a real shell to mean the same thing is refused
 * rather than approximated, so the verified command is exactly what the host ran. A trailing `2>&1` and a final
 * `| tail -N` or `| head -N` only shape what the host printed: the sandbox captures both streams and replays the check
 * itself, so its exit code is the check's own rather than the trimming filter's.
 */
export declare function normalizeObservedCheck(command: string, projectRoot: string): ObservedCheck | undefined;