export type CommandHandler = (argv: string[]) => Promise<number>;
/** Verbs dispatched asynchronously ahead of the synchronous runCli core. cli.ts drives its dispatch from this. */
export declare const ASYNC_COMMANDS: Readonly<Record<string, CommandHandler>>;
/** Verbs handled by the synchronous runCli core (read-only views + local ops). Kept in sync with runCli's switch
 *  — the source of truth for these stays runCli; this list completes the surface for the registry contract. */
export declare const SYNC_COMMANDS: readonly ["status", "cycles", "trigger", "value", "narrative", "retention", "gene-value", "replay", "rebuild-views", "reset-local-secret"];
/** Every top-level verb `evolver` resolves to (async-dispatched ∪ runCli core). */
export declare const ALL_COMMANDS: ReadonlySet<string>;
export declare function v1TopLevelRunArgs(argv: readonly string[]): readonly string[] | undefined;
/** Run a top-level argv against the registry: async handler if present, else the synchronous runCli core. */
export declare function dispatch(argv: readonly string[]): Promise<number> | number;