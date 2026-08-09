// First-run supervision bootstrap for the DEFAULT self-update policy.
//
// Default auto self-update degrades to 'off' without a durable supervisor attestation (policy.ts).
// To make `npm install` a complete zero-config path, an unsupervised foreground startup may ONCE
// register its own user-level durable launcher (`evolver lifecycle bootstrap`) and hand over to it:
// the generated launcher carries the EVOLVER_SELF_UPDATE_SUPERVISOR attestation, so the next
// supervised startup runs auto self-update with the unchanged signature/health-check/rollback gates.
//
// Bootstrap is a convenience, never an escalation: it is skipped for attested runs, explicit
// non-auto policies, the EVOLVER_SELF_BOOTSTRAP kill switch, CI, containers, and within a
// cooldown window after a failed attempt. The npm/JS install shape has no bindable
// self-update target, so instead of launcher bootstrap it attempts a one-time migration to
// the standalone release binary (migration.ts). Any failure degrades back to the existing
// 'off + warning' startup.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSelfUpdateExplicit, resolveSelfUpdatePolicy, selfUpdateSupervisorAttested, } from './policy.js';
import { expandHomePath } from '../bin/envFile.js';
import { resolveSelfUpdateTarget } from './releaseBinary.js';
import { migrateToStandaloneBinary } from './migration.js';
const requireFromHere = createRequire(import.meta.url);
export const BOOTSTRAP_SUCCESS_FILE = 'bootstrap.json';
const BOOTSTRAP_ATTEMPT_FILE = 'bootstrap-attempt.json';
const BOOTSTRAP_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// The CLI-side service activation itself spawns up to ~60s (lifecycle powershell/schtasks
// activation), so a shorter timeout would kill the child mid-activation and leave the
// half-installed state: the service registered but bootstrap judged failed.
const BOOTSTRAP_TIMEOUT_MS = 90_000;
const BOOTSTRAP_ENV_FILE_HANDOFF = 'EVOLVER_INTERNAL_BOOTSTRAP_ENV_FILE';
/** Lifecycle state dir mirror of evolver-cli lifecyclePaths (kept dependency-free across packages). */
export function resolveBootstrapStateDir(env) {
    const explicit = env['EVOLVER_LIFECYCLE_STATE_DIR']?.trim();
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    return resolvePath(explicit || join(home, 'lifecycle'));
}
function bootstrapChildEnv(env) {
    const childEnv = { ...env };
    const envFile = env['EVOLVER_ENV_FILE']?.trim();
    delete childEnv['EVOLVER_ENV_FILE'];
    delete childEnv[BOOTSTRAP_ENV_FILE_HANDOFF];
    if (envFile)
        childEnv[BOOTSTRAP_ENV_FILE_HANDOFF] = resolvePath(expandHomePath(envFile));
    // Resolve while the foreground proxy still owns cwd, then carry that identity through the
    // bootstrap child and generated service launcher. Service managers do not share one cwd.
    childEnv['EVOLVER_LIFECYCLE_STATE_DIR'] = resolveBootstrapStateDir(env);
    return childEnv;
}
const defaultReadTextFile = (path) => readFileSync(path, 'utf8');
export function looksLikeContainer(exists, readFile) {
    if (exists('/.dockerenv'))
        return true;
    try {
        return /docker|containerd|kubepods|podman|lxc/.test(readFile('/proc/1/cgroup'));
    }
    catch {
        return false;
    }
}
function readBootstrapAttempt(env, readFile) {
    try {
        const parsed = JSON.parse(readFile(join(resolveBootstrapStateDir(env), BOOTSTRAP_ATTEMPT_FILE)));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
// Cooldown-worthy attempt outcomes. Migration adds its own failure/timeout outcomes so a
// broken release (download/verify/install/register) does not get retried on every startup.
const BOOTSTRAP_FAILURE_OUTCOMES = new Set([
    'failed', 'timeout', 'cli_not_found', 'migration_failed', 'migration_timeout',
]);
/** True when a recent bootstrap/migration attempt failed within the cooldown window. */
export function recentBootstrapFailure(env, readFile, now) {
    const attempt = readBootstrapAttempt(env, readFile);
    if (!attempt)
        return false;
    if (typeof attempt['outcome'] !== 'string' || !BOOTSTRAP_FAILURE_OUTCOMES.has(attempt['outcome']))
        return false;
    if (typeof attempt['attemptedAt'] !== 'string')
        return false;
    const attemptedAt = Date.parse(attempt['attemptedAt']);
    if (Number.isNaN(attemptedAt))
        return false;
    return now - attemptedAt < BOOTSTRAP_FAILURE_COOLDOWN_MS;
}
/**
 * Decide whether an unsupervised (degraded) startup should attempt first-run bootstrap.
 * Pure — filesystem access is injectable for tests.
 */
export function shouldBootstrap(env, platform = process.platform, options = {}) {
    if (selfUpdateSupervisorAttested(env))
        return { proceed: false, reason: 'already_supervised' };
    const bootstrapSwitch = env['EVOLVER_SELF_BOOTSTRAP']?.trim();
    if (bootstrapSwitch === '0' || bootstrapSwitch === 'off')
        return { proceed: false, reason: 'bootstrap_disabled' };
    if (isSelfUpdateExplicit(env) && resolveSelfUpdatePolicy(env) !== 'auto') {
        return { proceed: false, reason: 'policy_not_auto' };
    }
    const exists = options.exists ?? existsSync;
    if (exists(join(resolveBootstrapStateDir(env), BOOTSTRAP_SUCCESS_FILE))) {
        return { proceed: false, reason: 'already_bootstrapped' };
    }
    // The npm/JS install shape has no replaceable standalone binary target, so the launcher
    // bootstrap would register a supervised instance that crashes at self-update target
    // resolution on every startup (crash-loop under the service manager). Skip it; an explicit
    // EVOLVER_SELF_UPDATE_TARGET_PATH keeps the target bindable and bypasses this guard.
    try {
        resolveSelfUpdateTarget({ env, processExecPath: options.execPath });
    }
    catch {
        return { proceed: false, reason: 'unsupported_install_shape' };
    }
    const ci = env['CI']?.trim();
    if (ci && ci.toLowerCase() !== 'false' && ci !== '0')
        return { proceed: false, reason: 'ci_environment' };
    if (platform === 'linux' && looksLikeContainer(exists, options.readFile ?? defaultReadTextFile)) {
        return { proceed: false, reason: 'container_environment' };
    }
    if (recentBootstrapFailure(env, options.readFile ?? defaultReadTextFile, options.now ?? Date.now())) {
        return { proceed: false, reason: 'recent_failure' };
    }
    return { proceed: true };
}
/**
 * Resolve the `lifecycle bootstrap` invocation for the current install shape: standalone binary,
 * CLI entry through node, or the npm-installed @evomap/evolver-cli sibling. Returns undefined when
 * no CLI can be located (degrade to the existing warning instead of failing startup).
 */
export function resolveBootstrapCliInvocation(options = {}) {
    const execPath = options.execPath ?? process.execPath;
    const argv1 = options.argv1 ?? process.argv[1];
    const exists = options.exists ?? existsSync;
    const executableName = basename(execPath).toLowerCase();
    if (/^evolver(?:\.exe|-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64\.exe))?$/.test(executableName)) {
        return { command: execPath, args: ['lifecycle', 'bootstrap'] };
    }
    if (argv1 && basename(argv1).toLowerCase() === 'cli.js') {
        return { command: execPath, args: [argv1, 'lifecycle', 'bootstrap'] };
    }
    try {
        const entry = requireFromHere.resolve('@evomap/evolver-cli');
        const cliPath = join(dirname(entry), 'cli.js');
        if (exists(cliPath))
            return { command: execPath, args: [cliPath, 'lifecycle', 'bootstrap'] };
    }
    catch {
        // Not resolvable from the installed proxy package — fall through to the monorepo layout.
    }
    const local = fileURLToPath(new URL('../../../evolver-cli/dist/cli.js', import.meta.url));
    if (exists(local))
        return { command: execPath, args: [local, 'lifecycle', 'bootstrap'] };
    return undefined;
}
/** Best-effort attempt marker; never throws — bootstrap bookkeeping must not break startup. */
export function recordBootstrapAttempt(env, outcome, options = {}) {
    const path = join(resolveBootstrapStateDir(env), BOOTSTRAP_ATTEMPT_FILE);
    const record = {
        attemptedAt: new Date(options.now ?? Date.now()).toISOString(),
        outcome: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
    try {
        const writeFile = options.writeFile ?? ((target, content) => {
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
        });
        writeFile(path, `${JSON.stringify(record)}\n`);
    }
    catch {
        // Marker is advisory; startup continues regardless.
    }
}
/** Spawn `evolver lifecycle bootstrap` and await its result within a bounded timeout. */
export async function runBootstrap(options) {
    const invocation = resolveBootstrapCliInvocation(options);
    if (!invocation)
        return { ok: false, reason: 'cli_not_found' };
    const spawnFn = options.spawnFn ?? spawn;
    const timeoutMs = options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
    return new Promise((resolvePromise) => {
        let child;
        try {
            child = spawnFn(invocation.command, invocation.args, {
                stdio: 'ignore',
                windowsHide: true,
                env: bootstrapChildEnv(options.env),
            });
        }
        catch (error) {
            resolvePromise({ ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) });
            return;
        }
        let settled = false;
        const settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(outcome);
        };
        const timer = setTimeout(() => {
            child.kill();
            settle({ ok: false, reason: 'timeout' });
        }, timeoutMs);
        child.once('error', (error) => {
            settle({ ok: false, reason: 'failed', detail: error.message });
        });
        child.once('exit', (code) => {
            if (code === 0)
                settle({ ok: true, reason: 'bootstrapped' });
            else
                settle({ ok: false, reason: 'failed', detail: `exit ${code ?? 'null'}` });
        });
    });
}
/**
 * Orchestrate bootstrap for a degraded (default-auto, unsupervised) startup: decide, attempt,
 * record, and produce the operator message. Never throws.
 */
