// The trusted external verifier (wires the hardened sandbox runner to the validation plan). A cycle's validate
// step should run its validation commands through HERE rather than a bare spawn: each command runs with shell-
// metachar rejection, node-eval-flag blocking, a scrubbed env, a SIGKILL timeout, and — where unprivileged
// namespaces exist — no network + hidden home secrets, so a validation command cannot phone home / exfiltrate to
// game the pass/fail. This is the "verifier outside the repo, untrusted caller" half the safety model relies on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isolationCommand, makeSandboxRunner, sandboxResourceLimitsAvailable, unshareNetAvailable, } from './sandboxRunner.js';
import { runValidation, validationScriptPath } from './validation.js';
let readOnlyIsolationAvailableCache;
let readOnlyFilesystemIsolationAvailableCache;
export function readOnlyFilesystemIsolationAvailable() {
    if (process.platform !== 'linux')
        return false;
    if (readOnlyFilesystemIsolationAvailableCache !== undefined)
        return readOnlyFilesystemIsolationAvailableCache;
    const probeRoot = mkdtempSync('/var/tmp/evolver-isolation-probe-');
    const probeHome = mkdtempSync('/var/tmp/evolver-isolation-home-');
    const scratch = join(probeRoot, 'session');
    const probeCwd = join(probeRoot, 'cwd');
    try {
        mkdirSync(scratch);
        mkdirSync(probeCwd);
        const probe = isolationCommand(process.execPath, ['--version'], {
            noNetwork: true,
            hideHomeSecrets: true,
            readOnlyFilesystem: true,
            writableTmpDir: scratch,
            readOnlyRoot: probeCwd,
            cwd: probeCwd,
        });
        readOnlyFilesystemIsolationAvailableCache = spawnSync(probe.cmd, probe.args, {
            cwd: probeCwd,
            env: {
                HOME: process.env.HOME ?? probeHome,
                PATH: process.env.PATH ?? '/usr/bin:/bin',
            },
            input: '\n',
            timeout: 5_000,
            stdio: ['pipe', 'ignore', 'ignore'],
        }).status === 0;
    }
    catch {
        readOnlyFilesystemIsolationAvailableCache = false;
    }
    finally {
        rmSync(probeRoot, { recursive: true, force: true });
        rmSync(probeHome, { recursive: true, force: true });
    }
    return readOnlyFilesystemIsolationAvailableCache;
}
export function readOnlyIsolationAvailable() {
    if (process.platform !== 'linux')
        return false;
    if (readOnlyIsolationAvailableCache !== undefined)
        return readOnlyIsolationAvailableCache;
    readOnlyIsolationAvailableCache = sandboxResourceLimitsAvailable() && readOnlyFilesystemIsolationAvailable();
    return readOnlyIsolationAvailableCache;
}
function validationReadOnlyRoot(cwd) {
    let current = resolve(cwd);
    while (true) {
        if (existsSync(join(current, '.git')))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return resolve(cwd);
        current = parent;
    }
}
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when unprivileged namespaces are available; elsewhere (Windows/macOS) it degrades to the non-namespace hardening
 * rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export async function runSandboxedValidation(cmds, cwd, opts = {}) {
    const isolationCheck = opts.unshareCheck ?? (opts.requireIsolation ? readOnlyIsolationAvailable : unshareNetAvailable);
    const isolated = isolationCheck();
    if (opts.requireIsolation && !isolated) {
        return { passed: false, score: 0.2, results: [], skipped: [], isolated: false };
    }
    let validationCwd = resolve(cwd);
    let readOnlyRoot = opts.readOnlyRoot ? resolve(opts.readOnlyRoot) : validationReadOnlyRoot(validationCwd);
    if (opts.requireIsolation && isolated) {
        try {
            validationCwd = realpathSync(validationCwd);
            readOnlyRoot = realpathSync(readOnlyRoot);
        }
        catch {
            return { passed: false, score: 0.2, results: [], skipped: [], isolated };
        }
        if (dirname(readOnlyRoot) === readOnlyRoot || !pathIsWithin(readOnlyRoot, validationCwd)) {
            return { passed: false, score: 0.2, results: [], skipped: [], isolated };
        }
    }
    // ONLY a truly empty command set is a vacuous pass (nothing to verify). A non-empty set with blank entries is a
    // malformed plan, NOT a pass: blanks are kept (trimmed to '') so they fall outside the allowlist and fail, rather
    // than being silently dropped into a pass (Bugbot).
    if (cmds.length === 0)
        return { passed: true, score: 0.95, results: [], skipped: [], isolated };
    const list = cmds.map((c) => String(c ?? '').trim());
    // Validation plans may reference repo-relative scripts that do not exist in this checkout; skip only those.
    const skipped = [];
    const runnable = [];
    for (const cmd of list) {
        const script = validationScriptPath(cmd);
        if (script && !isAbsolute(script) && !existsSync(resolve(validationCwd, script))) {
            skipped.push({ cmd, script, reason: 'missing_script' });
            console.warn(`[Validation] Skipping validation command (script not in repoRoot): ${script}`);
            continue;
        }
        runnable.push(cmd);
    }
    if (runnable.length === 0)
        return { passed: false, score: 0.2, results: [], skipped, isolated };
    const scratch = isolated && opts.requireIsolation
        ? mkdtempSync('/var/tmp/evolver-validation-')
        : undefined;
    const runner = makeSandboxRunner({
        cwd: validationCwd,
        noNetwork: isolated,
        hideHomeSecrets: isolated,
        readOnlyFilesystem: isolated && opts.requireIsolation,
        resourceLimits: isolated && opts.requireIsolation,
        writableTmpDir: scratch,
        readOnlyRoot,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.resourceGroupFactory ? { resourceGroupFactory: opts.resourceGroupFactory } : {}),
        unshareCheck: () => isolated,
    });
    const allowlist = [...new Set(runnable.map((c) => c.split(/\s+/)[0] ?? '').filter(Boolean))];
    let results;
    let passed;
    try {
        ({ results, passed } = await runValidation({ commands: runnable.map((cmd) => ({ cmd })), allowlist }, runner));
    }
    finally {
        if (scratch)
            rmSync(scratch, { recursive: true, force: true });
    }
    const complete = skipped.length === 0;
    return {
        passed: passed && complete,
        score: passed && complete ? 0.95 : 0.2,
        results,
        skipped,
        isolated,
    };
}
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}