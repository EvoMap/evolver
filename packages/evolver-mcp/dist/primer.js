// Mechanism primer (#mcp-onboarding) — the runtime-agnostic explanation of how to reuse Evolver memory without
// turning routine checks into user-visible chatter. It is surfaced through initialize.instructions and the explicit
// evolver_guide tool. PURE: a function of the wired capabilities, no IO.
/**
 * Build the evolver mechanism primer: a short, quiet-by-default description of the recall/search -> reuse -> report -> capture
 * loop, anchored to the exact tool names so the model can map each step onto a tool in tools/list. Adapts to the
 * wired capabilities so it never tells the agent to call a tool that is not present (reuse-result / validate are
 * proxy-only). Deterministic given its options.
 */
export function buildEvolverPrimer(opts = {}) {
    const proxy = opts.proxy === true;
    const searchWhere = proxy ? 'shared experience on the hub' : 'your local experience store';
    const publishStep = proxy
        ? 'dry-run validate it (evolver_asset_validate), then publish (evolver_asset_publish).'
        : 'then publish it (evolver_asset_publish).';
    const lines = [
        'Evolver gives this agent reusable memory. A Recipe is ordered Gene/Capsule DNA. Default discovery/execution is Recipe search then express; Gene/Capsule search is fallback when no Recipe matches. Expressing a Recipe is what actually reuses those steps on the hub. Use it quietly when prior experience is likely to help:',
        '',
        '1. SEARCH AND EXPRESS RECIPES FIRST. For clear error text, repeated workflows, or substantial tasks:',
    ];
    if (proxy) {
        lines.push('   - call evolver_recipe_search with the task or error text;', '   - if a recipe fits, call evolver_recipe_express — the hub expands Gene then Capsule steps; do not parse recipe JSON locally;', '   - if no recipe hits, fall back to evolver_asset_search / evolver_asset_fetch on genes and capsules;', '   - call evolver_recall only for approved local genes that are likely to help.');
    }
    else {
        lines.push('   - call evolver_recall when approved local genes are likely to help;', `   - call evolver_asset_search with concise key signals or error text to search ${searchWhere} (Recipe search needs a hub/proxy);`, '   - if a candidate fits, call evolver_asset_fetch and reuse only the parts that apply.');
    }
    if (proxy) {
        lines.push('2. REPORT REAL REUSE. After a fetched asset materially affects the solution, call evolver_asset_reuse_result', '   (success / failed / mismatched / stale / unsafe) so the memory learns what is worth keeping.', '3. CAPTURE VERIFIED LEARNING. When you solve something non-trivial and have VERIFIED it, distill it for the next agent:');
    }
    else {
        lines.push('2. CAPTURE VERIFIED LEARNING. When you solve something non-trivial and have VERIFIED it, distill it for the next agent:');
    }
    lines.push('   - evolver_distill_conversation with a concrete summary + strategy + evidence + validation (weak signals are rejected);', `   - or build it yourself (evolver_gep_build), ${publishStep}`, '', 'The mechanism is: recall/search -> reuse -> capture. Do not narrate routine Evolver status, preflight, or empty search results to the user; mention Evolver only when the user asks, a reused asset materially changes the answer, or a blocker matters. Only capture what you actually verified; never publish secrets.');
    return lines.join('\n');
}