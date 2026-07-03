/**
 * `evolver login` — RFC 8628 device authorization grant against the public hub
 * (like `gh auth login`): print a user code + verification URL, then poll until
 * the user approves in the browser, storing the token at ~/.evomap/token.json.
 *
 * Hub URL comes from EVOMAP_HUB_URL (default https://evomap.ai); EVOMAP_DIR
 * overrides the credential directory. The token replaces node_secret for
 * publish + /a2a calls (it carries the `a2a` scope).
 */
export declare function runLogin(_argv: readonly string[]): Promise<number>;