// Evolution strategy presets (ported from v1 gep/strategy.js). An operator-selectable POSTURE that biases the
// repair/optimize/innovate/explore mix for a cycle — "harden after a big change", "repair-only emergency",
// "innovate when stable" — plus a repair-loop threshold. resolveStrategy is pure + fully input-driven (the
// caller supplies the chosen name, recent signals, and cycle count from env/state); auto-detection picks
// early-stabilize for the first few cycles and steady-state when saturation signals appear.
export const STRATEGY_PRESETS = {
    balanced: { name: 'balanced', label: 'Balanced', description: 'Normal operation. Steady growth with stability.', repair: 0.2, optimize: 0.2, innovate: 0.5, explore: 0.1, repairLoopThreshold: 0.5 },
    innovate: { name: 'innovate', label: 'Innovation Focus', description: 'System is stable. Maximize new features and capabilities.', repair: 0.05, optimize: 0.1, innovate: 0.8, explore: 0.05, repairLoopThreshold: 0.3 },
    harden: { name: 'harden', label: 'Hardening', description: 'After a big change. Focus on stability and robustness.', repair: 0.4, optimize: 0.35, innovate: 0.2, explore: 0.05, repairLoopThreshold: 0.7 },
    'repair-only': { name: 'repair-only', label: 'Repair Only', description: 'Emergency. Fix everything before doing anything else.', repair: 0.8, optimize: 0.18, innovate: 0.0, explore: 0.02, repairLoopThreshold: 1.0 },
    'early-stabilize': { name: 'early-stabilize', label: 'Early Stabilization', description: 'First cycles. Prioritize fixing existing issues before innovating.', repair: 0.6, optimize: 0.22, innovate: 0.15, explore: 0.03, repairLoopThreshold: 0.8 },
    'steady-state': { name: 'steady-state', label: 'Steady State', description: 'Evolution saturated. Maintain existing capabilities. Explore for new directions.', repair: 0.55, optimize: 0.25, innovate: 0.05, explore: 0.15, repairLoopThreshold: 0.9 },
};
export function strategyNames() {
    return Object.keys(STRATEGY_PRESETS);
}
/** Saturation meta-signals that switch auto-detection to steady-state (graceful degradation). */
const SATURATION_SIGNALS = new Set(['force_steady_state', 'evolution_saturation']);
/**
 * Meta-signals that mean "stuck repairing / failing — break out by innovating" (ported from v1 strategy.js
 * intent: a repair loop or a high failure ratio should pivot the posture off repair toward new directions).
 * Saturation takes precedence (it wins when both are present, matching v1's steady-state-on-saturation rule).
 */
const INNOVATE_PIVOT_SIGNALS = new Set([
    'repair_loop_detected',
    'force_innovation_after_repair_loop',
    'high_failure_ratio',
]);
/**
 * Resolve the active strategy preset. Explicit name wins (unknown → balanced). Otherwise auto-detect:
 * first 1-5 cycles → early-stabilize; an innovate-pivot meta-signal (repair loop / high failure ratio) →
 * innovate; a saturation signal → steady-state (overrides both); forceInnovation → innovate. This is where
 * the history-derived meta-signals (see signals/metaSignals.ts) actually drive strategy adaptation.
 * Pure — no env/fs reads (the caller supplies the inputs).
 */
export function resolveStrategy(input = {}) {
    const explicit = typeof input.name === 'string' && input.name.trim() !== '';
    let name = (explicit ? input.name : 'balanced').toLowerCase().trim();
    let forceInnovation = false;
    if (!explicit && input.forceInnovation) {
        name = 'innovate';
        forceInnovation = true;
    }
    const isDefault = !explicit || name === 'balanced' || name === 'auto';
    if (isDefault && !forceInnovation) {
        const signals = input.signals ?? [];
        const cycleCount = input.cycleCount ?? 0;
        if (cycleCount > 0 && cycleCount <= 5)
            name = 'early-stabilize';
        // Stuck repairing / failing → pivot to innovate to break the loop (v1 strategy.js intent).
        if (signals.some((s) => INNOVATE_PIVOT_SIGNALS.has(s)))
            name = 'innovate';
        // Saturation → steady-state. Last so it overrides early-stabilize AND the innovate pivot:
        // when the loop has exhausted its innovation space, hardening/maintenance beats more innovation.
        if (signals.some((s) => SATURATION_SIGNALS.has(s)))
            name = 'steady-state';
    }
    if (name === 'auto')
        name = 'balanced';
    return STRATEGY_PRESETS[name] ?? STRATEGY_PRESETS['balanced'];
}