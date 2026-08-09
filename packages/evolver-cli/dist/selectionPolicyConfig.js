/** Unknown values fail safe to the current production policy. */
export function selectionPolicyFromEnv(env = process.env) {
    const value = env['EVOLVER_SELECTION_POLICY']?.trim().toLowerCase();
    return value === 'ucb1-shadow' || value === 'ucb1' ? value : 'engine-health';
}
/** Unknown values fail safe to the production relevance guard. */
export function selectionGuardFromEnv(env = process.env) {
    const value = env['EVOLVER_SELECTION_GUARD']?.trim().toLowerCase();
    return value === 'legacy' || value === 'shadow' ? value : 'enforce';
}
/** Optional score floor. Invalid values are omitted so core keeps its declared default. */
export function selectionFloorFromEnv(env = process.env) {
    const raw = env['EVOLVER_SELECTION_FLOOR']?.trim();
    if (!raw)
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}