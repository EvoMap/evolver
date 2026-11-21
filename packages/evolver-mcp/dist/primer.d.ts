export interface PrimerOptions {
    /** Whether a local evolver-proxy → PrivateHub link is wired (mirrors how the tool descriptions branch). When
     *  true the loop includes the hub-only steps (reuse-result reporting, pre-publish dry-run validate). */
    proxy?: boolean;
}
export declare function buildEvolverPrimer(opts?: PrimerOptions): string;