// The trusted external verifier (wires the hardened sandbox runner to the validation plan). A cycle's validate
// step should run its validation commands through HERE rather than a bare spawn: each command runs with shell-
// metachar rejection, node-eval-flag blocking, a scrubbed env, a SIGKILL timeout, and — where unprivileged
// namespaces exist — no network + hidden home secrets, so a validation command cannot phone home / exfiltrate to
// game the pass/fail. This is the "verifier outside the repo, untrusted caller" half the safety model relies on.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isolationCommand, makeSandboxRunner, sandboxResourceLimitsAvailable, } from './sandboxRunner.js';
import { runValidation, tokenizeValidationCommand, validationScriptPath, } from './validation.js';
import { sanitizeExecutionCommand, sanitizeExecutionPayload } from './executionRedaction.js';
import { trustedValidationRuntime } from './trustedValidationRuntime.js';
// Keep the public helper available, but never scan an untrusted tree inside validation's daemon path.
export { treeFingerprint } from './validationTreeFingerprint.js';
let readOnlyIsolationAvailableCache;
let readOnlyFilesystemIsolationAvailableCache;
let privateRootIsolationAvailableCache;
/** Probe the complete fallback boundary, not merely whether a network namespace can be created. */
export function privateRootIsolationAvailable() {
    if (process.platform !== 'linux')
        return false;
    if (privateRootIsolationAvailableCache !== undefined)
        return privateRootIsolationAvailableCache;
    let probeRoot;
    const runtimeCleanups = [];
    try {
        probeRoot = mkdtempSync('/var/tmp/evolver-private-root-probe-');
        const cwd = join(probeRoot, 'source');
        const scratch = join(probeRoot, 'session');
        mkdirSync(cwd);
        mkdirSync(scratch);
        const probe = isolationCommand(process.execPath, ['--version'], {
            noNetwork: true,
            hideHomeSecrets: true,
            privateRootFilesystem: true,
            javascriptRuntime: true,
            writableTmpDir: scratch,
            readOnlyRoot: cwd,
            cwd,
        });
        if (probe.cleanup)
            runtimeCleanups.push(probe.cleanup);
        // The outer process holds the launcher's parent-liveness pipe until the probe exits. On timeout it is
        // killed, closing that pipe so the guardian also tears down the probe's complete namespace tree.
        const supervise = "const {spawn}=require('node:child_process'); const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['pipe','ignore','ignore']}); child.on('error',()=>process.exit(1)); child.on('close',code=>process.exit(code??1));";
        const outer = trustedValidationRuntime(supervise, [probe.cmd, ...probe.args]);
        runtimeCleanups.push(outer.cleanup);
        privateRootIsolationAvailableCache = spawnSync(outer.cmd, outer.args, {
            cwd: outer.cwd,
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', ...outer.env },
            timeout: 5_000,
            stdio: 'ignore',
        }).status === 0;
    }
    catch {
        privateRootIsolationAvailableCache = false;
    }
    finally {
        for (const cleanup of runtimeCleanups) {
            try {
                cleanup();
            }
            catch {
                privateRootIsolationAvailableCache = false;
            }
        }
        if (probeRoot) {
            try {
                rmSync(probeRoot, { recursive: true, force: true });
            }
            catch {
                privateRootIsolationAvailableCache = false;
            }
        }
    }
    return privateRootIsolationAvailableCache;
}
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
                ...(process.versions['bun'] ? { BUN_BE_BUN: '1' } : {}),
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
/** What this host can actually build, strongest first. Callers log it to explain a downgrade. */
export function availableIsolationTier() {
    if (readOnlyIsolationAvailable())
        return 'read-only';
    return privateRootIsolationAvailable() ? 'no-network' : 'none';
}
export function readOnlyIsolationAvailable() {
    if (process.platform !== 'linux')
        return false;
    if (readOnlyIsolationAvailableCache !== undefined)
        return readOnlyIsolationAvailableCache;
    readOnlyIsolationAvailableCache = sandboxResourceLimitsAvailable() && readOnlyFilesystemIsolationAvailable();
    return readOnlyIsolationAvailableCache;
}
const TIER_RANK = { none: 0, 'no-network': 1, 'read-only': 2 };
function meetsFloor(tier, floor) {
    return TIER_RANK[tier] >= TIER_RANK[floor];
}
/**
 * The `unshareCheck` seam predates tiers and callers still rely on its exact meaning: a true probe under
 * `requireIsolation` stood for the full cage, and without it for the network-only one. Keep that mapping verbatim
 * so overriding the probe still describes the same two worlds it always did.
 */
