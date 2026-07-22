export interface LegacyNodeIdCandidateOptions {
    /** Test seam for platform-independent home probing; production uses os.homedir(). */
    homeDir?: string;
    /** Test seam for source/dist/package-layout probing; production uses this module dir. */
    moduleDir?: string;
    /** Test seam for override-aware evomap home; production resolves env overrides at call time. */
    evomapHomeDir?: string;
    /** Test seam for the EVOMAP_DIR root; production reads process.env['EVOMAP_DIR'] at call time. */
    evomapDir?: string;
}
/**
 * Legacy node_id file locations, in priority order. Mirror of v1
 * `_loadPersistedNodeId`:
 *
 *  0. `<EVOMAP_DIR>/node_id` — the explicit dir the CLI recipe / ATP / proxy
 *     anti-abuse code write under (`recipeHomeCandidates` puts EVOMAP_DIR ahead
 *     of EVOLVER_HOME/EVOMAP_HOME). `resolveEvomapHome` never consults EVOMAP_DIR,
 *     so a deployment that pivots on it would otherwise send no node_id on hello
 *     and let the hub mint a duplicate. Probed FIRST and ADDITIVELY (the
 *     EVOLVER_HOME/EVOMAP_HOME candidates below are kept), so setting EVOMAP_DIR
 *     never hides an id that lives under one of the home overrides. Deduped.
 *  1. `<identity home>/node_id` — the override-aware home files. `identityHomeCandidates()`
 *     probes EVOMAP_HOME first (THE identity home, #555 T2 — the evox agentDir split keeps
 *     node files under `<agentDir>/evomap` while EVOLVER_HOME points at the state root) and
 *     then EVOLVER_HOME (matching v1 `getEvomapDir`), after dropping blank/relative
 *     overrides. Probing both keeps the v1 #120 lesson — the reader walks every dir a
 *     writer may have used — while the order makes a split identity dir win over the
 *     state root when both hold files.
 *  2. `~/.evomap/node_id` — the UNCONDITIONAL v1 location. v1's writer pivots on
 *     `getEvomapDir` = `EVOLVER_HOME || ~/.evomap` and ignores EVOMAP_HOME
 *     entirely, so unless EVOLVER_HOME was set a v1 file always physically lands
 *     here. We probe it explicitly so a v2 install that sets only EVOMAP_HOME
 *     (which steers candidate 1 away from `~/.evomap`) still recovers the v1
 *     identity instead of letting the hub mint a duplicate orphan node. Deduped
 *     against candidate 1 for the common no-override case where they coincide.
 *  3. `<proxy package>/.evomap_node_id` — the install-root file the writer falls
 *     back to when `~/.evomap/` isn't writable (read-only $HOME in
 *     containers / restricted CI). Kept first for parity with the old v2
 *     candidate.
 *  4. `<outer package/workspace root>/.evomap_node_id` — the v1/outer install
 *     root fallback. In v2's multi-package layout the proxy code lives below
 *     `packages/evolver-proxy`, so only checking the proxy package root misses
 *     a file written at the install/workspace root.
 *
 * Resolved on every call rather than cached at module load: env and `homedir()`
 * are read at call time, so caching would freeze the home path and silently
 * ignore a later EVOLVER_HOME/EVOMAP_HOME change (this is also how the tests
 * point it at a tmp dir). The install-root paths use a bounded package.json walk
 * from the module dir so source and dist layouts both work.
 */
export declare function legacyNodeIdCandidates(opts?: LegacyNodeIdCandidateOptions): string[];
export interface ReadLegacyNodeIdOptions extends LegacyNodeIdCandidateOptions {
    /** Override the candidate file list (tests inject tmp paths). */
    candidates?: string[];
}
/**
 * Recover a node_id persisted by the legacy v1 GEP path. Returns the first
 * candidate file whose trimmed contents match NODE_ID_RE, else `undefined`.
 *
 * Why this exists (PORT v1 #117): v2 resolves the wire node_id as
 * `store.node_id ?? EVOMAP_NODE_ID/A2A_NODE_ID`. When BOTH are empty the
 * `/a2a/hello` payload carries no `node_id` and the hub MINTS A FRESH A2ANode,
 * which the lifecycle manager then persists. So any install whose mailbox
 * store was created (or wiped) after a v1 `~/.evomap/node_id` already existed —
 * an upgrade from a pre-lifecycle version, or a partial recovery flow —
 * silently registers a brand-new node under the same owner on the very next
 * daemon boot, abandoning the original record (with its stake / reputation /
 * aliases) as an orphan in the web UI. Reading the legacy file between the
 * store/env lookup and the hub mint keeps both code paths agreeing on a single
 * identity.
 */
export declare function readLegacyNodeId(opts?: ReadLegacyNodeIdOptions): string | undefined;
export interface ResolveProxyNodeIdOptions {
    /** Persisted store value (`store.getState('node_id')`). */
    storedNodeId: string | undefined;
    /** Operator env override (`EVOMAP_NODE_ID` / `A2A_NODE_ID`). */
    configuredNodeId: string | undefined;
    /** Legacy-file reader seam (defaults to {@link readLegacyNodeId}). */
    readLegacy?: () => string | undefined;
}
/**
 * Resolve the node_id the proxy presents on the wire, in priority order:
 * persisted store value → operator env override → recovered legacy file →
 * `undefined` (the hub mints a fresh id on hello). An explicit env override
 * outranks the legacy file because the operator set it deliberately.
 *
 * The legacy read only fires while the store is unprimed AND no env override
 * is set — the first-boot window before a successful hello persists an id.
 * Already-registered nodes short-circuit on the store value and never touch
 * the filesystem.
 *
 * Empty / whitespace store and env values are normalised to `undefined` first:
 * `??` alone treats `''` as a present value, so a blank `EVOMAP_NODE_ID=` (or a
 * store cleared to `''`) would otherwise suppress legacy recovery and put a
 * blank id on the wire — the exact orphan-node failure this module prevents.
 */
export declare function resolveProxyNodeId(opts: ResolveProxyNodeIdOptions): string | undefined;