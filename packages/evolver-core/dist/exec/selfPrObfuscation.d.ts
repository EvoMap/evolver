/** Reads the raw manifest text. Return null when absent/unreadable (treated as fail-closed). Inject in tests. */
export type ReadManifest = () => string | null;
/** Normalize a path for comparison: backslash→slash, strip leading `./`, trim. Mirrors v1 normalizeRel. */
export declare function normalizeManifestPath(filePath: string): string;
/** Default manifest reader: reads `<repoRoot>/public.manifest.json`, returning null on any failure. */
export declare function defaultReadManifest(repoRoot: string): ReadManifest;
/** Test/maintenance hook: drop any cached load for a reader (or all readers) so the load path re-runs. */
export declare function resetObfuscatedCache(reader?: ReadManifest): void;
/**
 * Load the obfuscated-file set from the manifest. Returns a normalized Set, or null when the manifest is
 * missing / unreadable / structurally invalid (NOT an `obfuscate` array of literal string paths). null is the
 * fail-closed signal: the caller must then reject all files. Result is cached per reader.
 */
export declare function loadObfuscatedFiles(readManifest: ReadManifest): Set<string> | null;
/**
 * Is `changedFile` one of the obfuscated files? FAIL-CLOSED: when the manifest can't be loaded (null) every
 * file is treated as obfuscated. Matching is on the normalized relative path (exact, segment-aware) — the
 * manifest holds literal file paths, so a similarly-named non-obfuscated file (e.g. "src/secret_helper.ts"
 * vs an obfuscated "src/secret.ts") is NOT a false positive.
 */
export declare function isObfuscatedFile(changedFile: string, readManifest: ReadManifest): boolean;