export interface PrimerOptions {
    /** Whether a local evolver-proxy → PrivateHub link is wired (mirrors how the tool descriptions branch). When
     *  true the loop includes the hub-only steps (reuse-result reporting, pre-publish dry-run validate). */
    proxy?: boolean;
}
/**
 * Build the evolver mechanism primer: a short, quiet-by-default description of the recall/search -> reuse -> report -> capture
 * loop, anchored to the exact tool names so the model can map each step onto a tool in tools/list. Adapts to the
 * wired capabilities so it never tells the agent to call a tool that is not present (reuse-result / validate are
 * proxy-only). Deterministic given its options.
 */
export declare function buildEvolverPrimer(opts?: PrimerOptions): string;