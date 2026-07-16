export interface PublicAuthPathOptions {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
}
export interface LogoutOptions extends PublicAuthPathOptions {
    exists?: (path: string) => boolean;
    unlink?: (path: string) => void;
}
export interface LogoutResult {
    tokenPath: string;
    removed: boolean;
}
export declare function publicOAuthTokenPath(opts?: PublicAuthPathOptions): string;
/**
 * `evolver login` — RFC 8628 device authorization grant against the public hub
 * (like `gh auth login`): print a user code + verification URL, then poll until
 * the user approves in the browser, storing the token at ~/.evomap/token.json.
 *
 * Hub URL follows A2A_HUB_URL -> EVOMAP_HUB_URL -> EVOLVER_DEFAULT_HUB_URL -> https://evomap.ai. Credential
 * home follows the same public Hub precedence as publish/ATP:
 * EVOMAP_DIR → EVOLVER_HOME → EVOMAP_HOME → ~/.evomap. The token replaces
 * node_secret for publish + /a2a calls (it carries the `a2a` scope).
 */
export declare function runLogin(argv: readonly string[]): Promise<number>;
export declare function logoutPublicOAuth(opts?: LogoutOptions): LogoutResult;
export declare function runLogout(argv: readonly string[], opts?: LogoutOptions): Promise<number>;