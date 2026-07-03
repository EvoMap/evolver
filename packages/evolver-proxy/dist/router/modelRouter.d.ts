export type Tier = 'cheap' | 'mid' | 'expensive';
export declare const REASONS: {
    readonly ROUTER_DISABLED: "router_disabled";
    readonly HARD_PINNED: "hard_pinned";
    readonly GENE_HINT: "gene_hint";
    readonly POST_TOOL_RESULT_SYNTHESIS: "post_tool_result_synthesis";
    readonly USER_REQUESTED_PLANNING: "user_requested_planning";
    readonly HIGH_TOOL_USE_DENSITY: "high_tool_use_density";
    readonly TRIVIAL_LOOKUP: "trivial_lookup";
    readonly DEFAULT_TIER: "default_tier";
    readonly ESCALATED_FROM_HISTORY: "escalated_from_history";
};
export type Reason = (typeof REASONS)[keyof typeof REASONS];
export interface RouterFeatures {
    last_assistant_tool_call_count: number;
    last_assistant_had_tool_call: boolean;
    last_user_is_tool_result_only: boolean;
    user_requested_planning: boolean;
    user_simple_lookup: boolean;
    last_assistant_output_tokens: number;
    last_assistant_stop_reason: 'ToolUse' | 'Stop' | null;
}
export interface RouterHistoryEntry {
    tier: Tier;
    output_tokens: number;
    had_tool_call: boolean;
}
export interface RouterState {
    history: readonly RouterHistoryEntry[];
    pinned: Tier | null;
}
export interface RouterConfig {
    default_tier: Tier;
    disable: boolean;
    hard_pin_after_plan: boolean;
}
export interface RouterInput {
    features: RouterFeatures;
    router_state: RouterState;
    config: RouterConfig;
    gene_hint?: Tier | null;
}
export interface RouterDecision {
    tier: Tier;
    reason: Reason;
    escalated_from: Tier | null;
}
/** Pick a tier for one turn. Precedence: disabled → hard-pin → gene hint → classify (+ history escalation). */
export declare function pickForTurn(input: RouterInput): RouterDecision;