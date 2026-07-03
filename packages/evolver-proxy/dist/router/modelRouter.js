// Multi-tier model router (ported from v1 proxy/router/model_router.js, itself a port of the EvoX Rust
// model_router.rs). Given stateless per-turn features, it picks a cost tier (cheap/mid/expensive) for an
// Anthropic /v1/messages turn so cheap turns (summarising tool output, trivial lookups) don't burn the
// expensive model and planning / high-tool-density turns get it.
//
// Field names are snake_case ON PURPOSE: they mirror the Rust router + its JSON fixture, and branch order is
// a parity invariant (post_tool_result_synthesis must win over high_tool_use_density). Pure + deterministic.
export const REASONS = {
    ROUTER_DISABLED: 'router_disabled',
    HARD_PINNED: 'hard_pinned',
    GENE_HINT: 'gene_hint',
    POST_TOOL_RESULT_SYNTHESIS: 'post_tool_result_synthesis',
    USER_REQUESTED_PLANNING: 'user_requested_planning',
    HIGH_TOOL_USE_DENSITY: 'high_tool_use_density',
    TRIVIAL_LOOKUP: 'trivial_lookup',
    DEFAULT_TIER: 'default_tier',
    ESCALATED_FROM_HISTORY: 'escalated_from_history',
};
const TIER_ORDER = { cheap: 0, mid: 1, expensive: 2 };
function tierStepUp(tier) {
    if (tier === 'cheap')
        return 'mid';
    return 'expensive'; // mid → expensive; expensive → expensive (clamped)
}
/** Parity invariant with model_router.rs:340 — branch ORDER matters. */
function classify(features, config) {
    // post_tool_result_synthesis must win over high_tool_use_density: a turn that only summarises tool output.
    if (features.last_user_is_tool_result_only && features.last_assistant_stop_reason === 'ToolUse') {
        return ['cheap', REASONS.POST_TOOL_RESULT_SYNTHESIS];
    }
    if (features.user_requested_planning)
        return ['expensive', REASONS.USER_REQUESTED_PLANNING];
    if (features.last_assistant_tool_call_count > 3)
        return ['expensive', REASONS.HIGH_TOOL_USE_DENSITY];
    if (features.user_simple_lookup)
        return ['cheap', REASONS.TRIVIAL_LOOKUP];
    return [config.default_tier, REASONS.DEFAULT_TIER];
}
/** Stalled-turn escalation (model_router.rs:373): last turn produced <50 output tokens with no tool call. */
function maybeEscalate(base, history) {
    if (!history || history.length === 0)
        return [base, null];
    const last = history[history.length - 1];
    const stalled = last.output_tokens < 50 && !last.had_tool_call;
    if (!stalled || last.tier === 'expensive')
        return [base, null];
    const target = tierStepUp(last.tier);
    if (TIER_ORDER[target] > TIER_ORDER[base])
        return [target, last.tier];
    return [base, null];
}
/** Pick a tier for one turn. Precedence: disabled → hard-pin → gene hint → classify (+ history escalation). */
export function pickForTurn(input) {
    const { features, router_state, config } = input;
    if (config.disable)
        return { tier: config.default_tier, reason: REASONS.ROUTER_DISABLED, escalated_from: null };
    if (config.hard_pin_after_plan && router_state?.pinned) {
        return { tier: router_state.pinned, reason: REASONS.HARD_PINNED, escalated_from: null };
    }
    if (input.gene_hint)
        return { tier: input.gene_hint, reason: REASONS.GENE_HINT, escalated_from: null };
    const [baseTier, baseReason] = classify(features, config);
    const [escalatedTier, escalatedFrom] = maybeEscalate(baseTier, router_state?.history ?? []);
    const reason = escalatedFrom !== null ? REASONS.ESCALATED_FROM_HISTORY : baseReason;
    return { tier: escalatedTier, reason, escalated_from: escalatedFrom };
}