function resolveIsolationTier(opts) {
    if (opts.isolationProbe)
        return opts.isolationProbe();
    if (opts.unshareCheck) {
        if (!opts.unshareCheck())
            return 'none';
        return opts.requireIsolation ? 'read-only' : 'no-network';
    }
    if (opts.requireIsolation && readOnlyIsolationAvailable())
        return 'read-only';
    return privateRootIsolationAvailable() ? 'no-network' : 'none';
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
function skippedCommand(cmd, script, reason) {
    return { cmd, script, reason };
}
/**
 * Validate the script target before it reaches the runner. The full read-only tier retains the host root,
 * so lexical containment alone is insufficient: a path inside the checkout may resolve through a symlink outside it.
 * Symlink script entries are rejected outright, and the canonical target is checked immediately before execution.
 */
function classifyValidationScript(cmd, script, validationCwd, readOnlyRoot) {
    if (isAbsolute(script)) {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_outside_root') };
    }
    let candidate;
    try {
        candidate = resolve(validationCwd, script);
    }
    catch {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_unresolvable') };
    }
    if (!pathIsWithin(readOnlyRoot, candidate)) {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_outside_root') };
    }
    let metadata;
    try {
        metadata = lstatSync(candidate);
    }
    catch {
        return { ok: false, skipped: skippedCommand(cmd, script, 'missing_script') };
    }
    if (metadata.isSymbolicLink()) {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_symlink') };
    }
    if (!metadata.isFile()) {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_unresolvable') };
    }
    let canonicalScript;
    try {
        canonicalScript = realpathSync(candidate);
    }
    catch {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_unresolvable') };
    }
    if (!pathIsWithin(readOnlyRoot, canonicalScript)) {
        return { ok: false, skipped: skippedCommand(cmd, script, 'script_outside_root') };
    }
    return { ok: true };
}
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when unprivileged namespaces are available; elsewhere (Windows/macOS) it degrades to the non-namespace hardening
 * rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export async function runSandboxedValidation(cmds, cwd, opts = {}) {
    if (opts.signal?.aborted)
        return { passed: false, cancelled: true, score: 0.2, results: [], skipped: [], isolated: false, isolationTier: 'none' };
    const tier = resolveIsolationTier(opts);
    const isolated = tier !== 'none';
    // `tier === 'none'` is rejected on its own, not just via the floor: the floor comes from the caller, and a
    // JavaScript caller can hand us 'none' past the type. requireIsolation must never be satisfiable by no boundary.
    const validFloor = opts.minimumIsolation === undefined || opts.minimumIsolation === 'read-only' || opts.minimumIsolation === 'no-network';
    if (opts.requireIsolation && (!validFloor || tier === 'none' || !meetsFloor(tier, opts.minimumIsolation ?? 'read-only'))) {
        return { passed: false, cancelled: opts.signal?.aborted === true, score: 0.2, results: [], skipped: [], isolated: false, isolationTier: 'none' };
    }
    let validationCwd = resolve(cwd);
    let readOnlyRoot = opts.readOnlyRoot ? resolve(opts.readOnlyRoot) : validationReadOnlyRoot(validationCwd);
    // Canonicalize the validation root in every mode. Namespace isolation is an additional boundary, not a substitute
    // for refusing an absolute, escaping, or symlinked script path; this also keeps the Windows/macOS path fail closed.
    try {
        validationCwd = realpathSync(validationCwd);
        readOnlyRoot = realpathSync(readOnlyRoot);
    }
    catch {
        return { passed: false, cancelled: opts.signal?.aborted === true, score: 0.2, results: [], skipped: [], isolated, isolationTier: tier };
    }
    if (dirname(readOnlyRoot) === readOnlyRoot || !pathIsWithin(readOnlyRoot, validationCwd)) {
        return { passed: false, cancelled: opts.signal?.aborted === true, score: 0.2, results: [], skipped: [], isolated, isolationTier: tier };
    }
    // ONLY a truly empty command set is a vacuous pass (nothing to verify). A non-empty set with blank entries is a
    // malformed plan, NOT a pass: blanks are kept (trimmed to '') so they fall outside the allowlist and fail, rather
    // than being silently dropped into a pass (Bugbot).
    if (cmds.length === 0)
        return { passed: true, cancelled: false, score: 0.95, results: [], skipped: [], isolated, isolationTier: tier };
    const list = cmds.map((c) => String(c ?? '').trim());
    const sanitizedPlan = list.map((command) => sanitizeExecutionCommand(command));
    if (sanitizedPlan.some((command) => command.changed || command.blocked)) {
        return {
            passed: false,
            cancelled: false,
            score: 0.2,
            results: sanitizedPlan.map((command) => ({
                label: command.value.split(/\s+/)[0] || '<redacted>',
                cmd: command.value,
                allowed: false,
                exitCode: null,
                stdoutSummary: command.changed || command.blocked
                    ? 'execution_credential_blocked'
                    : 'validation_plan_blocked',
                passed: false,
            })),
            skipped: [],
            isolated,
            isolationTier: tier,
        };
    }
    // Validation plans may reference repo-relative scripts that do not exist in this checkout; skip those, but never
    // execute a script that is absolute, escapes the root, resolves through a symlink, or is not a regular file.
    const skipped = [];
    const runnable = [];
    for (const cmd of list) {
        const script = validationScriptPath(cmd);
        if (script) {
            const classification = classifyValidationScript(cmd, script, validationCwd, readOnlyRoot);
            if (!classification.ok) {
                skipped.push(classification.skipped);
                if (classification.skipped.reason === 'missing_script') {
                    console.warn(`[Validation] Skipping validation command (script not in repoRoot): ${script}`);
                }
                else {
                    console.warn(`[Validation] Rejecting validation command (${classification.skipped.reason}): ${script}`);
                }
                continue;
            }
        }
        runnable.push(cmd);
    }
    if (runnable.length === 0)
        return { passed: false, cancelled: opts.signal?.aborted === true, score: 0.2, results: [], skipped, isolated, isolationTier: tier };
    let scratch;
    try {
        scratch = isolated ? mkdtempSync('/var/tmp/evolver-validation-') : undefined;
    }
    catch {
        return { passed: false, cancelled: opts.signal?.aborted === true, failureReason: 'sandbox_setup_failed', score: 0.2, results: [], skipped, isolated, isolationTier: tier };
    }
    const runner = makeSandboxRunner({
        cwd: validationCwd,
        noNetwork: isolated,
        hideHomeSecrets: isolated,
        readOnlyFilesystem: tier === 'read-only',
        privateRootFilesystem: tier === 'no-network',
        resourceLimits: tier === 'read-only',
        writableTmpDir: scratch,
        readOnlyRoot,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.resourceGroupFactory ? { resourceGroupFactory: opts.resourceGroupFactory } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        unshareCheck: () => isolated,
    });
    // Re-check each script immediately before its spawn. The initial pass supplies precise skipped reasons, while
    // this second gate closes the degraded-mode window where an earlier validator could replace a later path.
    const guardedRunner = async (cmd, signal) => {
        const script = validationScriptPath(cmd);
        if (script) {
            const classification = classifyValidationScript(cmd, script, validationCwd, readOnlyRoot);
            if (!classification.ok) {
                return {
                    exitCode: 126,
                    stdout: `[sandbox] rejected: ${classification.skipped.reason}: ${script}`,
                };
            }
        }
        return runner(cmd, signal);
    };
    const allowlist = [...new Set(runnable
            .map((c) => tokenizeValidationCommand(c)?.[0] ?? '')
            .filter(Boolean))];
    let results;
    let passed;
    let cancelled;
    let cleaned = true;
    try {
        ({ results, passed, cancelled } = await runValidation({ commands: runnable.map((cmd) => ({ cmd })), allowlist }, guardedRunner, opts.signal));
    }
    finally {
        if (scratch) {
            try {
                rmSync(scratch, { recursive: true, force: true });
            }
            catch {
                cleaned = false;
            }
        }
    }
    // Both isolated tiers prevent source mutations at the mount boundary. No host-side content scan or mutable
    // retry baseline is needed; even a failed or cancelled validator leaves the caller's source bytes untouched.
    const complete = skipped.length === 0 && !cancelled && cleaned;
    return sanitizeExecutionPayload({
        passed: passed && complete,
        cancelled,
        ...(!cleaned ? { failureReason: 'sandbox_cleanup_failed' } : {}),
        score: passed && complete ? 0.95 : 0.2,
        results,
        skipped,
        isolated,
        isolationTier: tier,
    }).value;
}
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}