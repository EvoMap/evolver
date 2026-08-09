type CapabilityGapsEnv = Readonly<Record<string, string | undefined>>;
export declare function resolveCurriculumMailboxPath(env?: CapabilityGapsEnv): string;
/** Read one immutable lifecycle snapshot per curriculum preparation without creating a proxy database. */
export declare function readPersistedCapabilityGaps(env?: CapabilityGapsEnv): string[];
export declare function makeCurriculumCapabilityGapsProvider(env?: CapabilityGapsEnv): () => readonly string[];
export {};