// `evolver autoexec` — the deployable form of the autonomous-exec daemon. A resident loop that drains a
// directory task queue through the productized kernel (exec.runAutoExecTask) with all safety controls, guarded
// by single-flight so a slow pass never stacks. DENY-BY-DEFAULT: allowedRoots starts empty (refuses every
// repo) until the operator explicitly allowlists one — autonomous edits to a real repo never happen by accident.
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { events, assetstore, algo, exec, ops, observers, hooks, material as materialNs, util, verify, hub as hubNs, daemon as daemonNs, personality, signals as signalNs } from '@evomap/evolver-core';
import { runRequiredSandboxedValidation } from './requiredSandboxValidation.js';
import { startResidentLoop } from './daemonLoop.js';
import { autoexecHeartbeatTelemetry } from './runtimeTelemetry.js';
import { connectPublicHub, OAuthAuthenticationPreflightError, OAuthCredentialBindingError, readPublicOAuthCredentialBinding, createSolidifyPermitCheck, getMinReuseScore, isTerminalHubRejectionStatus, ReuseCache, reuseBeforeSolve, resolveConfiguredHubUrl, resolveHubUrl, searchHubMetadata, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv, proxyClientFromEnv } from '@evomap/evolver-mcp';
import { resolveValueDigestObserver } from './valueDigest.js';
import { resolveReflectionObserver } from './reflectionObserver.js';
import { resolveCursorRewriteObserver } from './cursorRewrite.js';
import { resolveMemoryEventMirrorObserver } from './memoryEventMirror.js';
import { resolveDistillObserver } from './distillObserver.js';
import { resolveAutoDistillLlm } from './autoDistillLlm.js';
import { resolveAutoDistillAntiGene as resolveAntiGeneDistill } from './autoDistillAntiGene.js';
import { runTranscriptDistillTick, transcriptDistillMode } from './autoDistillTranscript.js';
import { resolveContextObservationWriter, runSessionIngestTick, scanSessionDirs } from './sessionIngest.js';
import { LocalMemoryGraph, resolveLocalMemoryUserIdentity } from './localMemoryGraph.js';
import { resolveAtpAutoDeliver } from './atpAutoDeliver.js';
import { memoryEventsFromCycleLog, resolveTaskReceiver } from './taskReceiver.js';
import { createAtpClientFromEnv, getAtpConsent, resolveAtpHome, resolveAtpSenderId } from './atp.js';
import { AtpAutoBuyer } from './atpAutoBuyer.js';
import { resolveExplicitNodeCredentials, resolveIdentityHome } from './identityHome.js';
import { runAutobuyPrompt } from './atpAutobuyPrompt.js';
import * as solomode from './solo/mode.js';
import * as gitGuard from './solo/gitGuard.js';
import * as breaker from './solo/breaker.js';
import { initializeWorkflowStartupRecovery } from './workflowRuntime.js';
import { readAutoExecConfig } from './autoexecConfig.js';
import { makeCurriculumCapabilityGapsProvider } from './curriculumCapabilityGaps.js';
import { resolveLearningTrace } from './learningTrace.js';
import { semanticIdfEnabled } from './semanticIdfConfig.js';
import { feedbackDestinationIdentity } from './feedbackDestinationIdentity.js';
export { feedbackDestinationIdentity } from './feedbackDestinationIdentity.js';
import { FeedbackNotDispatchedError, FeedbackOutbox } from './feedbackOutbox.js';
import { TaskOutcomeOutbox, taskOutcomeIdentity } from './taskOutcomeOutbox.js';
import { selectionFloorFromEnv, selectionGuardFromEnv, selectionPolicyFromEnv, } from './selectionPolicyConfig.js';
export { readAutoExecConfig } from './autoexecConfig.js';
export { semanticIdfEnabled } from './semanticIdfConfig.js';
export { selectionFloorFromEnv, selectionGuardFromEnv, selectionPolicyFromEnv, } from './selectionPolicyConfig.js';
export function withAutoExecSelectionPolicy(deps, env = process.env) {
    const policy = selectionPolicyFromEnv(env);
    return policy === 'engine-health' ? deps : { ...deps, selectionPolicy: policy };
}
export function withAutoExecSelectionConfig(deps, env = process.env) {
    const withPolicy = withAutoExecSelectionPolicy(deps, env);
    const selectionGuard = selectionGuardFromEnv(env);
    const selectionFloor = selectionFloorFromEnv(env);
    return {
        ...withPolicy,
        selectionGuard,
        ...(selectionFloor !== undefined ? { selectionFloor } : {}),
    };
}
const ENV_FILE_UNAVAILABLE_DIAGNOSTIC = '[evolver-autoexec] env_file_unavailable\n';
/** Create the queue layout under <home>/autoexec/{tasks,inflight,done,refused}. */
export function ensureAutoExecDirs(base) {
    const dirs = {
        base,
        tasks: join(base, 'tasks'),
        inflight: join(base, 'inflight'),
        done: join(base, 'done'),
        refused: join(base, 'refused'),
    };
    for (const dir of [dirs.tasks, dirs.inflight, receiptDir(dirs), dirs.done, dirs.refused])
        mkdirSync(dir, { recursive: true });
    return dirs;
}
function clippedValidationText(value) {
    return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}
