import { join } from 'node:path';
import { algo } from '@evomap/evolver-core';
import { LocalMemoryGraph, resolveLocalMemoryUserIdentity } from './localMemoryGraph.js';
import { kernelTriggerFeedbackBinding, readKernelTriggerFeedback } from './kernelTriggerFeedback.js';
import { createBoundTriggerFeedbackHub } from './triggerFeedbackHub.js';
import { synchronizeTriggerFeedback } from './triggerFeedbackSync.js';
import { recoverTriggerFeedback } from './triggerFeedbackRecovery.js';
const USAGE = 'evolver trigger-feedback (sync|get) --run-id <id> --json [--hub|--local-only] [--minimum-revision <n> --operation-id <id> --trigger-id <id>]\nevolver trigger-feedback recover --json [--local-only]\n';
export async function runTriggerFeedbackCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
        stdout(USAGE);
        return 0;
    }
    const command = argv[0];
    let runId;
    let json = false;
    let syncHub = false;
    let localOnly = false;
    let receiptOnly = false;
    let minimumRevision;
    let operationId;
    let triggerId;
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--json' && !json)
            json = true;
        else if (flag === '--hub' && !syncHub)
            syncHub = true;
        else if (flag === '--local-only' && !localOnly)
            localOnly = true;
        else if (flag === '--receipt-only' && !receiptOnly)
            receiptOnly = true;
        else if (flag === '--run-id' && runId === undefined && argv[i + 1] && !argv[i + 1].startsWith('--'))
            runId = argv[++i];
        else if (flag === '--minimum-revision' && minimumRevision === undefined && argv[i + 1])
            minimumRevision = Number(argv[++i]);
        else if (flag === '--operation-id' && operationId === undefined && argv[i + 1])
            operationId = argv[++i];
        else if (flag === '--trigger-id' && triggerId === undefined && argv[i + 1])
            triggerId = argv[++i];
        else {
            stderr(USAGE);
            return 2;
        }
    }
    const guarded = minimumRevision !== undefined || operationId !== undefined || triggerId !== undefined;
    if (!json || (receiptOnly && command !== 'get') || (syncHub && (command !== 'sync' || localOnly))
        || (command === 'recover' ? runId !== undefined || guarded : (command !== 'sync' && command !== 'get') || !runId?.trim() || Buffer.byteLength(runId) > 256)) {
        stderr(USAGE);
        return 2;
    }
    if (guarded && (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1 || !operationId?.trim() || !triggerId?.trim()
        || [operationId, triggerId].some((value) => value.startsWith('--') || Buffer.byteLength(value) > 256))) {
        stderr(USAGE);
        return 2;
    }
    const requireReceipt = (snapshot) => {
        if (guarded && (!snapshot.commit || snapshot.triggerId !== triggerId || snapshot.commit.revision < minimumRevision
            || (snapshot.commit.revision === minimumRevision && snapshot.commit.operationId !== operationId)))
            throw new Error('trigger_feedback_source_mismatch');
    };
    let graph;
    try {
        if (command === 'recover') {
            const report = await recoverTriggerFeedback(deps, localOnly);
            stdout(JSON.stringify(report) + '\n');
            return report.ok ? 0 : 1;
        }
        const env = { ...(deps.env ?? process.env) };
        const binding = kernelTriggerFeedbackBinding(env);
        const id = runId;
        const dir = join(binding.agentDir, 'evolver', 'evolution');
        graph = deps.createGraph?.(dir) ?? new LocalMemoryGraph({ dir, ...resolveLocalMemoryUserIdentity(dir) });
        let snapshot = await (deps.readKernel ?? readKernelTriggerFeedback)(binding, id);
        requireReceipt(snapshot);
        let transport;
        let remote;
        if (syncHub) {
            try {
                transport = (deps.createRemote ?? createBoundTriggerFeedbackHub)(binding, env);
            }
            catch (error) {
                remote = { status: 'unverified', reason: safeReason(error, 'trigger_feedback_destination_unbound') };
            }
            snapshot = await (deps.readKernel ?? readKernelTriggerFeedback)(binding, id);
            requireReceipt(snapshot);
        }
        let local = command === 'sync' ? graph.applyKernelTriggerFeedback(snapshot, transport?.destinationId) : graph.readTriggerFeedback(id);
        const captured = graph.readTriggerFeedback(id);
        if (captured)
            snapshot = algo.updateTriggerFeedbackState(captured, snapshot).snapshot;
        const delivery = graph.readTriggerFeedbackDelivery(id);
        const remoteRequired = syncHub || delivery !== null;
        if (command === 'sync' && remoteRequired && !localOnly && !remote) {
            try {
                transport ??= (deps.createRemote ?? createBoundTriggerFeedbackHub)(binding, env);
                const synchronized = await synchronizeTriggerFeedback({ snapshot, graph, remote: transport,
                    readKernel: () => (deps.readKernel ?? readKernelTriggerFeedback)(binding, id), requireReceipt,
                    local: local, force: syncHub });
                snapshot = synchronized.snapshot;
                local = synchronized.local;
                remote = synchronized.remote;
            }
            catch (error) {
                remote = { status: 'unverified', reason: safeReason(error, 'trigger_feedback_hub_unverified') };
            }
        }
        else if (remoteRequired && localOnly) {
            remote = { status: 'unverified', reason: 'trigger_feedback_publish_suspended' };
        }
        else if (command === 'get' && delivery) {
            try {
                transport ??= (deps.createRemote ?? createBoundTriggerFeedbackHub)(binding, env);
                remote = transport.isCurrent() && transport.destinationId === delivery.destinationId && delivery.status === 'confirmed'
                    && delivery.acknowledgedRevision === (snapshot.commit?.revision ?? 0)
                    ? { status: 'confirmed', from: 'durable-receipt' } : { status: 'unverified', reason: delivery.reason ?? 'trigger_feedback_hub_unverified' };
            }
            catch (error) {
                remote = { status: 'unverified', reason: safeReason(error, 'trigger_feedback_destination_unbound') };
            }
        }
        const ok = command === 'get' || localOnly || remote === undefined || remote.status === 'confirmed';
        const localCommitted = command === 'sync' || Boolean(local && 'snapshot' in local && JSON.stringify(local.snapshot) === JSON.stringify(snapshot));
        const outputLocal = receiptOnly && local && 'snapshot' in local ? { committed: local.snapshot.commit } : local;
        stdout(JSON.stringify({ ok, schemaVersion: 1, runId: id, command, canonical: snapshot.commit, local: outputLocal, localCommitted,
            sourceAvailable: graph.triggerFeedbackSourceAvailable(id), remoteRequired, remote,
            delivery: graph.readTriggerFeedbackDelivery(id), effectiveScore: algo.triggerEffectiveScore(snapshot) }) + '\n');
        return ok ? 0 : 1;
    }
    catch (error) {
        if (graph && runId) {
            try {
                graph.markTriggerFeedbackSourceUnavailable(runId);
            }
            catch { /* Preserve the original failure and existing records. */ }
        }
        const reason = error instanceof algo.TriggerFeedbackConflictError ? error.code : safeReason(error, 'trigger_feedback_local_unverified');
        stdout(JSON.stringify({ ok: false, command, runId, reason }) + '\n');
        return 1;
    }
}
function safeReason(error, fallback) {
    return error instanceof Error && /^trigger_feedback_[a-z_]+$/.test(error.message) ? error.message : fallback;
}