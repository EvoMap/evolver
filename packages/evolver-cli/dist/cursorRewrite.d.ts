import { assetstore, observers } from '@evomap/evolver-core';
import { formatCursorGeneLine, type CursorGene } from '@evomap/evolver-mcp';
/**
 * Map a stored gene asset onto the renderer's minimal CursorGene shape. Mirrors the CC SessionStart line voice
 * (id + category + a short hint = summary, else the first few signals_match) so cursor users see the same memory
 * the CC SessionStart hook would inject. Deterministic.
 */
export declare function geneToCursorGene(g: assetstore.AssetRecord): CursorGene;
export interface CursorRewriteWiring {
    /** EVOLVER_CURSOR_REWRITE !== '0' AND cursor injection is installed at the project root (default ON when both). */
    enabled: boolean;
    /** Why it is disabled (for the daemon's startup line): 'off' (env) | 'not-installed' | undefined when enabled. */
    reason?: 'off' | 'not-installed';
    /** The wired observer (null when disabled). */
    observer: ReturnType<typeof observers.cursorRewriteObserver> | null;
}
export interface CursorRewriteOptions {
    /** Project root that holds .cursor/rules/evolver.mdc. Default cwd (the daemon runs at the repo root). */
    projectRoot?: string;
    /** The asset store to read the gene pool from. Default the live ~/.evomap assets dir. */
    store?: assetstore.AssetStoreProvider;
    /** Review gate — withholds quarantined/rejected drafts from the rendered rules (A2a). Default the live ledger. */
    review?: assetstore.ReviewLedger;
    /** Provenance gate — withholds untrusted hub assets from rendered rules until promotion. */
    provenance?: assetstore.ProvenanceStore;
    /** Max genes rendered into the always-on body (token-tax bound). Default the installer's default (8). */
    maxGenes?: number;
    /** Debounce window (a cycle's burst of gene events ⇒ one rewrite). Default the observer's default (2s). */
    debounceMs?: number;
}
/**
 * Build the live cursor rewrite observer from the environment. Returns enabled=false (no observer) when
 * EVOLVER_CURSOR_REWRITE=0 OR cursor injection is not installed at `projectRoot` (the user never opted in). When
 * enabled, the injected `rewrite` callback reads the current top genes from the store and re-renders
 * .cursor/rules/evolver.mdc; the installer's own idempotency makes an unchanged gene set a true no-op (no write).
 */
export declare function resolveCursorRewriteObserver(env?: NodeJS.ProcessEnv, opts?: CursorRewriteOptions): CursorRewriteWiring;
/** Re-export for the installer composition: `setup-hooks --runtime=cursor` seeds evolver.mdc with the current
 *  top REVIEW-APPROVED genes (so the file is useful immediately, before the first daemon rewrite — without
 *  seeding an unapproved draft into the always-on rules, same gate as the live rewrite). */
export declare function currentTopCursorGenes(store: assetstore.AssetStoreProvider, review: assetstore.ReviewLedger, maxGenes?: number, provenance?: assetstore.ProvenanceStore): Promise<CursorGene[]>;
export { formatCursorGeneLine };