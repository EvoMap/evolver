import { applyPersonalityMutations } from './mutate.js';
import { normalizePersonalityState } from './schema.js';
/**
 * required: creativity +0.2 / risk_tolerance +0.15 (更激进)
 * suggested: creativity +0.15 / risk_tolerance +0.1
 */
export function forcePivot(input) {
    const severity = input.severity === 'required' ? 'required' : 'suggested';
    const evals = Number(input.evalsSinceImprovement) || 0;
    const mk = (param, delta, reason) => ({ type: 'PersonalityMutation', param, delta, reason });
    const proposals = severity === 'required'
        ? [
            mk('creativity', +0.2, `forced_pivot_required (plateau ${evals} evals)`),
            mk('risk_tolerance', +0.15, 'forced_pivot_exploration'),
        ]
        : [
            mk('creativity', +0.15, `pivot_suggested (plateau ${evals} evals)`),
            mk('risk_tolerance', +0.1, 'pivot_exploration_nudge'),
        ];
    const { state, applied } = applyPersonalityMutations(normalizePersonalityState(input.base), proposals);
    return { state, mutations: applied, severity };
}