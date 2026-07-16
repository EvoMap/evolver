import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicOAuthProvider, createOAuthHttpTransport, resolveHubUrl } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const LOGIN_USAGE = 'usage: evolver login\n';
function publicAuthDir(opts = {}) {
    const env = opts.env ?? process.env;
    return env.EVOMAP_DIR ?? env.EVOLVER_HOME ?? env.EVOMAP_HOME ?? join(opts.homeDir ?? homedir(), '.evomap');
}
export function publicOAuthTokenPath(opts = {}) {
    return join(publicAuthDir(opts), 'token.json');
}
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
export async function runLogin(argv) {
    if (argv[0] === '--help' || argv[0] === '-h') {
        process.stdout.write(LOGIN_USAGE);
        return 0;
    }
    if (argv.length > 0) {
        process.stderr.write(LOGIN_USAGE);
        return 1;
    }
    loadEnvFileFromEnv(process.env);
    const hubUrl = resolveHubUrl(process.env);
    const dir = publicAuthDir();
    const credPath = publicOAuthTokenPath();
    const provider = new PublicOAuthProvider({
        credPath,
        machine: { softIdPath: join(dir, 'machine-id') },
        transport: createOAuthHttpTransport({ hubUrl }),
        onUserCode: (d) => {
            process.stdout.write(`\nTo authorize this device:\n` +
                `  1. open  ${d.verificationUri}\n` +
                `  2. enter code:  ${d.userCode}\n\n` +
                `Waiting for approval (Ctrl-C to cancel)...\n`);
        },
    });
    try {
        const cred = await provider.login();
        const exp = cred.expiresAt ? new Date(cred.expiresAt).toISOString() : 'n/a';
        process.stdout.write(`\n✓ Logged in to ${hubUrl}. Token stored at ${credPath} (expires ${exp}).\n`);
        return 0;
    }
    catch (e) {
        process.stderr.write(`login failed: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
}
export function logoutPublicOAuth(opts = {}) {
    const tokenPath = publicOAuthTokenPath(opts);
    const exists = opts.exists ?? existsSync;
    if (!exists(tokenPath))
        return { tokenPath, removed: false };
    (opts.unlink ?? unlinkSync)(tokenPath);
    return { tokenPath, removed: true };
}
export async function runLogout(argv, opts = {}) {
    if (argv[0] === '--help' || argv[0] === '-h') {
        process.stdout.write('用法: evolver logout\n');
        return 0;
    }
    if (argv.length > 0) {
        process.stderr.write('用法: evolver logout\n');
        return 1;
    }
    try {
        const result = logoutPublicOAuth(opts);
        if (result.removed)
            process.stdout.write(`Logged out. Removed OAuth token at ${result.tokenPath}\n`);
        else
            process.stdout.write(`Already logged out. No OAuth token at ${result.tokenPath}\n`);
        return 0;
    }
    catch (err) {
        process.stderr.write(`logout failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
}