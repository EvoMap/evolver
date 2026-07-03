export interface StrategyPreset {
    name: string;
    label: string;
    description: string;
    /** Target allocation ratios that inform the cycle's intent mix (sum ≈ 1). */
    repair: number;
    optimize: number;
    innovate: number;
    explore: number;
    /** Repair ratio over recent cycles that should force innovation to break a repair loop. */
    repairLoopThreshold: number;
}
export declare const STRATEGY_PRESETS: Record<string, StrategyPreset>;
export declare function strategyNames(): string[];
export interface ResolveStrategyInput {
    /** Explicit strategy (e.g. EVOLVE_STRATEGY). Undefined / 'balanced' / 'auto' enable auto-detection. */
    name?: string;
    /** Recent signal kinds (for saturation detection). */
    signals?: readonly string[];
    /** Current evolution cycle count (for the early-stabilize heuristic). */
    cycleCount?: number;
    /** Back-compat: forces 'innovate' when no explicit name is set. */
    forceInnovation?: boolean;
}
/**
 * Resolve the active strategy preset. Explicit name wins (unknown → balanced). Otherwise auto-detect:
 * first 1-5 cycles → early-stabilize; an innovate-pivot meta-signal (repair loop / high failure ratio) →
 * innovate; a saturation signal → steady-state (overrides both); forceInnovation → innovate. This is where
 * the history-derived meta-signals (see signals/metaSignals.ts) actually drive strategy adaptation.
 * Pure — no env/fs reads (the caller supplies the inputs).
 */
export declare function resolveStrategy(input?: ResolveStrategyInput): StrategyPreset;