// Hardened sandbox CommandRunner (ported from v1 src/gep/validator/sandboxExecutor.js). Fills the
// CommandRunner seam in validation.ts so the validator role can actually EXECUTE validation commands
// (e.g. `node test.js`) to verify an evolution — safely, without trusting the caller. The executable
// allowlist stays data-driven in the ValidationPlan (runValidation checks it before calling this); this
// module hardens EXECUTION: blocked node eval-flags, shell-metachar rejection, a fresh wiped temp cwd,
// a scrubbed env (no secrets leak in), and a SIGKILL timeout. Output is folded + truncated.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNodeExecutable, nodeFlagViolation, SHELL_METACHARS } from './validation.js';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
// Env scrub: only these keys reach the child, so node-secrets/tokens in the parent env cannot leak into validation.
const DEFAULT_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'];
/** Credential dirs hidden under $HOME when hideHomeSecrets is set (dirs only — never where binaries live). */
const SECRET_HOME_DIRS = ['.evomap', '.ssh', '.aws', '.gnupg', '.docker', '.kube'];
// Fixed setup run inside the mount ns: tmpfs over each existing secret dir, then exec the command. The command
// is passed as POSITIONAL args (`exec "$@"`), never interpolated into the script — no shell-injection vector.
const HIDE_SECRETS_SCRIPT = `for d in ${SECRET_HOME_DIRS.map((d) => `"$HOME/${d}"`).join(' ')}; do [ -d "$d" ] && mount -t tmpfs none "$d" 2>/dev/null; done; exec "$@"`;
/** Wrap an (executable,args) in unprivileged namespaces per the requested isolation (pure — testable). */
export function isolationCommand(bin, args, opts) {
    const flags = ['-r'];
    if (opts.hideHomeSecrets)
        flags.push('-m');
    if (opts.noNetwork)
        flags.push('-n');
    if (!opts.noNetwork && !opts.hideHomeSecrets)
        return { cmd: bin, args: [...args] };
    const base = [...flags, '--fork', '--kill-child', '--'];
    // Mount setup needs a launcher (sh runs the FIXED script then exec "$@"); net-only needs no shell.
    return opts.hideHomeSecrets
        ? { cmd: 'unshare', args: [...base, 'sh', '-c', HIDE_SECRETS_SCRIPT, 'sh', bin, ...args] }
        : { cmd: 'unshare', args: [...base, bin, ...args] };
}
let unshareCache;
/** Whether unprivileged user+mount+net namespaces (`unshare -r -m -n`) work here (cached) — covers both isolation modes. */
export function unshareNetAvailable() {
    if (unshareCache === undefined) {
        try {
            unshareCache = spawnSync('unshare', ['-r', '-m', '-n', 'true'], { timeout: 5000 }).status === 0;
        }
        catch {
            unshareCache = false;
        }
    }
    return unshareCache;
}
function parse(cmd) {
    const tokens = cmd.trim().split(/\s+/).filter(Boolean);
    return { executable: tokens[0] ?? '', args: tokens.slice(1) };
}
function scrubEnv(allow) {
    const out = {};
    for (const k of allow) {
        const v = process.env[k];
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/**
 * Build a hardened CommandRunner. The executable allowlist is the ValidationPlan's job (runValidation);
 * this only hardens how an allowed command runs.
 */
export function makeSandboxRunner(opts = {}) {
    const timeout = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const envAllow = opts.envAllowKeys ?? DEFAULT_ENV_ALLOW;
    return (cmd) => new Promise((resolve) => {
        const deny = (msg, code = 126) => resolve({ exitCode: code, stdout: `[sandbox] ${msg}` });
        const { executable, args } = parse(cmd);
        if (!executable)
            return deny('empty command', 1);
        if (SHELL_METACHARS.test(cmd))
            return deny('rejected: shell metacharacter (no shell is provided; split compound commands)');
        const badFlag = nodeFlagViolation(executable, args);
        if (badFlag)
            return deny(`rejected: blocked node flag ${badFlag}`);
        // Isolation (#26): fail-safe — if we can't actually create the namespaces, refuse rather than run un-isolated.
        if ((opts.noNetwork || opts.hideHomeSecrets) && !(opts.unshareCheck ?? unshareNetAvailable)()) {
            return deny('rejected: isolation (noNetwork/hideHomeSecrets) requested but unprivileged namespaces (unshare -r -m -n) are unavailable here');
        }
        const ownTemp = !opts.cwd;
        let cwd;
        try {
            cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'evo-sbx-'));
        }
        catch (e) {
            return deny(`temp dir failed: ${e instanceof Error ? e.message : 'err'}`, 1);
        }
        const cleanup = () => { if (ownTemp) {
            try {
                rmSync(cwd, { recursive: true, force: true });
            }
            catch { /* best effort */ }
        } };
        // Resolve 'node' to the running binary so spawn(shell:false) works on Windows too (where bare 'node' would ENOENT).
        const bin = isNodeExecutable(executable) ? process.execPath : executable;
        try {
            const { cmd: spawnCmd, args: spawnArgs } = isolationCommand(bin, args, { noNetwork: opts.noNetwork, hideHomeSecrets: opts.hideHomeSecrets });
            const child = spawn(spawnCmd, spawnArgs, { shell: false, cwd, env: scrubEnv(envAllow), timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            const cap = (d) => { if (out.length < MAX_OUTPUT_CHARS)
                out += String(d); };
            child.stdout?.on('data', cap);
            child.stderr?.on('data', cap);
            child.on('error', (err) => { cleanup(); resolve({ exitCode: 127, stdout: `[sandbox] spawn error: ${err.message}` }); });
            child.on('close', (code, signal) => { cleanup(); resolve({ exitCode: code ?? (signal ? 137 : 1), stdout: out.slice(0, MAX_OUTPUT_CHARS) }); });
        }
        catch (e) {
            cleanup();
            resolve({ exitCode: 127, stdout: `[sandbox] spawn failed: ${e instanceof Error ? e.message : 'err'}` });
        }
    });
}