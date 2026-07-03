// The trusted external verifier (wires the hardened sandbox runner to the validation plan). A cycle's validate
// step should run its validation commands through HERE rather than a bare spawn: each command runs with shell-
// metachar rejection, node-eval-flag blocking, a scrubbed env, a SIGKILL timeout, and — where unprivileged
// namespaces exist — no network + hidden home secrets, so a validation command cannot phone home / exfiltrate to
// game the pass/fail. This is the "verifier outside the repo, untrusted caller" half the safety model relies on.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { makeSandboxRunner, unshareNetAvailable } from './sandboxRunner.js';
import { runValidation, validationScriptPath } from './validation.js';
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when unprivileged namespaces are available; elsewhere (Windows/macOS) it degrades to the non-namespace hardening
 * rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export async function runSandboxedValidation(cmds, cwd, opts = {}) {
    const isolated = (opts.unshareCheck ?? unshareNetAvailable)();
    // ONLY a truly empty command set is a vacuous pass (nothing to verify). A non-empty set with blank entries is a
    // malformed plan, NOT a pass: blanks are kept (trimmed to '') so they fall outside the allowlist and fail, rather
    // than being silently dropped into a pass (Bugbot).
    if (cmds.length === 0)
        return { passed: true, score: 0.95, results: [], skipped: [], isolated };
    const runner = makeSandboxRunner({
        cwd,
        noNetwork: isolated,
        hideHomeSecrets: isolated,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.unshareCheck ? { unshareCheck: opts.unshareCheck } : {}),
    });
    const list = cmds.map((c) => String(c ?? '').trim());
    // Validation plans may reference repo-relative scripts that do not exist in this checkout; skip only those.
    const skipped = [];
    const runnable = [];
    for (const cmd of list) {
        const script = validationScriptPath(cmd);
        if (script && !isAbsolute(script) && !existsSync(resolve(cwd, script))) {
            skipped.push({ cmd, script, reason: 'missing_script' });
            console.warn(`[Validation] Skipping validation command (script not in repoRoot): ${script}`);
            continue;
        }
        runnable.push(cmd);
    }
    if (runnable.length === 0)
        return { passed: false, score: 0.2, results: [], skipped, isolated };
    const allowlist = [...new Set(runnable.map((c) => c.split(/\s+/)[0] ?? '').filter(Boolean))];
    const { results, passed } = await runValidation({ commands: runnable.map((cmd) => ({ cmd })), allowlist }, runner);
    const complete = skipped.length === 0;
    return {
        passed: passed && complete,
        score: passed && complete ? 0.95 : 0.2,
        results,
        skipped,
        isolated,
    };
}