function validationCommandDisplay(cmd) {
    const script = verify.validationScriptPath(cmd);
    if (script)
        return `node ${script}`;
    const executable = String(cmd ?? '').trim().split(/\s+/)[0] ?? '';
    return executable || '<empty>';
}
export function summarizeSandboxedValidation(result) {
    const parts = [];
    if (result.failureReason)
        parts.push(result.failureReason);
    if (result.isolationTier !== undefined) {
        parts.push(result.isolationTier === 'no-network'
            ? 'isolation: no-network (private root, read-only source; no aggregate cgroup limits)'
            : `isolation: ${result.isolationTier}`);
    }
    if (result.skipped.length > 0) {
        const skipped = result.skipped.map((item) => clippedValidationText(`node ${item.script} (${item.reason})`));
        parts.push(`skipped ${result.skipped.length} validation command(s): ${skipped.join('; ')}`);
    }
    const failed = result.results.filter((item) => !item.allowed || !item.passed);
    if (failed.length > 0) {
        const failures = failed.map((item) => {
            const status = item.allowed ? `exit ${String(item.exitCode)}` : 'denied';
            return clippedValidationText(`${validationCommandDisplay(item.cmd)} (${status})`);
        });
        parts.push(`failed ${failed.length} validation command(s): ${failures.join('; ')}`);
    }
    return parts.length > 0 ? parts.join(' | ') : null;
}
function createAutoExecPersonalityStore() {
    return new personality.PersonalityStore();
}
const CLAIMED_TASK_SUFFIX = '.claimed.json';
const STARTED_TASK_SUFFIX = '.started.json';
const FEEDBACK_PREPARATION_FAILURE = /^(?:EIO|ENOSPC|EROFS|EACCES|EPERM|ENOENT|EMFILE|ENFILE|EDQUOT|EEXIST|EBUSY|EINVAL|unknown)$/;
const AMBIGUOUS_RECOVERY_REASON = 'autoexec_crash_recovery_ambiguous: execution may have started before shutdown; refusing automatic retry, explicitly requeue after inspecting prior side effects';
function receiptDir(dirs) {
    return join(dirs.base, 'receipts');
}
function syncQueueDirectory(path) {
    if (process.platform === 'win32')
        return;
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
const RECEIPT_TEMP_SUFFIX = /^(.*\.started\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
function receiptArtifactClaimName(name) {
    const tempMatch = RECEIPT_TEMP_SUFFIX.exec(name);
    const claimName = tempMatch?.[1] ?? name;
    const claim = parseAutoExecClaim(claimName);
    if (!claim || claim.name !== claimName)
        return null;
    if (tempMatch)
        return claim.phase === 'started' ? claimName : null;
    return claim.phase === 'started' || claim.phase === 'legacy' ? claimName : null;
}
function cleanupReceiptArtifacts(dirs, shouldRemove) {
    const dir = receiptDir(dirs);
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const claimName = receiptArtifactClaimName(entry.name);
        if (!claimName || !shouldRemove(claimName))
            continue;
        try {
            unlinkSync(join(dir, entry.name));
        }
        catch {
            // Cleanup is retried by the next pass after the claim has been archived.
        }
    }
}
function cleanupCommittedClaimReceipt(dirs, claimName) {
    const path = join(receiptDir(dirs), claimName);
    try {
        if (lstatSync(path).isFile())
            unlinkSync(path);
    }
    catch {
        // Orphan cleanup retries this after the claim has been archived.
    }
}
function cleanupOrphanReceiptArtifacts(dirs) {
    let activeClaims;
    try {
        activeClaims = new Set(readdirSync(dirs.inflight, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name));
    }
    catch {
        return;
    }
    cleanupReceiptArtifacts(dirs, (claimName) => !activeClaims.has(claimName)
        && !hasRecoverableClaimReceipt(dirs, claimName));
}
function hasRecoverableClaimReceipt(dirs, claimName) {
    try {
        const path = join(receiptDir(dirs), claimName);
        if (!lstatSync(path).isFile())
            return false;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return !!value && typeof value === 'object'
            && ('archiveName' in value || 'executionDestinationId' in value || 'taskOutcomeEnabled' in value || 'postCommit' in value);
    }
    catch (error) {
        // Unknown durable bytes are evidence, not disposable temp files.
        return error.code !== 'ENOENT';
    }
}
function parseAutoExecClaim(name) {
    const separator = name.indexOf('--');
    if (separator < 0 || separator + 2 >= name.length)
        return null;
    const encodedName = name.slice(separator + 2);
    if (encodedName.endsWith(CLAIMED_TASK_SUFFIX)) {
        return {
            name,
            originalName: `${encodedName.slice(0, -CLAIMED_TASK_SUFFIX.length)}.json`,
            phase: 'claimed',
        };
    }
    if (encodedName.endsWith(STARTED_TASK_SUFFIX)) {
        return {
            name,
            originalName: `${encodedName.slice(0, -STARTED_TASK_SUFFIX.length)}.json`,
            phase: 'started',
        };
    }
    return encodedName.endsWith('.json') ? { name, originalName: encodedName, phase: 'legacy' } : null;
}
/**
 * Whether a claim for this queue id is already checked out to the exec pass. The name has
 * to match on both ends — `--hub-1` is a prefix of `--hub-10`, and treating one task as
 * another's execution either strands it until its commitment lapses or runs it twice.
 */
export function hasInflightClaim(dirs, queueTaskId) {
    // `.json` is the pre-suffix layout a running daemon may still have on disk after an
    // upgrade; parseAutoExecClaim reads those as legacy claims, so this has to see them too.
    const suffixes = [CLAIMED_TASK_SUFFIX, STARTED_TASK_SUFFIX, '.json'];
    return readdirSync(dirs.inflight)
        .some((name) => suffixes.some((suffix) => name.endsWith(`--${queueTaskId}${suffix}`)));
}
function taskClaimName(originalName) {
    return `${randomUUID()}--${originalName.slice(0, -'.json'.length)}${CLAIMED_TASK_SUFFIX}`;
}
function archiveTaskPath(dest, originalName, claimName) {
    const defaultArchive = join(dest, `task-${originalName}`);
    return existsSync(defaultArchive) ? join(dest, `task-${claimName}`) : defaultArchive;
}
function isAutoExecVerdict(value, taskId) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    return candidate.taskId === taskId
        && (candidate.status === 'refused'
            || candidate.status === 'skipped'
            || candidate.status === 'solidified'
            || candidate.status === 'failed'
            || candidate.status === 'innovated'
            || candidate.status === 'unsafe_to_replay');
}
function persistedClaimReceipt(dirs, claim, taskId) {
    try {
        const path = join(receiptDir(dirs), claim.name);
        if (!lstatSync(path).isFile())
            return null;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (!value || typeof value !== 'object')
            return null;
        const receipt = value;
        const ownerTaskId = taskId ?? receipt.verdict?.taskId;
        if (receipt.claimName !== claim.name
            || (receipt.destination !== 'done' && receipt.destination !== 'refused')
            || typeof ownerTaskId !== 'string' || !ownerTaskId.trim()
            || !isAutoExecVerdict(receipt.verdict, ownerTaskId))
            return null;
        const expectedDestination = receipt.verdict.status === 'refused' || receipt.verdict.status === 'unsafe_to_replay' ? 'refused' : 'done';
        if (receipt.destination !== expectedDestination)
            return null;
        if (receipt.archiveName !== undefined
            && (typeof receipt.archiveName !== 'string' || /[\\/]/.test(receipt.archiveName)
                || (receipt.archiveName !== `task-${claim.originalName}` && receipt.archiveName !== `task-${claim.name}`))) {
            throw new Error('claim receipt archive identity mismatch');
        }
        if (receipt.executionDestinationId !== undefined && receipt.executionDestinationId !== null
            && (typeof receipt.executionDestinationId !== 'string'
                || !/^sha256:[a-f0-9]{64}$/.test(receipt.executionDestinationId))) {
            throw new Error('claim receipt execution destination invalid');
        }
        if (receipt.postCommit !== undefined && receipt.postCommit !== 'pending' && receipt.postCommit !== 'dispatching') {
            throw new Error('claim receipt post-commit state invalid');
        }
        if (receipt.taskOutcomeEnabled !== undefined && typeof receipt.taskOutcomeEnabled !== 'boolean') {
            throw new Error('claim receipt task-outcome eligibility invalid');
        }
        if (receipt.feedbackPreparationFailure !== undefined
            && (typeof receipt.feedbackPreparationFailure !== 'string'
                || !FEEDBACK_PREPARATION_FAILURE.test(receipt.feedbackPreparationFailure))) {
            throw new Error('claim receipt feedback-preparation state invalid');
        }
        if (receipt.feedbackPreparationPending !== undefined && typeof receipt.feedbackPreparationPending !== 'boolean') {
            throw new Error('claim receipt feedback-preparation marker invalid');
        }
        return receipt;
    }
    catch (error) {
        if (error.code !== 'ENOENT'
            && !(error instanceof SyntaxError))
            throw error;
        return null;
    }
}
function persistClaimReceipt(dirs, receipt) {
    const receipts = receiptDir(dirs);
    const receiptPath = join(receipts, receipt.claimName);
    const tempPath = join(receipts, `${receipt.claimName}.${randomUUID()}.tmp`);
    let fd;
    try {
        fd = openSync(tempPath, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(receipt, null, 2), 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tempPath, receiptPath);
        syncQueueDirectory(receipts);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            if (lstatSync(tempPath).isFile())
                unlinkSync(tempPath);
        }
        catch {
            // The atomic rename normally removes the temp path.
        }
    }
}
function finishCommittedClaim(dirs, claim, task, receipt, options, archived, recovering) {
    if (task.id !== receipt.verdict.taskId || task.generation !== receipt.verdict.generation) {
        throw new Error('claim receipt task identity mismatch');
    }
    const dest = receipt.destination === 'refused' ? dirs.refused : dirs.done;
    const archiveName = receipt.archiveName ?? basename(archiveTaskPath(dest, claim.originalName, claim.name));
    const archivePath = join(dest, archiveName);
    if (!archived && existsSync(archivePath))
        throw new Error('claim archive destination occupied');
    receipt.archiveName = archiveName;
    const canonicalVerdict = join(dest, claim.originalName);
    // Queue filenames own the flat archive namespace; snapshots have a disjoint directory.
    const archivedVerdictDir = join(dest, 'verdicts');
    const archivedVerdict = join(archivedVerdictDir, claim.name);
    let verdictPath = canonicalVerdict;
    if (recovering && existsSync(archivedVerdictDir)
        && (!lstatSync(archivedVerdictDir).isDirectory() || lstatSync(archivedVerdictDir).isSymbolicLink())) {
        throw new Error('unsafe archived verdict directory');
    }
    if (recovering && existsSync(archivedVerdict)) {
        if (!lstatSync(archivedVerdict).isFile()
            || !isDeepStrictEqual(JSON.parse(readFileSync(archivedVerdict, 'utf8')), receipt.verdict)) {
            throw new Error('archived claim verdict identity mismatch');
        }
    }
    if (recovering && existsSync(canonicalVerdict)) {
        if (!lstatSync(canonicalVerdict).isFile())
            throw new Error('archived verdict is not a regular file');
        const existing = JSON.parse(readFileSync(canonicalVerdict, 'utf8'));
        // Preparation is owned by the exact receipt and archived task above.
        // The filename-level verdict may already belong to a newer filing; never overwrite it.
        const currentTaskId = existing && typeof existing === 'object' ? existing.taskId : undefined;
        if (typeof currentTaskId !== 'string' || !isAutoExecVerdict(existing, currentTaskId)) {
            throw new Error('archived verdict identity mismatch');
        }
        if (!isDeepStrictEqual(existing, receipt.verdict))
            verdictPath = archivedVerdict;
    }
    // An earlier rename may have succeeded while receipt-directory fsync failed.
    // Recommit the saved identity before reconstructing debt, never today's identity.
    if (options.prepareFeedback && receipt.feedbackPreparationPending !== false)
        receipt.feedbackPreparationPending = true;
    if (recovering)
        persistClaimReceipt(dirs, receipt);
    if (verdictPath === archivedVerdict) {
        mkdirSync(archivedVerdictDir, { recursive: true, mode: 0o700 });
        if (!lstatSync(archivedVerdictDir).isDirectory() || lstatSync(archivedVerdictDir).isSymbolicLink()) {
            throw new Error('unsafe archived verdict directory');
        }
    }
    if (recovering ? !existsSync(verdictPath) : !archived || !existsSync(canonicalVerdict)) {
        // Recovery owns only its saved verdict; a newly appeared path must never be truncated.
        const fd = openSync(verdictPath, recovering ? 'wx' : 'w', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(receipt.verdict, null, 2));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    else if (recovering) {
        // Visible bytes may remain after a failed fsync. Recommit the exact opened file without truncation.
        const fd = openSync(verdictPath, 'r+', 0o600);
        try {
            if (!isDeepStrictEqual(JSON.parse(readFileSync(fd, 'utf8')), receipt.verdict)) {
                throw new Error('claim verdict identity changed');
            }
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    if (verdictPath === archivedVerdict)
        syncQueueDirectory(archivedVerdictDir);
    if (!archived) {
        renameSync(join(dirs.inflight, claim.name), archivePath);
    }
    syncQueueDirectory(dest);
    syncQueueDirectory(dirs.inflight);
    if ((receipt.feedbackPreparationPending || receipt.feedbackPreparationFailure !== undefined)
        && !options.prepareFeedback)
        return receipt.verdict;
    try {
        if (receipt.feedbackPreparationPending !== false) {
            options.prepareFeedback?.(claim.name.slice(0, claim.name.indexOf('--')), task, receipt.verdict, receipt.executionDestinationId, receipt.taskOutcomeEnabled === true);
        }
    }
    catch (error) {
        const code = error instanceof Error ? error.code : undefined;
        receipt.feedbackPreparationFailure = typeof code === 'string' && FEEDBACK_PREPARATION_FAILURE.test(code) ? code : 'unknown';
        persistClaimReceipt(dirs, receipt);
        return receipt.verdict;
    }
    if (receipt.feedbackPreparationPending) {
        receipt.feedbackPreparationPending = false;
        delete receipt.feedbackPreparationFailure;
        persistClaimReceipt(dirs, receipt);
    }
    if (receipt.postCommit === 'dispatching')
        return receipt.verdict;
    if (receipt.postCommit === 'pending') {
        if (!options.afterCommit)
            return receipt.verdict;
        receipt.postCommit = 'dispatching';
        persistClaimReceipt(dirs, receipt);
        try {
            options.afterCommit(task, receipt.verdict);
        }
        catch {
            return receipt.verdict; /* unknown optional dispatch remains inspectable and is never replayed */
        }
    }
    cleanupCommittedClaimReceipt(dirs, claim.name);
    return receipt.verdict;
}
function recoverArchivedClaim(dirs, claim, options) {
    const receipt = persistedClaimReceipt(dirs, claim);
    if (!receipt?.archiveName)
        throw new Error('archived claim receipt unavailable');
    const dest = receipt.destination === 'refused' ? dirs.refused : dirs.done;
    const path = join(dest, receipt.archiveName);
    if (!lstatSync(path).isFile())
        throw new Error('archived claim task is not a regular file');
    const task = exec.normalizeAutoExecTask(JSON.parse(readFileSync(path, 'utf8')));
    const noNewVerdict = receipt.feedbackPreparationPending === false || receipt.feedbackPreparationFailure !== undefined
        || (receipt.feedbackPreparationPending && !options.prepareFeedback) || receipt.postCommit === 'dispatching'
        || (receipt.postCommit === 'pending' && !options.afterCommit);
    const verdict = finishCommittedClaim(dirs, claim, task, receipt, options, true, true);
    return noNewVerdict ? undefined : verdict;
}
function recoverAmbiguousClaim(dirs, claim, options) {
    const taskPath = join(dirs.inflight, claim.name);
    let taskId = `recovery-${claim.name.slice(0, 64)}`;
    let task;
    try {
        task = exec.normalizeAutoExecTask(JSON.parse(readFileSync(taskPath, 'utf8')));
        taskId = task.id;
    }
    catch {
        // The task may have been only partially published before the prior process stopped.
    }
    const receipt = persistedClaimReceipt(dirs, claim, taskId);
    if (receipt) {
        if (!task)
            throw new Error('feedback claim task unavailable during recovery');
        return finishCommittedClaim(dirs, claim, task, receipt, options, false, true);
    }
    const verdict = {
        taskId,
        status: 'refused',
        reason: AMBIGUOUS_RECOVERY_REASON,
    };
    writeFileSync(join(dirs.refused, `recovery-${claim.name}`), JSON.stringify(verdict, null, 2));
    renameSync(taskPath, archiveTaskPath(dirs.refused, claim.originalName, claim.name));
    cleanupCommittedClaimReceipt(dirs, claim.name);
    return verdict;
}
/**
 * One queue pass: atomically claim regular tasks/*.json into inflight/, then route each verdict to done/
 * (success or failure) or refused/ (deny-by-default). A claim is atomically marked started before runOne;
 * after a crash, started and legacy claims are ambiguous and fail closed instead of repeating side effects.
 * Unreadable or incomplete claimed tasks stay pending because the drop-directory has no atomic publish marker.
 */
export async function autoExecPass(dirs, runOne, options = {}) {
    const executePendingTasks = options.executePendingTasks ?? true;
    const existingClaims = readdirSync(dirs.inflight, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => parseAutoExecClaim(entry.name))
        .filter((claim) => claim !== null);
    const pendingClaims = existingClaims.filter((claim) => claim.phase === 'claimed');
    const out = [];
    const activeNames = new Set(existingClaims.map(claim => claim.name));
    const archivedClaims = readdirSync(receiptDir(dirs), { withFileTypes: true })
        .filter(entry => entry.isFile() && receiptArtifactClaimName(entry.name) === entry.name
        && !activeNames.has(entry.name) && hasRecoverableClaimReceipt(dirs, entry.name))
        .map(entry => parseAutoExecClaim(entry.name))
        .filter((claim) => claim !== null);
    for (const claim of [...archivedClaims, ...existingClaims.filter((item) => item.phase !== 'claimed')]) {
        try {
            const recovered = activeNames.has(claim.name)
                ? recoverAmbiguousClaim(dirs, claim, options) : recoverArchivedClaim(dirs, claim, options);
            if (recovered)
                out.push(recovered);
        }
        catch (error) {
            const errorCode = error.code;
            out.push({
                taskId: `recovery-${claim.name.slice(0, claim.name.indexOf('--'))}`,
                status: 'failed',
                reason: `autoexec_crash_recovery_failed:${errorCode && /^[A-Z0-9_]+$/.test(errorCode) ? errorCode : 'unknown'}`,
            });
        }
    }
    cleanupOrphanReceiptArtifacts(dirs);
    if (!executePendingTasks)
        return out;
    const files = readdirSync(dirs.tasks, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    for (const f of files) {
        const claimName = taskClaimName(f);
        try {
            renameSync(join(dirs.tasks, f), join(dirs.inflight, claimName));
            const claim = parseAutoExecClaim(claimName);
            if (claim)
                pendingClaims.push(claim);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    for (const claim of pendingClaims) {
        const taskPath = join(dirs.inflight, claim.name);
        let task;
        try {
            task = exec.normalizeAutoExecTask(JSON.parse(readFileSync(taskPath, 'utf8')));
        }
        catch {
            // A producer may still hold this path open and finish writing it after this pass.
            // Leaving it in place prevents a transient partial read from acknowledging and losing the task.
            continue;
        }
        const startedName = claim.name.slice(0, -CLAIMED_TASK_SUFFIX.length) + STARTED_TASK_SUFFIX;
        const startedPath = join(dirs.inflight, startedName);
        renameSync(taskPath, startedPath);
        const returned = await runOne(task).catch((e) => ({ taskId: task.id, status: 'failed',
            ...(task.generation !== undefined ? { generation: task.generation } : {}),
            reason: e instanceof Error ? e.message : String(e) }));
        // The queue owns the invoked filing. Older/early kernel verdicts may omit
        // this optional field; an explicitly different filing must still fail closed.
        const v = returned.generation === undefined && task.generation !== undefined
            ? { ...returned, generation: task.generation } : returned;
        const destination = v.status === 'refused' || v.status === 'unsafe_to_replay' ? 'refused' : 'done';
        const dest = destination === 'refused' ? dirs.refused : dirs.done;
        let executionDestinationId;
        try {
            executionDestinationId = options.captureFeedbackDestination?.(task);
            if (executionDestinationId !== undefined && executionDestinationId !== null
                && !/^sha256:[a-f0-9]{64}$/.test(executionDestinationId))
                throw new Error('execution feedback destination invalid');
        }
        catch {
            // Optional destination evidence may fail, but the completed verdict must still converge.
            // Null keeps recovered feedback unbound instead of adopting a later Hub identity.
            executionDestinationId = null;
        }
        const receipt = {
            claimName: startedName, destination, verdict: v,
            archiveName: basename(archiveTaskPath(dest, claim.originalName, startedName)),
            ...(executionDestinationId !== undefined ? { executionDestinationId } : {}),
            taskOutcomeEnabled: options.taskOutcomeEnabled === true,
            ...(options.prepareFeedback ? { feedbackPreparationPending: true } : {}),
            ...(options.afterCommit ? { postCommit: 'pending' } : {}),
        };
        persistClaimReceipt(dirs, receipt);
        out.push(finishCommittedClaim(dirs, { ...claim, name: startedName, phase: 'started' }, task, receipt, options, false, false));
    }
    cleanupOrphanReceiptArtifacts(dirs);
    return out;
}
/**
 * Which repo Hub tasks land in. A Hub task does not say which one it belongs to, so a
 * multi-repo allowlist cannot be spread across — one receiver serves one repo. Silently
 * taking the first is a guess the operator never made, so EVOLVER_TASK_RECEIVER_REPO lets
 * them say; it must still be allowlisted, or the receiver has no repo and stays off.
 */
export function taskReceiverRepo(env, allowedRoots) {
    const chosen = env['EVOLVER_TASK_RECEIVER_REPO']?.trim();
    if (!chosen)
        return allowedRoots[0];
    return allowedRoots.includes(chosen) ? chosen : undefined;
}
/** Runners cleared to take work off the queue, rather than only keeping the daemon alive. */
export function canExecuteQueue(runner) {
    return runner === 'gemini' || runner === 'llm';
}
/** Keep unsupported built-in runners away from the execution queue without stopping the resident daemon. */
export function runnerBoundAutoExecPass(runner, dirs, runOne, options = {}) {
    return () => autoExecPass(dirs, runOne, { executePendingTasks: canExecuteQueue(runner), ...options });
}
const ATP_CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
function atpCapabilityGaps(signals) {
    return signalNs.capabilityGapsFromSignals(signals)
        .filter((capability) => ATP_CAPABILITY_PATTERN.test(capability))
        .slice(0, 8);
}
function hasAtpCapabilityGap(signals) {
    return signals.includes('capability_gap') || atpCapabilityGaps(signals).length > 0;
}
function normalizedCapabilityGapSignals(signals) {
    if (!hasAtpCapabilityGap(signals))
        return signals;
    const ordinary = signals.filter((signal) => signal !== 'capability_gap'
        && !signal.startsWith('capability_gap:')
        && !signal.startsWith('cap:'));
    return [...new Set([...ordinary, ...atpCapabilityGapRequest(signals).signals])];
}
/** Build the deliberately small, public-safe ATP request allowed to leave autoexec after a verified Hub miss. */
export function atpCapabilityGapRequest(signals) {
    const capabilities = atpCapabilityGaps(signals);
    if (capabilities.length === 0)
        capabilities.push('code_evolution');
    const subject = capabilities[0].replace(/[_-]+/g, ' ');
    return {
        kind: 'capability_gap',
        capabilities,
        question: `I need help with ${subject}. Please provide one concrete, actionable solution and state any assumptions.`,
        routingMode: 'fastest',
        verifyMode: 'auto',
        signals: ['capability_gap', ...capabilities.map((capability) => `cap:${capability}`)],
    };
}
/** Schedule economic work outside the reuse/task critical path and contain all asynchronous failures. */
export function scheduleAtpAutoBuyForVerifiedMiss(miss, buyer) {
    void buyer.consider(atpCapabilityGapRequest(miss.signals)).catch(() => undefined);
}
/** Resolve an autonomous buyer only after an explicit env/ack consent check; the buyer checks consent again. */
export function resolveAtpAutoBuyer(env = process.env, createClient = createAtpClientFromEnv) {
    if (!getAtpConsent(env).enabled)
        return undefined;
    try {
        return new AtpAutoBuyer({ client: createClient(env), env });
    }
    catch {
        return undefined;
    }
}
export function makeHubReuseSeam(cap, cache, _ingestor, onAssetReused, onVerifiedSearchMiss, audit = {}) {
    return async (signals, ctx) => {
        const searchSignals = normalizedCapabilityGapSignals(signals);
        const r = await reuseBeforeSolve(cap, cache, searchSignals, {
            ...(ctx?.cycleId ? { cycleId: ctx.cycleId } : {}),
            ...(audit.env ? { env: audit.env } : {}),
            // A fetched candidate is only an acquisition, not an application or a successful reuse.
            // The caller may use this for neutral search telemetry. Terminal feedback is emitted only
            // after the selected asset actually executes and the task has a committed outcome.
            onReuseHit: (hit) => {
                try {
                    onAssetReused?.(hit.assetId);
                }
                catch { /* tracking must never break reuse */ }
            },
        });
        const runId = ctx?.cycleId ?? null;
        const taskId = ctx?.taskId ?? (runId?.startsWith('autoexec-') ? runId.slice('autoexec-'.length) : undefined);
        if (r.action === 'fetch') {
            const rawAsset = r.asset;
            const assetId = r.candidate?.assetId ?? stringField(rawAsset, 'asset_id');
            const assetType = stringField(rawAsset, 'type');
            const sourceNodeId = stringField(rawAsset, 'source_node_id');
            const chainId = stringField(rawAsset, 'chain_id');
            const indexedTokenCost = assetId ? assetTokenCostBestEffort(audit.assetLog, assetId) : undefined;
            const savings = hubNs.reuseSavingsForAsset(rawAsset, r.mode, indexedTokenCost);
            const hit = {
                runId,
                ...(assetId ? { assetId } : {}),
                ...(assetType ? { assetType } : {}),
                ...(sourceNodeId ? { sourceNodeId } : {}),
                ...(chainId ? { chainId } : {}),
                ...(r.score !== undefined ? { score: r.score } : {}),
                mode: r.mode,
                signals: [...searchSignals],
                tokensSaved: savings.tokens_saved,
                tokensSavedBasis: savings.tokens_saved_basis,
            };
            scheduleAssetCallBestEffort(audit.assetLog, {
                run_id: runId,
                action: 'hub_search_hit',
                ...(hit.assetId ? { asset_id: hit.assetId } : {}),
                ...(hit.assetType ? { asset_type: hit.assetType } : {}),
                ...(hit.sourceNodeId ? { source_node_id: hit.sourceNodeId } : {}),
                ...(hit.chainId ? { chain_id: hit.chainId } : {}),
                ...(hit.score !== undefined ? { score: hit.score } : {}),
                mode: hit.mode,
                signals: hit.signals,
                ...(taskId ? { extra: { task_id: taskId } } : {}),
            });
            try {
                audit.onSearchHit?.(hit);
            }
            catch { /* audit state must never change reuse */ }
        }
        else if (r.reason !== 'no_signals') {
            scheduleAssetCallBestEffort(audit.assetLog, {
                run_id: runId,
                action: 'hub_search_miss',
                mode: r.mode,
                signals: [...searchSignals],
                ...(r.reason ? { reason: r.reason } : {}),
                ...(taskId ? { extra: { task_id: taskId } } : {}),
            });
        }
        if (r.action === 'solve-fresh'
            && (r.reason === 'no_results' || r.reason === 'below_threshold')
            && hasAtpCapabilityGap(searchSignals)) {
            try {
                onVerifiedSearchMiss?.({
                    reason: r.reason,
                    signals: [...searchSignals],
                    ...(ctx?.cycleId ? { cycleId: ctx.cycleId } : {}),
                });
            }
            catch { /* an optional economic side effect must never change reuse behavior */ }
        }
        return r.action === 'fetch' && r.candidate ? [r.candidate] : [];
    };
}
/**
 * Free search-only seam used by ATP auto-buy when reuse injection is disabled. It proves a capability miss with
 * the same dual-leg search and score threshold as reuse, but never performs the paid fetch or contributes a Hub
 * candidate.
 */
export function makeHubSearchMissProbe(cap, cache, onVerifiedSearchMiss, enabled, env = process.env, assetLog) {
    return async (signals, ctx) => {
        if (!enabled() || !hasAtpCapabilityGap(signals))
            return [];
        // ATP consent authorizes a bounded capability query, not disclosure of local error signatures/transcripts.
        const signalList = atpCapabilityGapRequest(signals).signals;
        if (signalList.length === 0)
            return [];
        const search = await searchHubMetadata(cap, cache, signalList, { env });
        if (!search.complete) {
            scheduleAssetCallBestEffort(assetLog, {
                run_id: ctx?.cycleId ?? null,
                action: 'hub_search_miss',
                mode: 'direct',
                signals: search.signals,
                reason: 'search_error',
            });
            return [];
        }
        const { metadata, searchCached } = search;
        let reason;
        if (metadata.length === 0) {
            reason = 'no_results';
        }
        else {
            const ranked = hubNs.scoreSearchResults(signalList, metadata);
            if (hubNs.decideReuse(ranked, { threshold: getMinReuseScore(env) }).action === 'solve-fresh') {
                reason = 'below_threshold';
            }
        }
        if (!reason)
            return [];
        scheduleAssetCallBestEffort(assetLog, {
            run_id: ctx?.cycleId ?? null,
            action: 'hub_search_miss',
            mode: 'direct',
            signals: signalList,
            reason,
            extra: { search_cached: searchCached },
        });
        try {
            onVerifiedSearchMiss({
                reason,
                signals: signalList,
                ...(ctx?.cycleId ? { cycleId: ctx.cycleId } : {}),
            });
        }
        catch { /* ATP scheduling must never change the solve path */ }
        return [];
    };
}
function stringField(record, key) {
    const value = record?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function assetTokenCostBestEffort(log, assetId) {
    try {
        return log?.assetCostIndex?.()[assetId];
    }
    catch {
        return undefined;
    }
}
function appendAssetCallBestEffort(log, entry) {
    try {
        log?.append(entry);
    }
    catch { /* local audit failure must never break reuse or task completion */ }
}
function scheduleAssetCallBestEffort(log, entry) {
    if (!log)
        return;
    setImmediate(() => { appendAssetCallBestEffort(log, entry); });
}
/** Project only a committed, exact selected/executed use, never a fetched candidate. */
export function committedFeedbackEvent(row) {
    const use = row.appliedUse;
    const payload = {
        assetId: use.assetId, geneId: use.geneId, cycleId: use.cycleId,
        source: use.source, sourceEventId: row.sourceEventId,
        applicationBinding: use.applicationBinding, verification: use.verification,
        producedValue: use.producedValue,
        ...(use.capsuleId ? { capsuleId: use.capsuleId } : {}),
        ...(use.eventId ? { eventId: use.eventId } : {}),
        ...(use.terminalDisposition ? { terminalDisposition: use.terminalDisposition } : {}),
    };
    if (use.outcome === 'success') {
        payload['fetchTokens'] = 0;
        payload['signalFingerprint'] = `sha256:${createHash('sha256').update(JSON.stringify(row.signals)).digest('hex')}`;
        return {
            type: ops.VALUE_REUSE_HIT_EVENT,
            human: { title: 'applied reuse success', detail: `cycle ${use.cycleId}` },
            payload,
        };
    }
    payload['outcome'] = use.outcome;
    return {
        type: ops.VALUE_REUSE_OUTCOME_EVENT,
        human: { title: `applied reuse ${use.outcome}`, detail: `cycle ${use.cycleId}` },
        payload,
    };
}
/** Local projection is owed before network delivery; ambiguous sends are never replayed automatically. */
export async function flushAutoExecFeedback(outbox, ingestor, sender, destinationId) {
    let projected = 0;
    let delivered = 0;
    let ambiguous = 0;
    const localPending = outbox.localPending();
    if (localPending.length > 0) {
        // A crash may occur after Ingestor durably appends the event but before the
        // outbox acknowledgement. Recover by its stable source id, not by emitting a
        // second RootEvent and hoping every future consumer deduplicates it.
        const existing = new Map();
        for (const event of ingestor.readAll()) {
            const payload = event.payload;
            const sourceId = payload['sourceEventId'];
            if (typeof sourceId === 'string' && sourceId.startsWith('autoexec-applied-use:')) {
                const previous = existing.get(sourceId);
                if (previous && (previous.type !== event.type
                    || !isDeepStrictEqual(previous.payload, payload))) {
                    throw new Error('conflicting applied-use source event');
                }
                existing.set(sourceId, { type: event.type, payload });
            }
        }
        for (const row of localPending) {
            const expected = committedFeedbackEvent(row);
            const prior = existing.get(row.sourceEventId);
            if (prior) {
                const payload = expected.payload;
                if (prior.type !== expected.type || !isDeepStrictEqual(prior.payload, payload)) {
                    throw new Error('conflicting applied-use projection');
                }
            }
            else {
                await ingestor.ingest(expected);
                existing.set(row.sourceEventId, { type: expected.type, payload: expected.payload });
                projected++;
            }
            outbox.acknowledgeLocal(row.operationId);
        }
    }
    if (sender && destinationId) {
        for (const row of outbox.pending()) {
            // A changed Hub endpoint or principal must never inherit another Hub's debt.
            if (row.destinationId !== destinationId)
                continue;
            const result = await outbox.deliver(row.operationId, destinationId, sender);
            if (result.networkStatus === 'acknowledged')
                delivered++;
            if (result.networkStatus === 'ambiguous')
                ambiguous++;
        }
    }
    return { projected, delivered, ambiguous };
}
/** A slow durable outbox drain must neither block Hub-task completion nor overlap the next beat. */
export function makeDeferredAutoExecFeedbackDrain(drain, onFailure) {
    const single = exec.singleFlight(drain);
    return () => {
        try {
            void single().catch(onFailure);
        }
        catch {
            onFailure();
        }
    };
}
/** Build the same event for byte-budget admission and durable emission. */
export function injectEvent(info) {
    const payload = {
        geneIds: info.sourceQualifications ? info.sourceQualifications.map((item) => item.assetId) : info.geneIds,
        ...(info.sourceQualifications ? assetstore.compactQualificationReceipts(info.sourceQualifications) : {}),
        ...(info.contentSchema ? { contentSchema: info.contentSchema } : {}),
        ...(info.content ? { content: info.content } : {}),
        ...(info.omittedByBudget !== undefined ? { omittedByBudget: info.omittedByBudget } : {}),
        ...(info.cycleId ? { cycleId: info.cycleId } : {}),
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        ...(info.outcome ? { outcome: info.outcome } : {}),
    };
    return {
        type: ops.VALUE_INJECT_EVENT,
        human: { title: `injected ${info.geneIds.length} gene(s)`, ...(info.cycleId ? { detail: `cycle ${info.cycleId}` } : {}) },
        payload: payload,
    };
}
export async function emitInject(ingestor, info) {
    try {
        if (info.geneIds.length === 0)
            return;
        await ingestor.ingest(injectEvent(info));
    }
    catch { /* emission must never break the injection path */ }
}
/**
 * Build the SessionStart inject emission seam (#123) — the public-repo composition point that connects core's
 * sink-agnostic `onInject` callback to the real `value.inject` root_event sink. Core (composeSessionStartWithRecap)
 * never imports the Ingestor; THIS is where the ingestor is wired in, mirroring makeHubReuseSeam for reuse. The
 * returned callback is synchronous (the seam core calls is sync) and fire-and-forget: it stashes the
 * error-swallowing emit promise so the caller can await durability without ever letting an ingest error surface.
 * Returns undefined when there is no ingestor (no sink → no emission, exactly today's behavior).
 */
export function makeInjectEmitter(ingestor) {
    if (!ingestor)
        return undefined;
    const pending = [];
    return {
        onInject: (info) => { pending.push(emitInject(ingestor, info)); },
        flush: async () => { if (pending.length > 0)
            await Promise.all(pending); }, // emitInject never rejects
    };
}
/** Both public HTTP and private proxy must explicitly acknowledge the exact asset use. */
function exactBoundFeedbackReport(row) {
    const use = row.appliedUse;
    const report = row.report;
    return !!report && use.schemaVersion === 'applied-use.v1'
        && use.applicationBinding === 'selected_execution'
        && use.verification === 'unverified'
        && (use.outcome === 'success' || use.outcome === 'failed')
        && (use.outcome !== 'success' || use.producedValue === true)
        && use.source === 'hub'
        && /^sha256:[a-f0-9]{64}$/.test(row.destinationId ?? '')
        && use.hubOriginDestinationId === row.destinationId
        && report.assetId === use.assetId
        && report.outcome === use.outcome
        && report.taskId === row.taskId
        && report.traceId === use.cycleId;
}
export function makeAppliedUseFeedbackSender(cap, expectedDestinationId, reportEnabled = true) {
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDestinationId)) {
        throw new Error('bound Hub feedback destination required');
    }
    return async (row) => {
        if (!row.report)
            return { status: 'terminal', reason: 'no_reportable_applied_use' };
        // The public sender can also be called directly by an embedder. Never let a
        // forged or stale row escape merely because it carries a report object.
        if (!exactBoundFeedbackReport(row)) {
            return { status: 'terminal', reason: 'hub_origin_destination_mismatch' };
        }
        if (row.destinationId !== expectedDestinationId) {
            throw new FeedbackNotDispatchedError('hub_feedback_destination_changed');
        }
        if (!reportEnabled)
            throw new FeedbackNotDispatchedError('outcome_reporting_disabled');
        if (!cap.recordReuseResult)
            return { status: 'terminal', reason: 'reuse_result_not_supported' };
        try {
            return reuseReceiptSendResult(await cap.recordReuseResult(row.report));
        }
        catch (error) {
            if (error instanceof OAuthCredentialBindingError || error instanceof OAuthAuthenticationPreflightError) {
                throw new FeedbackNotDispatchedError(error instanceof OAuthCredentialBindingError
                    ? 'oauth_credential_binding_changed' : 'oauth_authentication_preflight_failed');
            }
            return { status: 'ambiguous', reason: 'reuse_result_transport_unknown' };
        }
    };
}
const DEFAULT_QUESTION_SUBMIT_TIMEOUT_MS = 3_000;
const QUESTION_SUBMIT_TIMEOUT_ENV = 'EVOLVER_QUESTION_SUBMIT_TIMEOUT_MS';
const SOLIDIFY_VERIFY_ENV = 'EVOLVER_SOLIDIFY_VERIFY';
const QUESTION_CONTEXT_SENSITIVE_RE = /secret|token|api[_-]?key|password|passwd|credential|bearer|authorization|cookie|session[_-]?id|private[_-]?key|oauth|refresh[_-]?token/i;
const DISTILL_TICK_EXPLORATION_CONTEXT = 'runtime session material ingestion';
const DISTILL_TICK_EXPLORATION_SIGNALS = ['stable_success_plateau', 'runtime_session_material'];
/**
 * Map an autoexec verdict onto the hub outcome vocabulary (success | failed).
 * refused/skipped ran no cycle — there is nothing to attribute, so no report.
 */
export function verdictToOutcomeStatus(status) {
    if (status === 'solidified')
        return 'success';
    if (status === 'failed')
        return 'failed';
    return null;
}
export function questionGeneratorStatePath(home = events.evomapHome()) {
    return join(home, 'evolution', 'question_generator_state.json');
}
function readQuestionState(path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return {
            lastAskedAt: typeof raw.lastAskedAt === 'string' ? raw.lastAskedAt : null,
            lastUrgentAt: typeof raw.lastUrgentAt === 'string' ? raw.lastUrgentAt : null,
            lastExploreAt: typeof raw.lastExploreAt === 'string' ? raw.lastExploreAt : null,
            recentQuestions: Array.isArray(raw.recentQuestions) ? raw.recentQuestions.map(String).slice(-30) : [],
        };
    }
    catch {
        return { lastAskedAt: null, lastUrgentAt: null, lastExploreAt: null, recentQuestions: [] };
    }
}
function writeQuestionState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
        lastAskedAt: state.lastAskedAt ?? null,
        lastUrgentAt: state.lastUrgentAt ?? null,
        lastExploreAt: state.lastExploreAt ?? null,
        recentQuestions: [...(state.recentQuestions ?? [])].slice(-30),
    }, null, 2)}\n`);
}
function laterQuestionTimestamp(left, right) {
    if (!left)
        return right ?? null;
    if (!right)
        return left;
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs))
        return rightMs >= leftMs ? right : left;
    if (Number.isFinite(leftMs))
        return left;
    if (Number.isFinite(rightMs))
        return right;
    return right >= left ? right : left;
}
function mergeQuestionStates(current, incoming) {
    const recency = (state) => Math.max(...[state.lastAskedAt, state.lastUrgentAt, state.lastExploreAt]
        .map((value) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY)
        .filter(Number.isFinite), Number.NEGATIVE_INFINITY);
    const [older, newer] = recency(current) <= recency(incoming)
        ? [current, incoming]
        : [incoming, current];
    const recentQuestions = [];
    for (const question of [...(older.recentQuestions ?? []), ...(newer.recentQuestions ?? [])]) {
        const existing = recentQuestions.indexOf(question);
        if (existing >= 0)
            recentQuestions.splice(existing, 1);
        recentQuestions.push(question);
    }
    return {
        lastAskedAt: laterQuestionTimestamp(current.lastAskedAt, incoming.lastAskedAt),
        lastUrgentAt: laterQuestionTimestamp(current.lastUrgentAt, incoming.lastUrgentAt),
        lastExploreAt: laterQuestionTimestamp(current.lastExploreAt, incoming.lastExploreAt),
        recentQuestions: recentQuestions.slice(-30),
    };
}
const MAX_PENDING_QUESTION_STATES = 30;
function rememberPendingQuestionState(pendingStates, state) {
    pendingStates.add(state);
    while (pendingStates.size > MAX_PENDING_QUESTION_STATES) {
        const oldest = pendingStates.values().next().value;
        if (!oldest)
            break;
        pendingStates.delete(oldest);
    }
}
function questionSubmitTimeoutMs(options) {
    const raw = options.timeoutMs ?? Number(options.env?.[QUESTION_SUBMIT_TIMEOUT_ENV]);
    if (Number.isFinite(raw) && raw > 0)
        return Math.round(raw);
    return DEFAULT_QUESTION_SUBMIT_TIMEOUT_MS;
}
function observeQuestionSubmit(submitPromise) {
    return submitPromise
        .then((receipts) => ({ status: 'submitted', receipts }))
        .catch(() => ({ status: 'failed', receipts: [] }));
}
function hasAcceptedQuestionReceipt(receipts) {
    if (receipts.length === 0)
        return true;
    return receipts.some((r) => !r.error);
}
function writeQuestionStateIfAccepted(path, state, receipts) {
    if (!hasAcceptedQuestionReceipt(receipts))
        return false;
    writeQuestionState(path, mergeQuestionStates(readQuestionState(path), state));
    return true;
}
function writeLateQuestionStateIfAccepted(submitResult, statePath, state, onSettled) {
    void submitResult
        .then((submitted) => {
        if (submitted.status !== 'submitted')
            return;
        try {
            writeQuestionStateIfAccepted(statePath, state, submitted.receipts);
        }
        catch {
            // The caller already received a timeout; late cooldown persistence is best-effort.
        }
    })
        .finally(onSettled);
}
async function submitQuestionsWithTimeout(submitResult, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            submitResult,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ status: 'timeout', receipts: [] }), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function submitProactiveQuestions(cap, task, options, pendingStates) {
    if (options.enabled === false || !cap.questions)
        return { status: 'disabled', questionCount: 0 };
    try {
        const statePath = options.statePath ?? questionGeneratorStatePath();
        const context = task.publicQuestionContext?.trim();
        if (!context)
            return { status: 'skipped', questionCount: 0 };
        if (QUESTION_CONTEXT_SENSITIVE_RE.test(context))
            return { status: 'skipped', questionCount: 0 };
        const effectiveState = [...pendingStates].reduce((state, pending) => mergeQuestionStates(state, pending), readQuestionState(statePath));
        const result = hubNs.generateQuestions({
            signals: task.signals,
            sessionTranscript: context,
            state: effectiveState,
            now: options.now?.() ?? Date.now(),
            env: options.env ?? process.env,
        });
        if (!result.changed || result.questions.length === 0)
            return { status: 'skipped', questionCount: 0 };
        const submitResult = observeQuestionSubmit(cap.questions.submit(result.questions));
        const submitted = await submitQuestionsWithTimeout(submitResult, questionSubmitTimeoutMs(options));
        if (submitted.status === 'timeout') {
            rememberPendingQuestionState(pendingStates, result.state);
            writeLateQuestionStateIfAccepted(submitResult, statePath, result.state, () => pendingStates.delete(result.state));
        }
        if (submitted.status !== 'submitted')
            return { status: submitted.status, questionCount: result.questions.length };
        if (!writeQuestionStateIfAccepted(statePath, result.state, submitted.receipts))
            return { status: 'not_accepted', questionCount: result.questions.length };
        return { status: 'submitted', questionCount: result.questions.length };
    }
    catch {
        // Proactive questions are optional ecosystem hints; hub failures must not affect task completion.
        return { status: 'failed', questionCount: 0 };
    }
}
export function makeHubQuestionLink(cap, options = {}) {
    let queue = Promise.resolve();
    const pendingStates = new Set();
    return {
        submitForTask: (task) => {
            const run = queue.then(() => submitProactiveQuestions(cap, task, options, pendingStates));
            queue = run.then(() => undefined, () => undefined);
            return run;
        },
    };
}
export function shouldSubmitProactiveQuestionsForTask(task) {
    return typeof task.publicQuestionContext === 'string' && task.publicQuestionContext.trim().length > 0;
}
export function autoexecLockFailureMessage(error) {
    if (error instanceof util.UnsafeLockPathError) {
        return `evolver autoexec: unsafe single-instance lock (${error.reason}) - inspect the Evolver state directory before retrying\n`;
    }
    if (error instanceof util.LockTimeoutError) {
        return 'evolver autoexec: another daemon holds the single-instance lock - refusing to start a second instance\n';
    }
    return 'evolver autoexec: failed to acquire the single-instance lock - refusing to start\n';
}
export function autoexecLockReleaseFailureMessage(error) {
    const reason = error instanceof util.UnsafeLockPathError
        ? error.reason
        : typeof error === 'object' && error !== null && typeof error.reason === 'string'
            ? error.reason
            : null;
    if (reason) {
        return `evolver autoexec: could not safely release the single-instance lock (${reason}); inspect the Evolver state directory if the next start is blocked\n`;
    }
    return 'evolver autoexec: could not release the single-instance lock; inspect the Evolver state directory if the next start is blocked\n';
}
export function releaseAutoexecLock(lockPath, deps = {}) {
    try {
        const result = (deps.releaseLock ?? util.releaseLock)(lockPath);
        if (result && !result.released) {
            (deps.stderr ?? ((text) => { process.stderr.write(text); }))(autoexecLockReleaseFailureMessage(result));
            return false;
        }
        return true;
    }
    catch (error) {
        (deps.stderr ?? ((text) => { process.stderr.write(text); }))(autoexecLockReleaseFailureMessage(error));
        return false;
    }
}
/** Keep a detached daemon alive when its output consumer closes, without hiding other stream failures. */
export function installAutoexecBrokenPipeGuards(deps = {}) {
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const onError = (error) => {
        if (error?.code === 'EPIPE')
            return;
        throw error;
    };
    stdout.on('error', onError);
    stderr.on('error', onError);
    let installed = true;
    return () => {
        if (!installed)
            return;
        installed = false;
        removeAutoexecStreamErrorListener(stdout, onError);
        removeAutoexecStreamErrorListener(stderr, onError);
    };
}
function removeAutoexecStreamErrorListener(stream, listener) {
    if (stream.off) {
        stream.off('error', listener);
        return;
    }
    stream.removeListener?.('error', listener);
}
/**
 * Own autoexec's process-signal lifetime. V2 intentionally has no hot-reload seam: SIGHUP is informational and
 * keeps the current generation alive; SIGINT/SIGTERM drain the resident loop before cleanup and exit.
 */
export function waitForAutoexecShutdown(deps) {
    const signals = deps.signals ?? process;
    const write = deps.write ?? ((message) => { process.stdout.write(message); });
    return new Promise((resolve, reject) => {
        let stopping = false;
        let listenersInstalled = true;
        const removeListeners = () => {
            if (!listenersInstalled)
                return;
            listenersInstalled = false;
            for (const [signal, listener] of listeners)
                removeAutoexecSignalListener(signals, signal, listener);
        };
        const finish = (failure) => {
            removeListeners();
            try {
                deps.cleanup();
            }
            catch (cleanupError) {
                reject(cleanupError);
                return;
            }
            if (failure)
                reject(failure.error);
            else
                resolve(0);
        };
        const shutdown = (signal) => {
            if (stopping)
                return;
            stopping = true;
            write(`\nevolver autoexec: ${signal} -> graceful stop (finishing in-flight, releasing lock)\n`);
            void Promise.resolve()
                .then(() => deps.stop())
                .then(() => { finish(); }, (error) => { finish({ error }); });
        };
        const onSighup = () => {
            if (stopping)
                return;
            write('\nevolver autoexec: SIGHUP received; hot reload is not supported, continuing with current configuration (restart the daemon to apply changes)\n');
        };
        const listeners = [
            ['SIGINT', () => { shutdown('SIGINT'); }],
            ['SIGTERM', () => { shutdown('SIGTERM'); }],
            ['SIGHUP', onSighup],
        ];
        for (const [signal, listener] of listeners)
            signals.on(signal, listener);
    });
}
function removeAutoexecSignalListener(source, signal, listener) {
    if (source.off) {
        source.off(signal, listener);
        return;
    }
    source.removeListener?.(signal, listener);
}
export function urgentQuestionRuntimeWiringStatus() {
    return hubNs.URGENT_QUESTION_RUNTIME_WIRING_STATUS;
}
function safeDistillContextToken(value) {
    const token = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!/^[a-z][a-z0-9_-]{3,40}$/.test(token))
        return null;
    if (QUESTION_CONTEXT_SENSITIVE_RE.test(token))
        return null;
    return token;
}
function safeDistillSignalToken(prefix, value) {
    const token = safeDistillContextToken(value)?.replace(/-/g, '_');
    if (!token)
        return null;
    return `${prefix}_${token}`.slice(0, 40);
}
function distillTickPublicQuestionContext(source) {
    const safeRecorded = Math.max(1, Math.floor(source.recorded));
    const anchors = [
        ...(source.sourceAgents ?? []).map((agent) => safeDistillContextToken(agent)),
        ...(source.signalKinds ?? []).map((kind) => safeDistillContextToken(kind)),
        ...(source.signalStrengths ?? []).map((strength) => safeDistillContextToken(strength)),
    ].filter((token) => Boolean(token)).slice(0, 6);
    const anchorText = anchors.length > 0 ? anchors.join(' ') : 'healthy runtime session material';
    return `${DISTILL_TICK_EXPLORATION_CONTEXT} recorded ${safeRecorded} material items ${anchorText} ${anchorText}`;
}
function distillTickPublicSignals(source) {
    const metadataSignals = [
        ...(source.sourceAgents ?? []).map((agent) => safeDistillSignalToken('agent', agent)),
        ...(source.signalKinds ?? []).map((kind) => safeDistillSignalToken('signal', kind)),
        ...(source.signalStrengths ?? []).map((strength) => safeDistillSignalToken('strength', strength)),
    ].filter((token) => Boolean(token));
    return [...DISTILL_TICK_EXPLORATION_SIGNALS, ...metadataSignals].slice(0, 8);
}
export async function submitDistillTickExplorationQuestion(questions, source) {
    if (!questions)
        return { status: 'disabled', questionCount: 0 };
    if (!source || !('recorded' in source))
        return { status: 'skipped', questionCount: 0 };
    const recorded = Math.floor(source.recorded);
    if (!Number.isFinite(recorded) || recorded <= 0)
        return { status: 'skipped', questionCount: 0 };
    return await questions.submitForTask({
        id: `autoexec-session-material-ingest-${recorded}`,
        repo: 'autoexec-runtime',
        target: 'runtime session material ingestion',
        expectedEffect: 'runtime session material ingestion',
        publicQuestionContext: distillTickPublicQuestionContext(source),
        signals: distillTickPublicSignals(source),
    });
}
export function scheduleAutoExecHubSideEffects(task, verdict, links) {
    if (links.questions && verdict.producedValue === true
        && verdictToOutcomeStatus(verdict.status) !== null && shouldSubmitProactiveQuestionsForTask(task)) {
        void links.questions.submitForTask(task).catch(() => undefined);
    }
    if (links.outcome)
        void links.outcome.reportOutcome(task, verdict).catch(() => undefined);
}
/**
 * Compose the reuse seam and the outcome reporters. A fetched candidate is neutral.
 * Exact applied-use delivery is owned by sendAppliedUse and the durable outbox;
 * the legacy task-wide outcome path cannot send a duplicate reuse-result claim.
 */
export function makeHubLink(cap, ingestor, reportEnabled = true, onVerifiedSearchMiss, assetLog, env, appliedUseSender, reportingCap = cap, reportingDestinationId) {
    const maxPendingAuditRuns = 256;
    const searchHitsByRun = new Map();
    const seam = makeHubReuseSeam(cap, new ReuseCache(), ingestor, undefined, onVerifiedSearchMiss, {
        assetLog,
        ...(env ? { env } : {}),
        onSearchHit: (hit) => {
            if (!hit.runId || !hit.assetId)
                return;
            if (!searchHitsByRun.has(hit.runId) && searchHitsByRun.size >= maxPendingAuditRuns) {
                const oldestRun = searchHitsByRun.keys().next().value;
                if (oldestRun !== undefined)
                    searchHitsByRun.delete(oldestRun);
            }
            // One reuse-before-solve invocation can fetch at most one winner. Replace any stale state left by an
            // unexpectedly aborted earlier run that reused the same task id.
            searchHitsByRun.set(hit.runId, new Map([[hit.assetId, {
                        ...hit, signals: [...hit.signals], audited: false,
                    }]]));
        },
    });
    const sendExactUse = appliedUseSender ?? (reportingDestinationId
        ? makeAppliedUseFeedbackSender(reportingCap, reportingDestinationId, reportEnabled) : undefined);
    return {
        seam,
        ...(reportingDestinationId ? { feedbackDestinationId: reportingDestinationId } : {}),
        ...(reportEnabled ? { sendTaskOutcome: async (report) => {
                let receipt;
                try {
                    receipt = await reportingCap.recordOutcome(report);
                }
                catch (error) {
                    if (error instanceof OAuthCredentialBindingError || error instanceof OAuthAuthenticationPreflightError) {
                        throw new FeedbackNotDispatchedError(error instanceof OAuthCredentialBindingError
                            ? 'oauth_credential_binding_changed' : 'oauth_authentication_preflight_failed');
                    }
                    throw error;
                }
                // The public adapter intentionally converts HTTP/transport failures into
                // recorded:false. Those may have reached the paid endpoint; only a known
                // local preflight refusal is terminal. Throw to leave other sends ambiguous.
                if (receipt.recorded === false
                    && receipt.reason !== 'no_signals'
                    && receipt.reason !== 'reference_not_execution_evidence'
                    && receipt.reason !== 'proxy_outcome_not_configured') {
                    throw new Error('outcome_receipt_unconfirmed');
                }
                return receipt;
            } } : {}),
        ...(reportEnabled && sendExactUse ? { sendAppliedUse: async (row) => {
                if (row.report && !exactBoundFeedbackReport(row)) {
                    return { status: 'terminal', reason: 'hub_origin_destination_mismatch' };
                }
                if (reportingDestinationId && row.destinationId !== reportingDestinationId) {
                    throw new FeedbackNotDispatchedError('hub_feedback_destination_changed');
                }
                // The row exists only after a durable queue verdict; a search hit alone is not use.
                const hit = searchHitsByRun.get(row.appliedUse.cycleId)?.get(row.appliedUse.assetId);
                if (row.report && hit && !hit.audited) {
                    hit.audited = true;
                    appendAssetCallBestEffort(assetLog, {
                        run_id: row.appliedUse.cycleId,
                        action: hit.mode === 'reference' ? 'asset_reference' : 'asset_reuse',
                        asset_id: row.appliedUse.assetId,
                        ...(hit.assetType ? { asset_type: hit.assetType } : {}),
                        ...(hit.sourceNodeId ? { source_node_id: hit.sourceNodeId } : {}),
                        ...(hit.chainId ? { chain_id: hit.chainId } : {}),
                        ...(hit.score !== undefined ? { score: hit.score } : {}),
                        mode: hit.mode,
                        tokens_saved: hit.tokensSaved, tokens_saved_basis: hit.tokensSavedBasis,
                        signals: hit.signals,
                        extra: { task_id: row.taskId, outcome_status: row.report.outcome },
                    });
                }
                return sendExactUse(row);
            } } : {}),
        reportOutcome: async (task, verdict) => {
            const disposition = verdict.execution_terminal?.disposition;
            const status = verdict.agentInvoked !== true
                || (verdict.status === 'failed' && verdict.outcome?.status !== 'failed')
                || verdict.failureKind === 'cancelled' || verdict.failureKind === 'timeout'
                || verdict.failureKind === 'spawn_failed' || verdict.failureKind === 'permission_denied'
                || disposition === 'cancelled' || disposition === 'timed_out' || disposition === 'denied'
                || disposition === 'unsafe_to_replay' || disposition === 'crashed'
                || (verdict.status === 'solidified' && verdict.producedValue !== true)
                || (verdict.status === 'solidified' && verdict.appliedUse?.outcome === 'failed')
                || (verdict.status === 'failed' && verdict.appliedUse?.outcome === 'success')
                || verdict.appliedUse?.outcome === 'inert'
                || verdict.appliedUse?.outcome === 'inconclusive'
                ? null : verdictToOutcomeStatus(verdict.status);
            const applied = verdict.appliedUse;
            const runId = applied?.cycleId ?? `autoexec-${task.id}`;
            const searchHits = searchHitsByRun.get(runId);
            const usedAssetIds = status !== null && applied?.source === 'hub'
                && !!reportingDestinationId
                && applied.hubOriginDestinationId === reportingDestinationId
                && applied.applicationBinding === 'selected_execution'
                && applied.verification === 'unverified'
                && (applied.outcome === 'success' || applied.outcome === 'failed')
                ? [applied.assetId] : [];
            // Both reporting paths share one audit claim. Capture and claim its owned
            // metadata before yielding; the bounded cache retains it for the other path.
            const audits = usedAssetIds.flatMap(assetId => {
                const hit = searchHits?.get(assetId);
                if (hit?.audited)
                    return [];
                if (hit)
                    hit.audited = true;
                return [{ assetId, hit }];
            });
            // Yield before the production sink's synchronous append and all Hub I/O.
            // The detached side effect cannot delay routing to done/.
            await new Promise((resolve) => { setImmediate(resolve); });
            if (status !== null) {
                for (const { assetId, hit } of audits) {
                    const mode = hit?.mode;
                    appendAssetCallBestEffort(assetLog, {
                        run_id: runId,
                        action: mode === 'reference' ? 'asset_reference' : 'asset_reuse',
                        asset_id: assetId,
                        ...(hit?.assetType ? { asset_type: hit.assetType } : {}),
                        ...(hit?.sourceNodeId ? { source_node_id: hit.sourceNodeId } : {}),
                        ...(hit?.chainId ? { chain_id: hit.chainId } : {}),
                        ...(hit?.score !== undefined ? { score: hit.score } : {}),
                        ...(mode ? { mode } : {}),
                        ...(hit ? { tokens_saved: hit.tokensSaved, tokens_saved_basis: hit.tokensSavedBasis } : {}),
                        signals: hit?.signals ?? task.signals,
                        ...(verdict.reason ? { reason: verdict.reason } : {}),
                        extra: { task_id: task.id, verdict_status: verdict.status, outcome_status: status },
                    });
                }
            }
            if (!reportEnabled || status === null)
                return;
            try {
                await reportingCap.recordOutcome({
                    signals: task.signals,
                    status,
                    ...(verdict.outcome?.score !== undefined ? { score: verdict.outcome.score } : {}),
                    ...(usedAssetIds.length > 0 ? { usedAssetIds } : {}),
                });
            }
            catch { /* recordOutcome never throws by contract; belt-and-braces — reporting must never break the pass */ }
        },
    };
}
function safeAssetCallReason(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}
function resolvePublicHub(env = process.env, connectHub = connectPublicHub, expectedOAuthTokenBinding) {
    if (hubMode(env) !== 'public')
        return undefined;
    const dir = resolveIdentityHome(env);
    if (!existsSync(join(dir, 'token.json')))
        return undefined;
    try {
        const hubUrl = resolveHubUrl(env);
        const resolvedSenderId = resolveAtpSenderId(env);
        if (!resolvedSenderId)
            return undefined;
        const { hub } = connectHub({
            hubUrl, authMode: 'oauth', evomapDir: dir, senderId: () => resolvedSenderId,
            ...(expectedOAuthTokenBinding ? { expectedOAuthTokenBinding } : {}),
        });
        return hub;
    }
    catch {
        return undefined;
    }
}
function hubMode(env) {
    const mode = String(env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase();
    return mode === 'public' || mode === 'private' ? mode : undefined;
}
/** Opaque nonsecret binding to the effective Hub principal and route, never a credential. */
function publicFeedbackDestinationId(env) {
    try {
        const sender = resolveAtpSenderId(env);
        if (!sender)
            return undefined;
        const binding = readPublicOAuthCredentialBinding(join(resolveIdentityHome(env), 'token.json'));
        return binding ? feedbackDestinationIdentity('public', resolveHubUrl(env), sender, binding) : undefined;
    }
    catch {
        // A missing, malformed, or unsafe credential path cannot establish a reporting principal.
        return undefined;
    }
}
/** The proxy attests the final identity it also checks on the feedback POST. */
export function privateFeedbackDestinationIdFromStatus(value) {
    const status = record(value);
    const nodeId = status['node_id'];
    const namespace = status['runtime_namespace'];
    const destination = status['feedback_destination_id'];
    // Older proxies expose a raw adapter fingerprint under the same field name.
    // Only the versioned final identity can be used for a durable outbox claim.
    if (status['hub_mode'] !== 'private' || status['feedback_destination_id_format'] !== 'proxy-bound.v1'
        || typeof nodeId !== 'string' || !nodeId.trim()
        || typeof namespace !== 'string' || !namespace.trim()
        || typeof destination !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(destination))
        return undefined;
    return destination;
}
/** A private proxy must attest its effective Hub destination, not merely its local node. */
export async function resolveFeedbackDestinationId(env) {
    const mode = hubMode(env);
    if (mode === 'public') {
        return publicFeedbackDestinationId(env);
    }
    if (mode !== 'private')
        return undefined;
    const proxy = proxyClientFromEnv(env);
    if (!proxy)
        return undefined;
    try {
        return privateFeedbackDestinationIdFromStatus(await proxy.status({ signal: AbortSignal.timeout(1_000) }));
    }
    catch {
        return undefined;
    }
}
export function makeAutoExecFeedbackBinding(candidate, mode, probe) {
    let boundDestinationId;
    let currentDestinationId;
    let refreshGeneration = 0;
    const bound = () => candidate && boundDestinationId ? { link: candidate, destinationId: boundDestinationId } : undefined;
    const current = () => candidate && currentDestinationId ? { link: candidate, destinationId: currentDestinationId } : undefined;
    return {
        bound,
        current,
        refresh: async () => {
            const generation = ++refreshGeneration;
            currentDestinationId = undefined;
            if (!candidate || !mode)
                return undefined;
            let destinationId;
            try {
                destinationId = await probe();
            }
            catch {
                return undefined;
            }
            if (generation !== refreshGeneration)
                return undefined;
            if (!destinationId || !/^sha256:[a-f0-9]{64}$/.test(destinationId)
                || (mode === 'public' && candidate.feedbackDestinationId !== destinationId)
                || (boundDestinationId && boundDestinationId !== destinationId))
                return undefined;
            boundDestinationId ??= destinationId;
            currentDestinationId = destinationId;
            return current();
        },
    };
}
/** One task may only create Hub debt if its execution and completion saw the same binding. */
export function confirmedTaskFeedbackDestination(started, completed) {
    return started && completed && started.link === completed.link
        && started.destinationId === completed.destinationId ? started.destinationId : undefined;
}
/** A recovered claim has no verified execution-time Hub binding; never adopt today's endpoint. */
export function committedTaskFeedbackDestination(taskDestination, current) {
    return taskDestination && current?.destinationId === taskDestination ? taskDestination : undefined;
}
/** A committed claim can finish recovering an existing row even while its Hub is unavailable. */
export function prepareCommittedTaskOutcomeFeedback(outbox, claimRoot, task, verdict, destinationId) {
    const existing = outbox.get(taskOutcomeIdentity(claimRoot).operationId);
    const ownerDestination = existing?.destinationId ?? destinationId;
    if (!ownerDestination)
        return;
    const row = outbox.prepare({ claimRoot, task, verdict, destinationId: ownerDestination });
    if (row)
        outbox.acknowledgeLocal(row.operationId);
}
/**
 * Resolve public/private reuse wiring. Reuse remains default-off. When a public ATP miss handler is supplied,
 * a consent-gated free search-only seam may still be composed so auto-buy can prove a miss independently of
 * reuse injection; that seam never fetches or injects Hub assets.
 */
export function resolveHubLink(env = process.env, ingestor, connectHub = connectPublicHub, onVerifiedSearchMiss, assetLog) {
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error) {
        process.stderr.write(ENV_FILE_UNAVAILABLE_DIAGNOSTIC);
        return undefined;
    }
    const reuseEnabled = env['EVOLVER_REUSE_BEFORE_SOLVE'] === '1';
    if (!reuseEnabled && !onVerifiedSearchMiss)
        return undefined;
    const resolvedAssetLog = assetLog ?? new hubNs.AssetCallLog(events.assetCallLogPath(env));
    if (hubMode(env) === 'private') {
        if (!reuseEnabled)
            return undefined;
        const proxy = proxyClientFromEnv(env);
        if (!proxy)
            return undefined;
        const reportEnabled = env['EVOLVER_OUTCOME_REPORT'] !== '0';
        const privateSender = async (row) => {
            if (!reportEnabled)
                throw new FeedbackNotDispatchedError('outcome_reporting_disabled');
            if (!row.report || !row.destinationId)
                return { status: 'terminal', reason: 'reuse_result_not_reportable' };
            try {
                const receipt = reuseReceipt(await proxy.recordReuseResult({
                    ...row.report,
                    expectedHubMode: 'private', expectedHubDestinationId: row.destinationId,
                }));
                return reuseReceiptSendResult(receipt);
            }
            catch (error) {
                // These proxy rejections happen before the bound adapter sees the POST.
                // Preserve the debt as unsent so a later valid binding can handle it.
                if (error instanceof Error && (error.message === 'proxy_hub_destination_mismatch'
                    || error.message === 'proxy_hub_mode_mismatch')) {
                    throw new FeedbackNotDispatchedError(error.message);
                }
                return { status: 'ambiguous', reason: 'reuse_result_transport_unknown' };
            }
        };
        const link = makeHubLink(makeProxyHubCapability(proxy), ingestor, reportEnabled, undefined, resolvedAssetLog, env, privateSender);
        // The external private adapter has no task-wide memory endpoint today; its
        // explicit false stub is not an acknowledgement and must not create debt.
        delete link.sendTaskOutcome;
        return link;
    }
    // A fetched candidate may become durable provenance for a later feedback claim.
    // Bind the reuse capability itself to the same exact credential as the reporter:
    // checking only before a run would allow an OAuth replacement during search/fetch
    // to attribute an asset from principal B to the stored destination for A.
    const binding = (() => {
        try {
            return readPublicOAuthCredentialBinding(join(resolveIdentityHome(env), 'token.json'));
        }
        catch {
            return undefined;
        }
    })();
    if (reuseEnabled && !binding)
        return undefined;
    const hub = resolvePublicHub(env, connectHub, reuseEnabled ? binding : undefined);
    if (!hub)
        return undefined;
    if (!reuseEnabled && onVerifiedSearchMiss) {
        return {
            seam: makeHubSearchMissProbe(hub, new ReuseCache(), onVerifiedSearchMiss, () => {
                try {
                    return getAtpConsent(env).enabled;
                }
                catch {
                    return false;
                }
            }, env, resolvedAssetLog),
            reportOutcome: async () => undefined,
        };
    }
    const reportingHub = binding ? hub : undefined;
    const boundDestinationId = reportingHub && binding ? (() => {
        try {
            const sender = resolveAtpSenderId(env);
            return sender ? feedbackDestinationIdentity('public', resolveHubUrl(env), sender, binding) : undefined;
        }
        catch {
            return undefined;
        }
    })() : undefined;
    // Pass the ingestor so a reuse hit emits a value.reuse_hit root_event (#112) — the live source the value
    // ledger derives source=reuse entries from.
    const link = makeHubLink(hub, ingestor, env['EVOLVER_OUTCOME_REPORT'] !== '0' && !!reportingHub, onVerifiedSearchMiss, resolvedAssetLog, env, undefined, reportingHub, boundDestinationId === publicFeedbackDestinationId(env) ? boundDestinationId : undefined);
    if (boundDestinationId && boundDestinationId === publicFeedbackDestinationId(env)) {
        link.feedbackDestinationId = boundDestinationId;
    }
    return link;
}
export function resolveHubQuestionLink(env = process.env, connectHub = connectPublicHub) {
    if (env['EVOLVER_OUTCOME_REPORT'] === '0')
        return undefined;
    if (hubMode(env) !== 'public')
        return undefined;
    const hub = resolvePublicHub(env, connectHub);
    if (!hub)
        return undefined;
    if (!hub.questions)
        return undefined;
    return makeHubQuestionLink(hub, { env });
}
export function resolveMemoryEventMirror(env = process.env, connectHub = connectPublicHub) {
    if (hubMode(env) === 'private') {
        return { enabled: false, reason: 'no_hub', observer: null };
    }
    const disabled = resolveMemoryEventMirrorObserver(env, null);
    if (disabled.reason === 'disabled')
        return disabled;
    return resolveMemoryEventMirrorObserver(env, resolvePublicHub(env, connectHub));
}
function solidifyVerifyFlag(env) {
    const raw = env[SOLIDIFY_VERIFY_ENV]?.trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off')
        return 'off';
    if (raw === '1' || raw === 'true' || raw === 'on')
        return 'on';
    return 'auto';
}
export function offlinePermitDir(env = process.env) {
    return join(resolveAtpHome(env), 'evolution', 'offline-permit');
}
export function makeOfflineSolidifyPermitGate(permits) {
    return () => {
        const result = permits.consumeOfflinePermit();
        if (result.ok)
            return { ok: true, reason: 'offline_permit' };
        return {
            ok: false,
            reason: `hub_solidify_offline_denied:${result.error}`,
            ...(result.detail ? { detail: result.detail } : {}),
        };
    };
}
export function resolveSolidifyPermitGate(env = process.env, connectHub = connectPublicHub, opts = {}) {
    const flag = solidifyVerifyFlag(env);
    if (flag === 'off')
        return undefined;
    const mode = hubMode(env);
    if (mode !== 'public') {
        return flag === 'on'
            ? () => ({
                ok: false,
                reason: mode === 'private'
                    ? 'hub_solidify_verify_unavailable:private_hub_not_supported'
                    : 'hub_solidify_verify_unavailable:invalid_hub_mode',
            })
            : undefined;
    }
    const hubUrl = resolveConfiguredHubUrl(env) ?? (flag === 'on' ? resolveHubUrl(env) : undefined);
    if (!hubUrl) {
        if (flag === 'on')
            return () => ({ ok: false, reason: 'hub_solidify_verify_unavailable:no_hub_url' });
        return undefined;
    }
    const explicitCredentials = resolveExplicitNodeCredentials(env);
    const { nodeSecret } = explicitCredentials;
    const senderId = nodeSecret
        ? explicitCredentials.senderId ?? resolveAtpSenderId(env)
        : resolveAtpSenderId(env);
    if (!senderId) {
        if (flag === 'on')
            return () => ({ ok: false, reason: 'hub_solidify_verify_unavailable:no_sender_id' });
        return undefined;
    }
    const authMode = nodeSecret ? 'legacy' : 'oauth';
    const dir = resolveIdentityHome(env);
    if (authMode === 'oauth' && !existsSync(join(dir, 'token.json'))) {
        if (flag === 'on')
            return () => ({ ok: false, reason: 'hub_solidify_verify_unavailable:no_credentials' });
        return undefined;
    }
    try {
        const { auth } = connectHub({
            hubUrl,
            authMode,
            evomapDir: dir,
            senderId: () => senderId,
            ...(nodeSecret ? { nodeSecret } : {}),
        });
        return createSolidifyPermitCheck({
            hubUrl,
            auth,
            senderId: () => senderId,
            dir: offlinePermitDir(env),
            nodeSecret,
            ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
            ...(opts.now ? { now: opts.now } : {}),
            ...(opts.store ? { store: opts.store } : {}),
        });
    }
    catch {
        if (flag === 'on')
            return () => ({ ok: false, reason: 'hub_solidify_verify_unavailable:no_credentials' });
        return undefined;
    }
}
// Only an accepted duplicate receipt confirms the same (asset, node, task_id) claim.
function reuseReceiptSendResult(receipt) {
    if (receipt.terminal === true) {
        return receipt.recorded === false && terminalReuseStatus(receipt.status)
            ? { status: 'terminal', reason: safeAssetCallReason(receipt.reason) ?? 'hub_rejected' }
            : { status: 'ambiguous', reason: 'reuse_receipt_unconfirmed' };
    }
    if (receipt.recorded === true || (receipt.recorded === false && receipt.reason === 'duplicate_report')) {
        return { status: 'acknowledged', ...(receipt.id ? { receiptId: receipt.id } : {}) };
    }
    return { status: 'ambiguous', reason: safeAssetCallReason(receipt.reason) ?? 'reuse_receipt_unconfirmed' };
}
function terminalReuseStatus(status) {
    return status === undefined || isTerminalHubRejectionStatus(status);
}
export function makeProxyHubCapability(proxy) {
    const auth = {
        kind: 'enterprise_sso',
        login: async () => ({ id: 'proxy', kind: 'enterprise_sso', token: '' }),
        authenticate: async () => ({ headers: {} }),
        rotate: async () => ({ id: 'proxy', kind: 'enterprise_sso', token: '' }),
        revoke: async () => { },
    };
    return {
        auth,
        search: async (query) => resultAssets(await proxy.search({
            ...proxySearchArgs(query),
            expectedHubMode: 'private',
        })),
        fetch: async (query) => resultAssets(await proxy.search({
            ...proxySearchArgs(query),
            expectedHubMode: 'private',
        })),
        fetchAssetById: async (assetId) => {
            const asset = firstAsset(await proxy.fetchAsset({ assetId, expectedHubMode: 'private' }));
            return assetMatchesId(asset, assetId) ? asset : null;
        },
        publish: async () => ({ receiptId: 'proxy-disabled', status: 'rejected', terminal: true, reason: 'proxy_autoexec_publish_disabled' }),
        recordOutcome: async () => ({ recorded: false, reason: 'proxy_outcome_not_configured' }),
        recordReuseResult: async (report) => reuseReceipt(await proxy.recordReuseResult({
            assetId: report.assetId,
            outcome: report.outcome,
            ...(report.taskId ? { taskId: report.taskId } : {}),
            ...(report.traceId ? { traceId: report.traceId } : {}),
            ...(report.timeSavedSeconds !== undefined ? { timeSavedSeconds: report.timeSavedSeconds } : {}),
            ...(report.reason ? { reason: report.reason } : {}),
            ...(report.evidence ? { evidence: report.evidence } : {}),
            expectedHubMode: 'private',
        })),
        task: {
            claim: async () => ({ claimId: 'proxy-disabled' }),
            complete: async () => ({ status: 'completed' }),
            subscribe: async function* () { },
        },
        mailbox: {
            poll: async () => ({ events: [] }),
            ack: async () => { },
            push: async () => { },
            status: async () => ({ pending: 0 }),
        },
    };
}
function proxySearchArgs(query) {
    return {
        ...(query.text ? { text: query.text } : {}),
        ...(query.signalsAny ? { signalsAny: query.signalsAny } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.gene ? { gene: query.gene } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
    };
}
function resultAssets(value) {
    const r = record(value);
    const payload = record(r['payload']);
    const rows = Array.isArray(r['results']) ? r['results']
        : Array.isArray(r['assets']) ? r['assets']
            : Array.isArray(payload['results']) ? payload['results']
                : Array.isArray(payload['assets']) ? payload['assets']
                    : [];
    return rows.filter((row) => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
}
function firstAsset(value) {
    return resultAssets(value)[0] ?? null;
}
function assetMatchesId(asset, assetId) {
    return Boolean(asset && asset.asset_id === assetId);
}
function reuseReceipt(value) {
    const r = record(value);
    const payload = record(r['payload']);
    const source = r['payload'] === undefined ? r : payload;
    const permitsSuccess = (value) => value === undefined || value === true;
    const rejected = !permitsSuccess(r['ok']) || !permitsSuccess(payload['ok'])
        || (source !== r && r['recorded'] !== undefined && r['recorded'] !== source['recorded'])
        || (source !== r && r['terminal'] !== undefined && source['terminal'] !== undefined
            && r['terminal'] !== source['terminal'])
        || (r['error'] !== undefined && r['error'] !== null)
        || (payload['error'] !== undefined && payload['error'] !== null);
    const terminalDeclared = source['terminal'] === true || r['terminal'] === true;
    const recorded = source['recorded'] === true && !rejected && !terminalDeclared;
    const reason = typeof source['reason'] === 'string' ? source['reason'] : undefined;
    const confirmedDuplicate = source['recorded'] === false && !rejected && !terminalDeclared;
    const status = source['status'];
    const outerStatus = r['status'];
    const terminal = source['recorded'] === false && !rejected && terminalDeclared
        && terminalReuseStatus(status) && terminalReuseStatus(outerStatus)
        && (status === undefined || outerStatus === undefined || status === outerStatus);
    return {
        recorded,
        ...(reason !== undefined ? { reason: reason === 'duplicate_report' && !recorded && !confirmedDuplicate && !terminal
                ? 'reuse_receipt_unconfirmed' : reason } : {}),
        ...(recorded && typeof source['id'] === 'string' ? { id: source['id'] } : {}),
        ...(recorded && typeof source['eligible'] === 'boolean' ? { eligible: source['eligible'] } : {}),
        ...(recorded && typeof source['counted'] === 'boolean' ? { counted: source['counted'] } : {}),
        ...(recorded && typeof source['weight'] === 'number' && Number.isFinite(source['weight']) ? { weight: source['weight'] } : {}),
        ...(terminal ? { terminal: true, ...(typeof status === 'number' ? { status } : {}) } : {}),
    };
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
/** Session-log dirs the auto-distill producer scans: EVOLVER_SESSION_DIRS (comma-sep) overrides; else the
 *  standard agent homes. The scanner skips non-existent dirs, so listing cross-platform homes is always safe. */
export function defaultSessionDirs(env = process.env) {
    const override = env['EVOLVER_SESSION_DIRS'];
    if (override && override.trim())
        return override.split(',').map((s) => s.trim()).filter(Boolean);
    const h = homedir();
    const dirs = [
        join(h, '.claude'),
        join(h, '.cursor'),
        join(h, '.codex'),
        join(h, '.gemini', 'tmp'),
        join(h, '.gemini', 'antigravity'),
        join(h, '.gemini', 'antigravity-ide'),
        join(h, '.kimi'),
        join(h, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'),
        join(h, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage'),
        join(h, '.config', 'Cursor', 'User', 'globalStorage'),
    ];
    const appData = env['APPDATA'];
    if (appData)
        dirs.push(join(appData, 'Cursor', 'User', 'globalStorage'));
    return Array.from(new Set(dirs));
}
/**
 * Whether the cross-runtime reuse SIGNAL is folded into selection (#268/#274 soft re-order). **Default ON**: the
 * re-rank is a SMALL, bounded, clamped nudge (±REUSE_WEIGHT) that the controlled A/B (reuseSignalAb.test.ts)
 * proves flips only NEAR-TIES and can never override a gene's health/signal-match — so cross-AI reuse evidence
 * shapes selection by default, not only when an operator opts in. `EVOLVER_REUSE_SIGNAL=0` is the kill switch.
 */
export function reuseSignalEnabled(env = process.env) {
    return env['EVOLVER_REUSE_SIGNAL'] !== '0';
}
/**
 * Whether the gene PROBATION loop is on (#306, phase 2). **Default OFF** — explicit opt-in (EVOLVER_GENE_PROBATION=1),
 * because it lets unproven auto-distilled genes be TRIED with their strategy embedded so the cross-AI reuse loop
 * self-closes (autoexec then also runs the evidence-based auto-promote tick). Unlike the bounded reuse soft re-order,
 * this drives the autonomous agent with an unreviewed strategy — contained by the proven exec hard gates + worktree
 * isolation (#309), but a real increase in what the loop attempts, so it stays opt-in until validated in production.
 */
export function geneProbationEnabled(env = process.env) {
    return env['EVOLVER_GENE_PROBATION'] === '1';
}
/**
 * Wire the auto-distill producer+consumer for the resident daemon (#106 slice2): returns the distillObserver to
 * register on the bus + a `tick()` that scans the session dirs and records material onto the SAME bus Ingestor
 * (→ `material.batch_ready` → the observer auto-drafts a quarantined gene). Off via `EVOLVER_AUTO_DISTILL=0`.
 * All stores/paths are injectable for tests; production defaults to the live ~/.evomap substrate + agent homes.
 */
export function resolveDistillProducer(env, opts) {
    const sessionDirs = opts.sessionDirs ?? defaultSessionDirs(env);
    if (env['EVOLVER_AUTO_DISTILL'] === '0') {
        return { enabled: false, reason: 'off', observer: null, tick: async () => ({ recorded: 0, sourceAgents: [], signalKinds: [], signalStrengths: [] }), sessionDirs };
    }
    const store = opts.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = opts.review ?? new assetstore.ReviewLedger(events.assetsDir());
    const materialStore = opts.materialStore ?? new materialNs.MaterialStore({ path: events.materialStorePath() });
    const watermarkStore = opts.watermarkStore ?? new materialNs.WatermarkStore(events.materialWatermarkPath());
    const consumer = opts.consumer ?? new materialNs.ConsumerGroups({ store: materialStore, path: join(dirname(events.materialStorePath()), 'distill-consumer.json') });
    const observer = resolveDistillObserver({ consumer, store, review, ingestor: opts.ingestor, ...(opts.maxPerTick !== undefined ? { maxPerTick: opts.maxPerTick } : {}) });
    const tick = () => runSessionIngestTick(sessionDirs, { materialStore, watermarkStore,
        ingestor: opts.ingestor, ...(opts.contextIngestor !== undefined ? { contextIngestor: opts.contextIngestor } : {}) });
    return { enabled: true, observer, tick, sessionDirs };
}
export function shouldRunIdleDistill(intensity) {
    return intensity === 'aggressive' || intensity === 'deep';
}
export async function runIdleLlmDistillForBeat(beat, guardedLlmDistill, write = (message) => { process.stdout.write(message); }) {
    if (!guardedLlmDistill || !shouldRunIdleDistill(beat.intensity))
        return;
    const d = await guardedLlmDistill();
    if (d && !('skipped' in d) && d.ok)
        write(`  auto-distill-llm: gene=${String(d.gene['id'] ?? d.gene.asset_id)} stored=${d.stored}\n`);
}
export async function runIdleAntiGeneDistillForBeat(beat, guardedAntiGeneDistill, write = (message) => { process.stdout.write(message); }) {
    if (!guardedAntiGeneDistill || !shouldRunIdleDistill(beat.intensity))
        return;
    const d = await guardedAntiGeneDistill();
    if (!d || 'skipped' in d)
        return;
    if (d.ok)
        write(`  auto-distill-anti-gene: antiGene=${d.antiGene.id} stored=${d.stored}\n`);
    else if (d.mode === 'shadow' && d.reason === 'shadow_logged')
        write('  auto-distill-anti-gene: shadowed=1\n');
}
const EMPTY_TRANSCRIPT_TICK = { scanned: 0, distilled: 0, shadowed: 0, skipped: 0, transient: 0 };
/**
 * Wire the LLM-over-transcript producer for the resident daemon (#319 slice 2). Default OFF
 * (EVOLVER_AUTO_DISTILL_TRANSCRIPT unset). When on, the tick scans the session dirs and LLM-distills prose-rich,
 * weak/zero-signal sessions (per-session dedup/cooldown + per-tick cap inside runTranscriptDistillTick). Runs in
 * the idle slot only (LLM cost), separate from the every-beat structural ingest.
 */
export function resolveAutoDistillTranscript(env, opts) {
    const mode = transcriptDistillMode(env);
    if (mode === 'off')
        return { enabled: false, mode, tick: async () => EMPTY_TRANSCRIPT_TICK };
    const sessionDirs = opts.sessionDirs ?? defaultSessionDirs(env);
    return {
        enabled: true, mode,
        tick: () => runTranscriptDistillTick({
            files: scanSessionDirs(sessionDirs), store: opts.store, env, cwd: process.cwd(),
            ...(opts.review ? { review: opts.review } : {}), ...(opts.ingestor ? { ingestor: opts.ingestor } : {}),
        }),
    };
}
export function resolveAutoDistillAntiGene(env, opts) {
    return resolveAntiGeneDistill(env, {
        store: opts.store,
        cwd: opts.cwd ?? process.cwd(),
        ...(opts.review ? { review: opts.review } : {}),
        ...(opts.ingestor ? { ingestor: opts.ingestor } : {}),
        ...(opts.statePath ? { statePath: opts.statePath } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.runner ? { runner: opts.runner } : {}),
    });
}
export async function runIdleTranscriptDistillForBeat(beat, guarded, write = (message) => { process.stdout.write(message); }) {
    if (!guarded || !shouldRunIdleDistill(beat.intensity))
        return;
    const d = await guarded();
    // singleFlight's busy sentinel is { skipped: true } — our result ALSO has a numeric `skipped`, so discriminate on
    // `distilled` (present only on the real result), not on `skipped`.
    if (!d || !('distilled' in d))
        return;
    // Shadow mode never distills (distilled=0), so surface `shadowed` too — that count IS the probation signal: how
    // many sessions enforce mode would have distilled. Without it, a shadow daemon looks idle when it is in fact working.
    if (d.distilled > 0 || d.shadowed > 0)
        write(`  auto-distill-transcript: distilled=${d.distilled} shadowed=${d.shadowed} scanned=${d.scanned} transient=${d.transient}\n`);
}
/**
 * `evolver autoexec [home]`: resident daemon. Builds the safe deps from EVOLVER_HOME, then single-flight-guards
 * autoExecPass on an interval. Real agent execution only happens for repos the operator has allowlisted in
 * <home>/autoexec/config.json (allowedRoots) — empty by default = nothing runs.
 */
export async function runAutoExec(argv) {
    // Load EVOLVER_ENV_FILE into process.env FIRST (PORT v1 #10 fix): the first-run prompt below and ALL ATP
    // home/consent resolution (EVOLVER_ATP_AUTOBUY / EVOLVER_HOME / EVOMAP_DIR / EVOMAP_HOME) read process.env, so an
    // env-file-only setting must be merged before the prompt runs — otherwise the prompt can fire when it should skip,
    // or read/write the ack under the wrong home (the env-file home is invisible until then). resolveHubLink still
    // loads the file too (idempotent re-read) for its standalone callers/tests, so this is the single authoritative
    // early load, not a replacement. This MUST stay above runAutobuyPrompt() (which now runs after the lock below).
    const envFile = loadEnvFileFromEnv(process.env);
    if (envFile.error) {
        process.stderr.write(ENV_FILE_UNAVAILABLE_DIAGNOSTIC);
        return 1;
    }
    const home = argv.find((a) => !a.startsWith('-')) ?? join(events.evomapHome(), 'autoexec');
    const dirs = ensureAutoExecDirs(home);
    const cfg = readAutoExecConfig(home);
    if (!canExecuteQueue(cfg.runner)) {
        process.stderr.write('evolver autoexec: execute queue is disabled for the configured built-in runner; non-execution daemon duties remain active. Set "runner":"llm" (no agent CLI needed) or "runner":"gemini" after reviewing its experimental capability boundary\n');
    }
    // Solo mode (--solo): the "constrained wild" profile. Hard-cut network + ATP
    // at the SOURCE — in-process, before any resolve* below reads its env gate — so
    // both the startup wiring and any in-cycle path see them disabled. This is the
    // "no escape valve" cut (a user cannot re-enable hub/ATP under --solo). The
    // per-cycle git snapshot/rollback and the failure circuit breaker are wired at
    // the resident-loop tick further down. When !solo, everything below is unchanged.
    const solo = solomode.isSoloRun(argv, process.env);
    const soloRepoRoot = cfg.allowedRoots[0] ?? home;
    if (solo) {
        solomode.applySoloLockdown(process.env);
        for (const line of solomode.soloBanner(soloRepoRoot))
            process.stdout.write(line + '\n');
    }
    const store = new assetstore.LocalJsonlProvider(events.assetsDir());
    const memoryGraphDir = join(events.evomapHome(), 'evolution');
    const memoryUser = resolveLocalMemoryUserIdentity(memoryGraphDir);
    const memoryGraph = new LocalMemoryGraph({ dir: memoryGraphDir, ...memoryUser });
    // Observer bus (#113): the event total-bus, finally given its FIRST built-in observer. The value-digest
    // observer is hung off the bus and the bus is wired as the Ingestor's sink, so every emitted event fans out to
    // it; its weekly cadence + measured-value gate keep it quiet. Off via EVOLVER_VALUE_DIGEST=0. Fault-isolated:
    // a broken sink quarantines the observer without ever touching the autoexec write path.
    const bus = new observers.ObserverBus();
    const digest = resolveValueDigestObserver(process.env);
    if (digest.observer)
        bus.register(digest.observer);
    // Cursor rewrite observer (#124): cursor has no SessionStart hook, so its injected gene memory
    // (.cursor/rules/evolver.mdc) is kept fresh by REWRITE-ON-CHANGE. This observer fires (debounced) on the same
    // gene-set-change events the CycleEngine already emits through this Ingestor — so a real cycle solidifying a
    // gene re-renders the cursor rules file. Opt-in: only registered when the user installed cursor injection at
    // the project root (the first allowlisted repo); off via EVOLVER_CURSOR_REWRITE=0. Fault-isolated by the bus.
    const provenance = new assetstore.ProvenanceStore(events.assetsDir());
    const review = new assetstore.ReviewLedger(events.assetsDir());
    const cursorRoot = cfg.allowedRoots[0];
    // The cursor rewrite reads the SAME review ledger the exec pool uses, so an auto-distilled draft fired onto this
    // bus (gene.distilled) is withheld from cursor's rules until approved (A2a) — not just by process isolation.
    const cursorRewrite = cursorRoot
        ? resolveCursorRewriteObserver(process.env, { projectRoot: cursorRoot, store, review })
        : { enabled: false, reason: 'not-installed', observer: null };
    if (cursorRewrite.observer)
        bus.register(cursorRewrite.observer);
    const ingestor = new events.Ingestor({ path: events.rootEventsPath(), sink: bus });
    // Material/cycle events still fan out on the bus. Context receipts require a
    // sink-free built-in writer whose durable result cannot be held by callbacks.
    const contextIngestor = new events.Ingestor({ path: events.rootEventsPath() });
    const reflection = resolveReflectionObserver(process.env, { ingestor });
    if (reflection.observer)
        bus.register(reflection.observer);
    const memoryEventMirror = resolveMemoryEventMirror(process.env);
    if (memoryEventMirror.observer)
        bus.register(memoryEventMirror.observer);
    const personalityStore = createAutoExecPersonalityStore();
    const engine = new algo.CycleEngine({
        ingestor,
        selection: algo.makeGeneSelectionPoint(),
        store,
        now: () => Date.now(),
        personality: personalityStore,
        capabilityGaps: makeCurriculumCapabilityGapsProvider(process.env),
    });
    // Reuse-before-solve (#110) + outcome report-back: wire the adapter's reuseBeforeSolve as the hub-reuse
    // seam when enabled + credentialed (default OFF → undefined → zero hub calls, exactly today's behavior).
    // The seam injects hub candidates into the same selection pool as local genes, trust-first; the link's
    // sender is enabled only when the effective Hub principal can be bound to an outbox debt.
    let atpAutoBuyer;
    const onVerifiedHubSearchMiss = (miss) => {
        // Resolve lazily: the first-run consent prompt happens after the daemon lock is acquired below, while Hub
        // composition happens here. A later verified miss therefore observes the newly recorded consent correctly.
        atpAutoBuyer ??= resolveAtpAutoBuyer(process.env);
        if (atpAutoBuyer)
            scheduleAtpAutoBuyForVerifiedMiss(miss, atpAutoBuyer);
    };
    const candidateHubLink = resolveHubLink(process.env, ingestor, connectPublicHub, onVerifiedHubSearchMiss);
    const feedbackMode = hubMode(process.env);
    const feedbackBinding = makeAutoExecFeedbackBinding(candidateHubLink, feedbackMode, () => feedbackMode === hubMode(process.env)
        ? resolveFeedbackDestinationId(process.env) : Promise.resolve(undefined));
    await feedbackBinding.refresh();
    const hubQuestionLink = resolveHubQuestionLink(process.env);
    const solidifyPermit = resolveSolidifyPermitGate(process.env);
    const strategyName = process.env['EVOLVE_STRATEGY'];
    const probationOn = geneProbationEnabled();
    const semanticIdfOn = semanticIdfEnabled();
    const selectionPolicy = selectionPolicyFromEnv();
    const selectionGuard = selectionGuardFromEnv();
    const selectionFloor = selectionFloorFromEnv();
    // File-only and best-effort: tracing must never fail or slow a task.
    const learningTrace = resolveLearningTrace(process.env);
    const executionBindingAuthority = {
        claimLease: () => false,
        acceptanceSpec: () => false,
        budget: () => false,
        consent: () => false,
    };
    const deps = withAutoExecSelectionConfig({
        engine, store, provenance, review, personality: personalityStore, memoryGraph,
        assertPromptAdapter: () => {
            if (!assetstore.isBuiltInPromptProvider(store))
                throw new Error('unsupported_unsupervised_prompt_provider_v1');
        },
        ...(process.env['EVOLVER_BENCHMARK_ID'] !== undefined ? { benchmark: assetstore.benchmarkContext(process.env['EVOLVER_BENCHMARK_ID']) } : {}),
        executionBinding: {
            journal: new exec.ExecutionBindingJournal(ingestor),
            authority: executionBindingAuthority,
            now: () => Date.now(),
            maxRuntimeMs: cfg.timeoutMs,
        },
        ...(learningTrace.config ? { learningTrace: learningTrace.config } : {}),
        // Probation (#306, gated, default OFF via EVOLVER_GENE_PROBATION): try unproven auto-distilled genes (with their
        // strategy embedded) so the cross-AI loop self-closes — contained by the proven exec gates + worktree isolation.
        ...(probationOn ? { includeProbation: true } : {}),
        ...(!semanticIdfOn ? { disableSemanticIdf: true } : {}),
        ...(solidifyPermit ? { solidifyPermit } : {}),
        ...(strategyName !== undefined ? { strategyName } : {}),
        // Validate through the hardened sandbox verifier so a validation command can't exfiltrate or phone home to game
        // the result. Validation is bounded by the sandbox's own per-command cap (NOT the agent exec timeout, a
        // different unit) so a long suite is not silently SIGKILL'd against the wrong budget.
        validate: (task) => async (_m, _d, cwd, signal) => {
            const cmds = task.validationCmds ?? [];
            const bindingRuntimeMs = task.execution_binding?.resource_grant.max_runtime_ms;
            const safetyRuntimeMs = cfg.timeoutMs;
            const validationTimeoutMs = bindingRuntimeMs === undefined
                ? safetyRuntimeMs
                : Math.min(bindingRuntimeMs, safetyRuntimeMs);
            const r = await runRequiredSandboxedValidation(cmds, cwd, { timeoutMs: validationTimeoutMs, ...(signal ? { signal } : {}) });
            const validationSummary = summarizeSandboxedValidation(r);
            if (validationSummary)
                process.stdout.write(`  validation: ${validationSummary}\n`);
            return {
                passed: r.passed,
                score: r.score,
                validator: {
                    id: 'required_sandboxed_validation',
                    version: 'sandboxed_validation.v1',
                    status: 'ran',
                    plan_digest: exec.computeValidationPlanDigest(cmds),
                    passed: r.passed,
                    score: r.score,
                    results: r.results,
                    skipped: r.skipped,
                    isolated: r.isolated,
                    ...(r.isolationTier !== undefined ? { isolationTier: r.isolationTier } : {}),
                    ...(r.failureReason !== undefined ? { failureReason: r.failureReason } : {}),
                },
            };
        },
    }, process.env);
    const safety = { allowedRoots: cfg.allowedRoots, timeoutMs: cfg.timeoutMs, runner: cfg.runner };
    // #268/#274 soft re-order — DEFAULT ON (kill switch: EVOLVER_REUSE_SIGNAL=0). Fold the latest cross-runtime reuse
    // outcomes + observed recall into selection as a SMALL, bounded, clamped nudge (±REUSE_WEIGHT); reuseSignalAb.test
    // proves it flips only near-ties and never overrides health/signal-match, so cross-AI reuse evidence shapes
    // selection without an opt-in. On → one readEvents per pass (the whole root_events log): negligible against a
    // multi-minute agent run, and the daemon does one pass per task — revisit only if the log grows large (rotation
    // is still deferred). The recall rail stays empty until EVOLVER_AUTO_RECALL=1 separately enables value.recall.
    const reuseSignalOn = reuseSignalEnabled();
    const feedbackOutbox = new FeedbackOutbox(join(dirs.base, 'feedback-outbox'));
    const taskOutcomeOutbox = new TaskOutcomeOutbox(join(dirs.base, 'task-outcome-outbox'));
    // Capture the confirmed run binding in its receipt before feedback preparation.
    // Recovery uses that saved identity and eligibility, never today's credentials.
    const taskFeedbackDestinations = new WeakMap();
    const runOne = async (task) => {
        taskFeedbackDestinations.set(task, null);
        // One read of root_events (per pass) feeds BOTH rails: reported reuse outcomes (#268) and observed recall (#274
        // slice 3, folded at a lower weight). value.recall rides the SAME flag — it is the same soft re-order actuator.
        const evts = reuseSignalOn ? events.readEvents(events.rootEventsPath()) : null;
        const activeBinding = await feedbackBinding.refresh();
        const taskDeps = {
            ...deps,
            ...(evts ? { reuseOutcomes: ops.summarizeReuseOutcomes(evts),
                recallEvents: evts.filter((e) => e.type === ops.VALUE_RECALL_EVENT) } : {}),
            hubReuse: activeBinding?.link.seam,
            // The private proxy attests report POSTs, but not search/fetch. Never mint
            // Hub origin evidence for an asset fetched through that unbound path.
            hubFeedbackDestinationId: feedbackMode === 'public' ? activeBinding?.destinationId : undefined,
        };
        const v = await exec.runAutoExecTask(taskDeps, task, safety);
        const completedBinding = await feedbackBinding.refresh();
        taskFeedbackDestinations.set(task, confirmedTaskFeedbackDestination(activeBinding, completedBinding) ?? null);
        return v;
    };
    const guarded = exec.singleFlight(runnerBoundAutoExecPass(cfg.runner, dirs, runOne, {
        // Solo may roll the entire worktree back after this pass; no successful applied-use
        // claim is stable until that decision. It has no Hub egress by design.
        ...(solo ? {} : {
            taskOutcomeEnabled: feedbackMode === 'public' && !!candidateHubLink?.sendTaskOutcome,
            captureFeedbackDestination: (task) => taskFeedbackDestinations.get(task) ?? null,
            prepareFeedback: (claimRoot, task, verdict, executionDestinationId, taskOutcomeEnabled) => {
                // The durable receipt owns this snapshot before the volatile entry is consumed.
                taskFeedbackDestinations.delete(task);
                feedbackOutbox.prepare({ claimRoot, task, verdict,
                    ...(executionDestinationId ? { destinationId: executionDestinationId } : {}) });
                // Existing debts retain their original destination even when today's Hub
                // is absent, private, opted out, or bound to another principal.
                prepareCommittedTaskOutcomeFeedback(taskOutcomeOutbox, claimRoot, task, verdict, taskOutcomeEnabled ? executionDestinationId ?? undefined : undefined);
            },
        }),
        afterCommit: (task, verdict) => {
            scheduleAutoExecHubSideEffects(task, verdict, { questions: hubQuestionLink });
        },
    }));
    // Auto-distill producer+consumer (#106): register the distillObserver on THIS bus, then a producer tick scans
    // the session dirs and records material on THIS Ingestor → material.batch_ready → observer drafts a quarantined
    // gene (A1) → human `review --approve` lifts it into inject/cursor (A2a/A2b). Off via EVOLVER_AUTO_DISTILL=0.
    const distill = resolveDistillProducer(process.env, { ingestor, contextIngestor, store, review });
    if (distill.observer)
        bus.register(distill.observer);
    const llmDistill = resolveAutoDistillLlm(process.env, { store, review, ingestor, cwd: process.cwd() });
    const antiGeneDistill = resolveAutoDistillAntiGene(process.env, { store, review, ingestor });
    const transcriptDistill = resolveAutoDistillTranscript(process.env, { store, review, ingestor });
    const atpAutoDeliver = resolveAtpAutoDeliver(process.env);
    const taskReceiver = resolveTaskReceiver(process.env, {
        repo: taskReceiverRepo(process.env, cfg.allowedRoots),
        queueDir: dirs.tasks,
        memoryEvents: () => memoryEventsFromCycleLog(events.readEvents(events.rootEventsPath())),
        // An unreadable inflight directory is not an empty one: answering "nothing is running"
        // there would hand the executor a task it may already be running. Say "busy" instead —
        // a task that waits one beat is recoverable, one run twice is not.
        inFlight: (queueTaskId) => { try {
            return hasInflightClaim(dirs, queueTaskId);
        }
        catch {
            return true;
        } },
    });
    const uninstallBrokenPipeGuards = installAutoexecBrokenPipeGuards();
    const reuseEnabled = process.env['EVOLVER_REUSE_BEFORE_SOLVE'] === '1' && feedbackBinding.bound() !== undefined;
    process.stdout.write(`evolver autoexec: runner=${cfg.runner} queue=${dirs.tasks} allowlist=${JSON.stringify(cfg.allowedRoots)} poll=${cfg.pollMs}ms reuse=${reuseEnabled ? 'on' : 'off'} reuse-signal=${reuseSignalOn ? 'on' : 'off'} semantic-idf=${semanticIdfOn ? 'on' : 'off'} selection-policy=${selectionPolicy} selection-guard=${selectionGuard} selection-floor=${selectionFloor === undefined ? 'unset' : selectionFloor} probation=${probationOn ? 'on' : 'off'} questions=${hubQuestionLink ? 'on' : 'off'} permit=${solidifyPermit ? 'on' : 'off'} value-digest=${digest.enabled ? 'on' : 'off'} reflection=${reflection.enabled ? 'on' : 'off'} learning-trace=${learningTrace.enabled ? `on(upload=${learningTrace.upload})` : 'off'} memory-event-mirror=${memoryEventMirror.enabled ? 'on' : `off(${memoryEventMirror.reason ?? 'no_hub'})`} cursor-rewrite=${cursorRewrite.enabled ? 'on' : `off(${cursorRewrite.reason})`} auto-distill=${distill.enabled ? 'on' : 'off'} auto-distill-llm=${llmDistill.enabled ? llmDistill.mode : 'off'} auto-distill-anti-gene=${antiGeneDistill.enabled ? antiGeneDistill.mode : 'off'} auto-distill-transcript=${transcriptDistill.enabled ? transcriptDistill.mode : 'off'} atp-autodeliver=${atpAutoDeliver.enabled ? 'on' : `off(${atpAutoDeliver.reason})`} task-receiver=${taskReceiver.enabled ? `on(repo=${taskReceiverRepo(process.env, cfg.allowedRoots)})` : `off(${taskReceiver.reason})`}\n`);
    if (cfg.allowedRoots.length === 0)
        process.stdout.write('  (allowlist empty → deny-by-default: nothing runs until you add a repo to config.json)\n');
    // Single-instance lock (#106): a second daemon on the same home would double-process the queue. That is harmless
    // for correctness (store + event writes are file-locked and watermark-idempotent) but wasteful, so refuse rather
    // than pile on. Stale locks (a crashed prior daemon) are auto-reclaimed by acquireLock's pid-liveness check.
    const lockPath = join(home, 'autoexec.lock');
    // maxTries must allow a stale-lock reclaim (a crashed prior daemon) PLUS the acquire that follows it: reclaim
    // consumes one try (unlink + continue), so maxTries:1 would reclaim then immediately time out, wrongly refusing
    // the FIRST restart (Bugbot #149). A few short tries reclaim a dead owner's lock yet still refuse a LIVE holder
    // fast (~maxTries×waitMs ≈ 50ms) — reclaim/refuse behavior is covered by fileLock.test.
    let runtimeOwner;
    try {
        runtimeOwner = util.acquireLock(lockPath, { maxTries: 5 });
    }
    catch (error) {
        process.stderr.write(autoexecLockFailureMessage(error));
        uninstallBrokenPipeGuards();
        return 1;
    }
    // First-run auto-buyer opt-in (PORT v1 #10): introduce the autonomous spend path to interactive operators once,
    // AFTER the single-instance lock is held so two concurrent `evolver autoexec` starts on the same home cannot both
    // pass the no-ack check, both prompt, and race writing the ack file (Bugbot). Still before the resident loop.
    // No-op under systemd/Docker/CI (non-TTY) and once the ack/env is set, so it never blocks a daemon; wrapped so a
    // prompt failure can never wedge `autoexec`.
    try {
        await runAutobuyPrompt();
    }
    catch (e) {
        process.stderr.write(`[ATP-AutoBuyer] first-run prompt failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    const uninstallUnhandledRejectionGuard = daemonNs.installUnhandledRejectionWindow({
        beforeExit: () => { releaseAutoexecLock(lockPath); },
    });
    let runtimeCleaned = false;
    const cleanupAutoexecRuntime = () => {
        if (runtimeCleaned)
            return;
        runtimeCleaned = true;
        uninstallUnhandledRejectionGuard();
        releaseAutoexecLock(lockPath);
        uninstallBrokenPipeGuards();
    };
    // Durable workflow recovery uses the same policy/review-gated runtime factory as `evolver workflow start/resume`.
    // Pass the already-loaded config so a custom autoexec home uses the same allowlist, runner, and validation profiles.
    initializeWorkflowStartupRecovery({ autoExecHome: home, autoExecConfig: cfg });
    // SINGLE-FLIGHT the producer tick (same as autoExecPass): a session scan that outlasts pollMs must not let two
    // ticks interleave in recordSessionMaterial (which would re-emit material.batch_ready before watermarks settle).
    const guardedDistill = distill.enabled && distill.observer ? exec.singleFlight(() => distill.tick()) : null;
    const guardedContextDelivery = exec.singleFlight(() => {
        const writer = resolveContextObservationWriter(ingestor, contextIngestor);
        return writer ? writer.recoverContextDeliveries({ deadlineAt: Date.now() + 200 }) : Promise.resolve(undefined);
    });
    const contextDeliveryRootReady = () => {
        const writer = resolveContextObservationWriter(ingestor, contextIngestor);
        if (!writer)
            return true;
        try {
            const journal = events.Ingestor.contextDeliveryStatus(writer.path);
            return journal.confirmedPending === 0 && !journal.reasons.cleanup_pending;
        }
        catch {
            return false;
        }
    };
    let contextDeliveryTurnReady = false;
    let ingestionTelemetry = { state: distill.enabled ? 'unknown' : 'disabled' };
    const guardedLlmDistill = llmDistill.enabled ? exec.singleFlight(() => llmDistill.tick()) : null;
    const guardedAntiGeneDistill = antiGeneDistill.enabled ? exec.singleFlight(() => antiGeneDistill.tick()) : null;
    const guardedTranscriptDistill = transcriptDistill.enabled ? exec.singleFlight(() => transcriptDistill.tick()) : null;
    const guardedAtpAutoDeliver = atpAutoDeliver.enabled ? exec.singleFlight(() => atpAutoDeliver.tick()) : null;
    const guardedTaskReceiver = taskReceiver.enabled ? exec.singleFlight(() => taskReceiver.tick()) : null;
    if (distill.observer)
        distill.observer.kick(); // recover any un-acked backlog from a prior run (restart)
    // One idle-aware resident beat runs the exec pass, ATP auto-delivery, THEN the distill scan (single-flight
    // guarded). Idle-aware pacing (#106): an idle machine polls more often, an active one backs off to the base
    // cadence. Off via EVOLVER_IDLE_AWARE=0 → fixed cfg.pollMs (exactly the previous behavior).
    const completionLine = (ack, assetId) => {
        if (ack.completed)
            return 'reported';
        // The asset outlived the claim: name it, or the work is lost with no way back to it.
        if (ack.error === 'commitment_expired')
            return `commitment expired, asset ${assetId} not sent`;
        return `${ack.pending ? 'owed, will retry' : 'failed'} ${ack.error ?? ''}`;
    };
    // Reporting has its own durable outboxes and may encounter a slow Hub or an arbitrary backlog.
    // It must never hold the resident beat ahead of a committed Hub-task completion or its owed retries.
    const scheduleFeedbackDrain = makeDeferredAutoExecFeedbackDrain(async () => {
        const activeBinding = await feedbackBinding.refresh();
        const feedback = await flushAutoExecFeedback(feedbackOutbox, ingestor, activeBinding?.link.sendAppliedUse, activeBinding?.destinationId);
        if (activeBinding?.link.sendTaskOutcome) {
            const outcomes = await taskOutcomeOutbox.flush(activeBinding.destinationId, activeBinding.link.sendTaskOutcome);
            if (outcomes.delivered || outcomes.terminal || outcomes.ambiguous) {
                process.stdout.write(`  task-outcome-feedback: delivered=${outcomes.delivered} terminal=${outcomes.terminal} ambiguous=${outcomes.ambiguous}\n`);
            }
        }
        if (feedback.projected || feedback.delivered || feedback.ambiguous) {
            process.stdout.write(`  applied-use-feedback: projected=${feedback.projected} delivered=${feedback.delivered} ambiguous=${feedback.ambiguous}\n`);
        }
    }, () => {
        process.stderr.write('[autoexec] feedback_drain_failed; durable outbox remains for recovery\n');
    });
    const tick = async (beat) => {
        contextDeliveryTurnReady = false;
        // Join the actual projection/cleanup before any synchronous root writer.
        // Its 200ms admission deadline remains unchanged; cleanup owns its resources.
        await guardedContextDelivery().catch(() => undefined);
        contextDeliveryTurnReady = contextDeliveryRootReady();
        if (!contextDeliveryTurnReady)
            return { failed: false };
        let failed = false;
        const r = await guarded();
        if (r && !('skipped' in r) && r.length) {
            process.stdout.write(`  pass: ${r.map((v) => `${v.taskId}=${v.status}`).join(' ')}\n`);
            // A cycle "failed" (for solo rollback) when a task's self-edit did not
            // solidify cleanly — i.e. any verdict is 'failed'. 'refused' (deny-by-
            // default / not in allowlist) is a no-op, not a broken edit.
            if (r.some((v) => v.status === 'failed'))
                failed = true;
            // A claim is a promise. The Hub only learns it was kept when the produced capsule
            // comes back — but a cycle solo rollback is about to revert has not kept it, and the
            // Hub cannot take a completion back. Stay silent and let the commitment expire.
            // Only a registered claim is Hub work: the `hub-` prefix is a naming convention a
            // local task may also use, and reporting its capsule would complete someone's task
            // with an unrelated asset. The generation narrows it further — a queue id can be
            // claimed, run and claimed again, and a result from the earlier filing is not this
            // claim's to hand over.
            const hubDone = r.flatMap((v) => {
                const claim = v.status === 'solidified' && v.resultAssetId ? taskReceiver.claimFor(v.taskId) : null;
                if (!claim || !v.resultAssetId)
                    return [];
                if (claim.generation !== v.generation) {
                    process.stdout.write(`  task-complete: ${claim.hubTaskId} result is from an earlier claim (${v.generation ?? 'none'} ≠ ${claim.generation}); not reporting it\n`);
                    return [];
                }
                return [{ hubTaskId: claim.hubTaskId, resultAssetId: v.resultAssetId, generation: claim.generation }];
            });
            if (failed && solo && hubDone.length > 0) {
                process.stdout.write(`  task-complete: holding ${hubDone.length} report(s) — this cycle rolls back\n`);
            }
            else {
                for (const task of hubDone) {
                    const ack = await taskReceiver.complete(task.hubTaskId, task.resultAssetId, task.generation);
                    process.stdout.write(`  task-complete: ${task.hubTaskId} ${completionLine(ack, task.resultAssetId)}\n`);
                }
            }
        }
        // Evidence-based auto-promote (#306 phase 2): after a pass, a probation gene that has proven itself (>= K clean
        // successes, 0 failures) is auto-approved — the cross-AI loop self-closes without a human quality gate. Bad ones
        // stay quarantined / get banned. Best-effort: promotion never breaks the loop. Only when probation is opted in.
        if (probationOn) {
            try {
                const promoted = await algo.autoPromoteProbationGenes(store, review);
                if (promoted.length > 0)
                    process.stdout.write(`  auto-promote: ${promoted.length} probation gene(s) proven → approved\n`);
            }
            catch { /* never break the loop on a promotion side-effect */ }
        }
        // Take work before delivering it: a task claimed this beat lands in the queue the
        // next pass reads, and the Hub only accepts delivery for tasks this node holds.
        // Debts before new work, and outside the receive switch: a claim taken by an earlier run
        // still owes the Hub its report, and a delivery the Hub never acknowledged gets
        // re-dispatched when the commitment expires. Turning the receiver off stops new work
        // only. A debt this beat just created is not due yet, so it waits for the next one.
        const requeued = await taskReceiver.retryQueueWrites();
        if (requeued.retried > 0 || requeued.dropped > 0)
            process.stdout.write(`  task-receiver: requeued=${requeued.queued}/${requeued.retried} still-unqueued=${requeued.pending}${requeued.dropped > 0 ? ` dropped=${requeued.dropped}` : ''}\n`);
        const owed = await taskReceiver.retryCompletions();
        if (owed.retried > 0)
            process.stdout.write(`  task-complete: retried=${owed.retried} reported=${owed.completed} abandoned=${owed.abandoned} owed=${owed.pending}${owed.unrecorded > 0 ? ` unrecorded=${owed.unrecorded}` : ''}\n`);
        for (const gone of owed.abandonedTasks) {
            // Dropped from the ledger after the retry budget: nothing will mention it again.
            process.stdout.write(`  task-complete: GAVE UP on ${gone.taskId} (asset ${gone.resultAssetId}) — ${gone.lastError}\n`);
        }
        if (guardedTaskReceiver) {
            const t = await guardedTaskReceiver();
            if (t && !('skipped' in t) && t.claimed && t.task) {
                process.stdout.write(`  task-receiver: ${t.reason} ${t.task.task_id}${t.commitmentDeadline ? ` until=${t.commitmentDeadline}` : ''}\n`);
            }
            else if (t && !('skipped' in t) && t.reason === 'claim_failed') {
                process.stdout.write(`  task-receiver: claim failed ${t.task?.task_id ?? ''} ${t.error ?? ''}\n`);
            }
            else if (t && !('skipped' in t) && t.reason === 'expired') {
                process.stdout.write(`  task-receiver: commitment on ${t.task?.task_id ?? ''} already expired, not resuming\n`);
            }
            else if (t && !('skipped' in t) && t.reason === 'fetch_failed') {
                process.stdout.write(`  task-receiver: fetch failed ${t.error ?? ''}\n`);
            }
            else if (t && !('skipped' in t) && t.reason === 'queue_failed') {
                process.stdout.write(`  task-receiver: claimed ${t.task?.task_id ?? ''} but could not queue it — ${t.error ?? ''}\n`);
            }
            else if (t && !('skipped' in t) && (t.seen > 0 || (t.rejected ?? 0) > 0)) {
                // The Hub had work but none of it was ours to take. Saying so is the only
                // way an operator can tell "fetching works" from "nothing ever ran".
                process.stdout.write(`  task-receiver: none (seen=${t.seen}${t.rejected ? ` rejected=${t.rejected}` : ''})\n`);
            }
        }
        if (guardedAtpAutoDeliver) {
            const d = await guardedAtpAutoDeliver();
            if (d && !('skipped' in d) && (d.delivered > 0 || d.terminalFailures > 0 || d.transientFailures > 0 || d.cooldownFailures > 0)) {
                process.stdout.write(`  atp-autodeliver: checked=${d.checked} delivered=${d.delivered} terminal=${d.terminalFailures} transient=${d.transientFailures} cooldown=${d.cooldownFailures}\n`);
            }
        }
        if (guardedDistill) {
            const d = await guardedDistill();
            if (d && !('skipped' in d))
                ingestionTelemetry = {
                    state: (d.parseFailures ?? 0) > 0 || (d.invalidJsonRows ?? 0) > 0 ? 'degraded' : 'observed',
                    lastTickAt: Date.now(), recorded: d.recorded, parseFailures: d.parseFailures ?? 0,
                };
            void submitDistillTickExplorationQuestion(hubQuestionLink, d).catch(() => undefined);
        }
        await runIdleLlmDistillForBeat(beat, guardedLlmDistill);
        await runIdleAntiGeneDistillForBeat(beat, guardedAntiGeneDistill);
        await runIdleTranscriptDistillForBeat(beat, guardedTranscriptDistill);
        return { failed };
    };
    // Solo tick wrapper: snapshot the target repo before each cycle; on a failed
    // cycle (a 'failed' verdict OR an unexpected throw) roll the repo back to the
    // snapshot and advance the circuit breaker. At the threshold, stop the loop
    // and exit non-zero — the wild loop's blind retry is replaced by a hard stop.
    // The resident loop swallows tick errors, so the breaker owns the exit here.
    const soloMax = solomode.soloMaxFails(process.env);
    let soloState = { consecutiveFailures: 0 };
    let soloTripped = false;
    const soloTick = async (beat) => {
        const snap = gitGuard.snapshot(soloRepoRoot);
        let ok = true;
        try {
            const r = await tick(beat);
            if (r.failed)
                ok = false;
        }
        catch (e) {
            ok = false;
            process.stderr.write(`[Solo] cycle 抛错：${e instanceof Error ? e.message : String(e)}\n`);
        }
        const b = breaker.step(soloState, ok, soloMax);
        soloState = b.state;
        if (!ok) {
            const rolledBack = gitGuard.rollbackTo(soloRepoRoot, snap);
            process.stdout.write(rolledBack
                ? `[Solo] cycle 失败，已 git 回滚目标仓到 ${String(snap).slice(0, 12)} (连续失败 ${soloState.consecutiveFailures}/${soloMax})\n`
                : `[Solo] cycle 失败且回滚未成功（无快照或 git 出错）。连续失败 ${soloState.consecutiveFailures}/${soloMax}\n`);
        }
        if (b.tripped && !soloTripped) {
            soloTripped = true;
            process.stderr.write(`[Solo] 连续失败 ${soloState.consecutiveFailures} 次达阈值，熔断停机（非盲重生）。\n`);
            // Stop scheduling, release the lock, and exit non-zero. Detached so we
            // don't await our own loop.stop() from inside a tick.
            void stopRuntime().catch((error) => {
                process.stderr.write(`[Solo] shutdown drain failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }).finally(() => { cleanupAutoexecRuntime(); process.exit(1); });
        }
        return { failed: !ok };
    };
    // Heartbeat (#106): record liveness + pacing on the AE spine for the WebUI console, THROTTLED so a fast poll does
    // not flood the log — emit on an intensity change or at most once per EVOLVER_HEARTBEAT_MS (default 60s).
    const heartbeatMinMs = Math.max(0, Number(process.env['EVOLVER_HEARTBEAT_MS'] ?? 60_000));
    let lastBeatAt = 0;
    let lastIntensity = '';
    let lastTickAt = 0;
    let lastTickOutcome = 'completed';
    await cursorRewrite.start?.();
    const loop = startResidentLoop({
        tick: async (beat) => {
            try {
                const result = await (solo ? soloTick(beat) : tick(beat));
                lastTickOutcome = !contextDeliveryTurnReady ? 'blocked' : result?.failed ? 'failed' : 'completed';
            }
            catch (error) {
                lastTickOutcome = 'failed';
                throw error;
            }
            finally {
                lastTickAt = Date.now();
            }
        },
        basePollMs: cfg.pollMs,
        idleAware: process.env['EVOLVER_IDLE_AWARE'] !== '0',
        onBeat: (b) => {
            // A later session-recovery turn may retain cleanup after SQL committed.
            // Neither heartbeat nor optional feedback may write through that owner.
            if (!contextDeliveryTurnReady || !contextDeliveryRootReady())
                return;
            const now = Date.now();
            if (!(b.intensity === lastIntensity && now - lastBeatAt < heartbeatMinMs)) {
                lastBeatAt = now;
                lastIntensity = b.intensity;
                void ingestor.ingest({
                    type: 'cycle.heartbeat', // a registered EVENT_TYPE (an unknown type would throw UnknownEventTypeError)
                    human: { title: `autoexec 心跳 (${b.intensity})`, severity: 'info' },
                    payload: { intensity: b.intensity, idleSeconds: b.idleSeconds, nextDelayMs: b.delayMs, runner: cfg.runner,
                        runtime: autoexecHeartbeatTelemetry(runtimeOwner, lastTickAt, lastTickOutcome, heartbeatMinMs, ingestionTelemetry) },
                    actor: { kind: 'machine', id: 'autoexec' },
                }).catch(() => { });
            }
            // Mandatory session ingestion and heartbeat admission precede synchronous
            // optional outbox checks; throttled beats still recover durable feedback.
            scheduleFeedbackDrain();
        },
    });
    // SIGINT/SIGTERM drain the in-flight beat before cleanup. SIGHUP cannot hot-reload this composition safely,
    // so it is explicit and non-destructive: keep running until the operator performs a normal restart.
    async function stopRuntime() {
        try {
            await loop.stop();
            await bus.drain();
        }
        finally {
            await cursorRewrite.stop?.();
        }
    }
    return await waitForAutoexecShutdown({ stop: stopRuntime, cleanup: cleanupAutoexecRuntime });
}