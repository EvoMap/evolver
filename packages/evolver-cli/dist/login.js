import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicOAuthProvider, createOAuthHttpTransport } from '@evomap/evolver-adapter-public';
/**
 * `evolver login` — RFC 8628 device authorization grant against the public hub
 * (like `gh auth login`): print a user code + verification URL, then poll until
 * the user approves in the browser, storing the token at ~/.evomap/token.json.
 *
 * Hub URL comes from EVOMAP_HUB_URL (default https://evomap.ai); EVOMAP_DIR
 * overrides the credential directory. The token replaces node_secret for
 * publish + /a2a calls (it carries the `a2a` scope).
 */
export async function runLogin(_argv) {
    const hubUrl = process.env.EVOMAP_HUB_URL ?? 'https://evomap.ai';
    const dir = process.env.EVOMAP_DIR ?? join(homedir(), '.evomap');
    const credPath = join(dir, 'token.json');
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