export async function bootstrapDegradedSelfUpdateStartup(env, platform = process.platform, options = {}) {
    const bootstrapEnv = {
        ...env,
        EVOLVER_LIFECYCLE_STATE_DIR: resolveBootstrapStateDir(env),
    };
    const decision = shouldBootstrap(bootstrapEnv, platform, options);
    if (!decision.proceed) {
        const reason = decision.reason ?? 'skipped';
        recordBootstrapAttempt(bootstrapEnv, { ok: false, reason }, options);
        if (reason === 'unsupported_install_shape') {
            // Do not suggest `evolver lifecycle bootstrap` here: under the npm/JS install shape it
            // would register a supervised service that crashes at self-update target resolution on
            // every startup (crash-loop). Only a standalone release binary can host self-update —
            // so attempt the one-time migration to it; any skip/failure keeps the degraded startup.
            const migration = await migrateToStandaloneBinary(env, platform, {
                ...options.migration,
                ...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
                ...(options.exists !== undefined ? { exists: options.exists } : {}),
                ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
                ...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
                ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
                ...(options.now !== undefined ? { now: options.now } : {}),
            });
            if (migration.outcome === 'migrated') {
                return { handedOver: true, message: migration.message };
            }
            return {
                handedOver: false,
                message: '[evolver-proxy] self-update: running from the npm/JS install shape, which has no standalone '
                    + 'binary target for self-update; bootstrap skipped, continuing with self-update off. '
                    + 'Install the standalone binary from GitHub Releases and start it to enable self-update. '
                    + `(${migration.message})`,
            };
        }
        return {
            handedOver: false,
            message: '[evolver-proxy] self-update: default auto requires a durable supervisor attestation; '
                + `running with self-update off (bootstrap skipped: ${reason}). `
                + 'Run `evolver lifecycle bootstrap` or `evolver lifecycle install-service` to enable.',
        };
    }
    const outcome = await runBootstrap({ env: bootstrapEnv, platform, ...options });
    recordBootstrapAttempt(bootstrapEnv, outcome, options);
    if (outcome.ok) {
        return {
            handedOver: true,
            message: '[evolver-proxy] self-update: registered durable service supervision via `evolver lifecycle bootstrap`; '
                + 'handing over to the service manager and exiting so it can take the IPC port.',
        };
    }
    return {
        handedOver: false,
        message: `[evolver-proxy] self-update: first-run bootstrap failed (${outcome.reason}); `
            + 'running with self-update off. Run `evolver lifecycle install-service` manually to enable.',
    };
}