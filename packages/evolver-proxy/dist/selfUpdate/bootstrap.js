// First-run supervision bootstrap for the DEFAULT self-update policy.
//
// Default auto self-update degrades to 'off' without a durable supervisor attestation (policy.ts).
// For a standalone release binary, an unsupervised foreground startup may once
// register its own user-level durable launcher (`evolver lifecycle bootstrap`) and hand over to it:
// the generated launcher carries the EVOLVER_SELF_UPDATE_SUPERVISOR attestation, so the next
// supervised startup runs auto self-update with the unchanged signature/health-check/rollback gates.
//
// Bootstrap is a convenience, never an escalation: it is skipped for attested runs, explicit
// non-auto policies, the EVOLVER_SELF_BOOTSTRAP kill switch, CI, containers, and within a
// cooldown window after a safe failed attempt. The npm/JS install shape first attempts the
// signed standalone migration from migration.ts. Foreground startup continues only when no
// registration child was created or a clean rollback and process-tree termination are proven;
// all ambiguous child ownership fails closed.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse as parsePath, posix, resolve as resolvePath, win32, } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap as coreBootstrap, util } from '@evomap/evolver-core';
import { isSelfUpdateExplicit, resolveSelfUpdatePolicy, selfUpdateSupervisorAttested, } from './policy.js';
import { isStandaloneReleaseBinaryName, resolveSelfUpdateTarget, } from './releaseBinary.js';
import { expandHomePath, parseEnvFile } from '../bin/envFile.js';
import { migrateToStandaloneBinary, } from './migration.js';
const requireFromHere = createRequire(import.meta.url);
const BOOTSTRAP_ATTEMPT_FILE = 'bootstrap-attempt.json';
const BOOTSTRAP_REGISTRATION_INTENT_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_FILE;
const BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE;
const BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE;
const BOOTSTRAP_REGISTRATION_INTENT_PUBLISHING_FILE = 'bootstrap-registration.intent.publishing';
const BOOTSTRAP_REGISTRATION_INTENT_PUBLISHER_PREFIX = 'bootstrap-registration.intent.publisher.';
const BOOTSTRAP_REGISTRATION_INTENT_SCHEMA = coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA;
const BOOTSTRAP_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// The child owns a shorter absolute transaction deadline. The parent waits beyond that deadline
// so the child can finish its durable rollback, and only then force-terminates the whole process
// tree if the child failed to honor the contract.
const BOOTSTRAP_TRANSACTION_BUDGET_MS = 180_000;
const BOOTSTRAP_PARENT_EXIT_GRACE_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = BOOTSTRAP_TRANSACTION_BUDGET_MS + BOOTSTRAP_PARENT_EXIT_GRACE_MS;
const BOOTSTRAP_TREE_TERMINATION_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const BOOTSTRAP_ENV_FILE_HANDOFF = 'EVOLVER_INTERNAL_BOOTSTRAP_ENV_FILE';
export const RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV = 'EVOLVER_INTERNAL_RECOVERY_CONTROLLER_LIFECYCLE_OWNER';
const MAX_RECOVERY_CONTROLLER_OWNER_CAPABILITY_BYTES = 1024;
const MAX_BOOTSTRAP_OUTPUT_BYTES = 64 * 1024;
const MAX_BOOTSTRAP_STATE_BYTES = 128 * 1024;
const MAX_BOOTSTRAP_ATTEMPT_BYTES = 4 * 1024;
const MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES = coreBootstrap.MAX_LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_BYTES;
const MAX_BOOTSTRAP_DETAIL_LENGTH = 512;
const HOST_WINDOWS_SYSTEM_ROOT = process.env['SystemRoot']?.trim() || 'C:\\Windows';
/** Lifecycle state dir mirror of evolver-cli lifecyclePaths (kept dependency-free across packages). */
export function resolveBootstrapStateDir(env) {
    const explicit = env['EVOLVER_LIFECYCLE_STATE_DIR']?.trim();
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    return resolvePath(explicit || join(home, 'lifecycle'));
}
export function withRecoveryControllerLifecycleOwnerCapability(env, owner) {
    return prepareRecoveryControllerLifecycleOwnerCapability(env, owner).env;
}
export function prepareRecoveryControllerLifecycleOwnerCapability(env, owner) {
    const startupAckToken = randomUUID();
    return {
        env: {
            ...env,
            [RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV]: JSON.stringify({
                v: 1,
                pid: owner.pid,
                token: owner.token,
                processStartIdentity: owner.processStartIdentity,
                startupAckToken,
            }),
        },
        startupAckToken,
    };
}
export function clearRecoveryControllerLifecycleOwnerCapability(env) {
    delete env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV];
}
export function publishRecoveryControllerLifecycleStartupAttestation(env, descriptor = 3) {
    if (env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV] === undefined)
        return false;
    const capability = recoveryControllerLifecycleOwnerCapability(env);
    if (!capability) {
        throw new Error('self_update_recovery_controller_lifecycle_capability_invalid');
    }
    assertRecoveryControllerLifecycleOwnerLease(env, capability.owner);
    writeSync(descriptor, `${capability.startupAckToken}\n`, undefined, 'utf8');
    closeSync(descriptor);
    clearRecoveryControllerLifecycleOwnerCapability(env);
    return true;
}
function bootstrapChildEnv(env, transactionDeadlineMs) {
    const childEnv = { ...env };
    const envFile = env['EVOLVER_ENV_FILE']?.trim();
    delete childEnv['EVOLVER_ENV_FILE'];
    delete childEnv[BOOTSTRAP_ENV_FILE_HANDOFF];
    if (envFile)
        childEnv[BOOTSTRAP_ENV_FILE_HANDOFF] = resolvePath(expandHomePath(envFile));
    // Resolve while the foreground proxy still owns cwd, then carry that identity through the
    // bootstrap child and generated service launcher. Service managers do not share one cwd.
    childEnv['EVOLVER_LIFECYCLE_STATE_DIR'] = resolveBootstrapStateDir(env);
    childEnv[coreBootstrap.LIFECYCLE_BOOTSTRAP_DEADLINE_ENV] = String(transactionDeadlineMs);
    return childEnv;
}
export function lifecycleBootstrapStatePresent(env, exists = bootstrapStateEntryPresent) {
    const stateDir = resolveBootstrapStateDir(env);
    return [
        coreBootstrap.LIFECYCLE_BOOTSTRAP_SUCCESS_FILE,
        coreBootstrap.LIFECYCLE_BOOTSTRAP_JOURNAL_FILE,
        coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE,
        coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_FILE,
        coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE,
        coreBootstrap.LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_FILE,
    ].some((name) => exists(join(stateDir, name)));
}
function bootstrapStateEntryPresent(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        return !isErrno(error, 'ENOENT');
    }
}
const defaultReadTextFile = (path) => readFileSync(path, 'utf8');
const BOOTSTRAP_JOURNAL_SCHEMA = 'evolver.lifecycle-bootstrap-transaction.v1';
const BOOTSTRAP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOTSTRAP_JOURNAL_STAGES = new Set([
    'prepared', 'installing', 'installed', 'activating', 'activated', 'committing',
    'committed', 'rollback_pending', 'rolled_back',
]);
function boundedBootstrapDetail(value) {
    let normalized = '';
    let previousWasSpace = false;
    for (const character of value) {
        const next = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character) ? ' ' : character;
        if (next === ' ' && previousWasSpace)
            continue;
        normalized += next;
        previousWasSpace = next === ' ';
        if (normalized.length >= MAX_BOOTSTRAP_DETAIL_LENGTH)
            break;
    }
    return normalized.slice(0, MAX_BOOTSTRAP_DETAIL_LENGTH);
}
function readBoundedBootstrapStateFile(path, options, maxBytes = MAX_BOOTSTRAP_STATE_BYTES) {
    const injected = options.exists !== undefined || options.readFile !== undefined;
    try {
        if (injected) {
            if (!(options.exists ?? existsSync)(path))
                return { status: 'absent' };
            const raw = (options.readFile ?? defaultReadTextFile)(path);
            if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
                return { status: 'invalid', detail: `oversized durable state: ${basename(path)}` };
            }
            return { status: 'present', raw };
        }
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
            || before.size > BigInt(maxBytes)
            || before.dev <= 0n || before.ino <= 0n) {
            return { status: 'invalid', detail: `unsafe durable state: ${basename(path)}` };
        }
        (options.assertIntentFileTrust ?? assertNativeBootstrapIntentFileTrust)(path);
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
                || opened.size !== before.size) {
                return { status: 'invalid', detail: `changed durable state: ${basename(path)}` };
            }
            const bytes = Buffer.alloc(maxBytes + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
                if (count === 0)
                    break;
                offset += count;
            }
            if (offset > maxBytes) {
                return { status: 'invalid', detail: `oversized durable state: ${basename(path)}` };
            }
            const raw = bytes.subarray(0, offset).toString('utf8');
            const after = fstatSync(descriptor, { bigint: true });
            if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
                || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
                return { status: 'invalid', detail: `changed durable state: ${basename(path)}` };
            }
            (options.assertIntentFileTrust ?? assertNativeBootstrapIntentFileTrust)(path);
            const settled = lstatSync(path, { bigint: true });
            if (!settled.isFile() || settled.isSymbolicLink() || settled.nlink !== 1n
                || settled.dev !== opened.dev || settled.ino !== opened.ino || settled.size !== opened.size
                || settled.mtimeNs !== opened.mtimeNs || settled.ctimeNs !== opened.ctimeNs) {
                return { status: 'invalid', detail: `changed durable state: ${basename(path)}` };
            }
            return { status: 'present', raw };
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return { status: 'absent' };
        return {
            status: 'invalid',
            detail: boundedBootstrapDetail(`unreadable durable state ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
}
function sameBootstrapStateFileSnapshot(left, right) {
    if (left.status !== right.status)
        return false;
    if (left.status === 'present' && right.status === 'present') {
        return left.raw === right.raw;
    }
    return left.status === 'absent' && right.status === 'absent';
}
function legacyBootstrapPathKey(path, target) {
    return target === 'windows'
        ? win32.normalize(path).toLowerCase()
        : posix.normalize(path);
}
function assertNativeBootstrapLegacyProofFileTrust(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink < 1) {
        throw new Error('legacy bootstrap proof file is unsafe');
    }
    if (process.platform === 'win32') {
        assertWindowsBootstrapIntentAclTrusted([{ path, parentOnly: false }]);
        return;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined
        || (info.uid !== uid && info.uid !== 0)
        || (info.mode & 0o022) !== 0) {
        throw new Error('legacy bootstrap proof file is not trusted');
    }
}
function readLegacyBootstrapProofFile(receipt, options) {
    if (receipt.size < 1 || receipt.size > MAX_BOOTSTRAP_STATE_BYTES) {
        throw new Error('legacy bootstrap proof receipt has an invalid size');
    }
    const injected = options.exists !== undefined || options.readFile !== undefined;
    const exists = options.exists ?? existsSync;
    const readFile = options.readFile ?? defaultReadTextFile;
    if (injected) {
        if (!exists(receipt.path))
            throw new Error('legacy bootstrap proof file is missing');
        const first = readFile(receipt.path);
        options.afterLegacyProofRead?.(receipt.path);
        const second = readFile(receipt.path);
        const bytes = Buffer.from(first, 'utf8');
        if (first !== second
            || bytes.length !== receipt.size
            || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
            throw new Error('legacy bootstrap proof file changed after adoption');
        }
        return first;
    }
    const assertDirectoryTrust = options.assertLegacyProofDirectoryTrust
        ?? ((directory) => assertNativeBootstrapIntentDirectoryTrust(directory, false));
    const assertFileTrust = options.assertLegacyProofFileTrust
        ?? assertNativeBootstrapLegacyProofFileTrust;
    const directory = dirname(receipt.path);
    assertDirectoryTrust(directory);
    assertFileTrust(receipt.path);
    const before = lstatSync(receipt.path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
        || before.dev <= 0n || before.ino <= 0n
        || before.size !== BigInt(receipt.size)
        || before.dev !== BigInt(receipt.device ?? '0')
        || before.ino !== BigInt(receipt.inode ?? '0')) {
        throw new Error('legacy bootstrap proof identity changed after adoption');
    }
    const descriptor = openSync(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()
            || opened.dev !== before.dev || opened.ino !== before.ino
            || opened.size !== before.size
            || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
            throw new Error('legacy bootstrap proof changed while opening');
        }
        const readPass = () => {
            const bytes = Buffer.alloc(receipt.size + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
                if (count === 0)
                    break;
                offset += count;
            }
            return bytes.subarray(0, offset);
        };
        const first = readPass();
        options.afterLegacyProofRead?.(receipt.path);
        const second = readPass();
        const after = fstatSync(descriptor, { bigint: true });
        if (!first.equals(second)
            || first.length !== receipt.size
            || createHash('sha256').update(first).digest('hex') !== receipt.sha256
            || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
            throw new Error('legacy bootstrap proof changed while reading');
        }
        assertDirectoryTrust(directory);
        assertFileTrust(receipt.path);
        const settled = lstatSync(receipt.path, { bigint: true });
        if (!settled.isFile() || settled.isSymbolicLink()
            || settled.dev !== opened.dev || settled.ino !== opened.ino
            || settled.size !== opened.size
            || settled.mtimeNs !== opened.mtimeNs || settled.ctimeNs !== opened.ctimeNs) {
            throw new Error('legacy bootstrap proof path changed while reading');
        }
        return first.toString('utf8');
    }
    finally {
        closeSync(descriptor);
    }
}
function validateLegacyBootstrapStateRootProof(marker, stateDir, env, options) {
    const proof = marker.legacyStateRootProof;
    if (!proof)
        return undefined;
    const key = (path) => legacyBootstrapPathKey(path, marker.target);
    if (key(proof.stateDir) !== key(stateDir)
        || key(env['EVOLVER_LIFECYCLE_STATE_DIR']?.trim() ?? '') !== key(proof.stateDir)
        || key(env['EVOLVER_ENV_FILE']?.trim() ?? '') !== key(proof.envFilePath)) {
        return 'legacy bootstrap state-root binding no longer matches the supervised environment';
    }
    const receipt = marker.preservedArtifacts?.find((artifact) => key(artifact.path) === key(proof.envFilePath));
    if (!receipt)
        return 'legacy bootstrap state-root proof has no preserved receipt';
    try {
        const raw = readLegacyBootstrapProofFile(receipt, options);
        const configured = parseEnvFile(raw)['EVOLVER_LIFECYCLE_STATE_DIR'];
        if (!configured || key(configured) !== key(proof.stateDir)) {
            return 'legacy bootstrap env file no longer pins the adopted state root';
        }
    }
    catch {
        return 'legacy bootstrap state-root proof could not be revalidated';
    }
    return undefined;
}
function parseBootstrapLockOwnerJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        const keys = Object.keys(record).sort();
        if (keys.length !== 4
            || keys[0] !== 'pid'
            || keys[1] !== 'processStart'
            || keys[2] !== 'token'
            || keys[3] !== 'v'
            || record['v'] !== 2
            || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0
            || typeof record['token'] !== 'string' || !BOOTSTRAP_UUID_RE.test(record['token'])) {
            return undefined;
        }
        const processStartIdentity = util.parseFileLockProcessStartIdentity(record['processStart']);
        if (!processStartIdentity)
            return undefined;
        return {
            pid: record['pid'],
            token: record['token'],
            processStartIdentity,
        };
    }
    catch {
        return undefined;
    }
}
function parseBootstrapJournalOwner(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const processStartIdentity = util.parseFileLockProcessStartIdentity(record['processStartIdentity']);
    if (!Number.isSafeInteger(record['pid']) || record['pid'] <= 0
        || typeof record['token'] !== 'string' || !BOOTSTRAP_UUID_RE.test(record['token'])
        || !processStartIdentity
        || typeof record['acquiredAt'] !== 'string'
        || Number.isNaN(Date.parse(record['acquiredAt']))) {
        return undefined;
    }
    return {
        pid: record['pid'],
        token: record['token'],
        processStartIdentity,
    };
}
function recoveryControllerLifecycleOwnerCapability(env, parentPid = process.ppid) {
    const raw = env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV];
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_CONTROLLER_OWNER_CAPABILITY_BYTES) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        const keys = Object.keys(record).sort();
        if (keys.length !== 5
            || keys[0] !== 'pid'
            || keys[1] !== 'processStartIdentity'
            || keys[2] !== 'startupAckToken'
            || keys[3] !== 'token'
            || keys[4] !== 'v'
            || record['v'] !== 1
            || !Number.isSafeInteger(record['pid'])
            || record['pid'] !== parentPid
            || typeof record['token'] !== 'string'
            || !BOOTSTRAP_UUID_RE.test(record['token'])
            || typeof record['startupAckToken'] !== 'string'
            || !BOOTSTRAP_UUID_RE.test(record['startupAckToken'])) {
            return undefined;
        }
        const processStartIdentity = util.parseFileLockProcessStartIdentity(record['processStartIdentity']);
        if (!processStartIdentity)
            return undefined;
        const owner = {
            pid: record['pid'],
            token: record['token'],
            processStartIdentity,
        };
        if (util.inspectFileLockOwnerProcess(owner) !== 'current')
            return undefined;
        return { owner, startupAckToken: record['startupAckToken'] };
    }
    catch {
        return undefined;
    }
}
function assertRecoveryControllerLifecycleOwnerLease(env, owner, options = {}) {
    const durable = inspectLifecycleBootstrapDurableState(env, {
        ...options,
        expectedRecoveryOwner: owner,
    });
    if (durable.status === 'invalid') {
        throw new Error('self_update_recovery_controller_lifecycle_capability_invalid:'
            + boundedBootstrapDetail(durable.detail));
    }
}
function sameBootstrapLockOwner(left, right) {
    return left.pid === right.pid
        && left.token === right.token
        && util.sameFileLockProcessStartIdentity(left.processStartIdentity, right.processStartIdentity);
}
function bootstrapLockProcessStatus(owner, options) {
    try {
        return (options.registrationOwnerProcessStatus
            ?? util.inspectFileLockOwnerProcess)(owner);
    }
    catch {
        return 'unverifiable';
    }
}
function inspectBootstrapRecoveryLock(owner, options) {
    if (!owner)
        return { recoveryStatus: 'active_or_unverifiable' };
    const processStatus = bootstrapLockProcessStatus(owner, options);
    return {
        owner,
        processStatus,
        recoveryStatus: processStatus === 'dead' || processStatus === 'pid_reused'
            ? 'stale'
            : 'active_or_unverifiable',
    };
}
function normalBootstrapActivationContractValid(record, owner, target, deadlineMs) {
    const managerBinding = record['managerBinding'];
    return owner !== undefined
        && target !== undefined
        && deadlineMs !== undefined
        && record['operation'] === undefined
        && record['terminalAction'] === undefined
        && typeof record['service'] === 'string'
        && record['service'].length > 0
        && record['service'].length <= 128
        && record['managerBefore'] === 'absent'
        && managerBinding !== null
        && typeof managerBinding === 'object'
        && !Array.isArray(managerBinding)
        && managerBinding['kind'] === 'transaction'
        && typeof managerBinding['artifactPath'] === 'string'
        && managerBinding['artifactPath'].length > 0
        && managerBinding['artifactPath'].length <= 4_096
        && Array.isArray(record['artifacts'])
        && record['artifacts'].length > 0
        && record['artifacts'].length <= 32
        && typeof record['updatedAt'] === 'string'
        && !Number.isNaN(Date.parse(record['updatedAt']));
}
function parseBootstrapJournalReceipt(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        if (record['schema'] !== BOOTSTRAP_JOURNAL_SCHEMA
            || typeof record['transactionId'] !== 'string' || !BOOTSTRAP_UUID_RE.test(record['transactionId'])
            || typeof record['stage'] !== 'string' || !BOOTSTRAP_JOURNAL_STAGES.has(record['stage'])) {
            return undefined;
        }
        if (record['terminalAction'] === undefined) {
            if (record['operation'] !== undefined
                || (record['target'] !== undefined
                    && (typeof record['target'] !== 'string'
                        || !['launchd', 'systemd', 'windows'].includes(record['target'])))
                || (record['owner'] !== undefined && !parseBootstrapJournalOwner(record['owner']))
                || (record['deadlineMs'] !== undefined
                    && (!Number.isSafeInteger(record['deadlineMs'])
                        || record['deadlineMs'] <= 0))
                || (record['activationStarted'] !== undefined
                    && typeof record['activationStarted'] !== 'boolean')) {
                return undefined;
            }
            const target = record['target'];
            const owner = record['owner'] === undefined
                ? undefined
                : parseBootstrapJournalOwner(record['owner']);
            const deadlineMs = record['deadlineMs'];
            return {
                transactionId: record['transactionId'],
                stage: record['stage'],
                ...(target ? { target } : {}),
                ...(owner ? { owner } : {}),
                ...(deadlineMs !== undefined ? { deadlineMs } : {}),
                ...(record['activationStarted'] !== undefined
                    ? { activationStarted: record['activationStarted'] }
                    : {}),
                ...(normalBootstrapActivationContractValid(record, owner, target, deadlineMs)
                    ? { activationContractValid: true }
                    : {}),
            };
        }
        if (record['operation'] === 'legacy-v907-remove'
            && record['terminalAction'] === 'remove_committed'
            && ['prepared', 'rollback_pending', 'rolled_back'].includes(record['stage'])
            && typeof record['target'] === 'string'
            && ['launchd', 'systemd', 'windows'].includes(record['target'])) {
            return {
                transactionId: record['transactionId'],
                stage: record['stage'],
                target: record['target'],
                terminalAction: 'remove_committed',
                operation: 'legacy-v907-remove',
            };
        }
        if (record['terminalAction'] !== 'remove_committed'
            || !['rollback_pending', 'rolled_back'].includes(record['stage'])
            || typeof record['target'] !== 'string'
            || !['launchd', 'systemd', 'windows'].includes(record['target'])) {
            return undefined;
        }
        return {
            transactionId: record['transactionId'],
            stage: record['stage'],
            target: record['target'],
            terminalAction: 'remove_committed',
        };
    }
    catch {
        return undefined;
    }
}
function inspectLifecycleBootstrapDurableState(env, options) {
    const stateDir = resolveBootstrapStateDir(env);
    if (options.exists === undefined && options.readFile === undefined) {
        try {
            const state = lstatSync(stateDir);
            if (!state.isDirectory() || state.isSymbolicLink()) {
                return { status: 'invalid', detail: 'lifecycle state directory is not trusted' };
            }
            if (process.platform !== 'win32') {
                const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
                if ((uid !== undefined && state.uid !== uid) || (state.mode & 0o077) !== 0) {
                    return { status: 'invalid', detail: 'lifecycle state directory is not owner-only' };
                }
            }
        }
        catch (error) {
            if (isErrno(error, 'ENOENT'))
                return { status: 'clean' };
            return { status: 'invalid', detail: 'lifecycle state directory is unreadable' };
        }
    }
    const markerFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_SUCCESS_FILE), options);
    const journalFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_JOURNAL_FILE), options);
    const ownerLockFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE), options, util.MAX_LOCK_OWNER_BYTES);
    const readinessFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_FILE), options);
    const readinessLockFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE), options, util.MAX_LOCK_OWNER_BYTES);
    const manualTransitionFile = readBoundedBootstrapStateFile(join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_FILE), options, coreBootstrap.MAX_LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_BYTES);
    for (const state of [
        markerFile,
        journalFile,
        ownerLockFile,
        readinessFile,
        readinessLockFile,
        manualTransitionFile,
    ]) {
        if (state.status === 'invalid')
            return { status: 'invalid', detail: state.detail };
    }
    const marker = markerFile.status === 'present'
        ? coreBootstrap.parseLifecycleBootstrapMarkerJson(markerFile.raw)
        : undefined;
    const legacyMarker = markerFile.status === 'present' && !marker
        ? coreBootstrap.parseLegacyLifecycleBootstrapMarkerJson(markerFile.raw)
        : undefined;
    if (markerFile.status === 'present' && !marker && !legacyMarker) {
        return { status: 'invalid', detail: 'bootstrap success marker is corrupt' };
    }
    const readiness = readinessFile.status === 'present'
        ? coreBootstrap.parseLifecycleBootstrapReadinessJson(readinessFile.raw)
        : undefined;
    if (readinessFile.status === 'present' && !readiness) {
        return { status: 'invalid', detail: 'bootstrap readiness receipt is corrupt' };
    }
    const journal = journalFile.status === 'present'
        ? parseBootstrapJournalReceipt(journalFile.raw)
        : undefined;
    if (journalFile.status === 'present' && !journal) {
        return { status: 'invalid', detail: 'bootstrap recovery journal is corrupt' };
    }
    const manualTransition = manualTransitionFile.status === 'present'
        ? coreBootstrap.parseLifecycleBootstrapManualTransitionJson(manualTransitionFile.raw)
        : undefined;
    if (manualTransitionFile.status === 'present' && !manualTransition) {
        return { status: 'invalid', detail: 'bootstrap manual-transition tombstone is corrupt' };
    }
    const ownerLockOwner = ownerLockFile.status === 'present'
        ? parseBootstrapLockOwnerJson(ownerLockFile.raw)
        : undefined;
    const expectedRecoveryOwner = options.expectedRecoveryOwner;
    if (expectedRecoveryOwner !== undefined
        && (ownerLockFile.status !== 'present'
            || ownerLockOwner === undefined
            || !sameBootstrapLockOwner(ownerLockOwner, expectedRecoveryOwner))) {
        return {
            status: 'invalid',
            detail: 'lifecycle bootstrap owner lease is no longer held by the expected owner',
        };
    }
    const ownerLockIgnored = ownerLockOwner !== undefined
        && expectedRecoveryOwner !== undefined
        && sameBootstrapLockOwner(ownerLockOwner, expectedRecoveryOwner);
    const ownerLockPresent = ownerLockFile.status === 'present' && !ownerLockIgnored;
    const readinessLockPresent = readinessLockFile.status === 'present';
    const ownerLock = ownerLockPresent
        ? inspectBootstrapRecoveryLock(ownerLockOwner, options)
        : undefined;
    const readinessLockOwner = readinessLockFile.status === 'present'
        ? parseBootstrapLockOwnerJson(readinessLockFile.raw)
        : undefined;
    const readinessLock = readinessLockPresent
        ? inspectBootstrapRecoveryLock(readinessLockOwner, options)
        : undefined;
    const changedAfterLockProbe = (prior, path, maxBytes) => {
        const current = readBoundedBootstrapStateFile(path, options, maxBytes);
        if (current.status === 'invalid')
            return current.detail;
        return sameBootstrapStateFileSnapshot(prior, current)
            ? undefined
            : `durable lifecycle state changed during lock owner inspection: ${basename(path)}`;
    };
    const snapshotFailure = changedAfterLockProbe(ownerLockFile, join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE), util.MAX_LOCK_OWNER_BYTES) ?? changedAfterLockProbe(readinessLockFile, join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE), util.MAX_LOCK_OWNER_BYTES) ?? changedAfterLockProbe(journalFile, join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_JOURNAL_FILE), MAX_BOOTSTRAP_STATE_BYTES);
    if (snapshotFailure)
        return { status: 'invalid', detail: snapshotFailure };
    const recoveryLocks = {
        ...(ownerLock ? { owner: ownerLock.recoveryStatus } : {}),
        ...(readinessLock ? { readiness: readinessLock.recoveryStatus } : {}),
    };
    const recoveryLockState = Object.keys(recoveryLocks).length > 0
        ? recoveryLocks
        : undefined;
    const activeRecoveryLock = Object.values(recoveryLocks)
        .some((status) => status === 'active_or_unverifiable');
    const withRecoveryLocks = recoveryLockState ? { recoveryLocks: recoveryLockState } : {};
    if (journal && readiness && journal.transactionId !== readiness.transactionId) {
        return { status: 'invalid', detail: 'bootstrap journal and readiness owners differ' };
    }
    if (journal?.target && marker && journal.target !== marker.target) {
        return { status: 'invalid', detail: 'bootstrap journal and marker targets differ' };
    }
    if (legacyMarker) {
        if (readiness) {
            return {
                status: 'invalid',
                detail: 'legacy bootstrap marker conflicts with transaction durable state',
            };
        }
        if (journal) {
            if (manualTransition && (journal.terminalAction !== 'remove_committed'
                || journal.transactionId !== manualTransition.removedTransactionId
                || journal.target !== manualTransition.target)) {
                return {
                    status: 'invalid',
                    detail: 'legacy bootstrap removal journal conflicts with manual-transition state',
                };
            }
            return {
                status: 'pending',
                detail: 'legacy bootstrap recovery journal requires CLI recovery',
                ...withRecoveryLocks,
                ...(manualTransition ? {
                    manualTransition: {
                        transitionId: manualTransition.transitionId,
                        target: manualTransition.target,
                    },
                } : {}),
            };
        }
        if (manualTransition) {
            return {
                status: 'invalid',
                detail: 'legacy bootstrap marker conflicts with manual-transition state',
            };
        }
        return {
            status: 'pending',
            detail: 'legacy bootstrap marker requires exact CLI adoption',
            ...withRecoveryLocks,
        };
    }
    if (manualTransition) {
        if (journal) {
            if (journal.terminalAction !== 'remove_committed'
                || journal.transactionId !== manualTransition.removedTransactionId
                || journal.target !== manualTransition.target) {
                return {
                    status: 'invalid',
                    detail: 'bootstrap manual-transition tombstone conflicts with recovery journal',
                };
            }
            if ((marker && (marker.transactionId !== manualTransition.removedTransactionId
                || marker.target !== manualTransition.target))
                || (readiness && readiness.transactionId !== manualTransition.removedTransactionId)) {
                return {
                    status: 'invalid',
                    detail: 'bootstrap manual-transition tombstone conflicts with committed state',
                };
            }
            return {
                status: 'pending',
                detail: 'committed service removal recovery is pending',
                ...withRecoveryLocks,
                manualTransition: {
                    transitionId: manualTransition.transitionId,
                    target: manualTransition.target,
                },
            };
        }
        if ((marker && (marker.transactionId !== manualTransition.removedTransactionId
            || marker.target !== manualTransition.target))
            || (readiness && (!marker
                || readiness.transactionId !== manualTransition.removedTransactionId))) {
            return {
                status: 'invalid',
                detail: 'bootstrap manual-transition tombstone conflicts with committed state',
            };
        }
        if (marker) {
            return {
                status: 'pending',
                detail: 'manual service removal has not retired the committed marker; rerun remove-service',
                ...withRecoveryLocks,
                manualTransition: {
                    transitionId: manualTransition.transitionId,
                    target: manualTransition.target,
                },
            };
        }
        if (activeRecoveryLock) {
            return {
                status: 'pending',
                detail: 'manual service transition lifecycle lock ownership is active or unverifiable',
                ...withRecoveryLocks,
                manualTransition: {
                    transitionId: manualTransition.transitionId,
                    target: manualTransition.target,
                },
            };
        }
        return {
            status: 'manual_transition',
            transitionId: manualTransition.transitionId,
            target: manualTransition.target,
        };
    }
    if (!marker && !journal && !ownerLockPresent && !readiness && !readinessLockPresent) {
        return { status: 'clean' };
    }
    if (marker?.managerBindingKind === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING) {
        const proofFailure = validateLegacyBootstrapStateRootProof(marker, stateDir, env, options);
        if (proofFailure) {
            return { status: 'invalid', detail: proofFailure };
        }
        if (readiness) {
            return {
                status: 'invalid',
                detail: 'legacy bootstrap binding cannot own a transaction readiness receipt',
            };
        }
        if (journal) {
            return {
                status: 'pending',
                detail: 'legacy bootstrap adoption journal requires CLI recovery',
                ...withRecoveryLocks,
            };
        }
        if (activeRecoveryLock) {
            return {
                status: 'pending',
                detail: 'legacy bootstrap adoption owner lock remains active or readiness lock is unverifiable',
                ...withRecoveryLocks,
            };
        }
        return {
            status: 'committed',
            transactionId: marker.transactionId,
            target: marker.target,
        };
    }
    if (marker && readiness) {
        if (marker.transactionId !== readiness.transactionId) {
            return { status: 'invalid', detail: 'bootstrap marker and readiness owners differ' };
        }
        if (journal && (journal.transactionId !== marker.transactionId
            || !['committing', 'committed'].includes(journal.stage))) {
            return { status: 'invalid', detail: 'bootstrap journal conflicts with committed receipt' };
        }
        if (activeRecoveryLock) {
            return {
                status: 'pending',
                detail: 'committed lifecycle state still has active or unverifiable lock ownership',
                ...withRecoveryLocks,
            };
        }
        return {
            status: 'committed',
            transactionId: marker.transactionId,
            target: marker.target,
        };
    }
    const now = options.now ?? Date.now();
    const supervisedActivation = !marker
        && journal?.stage === 'activating'
        && journal.activationStarted === true
        && journal.activationContractValid === true
        && journal.target !== undefined
        && journal.owner !== undefined
        && journal.deadlineMs !== undefined
        && Number.isSafeInteger(now)
        && now >= 0
        && journal.deadlineMs > now
        && ownerLock?.processStatus === 'current'
        && ownerLock.owner !== undefined
        && sameBootstrapLockOwner(ownerLock.owner, journal.owner)
        && readinessLock?.recoveryStatus !== 'active_or_unverifiable'
        && (!readiness || readiness.transactionId === journal.transactionId)
        ? {
            transactionId: journal.transactionId,
            target: journal.target,
        }
        : undefined;
    const present = [
        marker ? 'marker' : undefined,
        journal ? 'journal' : undefined,
        ownerLockPresent ? 'owner lock' : undefined,
        readiness ? 'readiness' : undefined,
        readinessLockPresent ? 'readiness lock' : undefined,
    ].filter((value) => value !== undefined);
    return {
        status: 'pending',
        detail: `partial durable bootstrap state: ${present.join(',')}`,
        ...withRecoveryLocks,
        ...(supervisedActivation ? { supervisedActivation } : {}),
    };
}
export function assertSupervisedLifecycleBootstrapState(env, options = {}) {
    const capabilityRaw = env[RECOVERY_CONTROLLER_LIFECYCLE_OWNER_CAPABILITY_ENV];
    const controllerCapability = capabilityRaw === undefined
        ? undefined
        : recoveryControllerLifecycleOwnerCapability(env, options.recoveryControllerParentPid ?? process.ppid);
    if (capabilityRaw !== undefined && !controllerCapability) {
        throw new Error('self_update_recovery_controller_lifecycle_capability_invalid');
    }
    if (!selfUpdateSupervisorAttested(env)) {
        if (controllerCapability) {
            assertRecoveryControllerLifecycleOwnerLease(env, controllerCapability.owner, options);
        }
        return;
    }
    const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR']?.trim();
    const supervisorTarget = supervisor === 'systemd'
        ? 'systemd'
        : supervisor === 'launchd'
            ? 'launchd'
            : supervisor === 'windows-scheduled-task'
                ? 'windows'
                : undefined;
    const transactionValue = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV];
    const transactionId = transactionValue?.trim();
    if (!lifecycleBootstrapStatePresent(env, options.exists ?? bootstrapStateEntryPresent)) {
        if (transactionValue !== undefined || options.requireLifecycleState) {
            throw new Error('self_update_supervisor_bootstrap_state_invalid:'
                + (transactionValue !== undefined
                    ? 'transaction-bound supervisor has no durable lifecycle state'
                    : 'unpinned legacy supervisor has no durable lifecycle state'));
        }
        return;
    }
    if (controllerCapability && options.expectedRecoveryOwner
        && !sameBootstrapLockOwner(controllerCapability.owner, options.expectedRecoveryOwner)) {
        throw new Error('self_update_recovery_controller_lifecycle_capability_invalid:expected owner differs');
    }
    const durable = inspectLifecycleBootstrapDurableState(env, {
        ...options,
        expectedRecoveryOwner: options.expectedRecoveryOwner ?? controllerCapability?.owner,
    });
    if (durable.status === 'committed') {
        if (durable.target !== supervisorTarget) {
            throw new Error('self_update_supervisor_bootstrap_state_invalid:'
                + 'committed lifecycle target does not match supervisor attestation');
        }
        if (transactionValue !== undefined
            && (!transactionId
                || !BOOTSTRAP_UUID_RE.test(transactionId)
                || transactionId !== durable.transactionId)) {
            throw new Error('self_update_supervisor_bootstrap_state_invalid:'
                + 'committed lifecycle transaction does not match supervisor attestation');
        }
        return;
    }
    if (durable.status === 'pending' && durable.supervisedActivation) {
        if (!transactionId
            || !BOOTSTRAP_UUID_RE.test(transactionId)
            || transactionId !== durable.supervisedActivation.transactionId
            || durable.supervisedActivation.target !== supervisorTarget) {
            throw new Error('self_update_supervisor_bootstrap_state_invalid:'
                + 'activating lifecycle transaction does not match supervisor attestation');
        }
        return;
    }
    const detail = durable.status === 'pending' || durable.status === 'invalid'
        ? durable.detail
        : 'supervised lifecycle state is not committed';
    throw new Error('self_update_supervisor_bootstrap_state_invalid:' + boundedBootstrapDetail(detail));
}
/**
 * Revalidate the narrow parent-owned activation window used by a newly launched recovery
 * controller. This deliberately rejects committed supervision: callers use it only as delegated
 * authority while the lifecycle parent still owns the mutation lock and is waiting for readiness.
 */
export function assertActiveSupervisedLifecycleBootstrapDelegation(env, options = {}) {
    const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR']?.trim();
    const supervisorTarget = supervisor === 'systemd'
        ? 'systemd'
        : supervisor === 'launchd'
            ? 'launchd'
            : supervisor === 'windows-scheduled-task'
                ? 'windows'
                : undefined;
    const transactionId = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV]?.trim();
    if (!selfUpdateSupervisorAttested(env)
        || !transactionId
        || !BOOTSTRAP_UUID_RE.test(transactionId)
        || !lifecycleBootstrapStatePresent(env, options.exists ?? bootstrapStateEntryPresent)) {
        throw new Error('self_update_supervisor_bootstrap_delegation_invalid:'
            + 'controller has no valid activating lifecycle attestation');
    }
    const durable = inspectLifecycleBootstrapDurableState(env, options);
    if (durable.status === 'pending'
        && durable.supervisedActivation?.transactionId === transactionId
        && durable.supervisedActivation.target === supervisorTarget) {
        return;
    }
    const detail = durable.status === 'pending' || durable.status === 'invalid'
        ? durable.detail
        : 'lifecycle state is not an active delegated activation';
    throw new Error('self_update_supervisor_bootstrap_delegation_invalid:'
        + boundedBootstrapDetail(detail));
}
/**
 * Revalidate a transaction-bound launcher before any self-update operation. Unlike the startup
 * assertion above, this never accepts the narrow activating window used to publish readiness.
 */
export function assertCommittedLifecycleBootstrapState(env, options = {}) {
    const transactionValue = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV];
    if (transactionValue === undefined)
        return;
    const transactionId = transactionValue.trim();
    const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR']?.trim();
    const supervisorTarget = supervisor === 'systemd'
        ? 'systemd'
        : supervisor === 'launchd'
            ? 'launchd'
            : supervisor === 'windows-scheduled-task'
                ? 'windows'
                : undefined;
    if (!selfUpdateSupervisorAttested(env)
        || !transactionId
        || !BOOTSTRAP_UUID_RE.test(transactionId)
        || !lifecycleBootstrapStatePresent(env, options.exists ?? bootstrapStateEntryPresent)) {
        throw new Error('self_update_supervisor_bootstrap_state_invalid:'
            + 'transaction-bound self-update has no valid committed lifecycle attestation');
    }
    const durable = inspectLifecycleBootstrapDurableState(env, options);
    if (durable.status === 'committed'
        && durable.transactionId === transactionId
        && durable.target === supervisorTarget) {
        return;
    }
    const detail = durable.status === 'pending' || durable.status === 'invalid'
        ? durable.detail
        : 'transaction-bound self-update lifecycle state is not committed';
    throw new Error('self_update_supervisor_bootstrap_state_invalid:' + boundedBootstrapDetail(detail));
}
/**
 * Serialize self-update with every lifecycle bootstrap, recovery, and manual-transition writer.
 * Acquisition is deliberately fail-fast: a heartbeat must not block the daemon while another
 * lifecycle owner is active. Transaction-bound launchers revalidate the committed receipt under
 * the exact acquired generation; legacy launchers still hold and recheck the shared owner lock.
 */
export function acquireLifecycleBootstrapOwnerLease(env, lockOptions = { maxTries: 2, waitMs: 0 }) {
    const transactionBound = env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV] !== undefined;
    if (transactionBound)
        assertCommittedLifecycleBootstrapState(env);
    const stateDir = resolveBootstrapStateDir(env);
    assertNativeBootstrapIntentDirectoryTrust(stateDir, true);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    assertNativeBootstrapIntentDirectoryTrust(stateDir, true);
    const path = join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE);
    const owner = util.acquireLock(path, lockOptions);
    let state = 'active';
    let guardian;
    const assertOwned = () => {
        if (state !== 'active') {
            throw new Error('self_update_lifecycle_owner_lease_not_active');
        }
        const lock = readBoundedBootstrapStateFile(path, { assertIntentFileTrust: () => undefined }, util.MAX_LOCK_OWNER_BYTES);
        const current = lock.status === 'present'
            ? parseBootstrapLockOwnerJson(lock.raw)
            : undefined;
        if (!current || !sameBootstrapLockOwner(current, owner)) {
            throw new Error('self_update_lifecycle_owner_lease_ownership_changed');
        }
    };
    const release = () => {
        if (state === 'transferred')
            return;
        if (state === 'released')
            return;
        if (state === 'release_failed') {
            throw new Error('self_update_lifecycle_owner_lease_release_failed');
        }
        const result = util.releaseLock(path);
        if (result.released
            && (result.reason === 'released' || result.reason === 'released_with_cleanup_error')) {
            state = 'released';
            return;
        }
        state = 'release_failed';
        throw new Error(`self_update_lifecycle_owner_lease_release_failed:${result.reason}`);
    };
    const armProcess = (pid) => {
        assertOwned();
        if (guardian !== undefined) {
            throw new Error('self_update_lifecycle_owner_lease_guardian_already_armed');
        }
        const result = util.attachLockGuardianToProcess(path, owner, pid);
        if (!result.attached) {
            throw new Error(`self_update_lifecycle_owner_lease_guardian_arm_failed:${result.reason}`);
        }
        guardian = result.guardian;
        return guardian;
    };
    const disarmProcess = () => {
        assertOwned();
        if (guardian === undefined)
            return;
        const result = util.clearLockGuardianForProcess(path, owner, guardian);
        if (!result.cleared) {
            throw new Error(`self_update_lifecycle_owner_lease_guardian_disarm_failed:${result.reason}`);
        }
        guardian = undefined;
    };
    const retainProcess = () => {
        assertOwned();
        if (guardian === undefined) {
            throw new Error('self_update_lifecycle_owner_lease_guardian_not_armed');
        }
        const result = util.retainLockGuardianForProcess(path, owner, guardian);
        if (!result.retained) {
            throw new Error(`self_update_lifecycle_owner_lease_guardian_retain_failed:${result.reason}`);
        }
        state = 'transferred';
    };
    const transferToProcess = (pid) => {
        const attached = armProcess(pid);
        retainProcess();
        return attached;
    };
    try {
        assertOwned();
        const options = { expectedRecoveryOwner: owner };
        if (transactionBound) {
            assertCommittedLifecycleBootstrapState(env, options);
        }
        else {
            const durable = inspectLifecycleBootstrapDurableState(env, options);
            if (durable.status === 'invalid') {
                throw new Error('self_update_lifecycle_owner_lease_invalid:'
                    + boundedBootstrapDetail(durable.detail));
            }
            if (durable.status === 'pending' || durable.status === 'manual_transition') {
                const detail = durable.status === 'pending'
                    ? durable.detail
                    : 'manual_transition';
                throw new Error('self_update_lifecycle_owner_lease_state_blocked:'
                    + boundedBootstrapDetail(detail));
            }
            const supervisor = env['EVOLVER_SELF_UPDATE_SUPERVISOR']?.trim();
            const supervisorTarget = supervisor === 'systemd'
                ? 'systemd'
                : supervisor === 'launchd'
                    ? 'launchd'
                    : supervisor === 'windows-scheduled-task'
                        ? 'windows'
                        : undefined;
            if (durable.status === 'committed'
                && supervisorTarget !== undefined
                && durable.target !== supervisorTarget) {
                throw new Error('self_update_lifecycle_owner_lease_state_blocked:'
                    + 'committed lifecycle target does not match supervisor attestation');
            }
        }
    }
    catch (error) {
        try {
            release();
        }
        catch (releaseError) {
            throw new AggregateError([error, releaseError], 'self_update_lifecycle_owner_lease_validation_and_release_failed');
        }
        throw error;
    }
    return {
        path,
        owner,
        assertOwned,
        armProcess,
        disarmProcess,
        retainProcess,
        transferToProcess,
        release,
    };
}
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
const BOOTSTRAP_ATTEMPT_OUTCOMES = new Set([
    'already_supervised',
    'already_bootstrapped',
    'unsupported_install_shape',
    'policy_not_auto',
    'bootstrap_disabled',
    'ci_environment',
    'container_environment',
    'recent_failure',
    'failed',
    'cli_not_found',
    'rolled_back',
    'bootstrapped',
    'bootstrapped_lock_release_unconfirmed',
    'blocked',
    'ambiguous',
    'termination_unconfirmed',
    'timeout',
    'signal',
    'migrated',
    'migration_failed',
    'migration_timeout',
    'migration_ambiguous',
]);
const BOOTSTRAP_ATTEMPT_PENDING_OUTCOMES = new Set([
    'blocked',
    'ambiguous',
    'termination_unconfirmed',
    'timeout',
    'signal',
    'migration_ambiguous',
]);
function readBootstrapAttempt(env, options) {
    try {
        const state = readBoundedBootstrapStateFile(join(resolveBootstrapStateDir(env), BOOTSTRAP_ATTEMPT_FILE), options, MAX_BOOTSTRAP_ATTEMPT_BYTES);
        if (state.status === 'absent')
            return { status: 'absent' };
        if (state.status === 'invalid')
            return { status: 'invalid' };
        const parsed = JSON.parse(state.raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { status: 'invalid' };
        }
        const record = parsed;
        if (typeof record['outcome'] !== 'string'
            || !BOOTSTRAP_ATTEMPT_OUTCOMES.has(record['outcome'])
            || typeof record['attemptedAt'] !== 'string') {
            return { status: 'invalid' };
        }
        const attemptedAt = Date.parse(record['attemptedAt']);
        if (!Number.isFinite(attemptedAt)
            || new Date(attemptedAt).toISOString() !== record['attemptedAt']
            || (record['detail'] !== undefined
                && typeof record['detail'] !== 'string')) {
            return { status: 'invalid' };
        }
        return BOOTSTRAP_ATTEMPT_PENDING_OUTCOMES.has(record['outcome'])
            ? { status: 'ambiguous', attemptedAt }
            : { status: 'safe_non_ambiguous', attemptedAt, outcome: record['outcome'] };
    }
    catch {
        return { status: 'invalid' };
    }
}
function bootstrapRegistrationIntentPresent(env) {
    const stateDir = resolveBootstrapStateDir(env);
    return bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_FILE))
        || bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_PUBLISHING_FILE))
        || bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE))
        || bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE))
        || bootstrapRegistrationPublisherEntryPresent(stateDir);
}
function bootstrapRegistrationPublisherEntryPresent(stateDir) {
    try {
        return readdirSync(stateDir).some((name) => name.startsWith(BOOTSTRAP_REGISTRATION_INTENT_PUBLISHER_PREFIX));
    }
    catch (error) {
        return !isErrno(error, 'ENOENT');
    }
}
// Only outcomes that prove no competing child remains may suppress a retry. Ambiguous bootstrap
// outcomes deliberately stay out of this set so recovery is never bypassed by the cooldown.
const BOOTSTRAP_COOLDOWN_OUTCOMES = new Set([
    'failed',
    'cli_not_found',
    'rolled_back',
    'migration_failed',
    'migration_timeout',
]);
/** True when a recent bootstrap/migration attempt failed within the cooldown window. */
export function recentBootstrapFailure(env, optionsOrReadFile, now) {
    const options = typeof optionsOrReadFile === 'function'
        ? { readFile: optionsOrReadFile }
        : optionsOrReadFile;
    const attempt = readBootstrapAttempt(env, options);
    if (attempt.status !== 'safe_non_ambiguous'
        || !BOOTSTRAP_COOLDOWN_OUTCOMES.has(attempt.outcome))
        return false;
    const ageMs = now - attempt.attemptedAt;
    return ageMs >= 0 && ageMs < BOOTSTRAP_FAILURE_COOLDOWN_MS;
}
/**
 * Decide whether an unsupervised (degraded) startup should attempt first-run bootstrap.
 * Pure — filesystem access is injectable for tests.
 */
export function shouldBootstrap(env, platform = process.platform, options = {}) {
    if (selfUpdateSupervisorAttested(env)) {
        try {
            resolveSelfUpdateTarget({ env, processExecPath: options.execPath });
        }
        catch {
            return { proceed: false, reason: 'unsupported_install_shape' };
        }
        return { proceed: false, reason: 'already_supervised' };
    }
    const exists = options.exists ?? existsSync;
    // The no-replace intent predates child creation and therefore outranks every lifecycle
    // state fragment. Recovery must classify it without creating another child.
    if (bootstrapRegistrationIntentPresent(env)) {
        return { proceed: false, reason: 'bootstrap_intent_pending' };
    }
    if (lifecycleBootstrapStatePresent(env, options.exists ?? bootstrapStateEntryPresent)) {
        try {
            resolveSelfUpdateTarget({ env, processExecPath: options.execPath });
            return { proceed: true };
        }
        catch {
            // Durable lifecycle state must be reconciled, but an npm/JS foreground cannot safely
            // perform that reconciliation through ordinary lifecycle bootstrap: it would bind the
            // service manager back to the same unreplaceable Node launcher. Route recovery through
            // the signed standalone migration and keep every non-migrated outcome fail-closed.
            return { proceed: false, reason: 'bootstrap_attempt_pending' };
        }
    }
    const attempt = readBootstrapAttempt(env, options);
    if (attempt.status === 'invalid') {
        return { proceed: false, reason: 'bootstrap_attempt_invalid' };
    }
    if (attempt.status === 'ambiguous') {
        try {
            resolveSelfUpdateTarget({ env, processExecPath: options.execPath });
            return { proceed: true, reason: 'bootstrap_attempt_pending' };
        }
        catch {
            // An npm/JS foreground cannot safely run ordinary lifecycle bootstrap. Retry the
            // signed standalone migration, whose reconciler keeps this ambiguity fail-closed.
            return { proceed: false, reason: 'bootstrap_attempt_pending' };
        }
    }
    const bootstrapSwitch = env['EVOLVER_SELF_BOOTSTRAP']?.trim();
    if (bootstrapSwitch === '0' || bootstrapSwitch === 'off')
        return { proceed: false, reason: 'bootstrap_disabled' };
    if (isSelfUpdateExplicit(env) && resolveSelfUpdatePolicy(env) !== 'auto') {
        return { proceed: false, reason: 'policy_not_auto' };
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
    if (recentBootstrapFailure(env, options, options.now ?? Date.now())) {
        return { proceed: false, reason: 'recent_failure' };
    }
    return { proceed: true };
}
/**
 * Resolve the `lifecycle bootstrap` invocation for the current install shape: standalone binary,
 * CLI entry through node, or the npm-installed @evomap/evolver-cli sibling. Returns undefined when
 * no CLI can be located. The caller may continue only after confirming durable state is clean.
 */
export function resolveBootstrapCliInvocation(options = {}) {
    const execPath = options.execPath ?? process.execPath;
    const argv1 = options.argv1 ?? process.argv[1];
    const exists = options.exists ?? existsSync;
    const executableName = basename(execPath).toLowerCase();
    if (isStandaloneReleaseBinaryName(executableName)) {
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
        ...(outcome.detail ? { detail: boundedBootstrapDetail(outcome.detail) } : {}),
    };
    try {
        const writeFile = options.writeFile ?? ((target, content) => {
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
            let descriptor;
            try {
                descriptor = openSync(temporary, 'wx', 0o600);
                writeFileSync(descriptor, content, { encoding: 'utf8' });
                fsyncSync(descriptor);
                closeSync(descriptor);
                descriptor = undefined;
                renameSync(temporary, target);
            }
            finally {
                if (descriptor !== undefined)
                    closeSync(descriptor);
                rmSync(temporary, { force: true });
            }
        });
        writeFile(path, `${JSON.stringify(record)}\n`);
    }
    catch {
        // Marker is advisory; startup continues regardless.
    }
}
function captureBootstrapOutput(stream) {
    const chunks = [];
    let capturedBytes = 0;
    let truncated = false;
    stream?.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const available = Math.max(0, MAX_BOOTSTRAP_OUTPUT_BYTES - capturedBytes);
        if (bytes.byteLength > available)
            truncated = true;
        if (available > 0) {
            const captured = bytes.subarray(0, available);
            chunks.push(captured);
            capturedBytes += captured.byteLength;
        }
    });
    return {
        get truncated() { return truncated; },
        text: () => Buffer.concat(chunks, capturedBytes).toString('utf8'),
    };
}
function parseBootstrapCliResult(output) {
    if (output.truncated)
        return undefined;
    const raw = output.text().trim();
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        if (record['status'] === 'bootstrap-committed-lock-release-unconfirmed') {
            const result = record['result'];
            const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
                ? result
                : undefined;
            const transactionId = resultRecord?.['transactionId'];
            if (record['outcome'] !== 'committed'
                || !resultRecord
                || !['bootstrapped', 'already-bootstrapped']
                    .includes(resultRecord['status'])
                || typeof transactionId !== 'string'
                || !BOOTSTRAP_UUID_RE.test(transactionId)
                || record['transactionId'] !== transactionId) {
                return undefined;
            }
            const detail = typeof record['detail'] === 'string' && record['detail'].trim()
                ? boundedBootstrapDetail(record['detail'])
                : undefined;
            if (!detail)
                return undefined;
            return { outcome: 'committed_lock_release_unconfirmed', transactionId, detail };
        }
        if (record['status'] === 'bootstrapped' || record['status'] === 'already-bootstrapped') {
            const transactionId = record['transactionId'];
            if (typeof transactionId !== 'string' || !BOOTSTRAP_UUID_RE.test(transactionId)) {
                return undefined;
            }
            return { outcome: 'bootstrapped', transactionId };
        }
        if (record['status'] !== 'bootstrap-failed')
            return undefined;
        const detail = typeof record['detail'] === 'string'
            ? boundedBootstrapDetail(record['detail'])
            : undefined;
        if (record['outcome'] === 'rolled_back') {
            return { outcome: 'rolled_back', ...(detail ? { detail } : {}) };
        }
        if (record['outcome'] === 'blocked') {
            return { outcome: 'blocked', ...(detail ? { detail } : {}) };
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
function observationDetail(observation, stdout, stderr) {
    const parts = [];
    if ('detail' in observation && observation.detail)
        parts.push(observation.detail);
    if (stdout.truncated)
        parts.push('stdout_truncated');
    if (stderr.truncated)
        parts.push('stderr_truncated');
    const stderrText = boundedBootstrapDetail(stderr.text().trim());
    if (stderrText)
        parts.push(stderrText);
    return parts.length > 0 ? boundedBootstrapDetail(parts.join('; ')) : undefined;
}
function reconcileBootstrapOutcome(observation, state, stdout, stderr) {
    const detail = observationDetail(observation, stdout, stderr);
    const failClosed = (reason, failureDetail) => ({
        ok: false,
        reason,
        ...(failureDetail ? { detail: boundedBootstrapDetail(failureDetail) } : {}),
        requiresForegroundExit: true,
    });
    const stateDetail = state.status === 'pending' || state.status === 'invalid' ? state.detail : undefined;
    const combinedDetail = [detail, stateDetail].filter((value) => Boolean(value)).join('; ');
    if (observation.kind === 'termination_unconfirmed') {
        return failClosed('termination_unconfirmed', combinedDetail || observation.detail);
    }
    if (observation.kind === 'timeout')
        return failClosed('timeout', combinedDetail || undefined);
    if (observation.kind === 'signal') {
        return failClosed('signal', combinedDetail || `signal ${observation.signal}`);
    }
    if (observation.kind === 'child_ambiguous') {
        return failClosed('ambiguous', combinedDetail || observation.detail);
    }
    if (state.status === 'invalid')
        return failClosed('ambiguous', combinedDetail);
    if (state.status === 'pending')
        return failClosed('blocked', combinedDetail);
    if (state.status === 'committed') {
        if (observation.kind === 'exit' && observation.code === 0
            && observation.cli?.outcome === 'bootstrapped'
            && observation.cli.transactionId === state.transactionId
            && !stdout.truncated) {
            return { ok: true, reason: 'bootstrapped' };
        }
        if (observation.kind === 'exit' && observation.code === 1
            && observation.cli?.outcome === 'committed_lock_release_unconfirmed'
            && observation.cli.transactionId === state.transactionId
            && !stdout.truncated) {
            return {
                ok: true,
                reason: 'bootstrapped_lock_release_unconfirmed',
                ...(observation.cli.detail ? { detail: observation.cli.detail } : {}),
            };
        }
        return failClosed('ambiguous', combinedDetail || 'durable bootstrap committed without a matching transaction-bound CLI success result');
    }
    if (observation.kind === 'no_child') {
        return {
            ok: false,
            reason: observation.reason,
            ...(detail ? { detail } : {}),
        };
    }
    if (observation.cli?.outcome === 'rolled_back' && observation.code !== 0 && !stdout.truncated) {
        return {
            ok: false,
            reason: 'rolled_back',
            ...(observation.cli.detail ? { detail: observation.cli.detail } : {}),
        };
    }
    if (observation.cli?.outcome === 'blocked') {
        return failClosed('blocked', combinedDetail || observation.cli.detail);
    }
    return failClosed('ambiguous', combinedDetail || `CLI result did not prove commit or rollback (exit ${observation.code ?? 'null'})`);
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function trustedWindowsSystemExecutable(name) {
    if (!win32.isAbsolute(HOST_WINDOWS_SYSTEM_ROOT) || /[\r\n\0]/.test(HOST_WINDOWS_SYSTEM_ROOT)) {
        throw new Error('Windows SystemRoot is not an absolute trusted path');
    }
    return win32.join(HOST_WINDOWS_SYSTEM_ROOT, 'System32', name);
}
function remainingMs(deadlineMs) {
    return Math.max(0, deadlineMs - Date.now());
}
async function waitForCondition(predicate, deadlineMs) {
    while (!predicate()) {
        const remaining = remainingMs(deadlineMs);
        if (remaining === 0)
            return false;
        await new Promise((resolvePromise) => {
            setTimeout(resolvePromise, Math.min(10, remaining));
        });
    }
    return true;
}
function requestWindowsProcessTreeTermination(pid, spawnFn, deadlineMs) {
    return new Promise((resolvePromise) => {
        let settled = false;
        let killer;
        let timer;
        const settle = (accepted) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolvePromise(accepted);
        };
        try {
            killer = spawnFn(trustedWindowsSystemExecutable('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.once('error', () => settle(false));
            killer.once('close', (code) => settle(code === 0));
            const remaining = remainingMs(deadlineMs);
            if (remaining === 0) {
                try {
                    killer.kill('SIGKILL');
                }
                catch { /* best-effort watchdog cleanup */ }
                settle(false);
                return;
            }
            timer = setTimeout(() => {
                try {
                    killer?.kill('SIGKILL');
                }
                catch { /* best-effort watchdog cleanup */ }
                settle(false);
            }, remaining);
        }
        catch {
            settle(false);
        }
    });
}
async function terminateBootstrapProcessTree(child, platform, childClosed, deadlineMs, processKill, treeKillSpawnFn) {
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid <= 0) {
        try {
            child.kill('SIGKILL');
        }
        catch { /* direct-child fallback only */ }
        await waitForCondition(childClosed, deadlineMs);
        return { confirmed: false, detail: 'process_tree_termination_unconfirmed' };
    }
    if (platform === 'win32') {
        const treeKillAccepted = await requestWindowsProcessTreeTermination(pid, treeKillSpawnFn, deadlineMs);
        if (!treeKillAccepted) {
            try {
                child.kill('SIGKILL');
            }
            catch { /* direct-child fallback only */ }
        }
        const directChildClosed = await waitForCondition(childClosed, deadlineMs);
        return treeKillAccepted && directChildClosed
            ? { confirmed: true }
            : { confirmed: false, detail: 'process_tree_termination_unconfirmed' };
    }
    let groupKillAccepted = false;
    try {
        processKill(-pid, 'SIGKILL');
        groupKillAccepted = true;
    }
    catch (error) {
        groupKillAccepted = isErrno(error, 'ESRCH');
        if (!groupKillAccepted) {
            try {
                child.kill('SIGKILL');
            }
            catch { /* direct-child fallback only */ }
        }
    }
    const processGroupGone = () => {
        try {
            processKill(-pid, 0);
            return false;
        }
        catch (error) {
            return isErrno(error, 'ESRCH');
        }
    };
    const confirmed = groupKillAccepted
        && await waitForCondition(() => childClosed() && processGroupGone(), deadlineMs);
    return confirmed
        ? { confirmed: true }
        : { confirmed: false, detail: 'process_tree_termination_unconfirmed' };
}
/** Spawn `evolver lifecycle bootstrap` and await its result within a bounded timeout. */
export async function runBootstrap(options) {
    const emptyOutput = () => captureBootstrapOutput(undefined);
    const reconcileNoChild = (reason, detail) => reconcileBootstrapOutcome({ kind: 'no_child', reason, ...(detail ? { detail } : {}) }, inspectLifecycleBootstrapDurableState(options.env, options), emptyOutput(), emptyOutput());
    const invocation = resolveBootstrapCliInvocation(options);
    if (!invocation)
        return reconcileNoChild('cli_not_found');
    const spawnFn = options.spawnFn ?? spawn;
    const timeoutMs = options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
    const transactionBudgetMs = options.transactionBudgetMs ?? BOOTSTRAP_TRANSACTION_BUDGET_MS;
    const terminationGraceMs = options.terminationGraceMs ?? BOOTSTRAP_TREE_TERMINATION_GRACE_MS;
    const startedAt = options.now ?? Date.now();
    if (!Number.isSafeInteger(timeoutMs)
        || !Number.isSafeInteger(transactionBudgetMs)
        || !Number.isSafeInteger(terminationGraceMs)
        || !Number.isSafeInteger(startedAt)
        || !Number.isSafeInteger(startedAt + transactionBudgetMs)
        || timeoutMs <= transactionBudgetMs
        || timeoutMs > MAX_TIMER_DELAY_MS
        || transactionBudgetMs <= 0
        || terminationGraceMs <= 0
        || terminationGraceMs > MAX_TIMER_DELAY_MS
        || startedAt < 0) {
        return reconcileNoChild('failed', 'invalid_bootstrap_timeout_contract');
    }
    const platform = options.platform ?? process.platform;
    return new Promise((resolvePromise) => {
        let child;
        try {
            child = spawnFn(invocation.command, invocation.args, {
                detached: platform !== 'win32',
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: bootstrapChildEnv(options.env, startedAt + transactionBudgetMs),
            });
        }
        catch (error) {
            resolvePromise(reconcileNoChild('failed', error instanceof Error ? error.message : String(error)));
            return;
        }
        const stdout = captureBootstrapOutput(child.stdout);
        const stderr = captureBootstrapOutput(child.stderr);
        let settled = false;
        let containmentStarted = false;
        let childClosed = false;
        let childStarted = Number.isSafeInteger(child.pid) && typeof child.pid === 'number' && child.pid > 0;
        const timerRef = {};
        const settle = (observation) => {
            if (settled)
                return;
            settled = true;
            if (timerRef.value)
                clearTimeout(timerRef.value);
            resolvePromise(reconcileBootstrapOutcome(observation, inspectLifecycleBootstrapDurableState(options.env, options), stdout, stderr));
        };
        const containAndSettle = (confirmedObservation) => {
            if (settled || containmentStarted)
                return;
            containmentStarted = true;
            const confirmationDeadlineMs = Date.now() + terminationGraceMs;
            void terminateBootstrapProcessTree(child, platform, () => childClosed, confirmationDeadlineMs, options.processKill ?? process.kill.bind(process), options.treeKillSpawnFn ?? spawn).then((termination) => {
                if (!termination.confirmed) {
                    settle({ kind: 'termination_unconfirmed', detail: termination.detail ?? 'process_tree_termination_unconfirmed' });
                    return;
                }
                settle(confirmedObservation);
            }).catch(() => {
                settle({ kind: 'termination_unconfirmed', detail: 'process_tree_termination_unconfirmed' });
            });
        };
        child.once('spawn', () => {
            childStarted = true;
        });
        child.once('close', (code, signal) => {
            childClosed = true;
            if (settled || containmentStarted)
                return;
            if (signal) {
                containAndSettle({ kind: 'signal', signal });
                return;
            }
            const cli = parseBootstrapCliResult(stdout);
            settle({
                kind: 'exit',
                code,
                cli,
                ...((stdout.truncated || !cli)
                    ? { detail: stdout.truncated ? 'bootstrap_cli_stdout_truncated' : 'bootstrap_cli_result_invalid' }
                    : {}),
            });
        });
        timerRef.value = setTimeout(() => {
            containAndSettle({ kind: 'timeout' });
        }, timeoutMs);
        child.once('error', (error) => {
            if (settled || containmentStarted)
                return;
            if (!childStarted && (!Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 0)) {
                settle({ kind: 'no_child', reason: 'failed', detail: error.message });
                return;
            }
            containAndSettle({ kind: 'child_ambiguous', detail: error.message });
        });
    });
}
function windowsBootstrapIntentAclScript(checks) {
    const encodedChecks = Buffer.from(JSON.stringify(checks), 'utf8').toString('base64');
    const d = String.fromCharCode(36);
    return [
        `${d}ErrorActionPreference = 'Stop'`,
        'try {',
        `  ${d}json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedChecks}'))`,
        `  ${d}checks = ${d}json | ConvertFrom-Json`,
        `  ${d}userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`,
        `  ${d}trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'`,
        `  ${d}trustedOwners = @(${d}userSid, 'S-1-5-18', 'S-1-5-32-544', ${d}trustedInstaller)`,
        `  ${d}trustedWriters = @(${d}userSid, 'S-1-5-18', 'S-1-5-32-544', ${d}trustedInstaller, 'S-1-3-0', 'S-1-3-4')`,
        `  ${d}parentDanger = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership`,
        `  ${d}contentDanger = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories`,
        `  foreach (${d}check in @(${d}checks)) {`,
        `    ${d}acl = Get-Acl -LiteralPath ${d}check.path`,
        `    ${d}owner = ${d}acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
        `    if (${d}trustedOwners -notcontains ${d}owner) { exit 21 }`,
        `    ${d}danger = if (${d}check.parentOnly) { ${d}parentDanger } else { ${d}parentDanger -bor ${d}contentDanger }`,
        `    foreach (${d}rule in @(${d}acl.Access)) {`,
        `      if (${d}rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }`,
        `      if ((${d}rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }`,
        `      if ((${d}rule.FileSystemRights -band ${d}danger) -eq 0) { continue }`,
        `      try { ${d}sid = ${d}rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { exit 22 }`,
        `      if (${d}trustedWriters -notcontains ${d}sid) { exit 23 }`,
        '    }',
        '  }',
        '} catch { exit 24 }',
    ].join('; ');
}
function assertWindowsBootstrapIntentAclTrusted(checks) {
    if (process.platform !== 'win32' || checks.length === 0)
        return;
    try {
        execFileSync(trustedWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', windowsBootstrapIntentAclScript(checks)], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    }
    catch (error) {
        throw new Error('bootstrap registration intent Windows ACL chain is not trusted', { cause: error });
    }
}
function bootstrapPathKey(path) {
    const resolved = resolvePath(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function assertNativeBootstrapIntentDirectoryTrust(directory, requireOwnerOnlyLeaf) {
    const absoluteDirectory = resolvePath(directory);
    let current = absoluteDirectory;
    const root = parsePath(current).root;
    const windowsChecks = [];
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    let nearestExisting = true;
    let privateUserAnchor = false;
    let directoryExists = false;
    for (;;) {
        let info;
        try {
            info = lstatSync(current);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
            if (current === root)
                break;
            current = dirname(current);
            continue;
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('bootstrap registration intent directory chain is unsafe');
        }
        if (bootstrapPathKey(current) === bootstrapPathKey(absoluteDirectory))
            directoryExists = true;
        if (process.platform === 'win32') {
            windowsChecks.push({ path: current, parentOnly: bootstrapPathKey(current) !== bootstrapPathKey(absoluteDirectory) });
        }
        else {
            if (uid !== undefined && info.uid !== uid && (nearestExisting || info.uid !== 0)) {
                throw new Error('bootstrap registration intent directory owner is untrusted');
            }
            if (requireOwnerOnlyLeaf && bootstrapPathKey(current) === bootstrapPathKey(absoluteDirectory)
                && (info.mode & 0o077) !== 0) {
                throw new Error('bootstrap registration intent directory is not owner-only');
            }
            const writableByOthers = (info.mode & 0o022) !== 0;
            const trustedStickyAncestor = !nearestExisting
                && privateUserAnchor
                && info.uid === 0
                && (info.mode & 0o1000) !== 0;
            if (writableByOthers && !trustedStickyAncestor) {
                throw new Error('bootstrap registration intent directory chain is writable by another principal');
            }
            if (info.uid === uid && (info.mode & 0o077) === 0)
                privateUserAnchor = true;
        }
        nearestExisting = false;
        if (current === root)
            break;
        current = dirname(current);
    }
    if (directoryExists
        && bootstrapPathKey(realpathSync(absoluteDirectory)) !== bootstrapPathKey(absoluteDirectory)) {
        throw new Error('bootstrap registration intent directory is not canonical');
    }
    assertWindowsBootstrapIntentAclTrusted(windowsChecks);
}
function assertNativeBootstrapIntentFileTrust(path, expectedLinkCount = 1) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== expectedLinkCount) {
        throw new Error('bootstrap registration intent file is unsafe');
    }
    if (process.platform === 'win32') {
        assertWindowsBootstrapIntentAclTrusted([{ path, parentOnly: false }]);
        return;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
        throw new Error('bootstrap registration intent file is not owner-only');
    }
}
function assertBootstrapIntentDirectoryTrust(options, directory, requireOwnerOnlyLeaf) {
    if (options.assertIntentDirectoryTrust) {
        options.assertIntentDirectoryTrust(directory);
        return;
    }
    assertNativeBootstrapIntentDirectoryTrust(directory, requireOwnerOnlyLeaf);
}
function assertBootstrapIntentFileTrust(options, path, expectedLinkCount = 1) {
    if (options.assertIntentFileTrust) {
        options.assertIntentFileTrust(path);
        return;
    }
    assertNativeBootstrapIntentFileTrust(path, expectedLinkCount);
}
function readBootstrapRegistrationProcessStartIdentity(options, pid) {
    return (options.readRegistrationProcessStartIdentity
        ?? util.readFileLockProcessStartIdentity)(pid);
}
function bootstrapRegistrationProcessIdentityDigest(identity) {
    const canonical = identity.source === 'linux-proc'
        ? ['linux-proc', identity.bootId, identity.startTicks]
        : identity.source === 'windows-powershell'
            ? ['windows-powershell', identity.startTimeTicks]
            : ['darwin-ps', identity.startTime];
    return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
function bootstrapRegistrationPublisherProcessStatus(options, publisher) {
    if (options.registrationPublisherProcessStatus) {
        return options.registrationPublisherProcessStatus({
            pid: publisher.pid,
            token: publisher.token,
            processIdentityDigest: publisher.processIdentityDigest,
        });
    }
    try {
        process.kill(publisher.pid, 0);
    }
    catch (error) {
        if (isErrno(error, 'ESRCH'))
            return 'dead';
        if (!isErrno(error, 'EPERM'))
            return 'unverifiable';
    }
    const current = readBootstrapRegistrationProcessStartIdentity(options, publisher.pid);
    if (current === null)
        return 'unverifiable';
    return bootstrapRegistrationProcessIdentityDigest(current) === publisher.processIdentityDigest
        ? 'current'
        : 'pid_reused';
}
function assertBootstrapRegistrationOwnerCurrent(options, owner) {
    const current = readBootstrapRegistrationProcessStartIdentity(options, owner.pid);
    if (current === null
        || !util.sameFileLockProcessStartIdentity(owner.processStartIdentity, current)) {
        throw new Error('bootstrap registration parent process identity is no longer current');
    }
}
function bootstrapRegistrationOwnerProcessStatus(options, owner) {
    return (options.registrationOwnerProcessStatus
        ?? util.inspectFileLockOwnerProcess)(owner);
}
function acquireBootstrapRegistrationRecoveryLock(options) {
    const stateDir = resolveBootstrapStateDir(options.env);
    assertBootstrapIntentDirectoryTrust(options, stateDir, true);
    const path = join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE);
    const owner = util.acquireLock(path, { maxTries: 2, waitMs: 0 });
    let released = false;
    return {
        path,
        owner,
        release: () => {
            if (released)
                return;
            const result = util.releaseLock(path);
            if (!result.released
                || (result.reason !== 'released' && result.reason !== 'released_with_cleanup_error')) {
                throw new Error(`bootstrap registration recovery lock release failed: ${result.reason}`);
            }
            released = true;
        },
    };
}
function parseBootstrapRegistrationIntent(raw) {
    return coreBootstrap.parseLifecycleBootstrapRegistrationIntentJson(raw);
}
function syncBootstrapDirectory(path) {
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY);
        fsyncSync(descriptor);
    }
    catch (error) {
        if (isErrno(error, 'EINVAL'))
            return;
        if (process.platform === 'win32' && (isErrno(error, 'EPERM') || isErrno(error, 'EACCES')))
            return;
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
function readBootstrapRegistrationIntentFile(options, path, registrationPath, terminalPath, clearingPath, expectedLinkCount = 1n) {
    try {
        assertBootstrapIntentFileTrust(options, path, Number(expectedLinkCount));
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinkCount
            || before.dev <= 0n || before.ino <= 0n
            || before.size > BigInt(MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES)
            || (process.platform !== 'win32' && (before.mode & 63n) !== 0n)) {
            return { status: 'invalid', detail: 'registration intent file is unsafe' };
        }
        const trustedFile = {
            path,
            device: before.dev,
            inode: before.ino,
            linkCount: before.nlink,
            size: before.size,
            mtimeNs: before.mtimeNs,
            ctimeNs: before.ctimeNs,
        };
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let raw;
        try {
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.nlink !== expectedLinkCount
                || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
                return { status: 'invalid', detail: 'registration intent changed before read' };
            }
            const bytes = Buffer.alloc(MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
                if (count === 0)
                    break;
                offset += count;
            }
            if (offset > MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES) {
                return { status: 'invalid', detail: 'registration intent is oversized', trustedFile };
            }
            raw = bytes.subarray(0, offset).toString('utf8');
            const settled = fstatSync(descriptor, { bigint: true });
            if (settled.dev !== opened.dev || settled.ino !== opened.ino
                || settled.size !== opened.size || settled.mtimeNs !== opened.mtimeNs
                || settled.ctimeNs !== opened.ctimeNs) {
                return { status: 'invalid', detail: 'registration intent changed during read' };
            }
        }
        finally {
            closeSync(descriptor);
        }
        const after = lstatSync(path, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || after.nlink !== expectedLinkCount
            || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return { status: 'invalid', detail: 'registration intent changed after read' };
        }
        assertBootstrapIntentFileTrust(options, path, Number(expectedLinkCount));
        const record = parseBootstrapRegistrationIntent(raw);
        if (!record) {
            return { status: 'invalid', detail: 'registration intent payload is invalid', trustedFile };
        }
        return {
            status: 'present',
            lease: {
                path: registrationPath,
                terminalPath,
                clearingPath,
                currentPath: path,
                device: before.dev,
                inode: before.ino,
                size: before.size,
                mtimeNs: before.mtimeNs,
                ctimeNs: before.ctimeNs,
                record,
            },
        };
    }
    catch (error) {
        return {
            status: 'invalid',
            detail: boundedBootstrapDetail(`registration intent is unreadable: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
}
function sameBootstrapRegistrationIntentOwner(left, right) {
    return left.createdAt === right.createdAt
        && left.owner.pid === right.owner.pid
        && left.owner.token === right.owner.token
        && util.sameFileLockProcessStartIdentity(left.owner.processStartIdentity, right.owner.processStartIdentity);
}
function bootstrapRegistrationIntentIdentity(lease, linkCount) {
    return {
        path: lease.currentPath,
        device: lease.device,
        inode: lease.inode,
        linkCount,
        size: lease.size,
        mtimeNs: lease.mtimeNs,
        ctimeNs: lease.ctimeNs,
    };
}
function sameBootstrapRegistrationIntentFileIdentity(left, right) {
    return left.path === right.path
        && left.device === right.device
        && left.inode === right.inode
        && left.linkCount === right.linkCount
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
const BOOTSTRAP_REGISTRATION_PUBLISHER_RE = /^bootstrap-registration\.intent\.publisher\.([1-9][0-9]{0,15})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/;
function readBootstrapRegistrationPublisherClaim(options, stateDir) {
    let names;
    try {
        names = readdirSync(stateDir).filter((name) => name.startsWith(BOOTSTRAP_REGISTRATION_INTENT_PUBLISHER_PREFIX));
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return { status: 'absent' };
        return {
            status: 'invalid',
            detail: boundedBootstrapDetail(`registration publisher claim directory is unreadable: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
    if (names.length === 0)
        return { status: 'absent' };
    if (names.length !== 1) {
        return { status: 'invalid', detail: 'registration publisher claim count is invalid' };
    }
    const name = names[0];
    const match = BOOTSTRAP_REGISTRATION_PUBLISHER_RE.exec(name);
    if (!match)
        return { status: 'invalid', detail: 'registration publisher claim name is invalid' };
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return { status: 'invalid', detail: 'registration publisher claim pid is invalid' };
    }
    const path = join(stateDir, name);
    try {
        assertBootstrapIntentFileTrust(options, path);
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
            || before.size !== 0n || before.dev <= 0n || before.ino <= 0n) {
            return { status: 'invalid', detail: 'registration publisher claim is unsafe' };
        }
        let descriptor;
        try {
            descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n
                || opened.dev !== before.dev || opened.ino !== before.ino
                || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
                return { status: 'invalid', detail: 'registration publisher claim changed before read' };
            }
        }
        finally {
            if (descriptor !== undefined)
                closeSync(descriptor);
        }
        const after = lstatSync(path, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.size !== 0n
            || after.dev !== before.dev || after.ino !== before.ino
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return { status: 'invalid', detail: 'registration publisher claim changed after read' };
        }
        assertBootstrapIntentFileTrust(options, path);
        return {
            status: 'present',
            claim: {
                path,
                pid,
                token: match[2],
                processIdentityDigest: match[3],
                identity: {
                    path,
                    device: before.dev,
                    inode: before.ino,
                    linkCount: 1n,
                    size: 0n,
                    mtimeNs: before.mtimeNs,
                    ctimeNs: before.ctimeNs,
                },
            },
        };
    }
    catch (error) {
        return {
            status: 'invalid',
            detail: boundedBootstrapDetail(`registration publisher claim is unreadable: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
}
function bootstrapRegistrationPublisherOwnsIntent(publisher, record) {
    return record.owner.pid === publisher.pid
        && record.owner.token === publisher.token
        && bootstrapRegistrationProcessIdentityDigest(record.owner.processStartIdentity)
            === publisher.processIdentityDigest;
}
function readBootstrapRegistrationIntent(options) {
    const stateDir = resolveBootstrapStateDir(options.env);
    const path = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_FILE);
    const publishingPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_PUBLISHING_FILE);
    const terminalPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE);
    const clearingPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE);
    try {
        const pathPresent = bootstrapStateEntryPresent(path);
        const publishingPresent = bootstrapStateEntryPresent(publishingPath);
        const terminalPresent = bootstrapStateEntryPresent(terminalPath);
        const clearingPresent = bootstrapStateEntryPresent(clearingPath);
        const publisherEntryPresent = bootstrapRegistrationPublisherEntryPresent(stateDir);
        if (!pathPresent && !publishingPresent && !terminalPresent && !clearingPresent
            && !publisherEntryPresent) {
            return { status: 'absent' };
        }
        assertBootstrapIntentDirectoryTrust(options, stateDir, true);
        const publisher = readBootstrapRegistrationPublisherClaim(options, stateDir);
        if (publisher.status === 'invalid') {
            return { status: 'invalid', detail: publisher.detail };
        }
        if (publishingPresent || publisher.status === 'present') {
            if (terminalPresent || clearingPresent) {
                return {
                    status: 'invalid',
                    detail: 'registration intent publication conflicts with a terminal transition',
                };
            }
            if (publisher.status !== 'present') {
                return {
                    status: 'invalid',
                    detail: 'registration intent publication has no authenticated publisher claim',
                };
            }
            if (pathPresent && publishingPresent) {
                const registration = readBootstrapRegistrationIntentFile(options, path, path, terminalPath, clearingPath, 2n);
                const publishing = readBootstrapRegistrationIntentFile(options, publishingPath, path, terminalPath, clearingPath, 2n);
                if (registration.status !== 'present'
                    || publishing.status !== 'present'
                    || registration.lease.record.state !== 'registering'
                    || publishing.lease.record.state !== 'registering'
                    || !bootstrapRegistrationPublisherOwnsIntent(publisher.claim, registration.lease.record)
                    || !bootstrapRegistrationPublisherOwnsIntent(publisher.claim, publishing.lease.record)
                    || !sameBootstrapRegistrationIntentOwner(registration.lease.record, publishing.lease.record)) {
                    return {
                        status: 'invalid',
                        detail: 'registration intent publication identity is invalid',
                    };
                }
                const registrationIdentity = bootstrapRegistrationIntentIdentity(registration.lease, 2n);
                const publishingIdentity = bootstrapRegistrationIntentIdentity(publishing.lease, 2n);
                if (registrationIdentity.device !== publishingIdentity.device
                    || registrationIdentity.inode !== publishingIdentity.inode
                    || registrationIdentity.size !== publishingIdentity.size
                    || registrationIdentity.mtimeNs !== publishingIdentity.mtimeNs
                    || registrationIdentity.ctimeNs !== publishingIdentity.ctimeNs) {
                    return {
                        status: 'invalid',
                        detail: 'registration intent publication does not own the canonical claim',
                    };
                }
                return {
                    status: 'incomplete_publication',
                    publication: {
                        publisher: publisher.claim,
                        publishing: publishingIdentity,
                        registration: {
                            lease: registration.lease,
                            identity: registrationIdentity,
                        },
                    },
                };
            }
            if (pathPresent) {
                const registration = readBootstrapRegistrationIntentFile(options, path, path, terminalPath, clearingPath);
                if (registration.status !== 'present'
                    || registration.lease.record.state !== 'registering'
                    || !bootstrapRegistrationPublisherOwnsIntent(publisher.claim, registration.lease.record)) {
                    return {
                        status: 'invalid',
                        detail: 'registration intent canonical publisher claim is invalid',
                    };
                }
                return {
                    status: 'incomplete_publication',
                    publication: {
                        publisher: publisher.claim,
                        registration: {
                            lease: registration.lease,
                            identity: bootstrapRegistrationIntentIdentity(registration.lease, 1n),
                        },
                    },
                };
            }
            if (publishingPresent) {
                const publishing = readBootstrapRegistrationIntentFile(options, publishingPath, path, terminalPath, clearingPath);
                if (publishing.status === 'present') {
                    if (publishing.lease.record.state !== 'registering'
                        || !bootstrapRegistrationPublisherOwnsIntent(publisher.claim, publishing.lease.record)) {
                        return {
                            status: 'invalid',
                            detail: 'registration intent publication payload is invalid',
                        };
                    }
                    return {
                        status: 'incomplete_publication',
                        publication: {
                            publisher: publisher.claim,
                            publishing: bootstrapRegistrationIntentIdentity(publishing.lease, 1n),
                        },
                    };
                }
                if (publishing.detail === 'registration intent payload is invalid'
                    && publishing.trustedFile !== undefined) {
                    return {
                        status: 'incomplete_publication',
                        publication: {
                            publisher: publisher.claim,
                            publishing: publishing.trustedFile,
                        },
                    };
                }
                return { status: 'invalid', detail: publishing.detail };
            }
            return {
                status: 'incomplete_publication',
                publication: { publisher: publisher.claim },
            };
        }
        if (clearingPresent && (pathPresent || terminalPresent)) {
            return { status: 'invalid', detail: 'registration intent clearing conflicts with another state' };
        }
        if (clearingPresent) {
            const clearing = readBootstrapRegistrationIntentFile(options, clearingPath, path, terminalPath, clearingPath);
            if (clearing.status !== 'present')
                return { status: 'invalid', detail: clearing.detail };
            if (clearing.lease.record.state !== 'terminal') {
                return { status: 'invalid', detail: 'registration clearing receipt is invalid' };
            }
            return { status: 'present', lease: clearing.lease };
        }
        const registration = pathPresent
            ? readBootstrapRegistrationIntentFile(options, path, path, terminalPath, clearingPath)
            : undefined;
        const terminal = terminalPresent
            ? readBootstrapRegistrationIntentFile(options, terminalPath, path, terminalPath, clearingPath)
            : undefined;
        if (registration && terminal) {
            if (registration.status !== 'present' || registration.lease.record.state !== 'registering') {
                return { status: 'invalid', detail: 'registration intent source is invalid during terminal publication' };
            }
            if (terminal.status === 'invalid') {
                if (!terminal.trustedFile)
                    return { status: 'invalid', detail: terminal.detail };
                return {
                    status: 'incomplete_terminal',
                    registering: registration.lease,
                    terminalFile: terminal.trustedFile,
                };
            }
            if (terminal.lease.record.state !== 'terminal'
                || !sameBootstrapRegistrationIntentOwner(registration.lease.record, terminal.lease.record)) {
                return { status: 'invalid', detail: 'registration terminal receipt has a different owner' };
            }
            return {
                status: 'present',
                lease: {
                    ...terminal.lease,
                    staleRegistering: {
                        path,
                        device: registration.lease.device,
                        inode: registration.lease.inode,
                        size: registration.lease.size,
                        mtimeNs: registration.lease.mtimeNs,
                        ctimeNs: registration.lease.ctimeNs,
                    },
                },
            };
        }
        if (registration) {
            if (registration.status !== 'present')
                return { status: 'invalid', detail: registration.detail };
            if (registration.lease.record.state !== 'registering') {
                return { status: 'invalid', detail: 'registration intent payload is invalid' };
            }
            return { status: 'present', lease: registration.lease };
        }
        if (!terminal)
            return { status: 'invalid', detail: 'registration terminal receipt is absent' };
        if (terminal.status !== 'present')
            return { status: 'invalid', detail: terminal.detail };
        if (terminal.lease.record.state !== 'terminal') {
            return { status: 'invalid', detail: 'registration terminal receipt is invalid' };
        }
        return { status: 'present', lease: terminal.lease };
    }
    catch (error) {
        return {
            status: 'invalid',
            detail: boundedBootstrapDetail(`registration intent is unreadable: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
}
function writeBootstrapRegistrationIntentBytes(descriptor, content, start, end) {
    let offset = start;
    while (offset < end) {
        const written = writeSync(descriptor, content, offset, end - offset, null);
        if (written <= 0)
            throw new Error('bootstrap registration intent write made no progress');
        offset += written;
    }
}
function createBootstrapRegistrationPublisherClaim(options, stateDir, owner) {
    const processIdentityDigest = bootstrapRegistrationProcessIdentityDigest(owner.processStartIdentity);
    const path = join(stateDir, `${BOOTSTRAP_REGISTRATION_INTENT_PUBLISHER_PREFIX}${owner.pid}.${owner.token}.${processIdentityDigest}`);
    let descriptor;
    let opened;
    try {
        descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        fsyncSync(descriptor);
        opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n
            || opened.dev <= 0n || opened.ino <= 0n
            || (process.platform !== 'win32' && (opened.mode & 63n) !== 0n)) {
            throw new Error('unsafe bootstrap registration publisher claim');
        }
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
    if (!opened)
        throw new Error('bootstrap registration publisher claim failed');
    syncBootstrapDirectory(stateDir);
    assertBootstrapIntentFileTrust(options, path);
    const settled = lstatSync(path, { bigint: true });
    if (!settled.isFile() || settled.isSymbolicLink() || settled.nlink !== 1n
        || settled.size !== 0n || settled.dev !== opened.dev || settled.ino !== opened.ino
        || settled.mtimeNs !== opened.mtimeNs || settled.ctimeNs !== opened.ctimeNs) {
        throw new Error('bootstrap registration publisher claim is unconfirmed');
    }
    return {
        path,
        pid: owner.pid,
        token: owner.token,
        processIdentityDigest,
        identity: {
            path,
            device: settled.dev,
            inode: settled.ino,
            linkCount: 1n,
            size: 0n,
            mtimeNs: settled.mtimeNs,
            ctimeNs: settled.ctimeNs,
        },
    };
}
function retireBootstrapRegistrationPublisherClaim(options, publisher) {
    const stateDir = dirname(publisher.path);
    assertBootstrapRegistrationIntentFileIdentity(options, publisher.identity);
    rmSync(publisher.path);
    syncBootstrapDirectory(stateDir);
    const remaining = readBootstrapRegistrationPublisherClaim(options, stateDir);
    if (remaining.status !== 'absent') {
        throw new Error('bootstrap registration publisher claim retirement is unconfirmed');
    }
}
function publishBootstrapRegistrationIntent(options) {
    const stateDir = resolveBootstrapStateDir(options.env);
    assertBootstrapIntentDirectoryTrust(options, stateDir, false);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    assertBootstrapIntentDirectoryTrust(options, stateDir, true);
    const path = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_FILE);
    const publishingPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_PUBLISHING_FILE);
    const terminalPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE);
    const clearingPath = join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE);
    options.beforeIntentPublish?.();
    const publicationLock = acquireBootstrapRegistrationRecoveryLock(options);
    try {
        for (const unavailablePath of [path, publishingPath, terminalPath, clearingPath]) {
            try {
                lstatSync(unavailablePath);
                throw new Error('bootstrap registration intent transition is incomplete');
            }
            catch (error) {
                if (!isErrno(error, 'ENOENT'))
                    throw error;
            }
        }
        if (readBootstrapRegistrationPublisherClaim(options, stateDir).status !== 'absent') {
            throw new Error('bootstrap registration publisher claim already exists');
        }
        const token = randomUUID();
        const createdAtMs = options.now ?? Date.now();
        if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
            throw new Error('invalid bootstrap registration intent clock');
        }
        const processStartIdentity = readBootstrapRegistrationProcessStartIdentity(options, process.pid);
        if (processStartIdentity === null) {
            throw new Error('bootstrap registration parent process identity is unavailable');
        }
        const record = {
            schema: BOOTSTRAP_REGISTRATION_INTENT_SCHEMA,
            state: 'registering',
            owner: { pid: process.pid, token, processStartIdentity },
            createdAt: new Date(createdAtMs).toISOString(),
        };
        const content = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        if (content.byteLength > MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES) {
            throw new Error('bootstrap registration intent publication is oversized');
        }
        const publisher = createBootstrapRegistrationPublisherClaim(options, stateDir, record.owner);
        let descriptor;
        let opened;
        try {
            descriptor = openSync(publishingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            options.afterIntentPublicationStep?.('create', publishingPath);
            const split = Math.max(1, Math.floor(content.byteLength / 2));
            writeBootstrapRegistrationIntentBytes(descriptor, content, 0, split);
            options.afterIntentPublicationStep?.('partial_write', publishingPath);
            writeBootstrapRegistrationIntentBytes(descriptor, content, split, content.byteLength);
            fsyncSync(descriptor);
            options.afterIntentPublicationStep?.('file_fsync', publishingPath);
            opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.nlink !== 1n || opened.dev <= 0n || opened.ino <= 0n
                || opened.size !== BigInt(content.byteLength)
                || (process.platform !== 'win32' && (opened.mode & 63n) !== 0n)) {
                throw new Error('unsafe bootstrap registration intent publication');
            }
        }
        finally {
            if (descriptor !== undefined)
                closeSync(descriptor);
        }
        if (!opened)
            throw new Error('bootstrap registration intent publication failed');
        assertBootstrapIntentFileTrust(options, publishingPath);
        const prepared = lstatSync(publishingPath, { bigint: true });
        if (!prepared.isFile() || prepared.isSymbolicLink() || prepared.nlink !== 1n
            || prepared.dev !== opened.dev || prepared.ino !== opened.ino
            || prepared.size !== opened.size || prepared.mtimeNs !== opened.mtimeNs
            || prepared.ctimeNs !== opened.ctimeNs) {
            throw new Error('bootstrap registration intent temp changed before publication');
        }
        linkSync(publishingPath, path);
        options.afterIntentPublicationStep?.('link', path);
        syncBootstrapDirectory(stateDir);
        options.afterIntentPublicationStep?.('directory_fsync', stateDir);
        assertBootstrapIntentFileTrust(options, publishingPath, 2);
        assertBootstrapIntentFileTrust(options, path, 2);
        const linkedTemp = lstatSync(publishingPath, { bigint: true });
        const linkedCanonical = lstatSync(path, { bigint: true });
        if (!linkedTemp.isFile() || linkedTemp.isSymbolicLink() || linkedTemp.nlink !== 2n
            || !linkedCanonical.isFile() || linkedCanonical.isSymbolicLink()
            || linkedCanonical.nlink !== 2n
            || linkedTemp.dev !== opened.dev || linkedTemp.ino !== opened.ino
            || linkedCanonical.dev !== opened.dev || linkedCanonical.ino !== opened.ino
            || linkedTemp.size !== opened.size || linkedCanonical.size !== opened.size
            || linkedTemp.mtimeNs !== opened.mtimeNs || linkedCanonical.mtimeNs !== opened.mtimeNs) {
            throw new Error('bootstrap registration intent canonical claim is unconfirmed');
        }
        rmSync(publishingPath);
        syncBootstrapDirectory(stateDir);
        if (bootstrapStateEntryPresent(publishingPath)) {
            throw new Error('bootstrap registration intent temp retirement is unconfirmed');
        }
        assertBootstrapIntentFileTrust(options, path);
        const published = lstatSync(path, { bigint: true });
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n
            || published.dev !== opened.dev || published.ino !== opened.ino
            || published.size !== opened.size || published.mtimeNs !== opened.mtimeNs) {
            throw new Error('bootstrap registration intent changed during publication');
        }
        retireBootstrapRegistrationPublisherClaim(options, publisher);
        return {
            path,
            terminalPath,
            clearingPath,
            currentPath: path,
            device: published.dev,
            inode: published.ino,
            size: published.size,
            mtimeNs: published.mtimeNs,
            ctimeNs: published.ctimeNs,
            record,
        };
    }
    finally {
        publicationLock.release();
    }
}
function terminalizeBootstrapRegistrationIntent(options, lease, outcome, transactionId) {
    if (outcome === 'committed' && (!transactionId || !BOOTSTRAP_UUID_RE.test(transactionId))) {
        throw new Error('bootstrap registration intent commit identity is invalid');
    }
    if (outcome !== 'committed' && transactionId !== undefined) {
        throw new Error('bootstrap registration intent terminal identity is unexpected');
    }
    if (lease.record.state !== 'registering' || lease.currentPath !== lease.path) {
        throw new Error('bootstrap registration intent is not an active registration');
    }
    assertBootstrapIntentDirectoryTrust(options, dirname(lease.currentPath), true);
    assertBootstrapIntentFileTrust(options, lease.currentPath);
    const current = lstatSync(lease.currentPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
        || current.dev !== lease.device || current.ino !== lease.inode || current.size !== lease.size
        || current.mtimeNs !== lease.mtimeNs || current.ctimeNs !== lease.ctimeNs) {
        throw new Error('bootstrap registration intent ownership changed');
    }
    const terminalAtMs = options.now ?? Date.now();
    if (!Number.isSafeInteger(terminalAtMs) || terminalAtMs < 0) {
        throw new Error('invalid bootstrap registration intent terminal clock');
    }
    const record = {
        schema: BOOTSTRAP_REGISTRATION_INTENT_SCHEMA,
        state: 'terminal',
        owner: lease.record.owner,
        createdAt: lease.record.createdAt,
        outcome,
        terminalAt: new Date(terminalAtMs).toISOString(),
        ...(transactionId !== undefined ? { transactionId } : {}),
    };
    const content = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(content, 'utf8') > MAX_BOOTSTRAP_REGISTRATION_INTENT_BYTES) {
        throw new Error('bootstrap registration intent terminal receipt is oversized');
    }
    for (const unavailablePath of [lease.terminalPath, lease.clearingPath]) {
        try {
            lstatSync(unavailablePath);
            throw new Error('bootstrap registration intent terminal path exists');
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
    }
    let descriptor;
    let settled;
    try {
        descriptor = openSync(lease.terminalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        writeFileSync(descriptor, content, { encoding: 'utf8' });
        options.beforeIntentTerminalFsync?.(lease.terminalPath);
        fsyncSync(descriptor);
        settled = fstatSync(descriptor, { bigint: true });
        if (!settled.isFile() || settled.nlink !== 1n
            || settled.dev <= 0n || settled.ino <= 0n
            || settled.size !== BigInt(Buffer.byteLength(content, 'utf8'))) {
            throw new Error('bootstrap registration intent terminalization is unsafe');
        }
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
    if (!settled)
        throw new Error('bootstrap registration intent terminal publication failed');
    assertBootstrapIntentFileTrust(options, lease.terminalPath);
    const after = lstatSync(lease.terminalPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || after.dev !== settled.dev || after.ino !== settled.ino
        || after.size !== settled.size || after.mtimeNs !== settled.mtimeNs
        || after.ctimeNs !== settled.ctimeNs) {
        throw new Error('bootstrap registration intent changed after terminalization');
    }
    const stateDir = dirname(lease.currentPath);
    syncBootstrapDirectory(stateDir);
    options.afterIntentTerminalPublish?.();
    const active = lstatSync(lease.path, { bigint: true });
    if (!active.isFile() || active.isSymbolicLink() || active.nlink !== 1n
        || active.dev !== lease.device || active.ino !== lease.inode || active.size !== lease.size
        || active.mtimeNs !== lease.mtimeNs || active.ctimeNs !== lease.ctimeNs) {
        throw new Error('bootstrap registration intent source changed before retirement');
    }
    rmSync(lease.path);
    syncBootstrapDirectory(stateDir);
    if (bootstrapStateEntryPresent(lease.path)) {
        throw new Error('bootstrap registration intent source retirement is unconfirmed');
    }
    return {
        ...lease,
        currentPath: lease.terminalPath,
        device: settled.dev,
        inode: settled.ino,
        size: settled.size,
        mtimeNs: settled.mtimeNs,
        ctimeNs: settled.ctimeNs,
        record,
    };
}
function clearBootstrapRegistrationIntent(options, lease) {
    if (lease.record.state !== 'terminal') {
        throw new Error('bootstrap registration intent is not terminal');
    }
    const stateDir = dirname(lease.currentPath);
    assertBootstrapIntentDirectoryTrust(options, stateDir, true);
    if (lease.staleRegistering) {
        assertBootstrapIntentFileTrust(options, lease.staleRegistering.path);
        const stale = lstatSync(lease.staleRegistering.path, { bigint: true });
        if (!stale.isFile() || stale.isSymbolicLink() || stale.nlink !== 1n
            || stale.dev !== lease.staleRegistering.device || stale.ino !== lease.staleRegistering.inode
            || stale.size !== lease.staleRegistering.size
            || stale.mtimeNs !== lease.staleRegistering.mtimeNs
            || stale.ctimeNs !== lease.staleRegistering.ctimeNs) {
            throw new Error('bootstrap registration intent source changed before recovery retirement');
        }
        rmSync(lease.staleRegistering.path);
        syncBootstrapDirectory(stateDir);
        if (bootstrapStateEntryPresent(lease.staleRegistering.path)) {
            throw new Error('bootstrap registration intent source recovery retirement is unconfirmed');
        }
    }
    assertBootstrapIntentFileTrust(options, lease.currentPath);
    const current = lstatSync(lease.currentPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
        || current.dev !== lease.device || current.ino !== lease.inode || current.size !== lease.size
        || current.mtimeNs !== lease.mtimeNs || current.ctimeNs !== lease.ctimeNs) {
        throw new Error('bootstrap registration intent ownership changed');
    }
    let clearingLease = lease;
    if (lease.currentPath === lease.terminalPath) {
        try {
            lstatSync(lease.clearingPath);
            throw new Error('bootstrap registration intent clearing path exists');
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
        renameSync(lease.terminalPath, lease.clearingPath);
        syncBootstrapDirectory(stateDir);
        const renamed = lstatSync(lease.clearingPath, { bigint: true });
        if (!renamed.isFile() || renamed.isSymbolicLink() || renamed.nlink !== 1n
            || renamed.dev !== lease.device || renamed.ino !== lease.inode
            || renamed.size !== lease.size) {
            throw new Error('bootstrap registration intent clear rename changed ownership');
        }
        clearingLease = {
            ...lease,
            currentPath: lease.clearingPath,
            size: renamed.size,
            mtimeNs: renamed.mtimeNs,
            ctimeNs: renamed.ctimeNs,
        };
        options.afterIntentClearRename?.();
    }
    else if (lease.currentPath !== lease.clearingPath) {
        throw new Error('bootstrap registration intent path is unexpected');
    }
    assertBootstrapIntentFileTrust(options, clearingLease.currentPath);
    const moved = lstatSync(clearingLease.currentPath, { bigint: true });
    if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1n
        || moved.dev !== clearingLease.device || moved.ino !== clearingLease.inode
        || moved.size !== clearingLease.size || moved.mtimeNs !== clearingLease.mtimeNs
        || moved.ctimeNs !== clearingLease.ctimeNs) {
        throw new Error('bootstrap registration intent clear changed ownership');
    }
    rmSync(clearingLease.currentPath);
    syncBootstrapDirectory(stateDir);
    if (bootstrapStateEntryPresent(lease.path)
        || bootstrapStateEntryPresent(lease.terminalPath)
        || bootstrapStateEntryPresent(lease.clearingPath)) {
        throw new Error('bootstrap registration intent clear is unconfirmed');
    }
}
function sameBootstrapIncompletePublication(left, right) {
    if (left.publisher.pid !== right.publisher.pid
        || left.publisher.token !== right.publisher.token
        || left.publisher.processIdentityDigest !== right.publisher.processIdentityDigest
        || !sameBootstrapRegistrationIntentFileIdentity(left.publisher.identity, right.publisher.identity)) {
        return false;
    }
    if ((left.publishing === undefined) !== (right.publishing === undefined))
        return false;
    if (left.publishing && right.publishing
        && !sameBootstrapRegistrationIntentFileIdentity(left.publishing, right.publishing)) {
        return false;
    }
    if ((left.registration === undefined) !== (right.registration === undefined))
        return false;
    if (!left.registration || !right.registration)
        return true;
    return sameBootstrapRegistrationIntentFileIdentity(left.registration.identity, right.registration.identity) && sameBootstrapRegistrationIntentOwner(left.registration.lease.record, right.registration.lease.record);
}
function assertBootstrapRegistrationIntentFileIdentity(options, expected) {
    assertBootstrapIntentFileTrust(options, expected.path, Number(expected.linkCount));
    const current = lstatSync(expected.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== expected.linkCount
        || current.dev !== expected.device || current.ino !== expected.inode
        || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs
        || current.ctimeNs !== expected.ctimeNs) {
        throw new Error('incomplete registration publication identity changed');
    }
}
function clearBootstrapIncompletePublication(options, publication) {
    const stateDir = resolveBootstrapStateDir(options.env);
    assertBootstrapIntentDirectoryTrust(options, stateDir, true);
    assertBootstrapRegistrationIntentFileIdentity(options, publication.publisher.identity);
    if (publication.publishing) {
        assertBootstrapRegistrationIntentFileIdentity(options, publication.publishing);
    }
    if (publication.registration) {
        assertBootstrapRegistrationIntentFileIdentity(options, publication.registration.identity);
        rmSync(publication.registration.identity.path);
        syncBootstrapDirectory(stateDir);
        if (bootstrapStateEntryPresent(publication.registration.identity.path)) {
            throw new Error('incomplete canonical registration claim retirement is unconfirmed');
        }
        if (publication.publishing
            && publication.registration.identity.device === publication.publishing.device
            && publication.registration.identity.inode === publication.publishing.inode) {
            assertBootstrapIntentFileTrust(options, publication.publishing.path);
            const remaining = lstatSync(publication.publishing.path, { bigint: true });
            if (!remaining.isFile() || remaining.isSymbolicLink() || remaining.nlink !== 1n
                || remaining.dev !== publication.publishing.device
                || remaining.ino !== publication.publishing.inode
                || remaining.size !== publication.publishing.size
                || remaining.mtimeNs !== publication.publishing.mtimeNs) {
                throw new Error('incomplete registration publication changed after claim retirement');
            }
        }
    }
    if (publication.publishing) {
        if (!publication.registration
            || publication.registration.identity.device !== publication.publishing.device
            || publication.registration.identity.inode !== publication.publishing.inode) {
            assertBootstrapRegistrationIntentFileIdentity(options, publication.publishing);
        }
        rmSync(publication.publishing.path);
        syncBootstrapDirectory(stateDir);
        if (bootstrapStateEntryPresent(publication.publishing.path)) {
            throw new Error('incomplete registration publication retirement is unconfirmed');
        }
    }
    retireBootstrapRegistrationPublisherClaim(options, publication.publisher);
    if (bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_FILE))
        || bootstrapStateEntryPresent(join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_PUBLISHING_FILE))
        || bootstrapRegistrationPublisherEntryPresent(stateDir)) {
        throw new Error('incomplete registration publication retirement is unconfirmed');
    }
}
function bootstrapRegistrationOwnerIsStale(status) {
    return status === 'dead' || status === 'pid_reused';
}
function recoverBootstrapRegistrationIntent(options) {
    const intent = readBootstrapRegistrationIntent(options);
    if (intent.status === 'absent' || intent.status === 'invalid') {
        return {
            status: 'blocked',
            detail: intent.status === 'invalid' ? intent.detail : 'registration intent disappeared during recovery',
        };
    }
    try {
        if (intent.status === 'incomplete_publication') {
            const observedPublisherStatus = bootstrapRegistrationPublisherProcessStatus(options, intent.publication.publisher);
            if (!bootstrapRegistrationOwnerIsStale(observedPublisherStatus)) {
                return {
                    status: 'blocked',
                    detail: `registration publisher owner is ${observedPublisherStatus}`,
                };
            }
            let recoveryLock;
            try {
                recoveryLock = acquireBootstrapRegistrationRecoveryLock(options);
            }
            catch {
                return {
                    status: 'blocked',
                    detail: 'registration publisher or another recovery owns the bootstrap transaction lock',
                };
            }
            try {
                const lockedIntent = readBootstrapRegistrationIntent(options);
                if (lockedIntent.status !== 'incomplete_publication'
                    || !sameBootstrapIncompletePublication(intent.publication, lockedIntent.publication)) {
                    return {
                        status: 'blocked',
                        detail: 'registration publication changed while acquiring recovery ownership',
                    };
                }
                const lockedPublisherStatus = bootstrapRegistrationPublisherProcessStatus(options, lockedIntent.publication.publisher);
                if (!bootstrapRegistrationOwnerIsStale(lockedPublisherStatus)) {
                    return {
                        status: 'blocked',
                        detail: `registration publisher owner became ${lockedPublisherStatus}`,
                    };
                }
                const lockedDurable = inspectLifecycleBootstrapDurableState(options.env, { ...options, expectedRecoveryOwner: recoveryLock.owner });
                if (lockedDurable.status !== 'clean'
                    && lockedDurable.status !== 'committed'
                    && lockedDurable.status !== 'manual_transition') {
                    return {
                        status: 'blocked',
                        detail: lockedDurable.status === 'invalid' || lockedDurable.status === 'pending'
                            ? lockedDurable.detail
                            : 'incomplete registration publication durable state is unresolved',
                    };
                }
                clearBootstrapIncompletePublication(options, lockedIntent.publication);
                return lockedDurable.status === 'committed'
                    ? { status: 'committed', transactionId: lockedDurable.transactionId }
                    : {
                        status: 'safe_terminal',
                        outcome: lockedDurable.status === 'manual_transition'
                            ? 'rolled_back'
                            : 'cancelled',
                    };
            }
            finally {
                recoveryLock.release();
            }
        }
        if (intent.status === 'present' && intent.lease.record.state === 'registering') {
            const observedStatus = bootstrapRegistrationOwnerProcessStatus(options, intent.lease.record.owner);
            if (!bootstrapRegistrationOwnerIsStale(observedStatus)) {
                return {
                    status: 'blocked',
                    detail: `registration intent owner is ${observedStatus}`,
                };
            }
            let recoveryLock;
            try {
                recoveryLock = acquireBootstrapRegistrationRecoveryLock(options);
            }
            catch {
                return {
                    status: 'blocked',
                    detail: 'registration child or another recovery owns the bootstrap transaction lock',
                };
            }
            try {
                const lockedIntent = readBootstrapRegistrationIntent(options);
                if (lockedIntent.status !== 'present'
                    || lockedIntent.lease.record.state !== 'registering'
                    || lockedIntent.lease.currentPath !== intent.lease.currentPath
                    || lockedIntent.lease.device !== intent.lease.device
                    || lockedIntent.lease.inode !== intent.lease.inode
                    || lockedIntent.lease.size !== intent.lease.size
                    || lockedIntent.lease.mtimeNs !== intent.lease.mtimeNs
                    || lockedIntent.lease.ctimeNs !== intent.lease.ctimeNs
                    || !sameBootstrapRegistrationIntentOwner(lockedIntent.lease.record, intent.lease.record)) {
                    return {
                        status: 'blocked',
                        detail: 'registration intent changed while acquiring recovery ownership',
                    };
                }
                const lockedOwnerStatus = bootstrapRegistrationOwnerProcessStatus(options, lockedIntent.lease.record.owner);
                if (!bootstrapRegistrationOwnerIsStale(lockedOwnerStatus)) {
                    return {
                        status: 'blocked',
                        detail: `registration intent owner became ${lockedOwnerStatus}`,
                    };
                }
                const lockedDurable = inspectLifecycleBootstrapDurableState(options.env, { ...options, expectedRecoveryOwner: recoveryLock.owner });
                if (lockedDurable.status !== 'clean'
                    && lockedDurable.status !== 'committed'
                    && lockedDurable.status !== 'manual_transition') {
                    return {
                        status: 'blocked',
                        detail: lockedDurable.status === 'invalid' || lockedDurable.status === 'pending'
                            ? lockedDurable.detail
                            : 'registration intent durable state is unresolved',
                    };
                }
                const terminal = terminalizeBootstrapRegistrationIntent(options, lockedIntent.lease, lockedDurable.status === 'committed'
                    ? 'committed'
                    : lockedDurable.status === 'manual_transition'
                        ? 'rolled_back'
                        : 'cancelled', lockedDurable.status === 'committed' ? lockedDurable.transactionId : undefined);
                clearBootstrapRegistrationIntent(options, terminal);
                return lockedDurable.status === 'committed'
                    ? { status: 'committed', transactionId: lockedDurable.transactionId }
                    : {
                        status: 'safe_terminal',
                        outcome: lockedDurable.status === 'manual_transition'
                            ? 'rolled_back'
                            : 'cancelled',
                    };
            }
            finally {
                recoveryLock.release();
            }
        }
        const durable = inspectLifecycleBootstrapDurableState(options.env, options);
        let lease;
        if (intent.status === 'incomplete_terminal') {
            if (durable.status !== 'clean'
                && durable.status !== 'committed'
                && durable.status !== 'manual_transition') {
                return {
                    status: 'blocked',
                    detail: durable.status === 'invalid' || durable.status === 'pending'
                        ? durable.detail
                        : 'incomplete terminal receipt has no safe durable proof',
                };
            }
            assertBootstrapIntentFileTrust(options, intent.terminalFile.path);
            const partial = lstatSync(intent.terminalFile.path, { bigint: true });
            if (!partial.isFile() || partial.isSymbolicLink() || partial.nlink !== 1n
                || partial.dev !== intent.terminalFile.device || partial.ino !== intent.terminalFile.inode) {
                throw new Error('incomplete terminal receipt ownership changed');
            }
            rmSync(intent.terminalFile.path);
            syncBootstrapDirectory(dirname(intent.terminalFile.path));
            if (bootstrapStateEntryPresent(intent.terminalFile.path)) {
                throw new Error('incomplete terminal receipt retirement is unconfirmed');
            }
            lease = terminalizeBootstrapRegistrationIntent(options, intent.registering, durable.status === 'committed'
                ? 'committed'
                : durable.status === 'manual_transition'
                    ? 'rolled_back'
                    : 'no_child', durable.status === 'committed' ? durable.transactionId : undefined);
        }
        else {
            lease = intent.lease;
        }
        if (lease.record.state === 'registering') {
            if (durable.status === 'manual_transition') {
                lease = terminalizeBootstrapRegistrationIntent(options, lease, 'rolled_back');
            }
            else if (durable.status !== 'committed') {
                const detail = durable.status === 'clean'
                    ? 'registration intent has no durable child completion proof'
                    : durable.detail;
                return { status: 'blocked', detail };
            }
            else {
                lease = terminalizeBootstrapRegistrationIntent(options, lease, 'committed', durable.transactionId);
            }
        }
        const terminal = lease.record;
        if (terminal.state !== 'terminal') {
            return { status: 'blocked', detail: 'registration intent did not reach a terminal state' };
        }
        if (terminal.outcome === 'committed') {
            if (durable.status !== 'committed'
                || durable.transactionId !== terminal.transactionId) {
                return { status: 'blocked', detail: 'registration intent commit receipt conflicts with durable state' };
            }
            clearBootstrapRegistrationIntent(options, lease);
            return { status: 'committed', transactionId: durable.transactionId };
        }
        const safeRolledBackTransition = terminal.outcome === 'rolled_back'
            && durable.status === 'manual_transition';
        if (durable.status !== 'clean' && !safeRolledBackTransition) {
            return {
                status: 'blocked',
                detail: durable.status === 'invalid' || durable.status === 'pending'
                    ? durable.detail
                    : 'registration intent terminal receipt conflicts with committed state',
            };
        }
        const outcome = terminal.outcome;
        clearBootstrapRegistrationIntent(options, lease);
        return { status: 'safe_terminal', outcome };
    }
    catch (error) {
        return {
            status: 'blocked',
            detail: boundedBootstrapDetail(`registration intent recovery failed: ${error instanceof Error ? error.message : String(error)}`),
        };
    }
}
async function runBootstrapWithRegistrationIntent(options, prepareRun) {
    let lease;
    try {
        lease = publishBootstrapRegistrationIntent(options);
    }
    catch {
        return {
            ok: false,
            reason: 'blocked',
            detail: 'bootstrap registration intent publication is unavailable',
            requiresForegroundExit: true,
        };
    }
    let runOptions = options;
    let outcome;
    let parentCurrentAtFinalClock = false;
    if (prepareRun) {
        try {
            runOptions = {
                ...options,
                ...await prepareRun(() => {
                    assertBootstrapRegistrationOwnerCurrent(options, lease.record.owner);
                    parentCurrentAtFinalClock = true;
                }),
            };
            if (!parentCurrentAtFinalClock) {
                throw new Error('bootstrap registration preparation omitted parent identity revalidation');
            }
        }
        catch (error) {
            // The preparation hook runs before child creation, so a strict terminal no-child receipt
            // can retire this bootstrap intent while the migration transaction handles its own state.
            outcome = {
                ok: false,
                reason: 'failed',
                detail: boundedBootstrapDetail(error instanceof Error ? error.message : String(error)),
            };
        }
    }
    if (!outcome) {
        try {
            // Re-read the parent process identity after every asynchronous sealed check, then bind the
            // exact unique intent token into only the child environment. runBootstrap reaches spawn
            // synchronously, so no await or mutation window exists between this check and child creation.
            if (!parentCurrentAtFinalClock) {
                assertBootstrapRegistrationOwnerCurrent(runOptions, lease.record.owner);
            }
            runOptions = {
                ...runOptions,
                env: {
                    ...runOptions.env,
                    [coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV]: lease.record.owner.token,
                },
            };
        }
        catch (error) {
            outcome = {
                ok: false,
                reason: 'failed',
                detail: boundedBootstrapDetail(error instanceof Error ? error.message : String(error)),
            };
        }
    }
    if (!outcome) {
        try {
            outcome = await runBootstrap(runOptions);
        }
        catch {
            // The no-replace intent remains authoritative until an operator or durable recovery clears it.
            return {
                ok: false,
                reason: 'ambiguous',
                detail: 'bootstrap registration runner failed unexpectedly',
                requiresForegroundExit: true,
            };
        }
    }
    if (outcome.requiresForegroundExit === true)
        return outcome;
    try {
        const durable = inspectLifecycleBootstrapDurableState(runOptions.env, runOptions);
        if (outcome.ok) {
            if (durable.status !== 'committed') {
                throw new Error('bootstrap success lacks a durable committed transaction');
            }
            lease = terminalizeBootstrapRegistrationIntent(runOptions, lease, 'committed', durable.transactionId);
        }
        else if (outcome.reason === 'rolled_back') {
            if (durable.status !== 'clean' && durable.status !== 'manual_transition') {
                throw new Error('bootstrap rollback did not restore a clean durable state');
            }
            lease = terminalizeBootstrapRegistrationIntent(runOptions, lease, 'rolled_back');
        }
        else if (['failed', 'cli_not_found'].includes(outcome.reason)) {
            if (durable.status !== 'clean') {
                throw new Error('bootstrap no-child failure left durable state');
            }
            lease = terminalizeBootstrapRegistrationIntent(runOptions, lease, 'no_child');
        }
        else {
            throw new Error('bootstrap result does not prove a safe terminal state');
        }
        clearBootstrapRegistrationIntent(runOptions, lease);
    }
    catch {
        return {
            ok: false,
            reason: 'blocked',
            detail: 'bootstrap registration intent clear is unconfirmed',
            requiresForegroundExit: true,
        };
    }
    return outcome;
}
function defaultMigrationRegistrationRunner(options) {
    const clock = options.migration?.clock ?? Date.now;
    const failed = (detail) => ({
        ok: false,
        reason: 'failed',
        detail: boundedBootstrapDetail(detail),
    });
    const readClock = () => {
        try {
            const value = clock();
            return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
        }
        catch {
            return undefined;
        }
    };
    return async (request) => {
        if (request.execPath !== request.targetIdentity.path
            || request.env['EVOLVER_SELF_UPDATE_TARGET_PATH'] !== request.execPath
            || !Number.isSafeInteger(request.startedAtMs)
            || request.startedAtMs < 0
            || !Number.isSafeInteger(request.transactionBudgetMs)
            || request.transactionBudgetMs <= 0
            || !Number.isSafeInteger(request.timeoutMs)
            || request.timeoutMs > MAX_TIMER_DELAY_MS
            || !Number.isSafeInteger(request.transactionDeadlineMs)
            || !Number.isSafeInteger(request.parentDeadlineMs)
            || request.transactionDeadlineMs - request.startedAtMs !== request.transactionBudgetMs
            || request.parentDeadlineMs - request.startedAtMs !== request.timeoutMs
            || request.timeoutMs <= request.transactionBudgetMs) {
            return failed('invalid migration registration binding');
        }
        return runBootstrapWithRegistrationIntent({
            env: request.env,
            platform: request.platform,
            execPath: request.execPath,
            ...(request.exists !== undefined ? { exists: request.exists } : {}),
            ...(request.readFile !== undefined ? { readFile: request.readFile } : {}),
            ...(request.writeFile !== undefined ? { writeFile: request.writeFile } : {}),
            ...(request.spawnFn !== undefined ? { spawnFn: request.spawnFn } : {}),
            ...(options.treeKillSpawnFn !== undefined ? { treeKillSpawnFn: options.treeKillSpawnFn } : {}),
            ...(options.processKill !== undefined ? { processKill: options.processKill } : {}),
            ...(options.terminationGraceMs !== undefined ? { terminationGraceMs: options.terminationGraceMs } : {}),
            ...(options.beforeIntentPublish !== undefined ? { beforeIntentPublish: options.beforeIntentPublish } : {}),
            ...(options.afterIntentPublicationStep !== undefined
                ? { afterIntentPublicationStep: options.afterIntentPublicationStep }
                : {}),
            ...(options.afterIntentTerminalPublish !== undefined
                ? { afterIntentTerminalPublish: options.afterIntentTerminalPublish }
                : {}),
            ...(options.beforeIntentTerminalFsync !== undefined
                ? { beforeIntentTerminalFsync: options.beforeIntentTerminalFsync }
                : {}),
            ...(options.afterIntentClearRename !== undefined
                ? { afterIntentClearRename: options.afterIntentClearRename }
                : {}),
            ...(options.assertIntentDirectoryTrust !== undefined
                ? { assertIntentDirectoryTrust: options.assertIntentDirectoryTrust }
                : {}),
            ...(options.assertIntentFileTrust !== undefined
                ? { assertIntentFileTrust: options.assertIntentFileTrust }
                : {}),
            ...(options.readRegistrationProcessStartIdentity !== undefined
                ? { readRegistrationProcessStartIdentity: options.readRegistrationProcessStartIdentity }
                : {}),
            ...(options.registrationOwnerProcessStatus !== undefined
                ? { registrationOwnerProcessStatus: options.registrationOwnerProcessStatus }
                : {}),
            ...(options.registrationPublisherProcessStatus !== undefined
                ? { registrationPublisherProcessStatus: options.registrationPublisherProcessStatus }
                : {}),
        }, async (assertParentCurrent) => {
            // The bootstrap intent is durable before these sealed checks. No await occurs between
            // successful target revalidation, remaining-budget calculation, and runBootstrap's spawn.
            const beforeRevalidation = readClock();
            if (beforeRevalidation === undefined
                || beforeRevalidation < request.startedAtMs
                || beforeRevalidation >= request.transactionDeadlineMs
                || beforeRevalidation >= request.parentDeadlineMs) {
                throw new Error('migration registration deadline expired before target revalidation');
            }
            try {
                await request.assertRegistrationIntentCurrent();
                await request.revalidateTarget();
            }
            catch {
                throw new Error('migration registration intent or target revalidation failed');
            }
            // This native observation can block. Run it before the final absolute-deadline clock read
            // so its elapsed time is subtracted instead of silently extending either remaining budget.
            assertParentCurrent();
            const current = readClock();
            if (current === undefined || current < beforeRevalidation) {
                throw new Error('migration registration clock regressed');
            }
            const transactionBudgetMs = request.transactionDeadlineMs - current;
            const timeoutMs = request.parentDeadlineMs - current;
            if (!Number.isSafeInteger(transactionBudgetMs)
                || !Number.isSafeInteger(timeoutMs)
                || transactionBudgetMs <= 0
                || timeoutMs <= transactionBudgetMs
                || timeoutMs > MAX_TIMER_DELAY_MS) {
                throw new Error('migration registration deadline expired before child creation');
            }
            return { now: current, transactionBudgetMs, timeoutMs };
        });
    };
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
    const migrateUnbindableInstall = async (reason) => {
        if (reason === 'bootstrap_attempt_pending') {
            const durable = inspectLifecycleBootstrapDurableState(bootstrapEnv, options);
            if (durable.status === 'manual_transition') {
                return {
                    disposition: 'continue',
                    handedOver: false,
                    message: '[evolver-proxy] self-update: automatic bootstrap remains disabled by a durable '
                        + 'manual service transition; continuing degraded without downloading, replacing, or '
                        + 'registering a standalone binary. Run evolver lifecycle install-service --target='
                        + durable.target
                        + ' explicitly to resume.',
                };
            }
            if (durable.status === 'pending' && durable.manualTransition) {
                return {
                    disposition: 'fail_closed',
                    handedOver: false,
                    exitCode: 1,
                    message: '[evolver-proxy] self-update: manual service transition recovery is incomplete; '
                        + 'exiting without downloading, replacing, or registering a standalone binary. '
                        + `(${boundedBootstrapDetail(durable.detail)}) Run evolver lifecycle remove-service --target=`
                        + durable.manualTransition.target
                        + ' to finish the interrupted removal before explicitly reinstalling the service.',
                };
            }
            if (durable.status === 'pending'
                && Object.values(durable.recoveryLocks ?? {})
                    .some((status) => status === 'active_or_unverifiable')) {
                return {
                    disposition: 'fail_closed',
                    handedOver: false,
                    exitCode: 1,
                    message: '[evolver-proxy] self-update: lifecycle recovery lock ownership is active or '
                        + 'unverifiable; exiting before migration download, target mutation, or child creation. ('
                        + boundedBootstrapDetail(durable.detail)
                        + ')',
                };
            }
            if (durable.status === 'invalid') {
                return {
                    disposition: 'fail_closed',
                    handedOver: false,
                    exitCode: 1,
                    message: '[evolver-proxy] self-update: lifecycle recovery state is invalid; exiting without '
                        + 'migration, target mutation, or child creation. ('
                        + boundedBootstrapDetail(durable.detail)
                        + ')',
                };
            }
        }
        // The npm/JS install shape cannot safely run ordinary lifecycle bootstrap because it would
        // bind supervision back to an unreplaceable Node launcher. Only the signed standalone
        // migration may register recovery, and pending ownership stays fail-closed on every skip.
        const migration = await migrateToStandaloneBinary(bootstrapEnv, platform, {
            ...options.migration,
            registrationRunner: options.migration?.registrationRunner
                ?? defaultMigrationRegistrationRunner(options),
            ...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
            ...(options.exists !== undefined ? { exists: options.exists } : {}),
            ...(options.readFile !== undefined ? { readFile: options.readFile } : {}),
            ...(options.writeFile !== undefined ? { writeFile: options.writeFile } : {}),
            ...(options.spawnFn !== undefined ? { spawnFn: options.spawnFn } : {}),
            ...(options.now !== undefined ? { now: options.now } : {}),
        });
        const recoveringPendingOwnership = reason === 'migration_ambiguous'
            || reason === 'bootstrap_attempt_pending';
        if (migration.requiresForegroundExit === true
            || (recoveringPendingOwnership && migration.outcome !== 'migrated')) {
            return {
                disposition: 'fail_closed',
                handedOver: false,
                exitCode: 1,
                message: '[evolver-proxy] self-update: standalone migration registration did not prove a clean rollback; '
                    + 'exiting the foreground proxy to avoid concurrent IPC ownership. '
                    + 'Inspect the lifecycle bootstrap transaction state before retrying.',
            };
        }
        if (migration.outcome === 'migrated') {
            return {
                disposition: 'handoff',
                handedOver: true,
                exitCode: 0,
                message: migration.message,
            };
        }
        if (migration.outcome === 'skipped' && migration.reason !== 'cooldown') {
            recordBootstrapAttempt(bootstrapEnv, { ok: false, reason }, options);
        }
        return {
            disposition: 'continue',
            handedOver: false,
            message: '[evolver-proxy] self-update: running from the npm/JS install shape, which has no standalone '
                + 'binary target for self-update; bootstrap skipped, continuing with self-update off. '
                + 'Install the standalone binary from GitHub Releases and start it to enable self-update. ('
                + migration.message
                + ')',
        };
    };
    const decision = shouldBootstrap(bootstrapEnv, platform, options);
    if (!decision.proceed) {
        const reason = decision.reason ?? 'skipped';
        if (reason === 'bootstrap_attempt_invalid') {
            return {
                disposition: 'fail_closed',
                handedOver: false,
                exitCode: 1,
                message: '[evolver-proxy] self-update: bootstrap attempt recovery state is invalid; '
                    + 'exiting without replacing it because prior process ownership cannot be classified safely. '
                    + 'Inspect the lifecycle state before retrying.',
            };
        }
        if (reason === 'bootstrap_intent_pending') {
            const recovery = recoverBootstrapRegistrationIntent({
                env: bootstrapEnv,
                platform,
                ...options,
            });
            if (recovery.status === 'committed') {
                try {
                    resolveSelfUpdateTarget({ env: bootstrapEnv, processExecPath: options.execPath });
                    return {
                        disposition: 'handoff',
                        handedOver: true,
                        exitCode: 0,
                        message: '[evolver-proxy] self-update: recovered a committed lifecycle bootstrap registration; '
                            + 'handing over to the service manager without creating another child.',
                    };
                }
                catch {
                    // Exact intent recovery retired the old no-replace authority. An npm/JS foreground
                    // still cannot prove that the committed launcher binds a standalone executable.
                    return migrateUnbindableInstall('bootstrap_attempt_pending');
                }
            }
            if (recovery.status === 'safe_terminal') {
                return {
                    disposition: 'continue',
                    handedOver: false,
                    message: '[evolver-proxy] self-update: recovered and cleared a bootstrap registration '
                        + `${recovery.outcome} receipt without creating another child; continuing degraded.`,
                };
            }
            return {
                disposition: 'fail_closed',
                handedOver: false,
                exitCode: 1,
                message: '[evolver-proxy] self-update: prior bootstrap registration ownership remains unresolved; '
                    + 'exiting without migration, target mutation, or child creation. '
                    + `(${boundedBootstrapDetail(recovery.detail)})`,
            };
        }
        if (reason === 'unsupported_install_shape'
            || reason === 'migration_ambiguous'
            || reason === 'bootstrap_attempt_pending') {
            // Do not suggest `evolver lifecycle bootstrap` here: under the npm/JS install shape it
            // would register a supervised service that crashes at self-update target resolution on
            // every startup (crash-loop). Only a standalone release binary can host self-update —
            // so attempt the one-time migration to it; any skip/failure keeps the degraded startup.
            return migrateUnbindableInstall(reason);
        }
        if (reason !== 'recent_failure') {
            recordBootstrapAttempt(bootstrapEnv, { ok: false, reason }, options);
        }
        return {
            disposition: 'continue',
            handedOver: false,
            message: '[evolver-proxy] self-update: default auto requires a durable supervisor attestation; '
                + `running with self-update off (bootstrap skipped: ${reason}). `
                + 'Run `evolver lifecycle bootstrap` or `evolver lifecycle install-service` to enable.',
        };
    }
    const outcome = await runBootstrapWithRegistrationIntent({ env: bootstrapEnv, platform, ...options });
    const recoveringPendingOwnership = decision.reason === 'migration_ambiguous'
        || decision.reason === 'bootstrap_attempt_pending';
    if (!recoveringPendingOwnership || outcome.ok) {
        recordBootstrapAttempt(bootstrapEnv, outcome, options);
    }
    if (outcome.ok) {
        const lockReleaseWarning = outcome.reason === 'bootstrapped_lock_release_unconfirmed'
            ? ' The lifecycle commit is durable, but lock release could not be confirmed'
                + ` (${boundedBootstrapDetail(outcome.detail ?? 'bootstrap lifecycle lock release is unconfirmed')}).`
                + ' Inspect the lifecycle state before the next lifecycle mutation.'
            : '';
        return {
            disposition: 'handoff',
            handedOver: true,
            exitCode: 0,
            message: '[evolver-proxy] self-update: registered durable service supervision via `evolver lifecycle bootstrap`; '
                + 'handing over to the service manager and exiting so it can take the IPC port.'
                + lockReleaseWarning,
        };
    }
    if (outcome.requiresForegroundExit) {
        const termination = outcome.reason === 'termination_unconfirmed'
            ? 'process-tree termination could not be confirmed'
            : `the child result was ${outcome.reason} and did not prove a clean rollback`;
        return {
            disposition: 'fail_closed',
            handedOver: false,
            exitCode: 1,
            message: `[evolver-proxy] self-update: bootstrap ${termination}; exiting the foreground proxy to avoid concurrent IPC ownership. `
                + 'Inspect the lifecycle bootstrap transaction state before retrying.',
        };
    }
    if (recoveringPendingOwnership) {
        return {
            disposition: 'fail_closed',
            handedOver: false,
            exitCode: 1,
            message: '[evolver-proxy] self-update: prior standalone migration ownership remains unresolved; '
                + 'exiting the foreground proxy without replacing the ambiguity marker. '
                + 'Inspect the lifecycle bootstrap transaction state before retrying.',
        };
    }
    return {
        disposition: 'continue',
        handedOver: false,
        message: `[evolver-proxy] self-update: first-run bootstrap failed (${outcome.reason}); `
            + 'running with self-update off. Run `evolver lifecycle install-service` manually to enable.',
    };
}