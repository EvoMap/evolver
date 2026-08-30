// `evolver autoexec` — the deployable form of the autonomous-exec daemon. A resident loop that drains a
// directory task queue through the productized kernel (exec.runAutoExecTask) with all safety controls, guarded
// by single-flight so a slow pass never stacks. DENY-BY-DEFAULT: allowedRoots starts empty (refuses every
// repo) until the operator explicitly allowlists one — autonomous edits to a real repo never happen by accident.
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { events, assetstore, algo, exec, ops, observers, hooks, material as materialNs, util, verify, hub as hubNs, daemon as daemonNs, personality, signals as signalNs } from '@evomap/evolver-core';
import { runRequiredSandboxedValidation } from './requiredSandboxValidation.js';
import { startResidentLoop } from './daemonLoop.js';
import { connectPublicHub, createSolidifyPermitCheck, getMinReuseScore, ReuseCache, reuseBeforeSolve, resolveConfiguredHubUrl, resolveHubUrl, searchHubMetadata, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv, proxyClientFromEnv } from '@evomap/evolver-mcp';
import { resolveValueDigestObserver } from './valueDigest.js';
import { resolveReflectionObserver } from './reflectionObserver.js';
import { resolveCursorRewriteObserver } from './cursorRewrite.js';
import { resolveMemoryEventMirrorObserver } from './memoryEventMirror.js';
import { resolveDistillObserver } from './distillObserver.js';
import { resolveAutoDistillLlm } from './autoDistillLlm.js';
import { resolveAutoDistillAntiGene as resolveAntiGeneDistill } from './autoDistillAntiGene.js';
import { runTranscriptDistillTick, transcriptDistillMode } from './autoDistillTranscript.js';
import { runSessionIngestTick, scanSessionDirs } from './sessionIngest.js';
import { LocalMemoryGraph, resolveLocalMemoryUserIdentity } from './localMemoryGraph.js';
import { resolveAtpAutoDeliver } from './atpAutoDeliver.js';
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
const AMBIGUOUS_RECOVERY_REASON = 'autoexec_crash_recovery_ambiguous: execution may have started before shutdown; refusing automatic retry, explicitly requeue after inspecting prior side effects';
function receiptDir(dirs) {
    return join(dirs.base, 'receipts');
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
    cleanupReceiptArtifacts(dirs, (claimName) => !activeClaims.has(claimName));
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
        if (receipt.claimName !== claim.name
            || (receipt.destination !== 'done' && receipt.destination !== 'refused')
            || !isAutoExecVerdict(receipt.verdict, taskId))
            return null;
        const expectedDestination = receipt.verdict.status === 'refused' || receipt.verdict.status === 'unsafe_to_replay' ? 'refused' : 'done';
        if (receipt.destination !== expectedDestination)
            return null;
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
    try {
        writeFileSync(tempPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx' });
        renameSync(tempPath, receiptPath);
    }
    finally {
        try {
            if (lstatSync(tempPath).isFile())
                unlinkSync(tempPath);
        }
        catch {
            // The atomic rename normally removes the temp path.
        }
    }
}
function recoverAmbiguousClaim(dirs, claim) {
    const taskPath = join(dirs.inflight, claim.name);
    let taskId = `recovery-${claim.name.slice(0, 64)}`;
    try {
        taskId = exec.normalizeAutoExecTask(JSON.parse(readFileSync(taskPath, 'utf8'))).id;
    }
    catch {
        // The task may have been only partially published before the prior process stopped.
    }
    const receipt = persistedClaimReceipt(dirs, claim, taskId);
    if (receipt) {
        const dest = receipt.destination === 'refused' ? dirs.refused : dirs.done;
        const canonicalVerdict = join(dest, claim.originalName);
        writeFileSync(canonicalVerdict, JSON.stringify(receipt.verdict, null, 2));
        renameSync(taskPath, archiveTaskPath(dest, claim.originalName, claim.name));
        cleanupCommittedClaimReceipt(dirs, claim.name);
        return receipt.verdict;
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
    cleanupOrphanReceiptArtifacts(dirs);
    const pendingClaims = existingClaims.filter((claim) => claim.phase === 'claimed');
    const out = [];
    for (const claim of existingClaims.filter((item) => item.phase !== 'claimed')) {
        try {
            out.push(recoverAmbiguousClaim(dirs, claim));
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
        const v = await runOne(task).catch((e) => ({ taskId: task.id, status: 'failed', reason: e instanceof Error ? e.message : String(e) }));
        const destination = v.status === 'refused' || v.status === 'unsafe_to_replay' ? 'refused' : 'done';
        const dest = destination === 'refused' ? dirs.refused : dirs.done;
        persistClaimReceipt(dirs, { claimName: startedName, destination, verdict: v });
        writeFileSync(join(dest, claim.originalName), JSON.stringify(v, null, 2));
        renameSync(startedPath, archiveTaskPath(dest, claim.originalName, startedName));
        cleanupCommittedClaimReceipt(dirs, startedName);
        out.push(v);
    }
    cleanupOrphanReceiptArtifacts(dirs);
    return out;
}
/** Keep unsupported built-in runners away from the execution queue without stopping the resident daemon. */
export function runnerBoundAutoExecPass(runner, dirs, runOne) {
    return () => autoExecPass(dirs, runOne, { executePendingTasks: runner === 'gemini' });
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
export function makeHubReuseSeam(cap, cache, ingestor, onAssetReused, onVerifiedSearchMiss, audit = {}) {
    return async (signals, ctx) => {
        const searchSignals = normalizedCapabilityGapSignals(signals);
        // Pending value.reuse_hit ingests (#112). The onReuseHit callback is synchronous, so it cannot await the
        // ingest itself; it stashes the (error-swallowing) promise here and the seam awaits them before returning,
        // making the emission deterministically durable without letting an ingest error ever break reuse.
        const pending = [];
        const r = await reuseBeforeSolve(cap, cache, searchSignals, {
            ...(ctx?.cycleId ? { cycleId: ctx.cycleId } : {}),
            ...(audit.env ? { env: audit.env } : {}),
            // Two consumers hang off a reuse HIT:
            //  - value-ledger emission (#112): a `value.reuse_hit` root_event so the ledger derives a real
            //    source=reuse entry (refs → assetId + cycleId) — live wiring, not a fixture;
            //  - used-asset tracking: the assetId feeds the fetch->outcome attribution claim the outcome
            //    report sends back to the hub (used_asset_ids). Fires on cache hits too — a cached payload
            //    is still a USE of that asset.
            onReuseHit: (hit) => {
                try {
                    onAssetReused?.(hit.assetId);
                }
                catch { /* tracking must never break reuse */ }
                if (ingestor)
                    pending.push(emitReuseHit(ingestor, hit));
            },
        });
        if (pending.length > 0)
            await Promise.all(pending); // emitReuseHit never rejects (it swallows ingest errors)
        const runId = ctx?.cycleId ?? null;
        const taskId = runId?.startsWith('autoexec-') ? runId.slice('autoexec-'.length) : undefined;
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
/** Append a `value.reuse_hit` root_event for a reuse hit (#112). Never throws (reuse stays an optimization). */
async function emitReuseHit(ingestor, hit) {
    try {
        const payload = {
            assetId: hit.assetId, cycleId: hit.cycleId, signalFingerprint: hit.signalFingerprint, fetchTokens: hit.fetchTokens,
        };
        await ingestor.ingest({
            type: ops.VALUE_REUSE_HIT_EVENT,
            human: { title: `reuse hit: ${hit.assetId}`, detail: `cycle ${hit.cycleId}` },
            payload: payload,
        });
    }
    catch { /* emission must never break the reuse path */ }
}
/**
 * Append a `value.inject` root_event for a SessionStart gene injection (#123). Attribution-only — the payload
 * carries the injected gene ids (+ cycle/outcome when known) and NO savings number, exactly per the ledger's
 * weakest-signal contract. Never throws: injection is the agent's critical path, so a failed emission is
 * swallowed (the genes are still injected). Skips an empty gene set — there is nothing to attribute.
 */
export async function emitInject(ingestor, info) {
    try {
        if (info.geneIds.length === 0)
            return;
        const payload = {
            geneIds: info.geneIds,
            ...(info.cycleId ? { cycleId: info.cycleId } : {}),
            ...(info.sessionId ? { sessionId: info.sessionId } : {}),
            ...(info.outcome ? { outcome: info.outcome } : {}),
        };
        await ingestor.ingest({
            type: ops.VALUE_INJECT_EVENT,
            human: { title: `injected ${info.geneIds.length} gene(s)`, ...(info.cycleId ? { detail: `cycle ${info.cycleId}` } : {}) },
            payload: payload,
        });
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
    if (links.questions && verdictToOutcomeStatus(verdict.status) !== null && shouldSubmitProactiveQuestionsForTask(task)) {
        void links.questions.submitForTask(task).catch(() => undefined);
    }
    if (links.outcome)
        void links.outcome.reportOutcome(task, verdict).catch(() => undefined);
}
/**
 * Compose the reuse seam and the outcome reporter. Reuse HITs still emit value-ledger observability, but the
 * Hub outcome `used_asset_ids` claim comes only from the finished verdict's selected/executed asset. A fetched
 * candidate can be withheld by trust/review gates or lose selection, so fetch-time attribution would overclaim.
 * Reporting never throws and never blocks the verdict.
 */
export function makeHubLink(cap, ingestor, reportEnabled = true, onVerifiedSearchMiss, assetLog, env) {
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
            searchHitsByRun.set(hit.runId, new Map([[hit.assetId, hit]]));
        },
    });
    return {
        seam,
        reportOutcome: async (task, verdict) => {
            const status = verdictToOutcomeStatus(verdict.status);
            const runId = `autoexec-${task.id}`;
            const searchHits = searchHitsByRun.get(runId);
            searchHitsByRun.delete(runId);
            const usedAssetIds = Array.isArray(verdict.usedAssetIds)
                ? [...new Set(verdict.usedAssetIds.filter((id) => typeof id === 'string' && id.length > 0))]
                : [];
            // Drain attribution synchronously (before a duplicate task id can start), then yield before the production
            // sink's synchronous append and all Hub I/O. The detached side effect cannot delay routing to done/.
            await new Promise((resolve) => { setImmediate(resolve); });
            if (status !== null) {
                for (const assetId of usedAssetIds) {
                    const hit = searchHits?.get(assetId);
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
                await cap.recordOutcome({
                    signals: task.signals,
                    status,
                    ...(verdict.outcome?.score !== undefined ? { score: verdict.outcome.score } : {}),
                    ...(usedAssetIds.length > 0 ? { usedAssetIds } : {}),
                });
            }
            catch { /* recordOutcome never throws by contract; belt-and-braces — reporting must never break the pass */ }
            if (usedAssetIds.length > 0 && cap.recordReuseResult) {
                await Promise.all(usedAssetIds.map(async (assetId) => {
                    try {
                        const receipt = await cap.recordReuseResult?.({
                            assetId,
                            outcome: status === 'success' ? 'success' : 'failed',
                            taskId: task.id,
                            ...(verdict.reason ? { reason: verdict.reason } : {}),
                        });
                        appendAssetCallBestEffort(assetLog, {
                            run_id: runId,
                            action: receipt?.recorded ? 'hub_review_submitted' : 'hub_review_rejected',
                            asset_id: assetId,
                            signals: task.signals,
                            ...(safeAssetCallReason(receipt?.reason) ? { reason: safeAssetCallReason(receipt?.reason) } : {}),
                            extra: { task_id: task.id, outcome_status: status, ...(receipt?.id ? { receipt_id: receipt.id } : {}) },
                        });
                    }
                    catch {
                        appendAssetCallBestEffort(assetLog, {
                            run_id: runId,
                            action: 'hub_review_failed',
                            asset_id: assetId,
                            signals: task.signals,
                            reason: 'record_reuse_result_failed',
                            extra: { task_id: task.id, outcome_status: status },
                        });
                    }
                }));
            }
        },
    };
}
function safeAssetCallReason(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}
function resolvePublicHub(env = process.env, connectHub = connectPublicHub) {
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
        const { hub } = connectHub({ hubUrl, authMode: 'oauth', evomapDir: dir, senderId: () => resolvedSenderId });
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
        return proxy ? makeHubLink(makeProxyHubCapability(proxy), ingestor, env['EVOLVER_OUTCOME_REPORT'] !== '0', undefined, resolvedAssetLog, env) : undefined;
    }
    const hub = resolvePublicHub(env, connectHub);
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
    // Pass the ingestor so a reuse hit emits a value.reuse_hit root_event (#112) — the live source the value
    // ledger derives source=reuse entries from.
    return makeHubLink(hub, ingestor, env['EVOLVER_OUTCOME_REPORT'] !== '0', onVerifiedSearchMiss, resolvedAssetLog, env);
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
    const source = Object.keys(payload).length > 0 ? payload : r;
    return {
        recorded: source['recorded'] !== false && source['ok'] !== false,
        ...(typeof source['reason'] === 'string' ? { reason: source['reason'] } : {}),
        ...(typeof source['id'] === 'string' ? { id: source['id'] } : {}),
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
    const tick = () => runSessionIngestTick(sessionDirs, { materialStore, watermarkStore, ingestor: opts.ingestor });
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
    if (cfg.runner !== 'gemini') {
        process.stderr.write('evolver autoexec: execute queue is disabled for the configured built-in runner; non-execution daemon duties remain active. Set "runner":"gemini" only after reviewing its experimental capability boundary\n');
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
    // reporter closes the loop by sending the cycle outcome + used-asset claim back to the hub.
    let atpAutoBuyer;
    const onVerifiedHubSearchMiss = (miss) => {
        // Resolve lazily: the first-run consent prompt happens after the daemon lock is acquired below, while Hub
        // composition happens here. A later verified miss therefore observes the newly recorded consent correctly.
        atpAutoBuyer ??= resolveAtpAutoBuyer(process.env);
        if (atpAutoBuyer)
            scheduleAtpAutoBuyForVerifiedMiss(miss, atpAutoBuyer);
    };
    const hubLink = resolveHubLink(process.env, ingestor, connectPublicHub, onVerifiedHubSearchMiss);
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
        ...(hubLink ? { hubReuse: hubLink.seam } : {}),
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
    const runOne = async (task) => {
        // One read of root_events (per pass) feeds BOTH rails: reported reuse outcomes (#268) and observed recall (#274
        // slice 3, folded at a lower weight). value.recall rides the SAME flag — it is the same soft re-order actuator.
        const evts = reuseSignalOn ? events.readEvents(events.rootEventsPath()) : null;
        const taskDeps = evts
            ? { ...deps, reuseOutcomes: ops.summarizeReuseOutcomes(evts), recallEvents: evts.filter((e) => e.type === ops.VALUE_RECALL_EVENT) }
            : deps;
        const v = await exec.runAutoExecTask(taskDeps, task, safety);
        // Hub writes are best-effort side effects. Schedule them after the verdict exists, but never hold the queue's
        // task->done move on network I/O or hub availability.
        scheduleAutoExecHubSideEffects(task, v, { questions: hubQuestionLink, outcome: hubLink });
        return v;
    };
    const guarded = exec.singleFlight(runnerBoundAutoExecPass(cfg.runner, dirs, runOne));
    // Auto-distill producer+consumer (#106): register the distillObserver on THIS bus, then a producer tick scans
    // the session dirs and records material on THIS Ingestor → material.batch_ready → observer drafts a quarantined
    // gene (A1) → human `review --approve` lifts it into inject/cursor (A2a/A2b). Off via EVOLVER_AUTO_DISTILL=0.
    const distill = resolveDistillProducer(process.env, { ingestor, store, review });
    if (distill.observer)
        bus.register(distill.observer);
    const llmDistill = resolveAutoDistillLlm(process.env, { store, review, ingestor, cwd: process.cwd() });
    const antiGeneDistill = resolveAutoDistillAntiGene(process.env, { store, review, ingestor });
    const transcriptDistill = resolveAutoDistillTranscript(process.env, { store, review, ingestor });
    const atpAutoDeliver = resolveAtpAutoDeliver(process.env);
    const uninstallBrokenPipeGuards = installAutoexecBrokenPipeGuards();
    const reuseEnabled = process.env['EVOLVER_REUSE_BEFORE_SOLVE'] === '1' && hubLink !== undefined;
    process.stdout.write(`evolver autoexec: runner=${cfg.runner} queue=${dirs.tasks} allowlist=${JSON.stringify(cfg.allowedRoots)} poll=${cfg.pollMs}ms reuse=${reuseEnabled ? 'on' : 'off'} reuse-signal=${reuseSignalOn ? 'on' : 'off'} semantic-idf=${semanticIdfOn ? 'on' : 'off'} selection-policy=${selectionPolicy} selection-guard=${selectionGuard} selection-floor=${selectionFloor === undefined ? 'unset' : selectionFloor} probation=${probationOn ? 'on' : 'off'} questions=${hubQuestionLink ? 'on' : 'off'} permit=${solidifyPermit ? 'on' : 'off'} value-digest=${digest.enabled ? 'on' : 'off'} reflection=${reflection.enabled ? 'on' : 'off'} learning-trace=${learningTrace.enabled ? `on(upload=${learningTrace.upload})` : 'off'} memory-event-mirror=${memoryEventMirror.enabled ? 'on' : `off(${memoryEventMirror.reason ?? 'no_hub'})`} cursor-rewrite=${cursorRewrite.enabled ? 'on' : `off(${cursorRewrite.reason})`} auto-distill=${distill.enabled ? 'on' : 'off'} auto-distill-llm=${llmDistill.enabled ? llmDistill.mode : 'off'} auto-distill-anti-gene=${antiGeneDistill.enabled ? antiGeneDistill.mode : 'off'} auto-distill-transcript=${transcriptDistill.enabled ? transcriptDistill.mode : 'off'} atp-autodeliver=${atpAutoDeliver.enabled ? 'on' : `off(${atpAutoDeliver.reason})`}\n`);
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
    try {
        util.acquireLock(lockPath, { maxTries: 5 });
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
    const guardedLlmDistill = llmDistill.enabled ? exec.singleFlight(() => llmDistill.tick()) : null;
    const guardedAntiGeneDistill = antiGeneDistill.enabled ? exec.singleFlight(() => antiGeneDistill.tick()) : null;
    const guardedTranscriptDistill = transcriptDistill.enabled ? exec.singleFlight(() => transcriptDistill.tick()) : null;
    const guardedAtpAutoDeliver = atpAutoDeliver.enabled ? exec.singleFlight(() => atpAutoDeliver.tick()) : null;
    if (distill.observer)
        distill.observer.kick(); // recover any un-acked backlog from a prior run (restart)
    // One idle-aware resident beat runs the exec pass, ATP auto-delivery, THEN the distill scan (single-flight
    // guarded). Idle-aware pacing (#106): an idle machine polls more often, an active one backs off to the base
    // cadence. Off via EVOLVER_IDLE_AWARE=0 → fixed cfg.pollMs (exactly the previous behavior).
    const tick = async (beat) => {
        let failed = false;
        const r = await guarded();
        if (r && !('skipped' in r) && r.length) {
            process.stdout.write(`  pass: ${r.map((v) => `${v.taskId}=${v.status}`).join(' ')}\n`);
            // A cycle "failed" (for solo rollback) when a task's self-edit did not
            // solidify cleanly — i.e. any verdict is 'failed'. 'refused' (deny-by-
            // default / not in allowlist) is a no-op, not a broken edit.
            if (r.some((v) => v.status === 'failed'))
                failed = true;
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
        if (guardedAtpAutoDeliver) {
            const d = await guardedAtpAutoDeliver();
            if (d && !('skipped' in d) && (d.delivered > 0 || d.terminalFailures > 0 || d.transientFailures > 0 || d.cooldownFailures > 0)) {
                process.stdout.write(`  atp-autodeliver: checked=${d.checked} delivered=${d.delivered} terminal=${d.terminalFailures} transient=${d.transientFailures} cooldown=${d.cooldownFailures}\n`);
            }
        }
        if (guardedDistill) {
            const d = await guardedDistill();
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
            void loop.stop().then(() => { cleanupAutoexecRuntime(); process.exit(1); });
        }
    };
    // Heartbeat (#106): record liveness + pacing on the AE spine for the WebUI console, THROTTLED so a fast poll does
    // not flood the log — emit on an intensity change or at most once per EVOLVER_HEARTBEAT_MS (default 60s).
    const heartbeatMinMs = Math.max(0, Number(process.env['EVOLVER_HEARTBEAT_MS'] ?? 60_000));
    let lastBeatAt = 0;
    let lastIntensity = '';
    const loop = startResidentLoop({
        tick: solo ? soloTick : tick,
        basePollMs: cfg.pollMs,
        idleAware: process.env['EVOLVER_IDLE_AWARE'] !== '0',
        onBeat: (b) => {
            const now = Date.now();
            if (b.intensity === lastIntensity && now - lastBeatAt < heartbeatMinMs)
                return;
            lastBeatAt = now;
            lastIntensity = b.intensity;
            void ingestor.ingest({
                type: 'cycle.heartbeat', // a registered EVENT_TYPE (an unknown type would throw UnknownEventTypeError)
                human: { title: `autoexec 心跳 (${b.intensity})`, severity: 'info' },
                payload: { intensity: b.intensity, idleSeconds: b.idleSeconds, nextDelayMs: b.delayMs, runner: cfg.runner },
                actor: { kind: 'machine', id: 'autoexec' },
            }).catch(() => { });
        },
    });
    // SIGINT/SIGTERM drain the in-flight beat before cleanup. SIGHUP cannot hot-reload this composition safely,
    // so it is explicit and non-destructive: keep running until the operator performs a normal restart.
    return await waitForAutoexecShutdown({ stop: loop.stop, cleanup: cleanupAutoexecRuntime });
}