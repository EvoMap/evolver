import { algo } from '@evomap/evolver-core';
import { advanceTriggerFeedbackDelivery, parseTriggerFeedbackDelivery } from './triggerFeedbackSyncState.js';
export const TRIGGER_FEEDBACK_FILE = 'memory_graph.trigger_feedback.json';
export const MAX_TRIGGER_FEEDBACK_BYTES = 32 * 1024 * 1024;
const MAX_TRIGGER_FEEDBACK_ROWS = 20_000;
export function readLocalTriggerFeedback(bytes) {
    if (bytes === null)
        return { version: 2, rows: [] };
    if (bytes.length > MAX_TRIGGER_FEEDBACK_BYTES)
        throw new Error('trigger_feedback_capacity');
    const raw = JSON.parse(bytes.toString('utf8'));
    const file = object(raw);
    if ((file['version'] !== 1 && file['version'] !== 2) || !Array.isArray(file['rows']) || file['rows'].length > MAX_TRIGGER_FEEDBACK_ROWS)
        throw new Error('trigger_feedback_invalid_store');
    const keys = new Set();
    const rows = file['rows'].map((rawRow) => {
        const row = object(rawRow);
        const userScope = scope(row['userScope']);
        const workspaceScope = row['workspaceScope'] === null ? null : scope(row['workspaceScope']);
        const epochId = text(row['epochId']);
        const stateRaw = object(row['state']);
        if (stateRaw['version'] !== 1 || !Array.isArray(stateRaw['operations']) || stateRaw['operations'].length > 1024)
            throw new Error('trigger_feedback_invalid_store');
        const snapshot = parseStoredSnapshot(stateRaw['snapshot']);
        const operations = stateRaw['operations'].map((operation) => {
            const parsed = parseStoredSnapshot({ ...snapshot, commit: operation });
            if (!parsed.commit)
                throw new Error('trigger_feedback_invalid_store');
            return parsed.commit;
        });
        let revision = 0;
        const operationIds = new Set();
        for (const operation of operations) {
            if (operation.revision <= revision || operationIds.has(operation.operationId))
                throw new Error('trigger_feedback_invalid_store');
            revision = operation.revision;
            operationIds.add(operation.operationId);
        }
        if (JSON.stringify(operations.at(-1) ?? null) !== JSON.stringify(snapshot.commit))
            throw new Error('trigger_feedback_invalid_store');
        const key = JSON.stringify([userScope, snapshot.runId]);
        if (keys.has(key))
            throw new Error('trigger_feedback_invalid_store');
        keys.add(key);
        const delivery = parseTriggerFeedbackDelivery(row['delivery']);
        if (delivery && delivery.desiredRevision > (snapshot.commit?.revision ?? 0))
            throw new Error('trigger_feedback_invalid_store');
        if (row['sourceAvailable'] !== undefined && typeof row['sourceAvailable'] !== 'boolean')
            throw new Error('trigger_feedback_invalid_store');
        return { userScope, workspaceScope, epochId, state: { version: 1, snapshot, operations }, ...(delivery ? { delivery } : {}), ...(row['sourceAvailable'] !== undefined ? { sourceAvailable: row['sourceAvailable'] } : {}) };
    });
    const parseCursors = (raw) => {
        if (raw === undefined)
            return undefined;
        const cursors = object(raw);
        if (Object.keys(cursors).length > MAX_TRIGGER_FEEDBACK_ROWS)
            throw new Error('trigger_feedback_capacity');
        return Object.fromEntries(Object.entries(cursors).map(([user, after]) => [scope(user), after === null ? null : text(after)]));
    };
    const recoveryCursors = parseCursors(file['recoveryCursors']);
    const deliveryCursors = parseCursors(file['deliveryCursors']);
    return { version: 2, rows, ...(recoveryCursors ? { recoveryCursors } : {}), ...(deliveryCursors ? { deliveryCursors } : {}) };
}
export function upsertLocalTriggerFeedback(file, snapshot, owner) {
    const index = file.rows.findIndex((row) => row.userScope === owner.userScope && row.state.snapshot.runId === snapshot.runId);
    const prior = file.rows[index];
    if (prior?.workspaceScope !== undefined && prior.workspaceScope !== null && owner.workspaceScope !== null && prior.workspaceScope !== owner.workspaceScope) {
        throw new algo.TriggerFeedbackConflictError('baseline_conflict');
    }
    const state = algo.updateTriggerFeedbackState(prior?.state, snapshot);
    const resetSuppressed = Boolean(prior && prior.epochId !== owner.epochId && (snapshot.commit?.revision ?? 0) === (prior.state.snapshot.commit?.revision ?? 0));
    const row = {
        ...owner, workspaceScope: owner.workspaceScope ?? prior?.workspaceScope ?? null,
        epochId: resetSuppressed ? prior.epochId : owner.epochId, state,
        ...(prior?.delivery ? { delivery: advanceTriggerFeedbackDelivery(prior.delivery, snapshot, owner.epochId) } : {}),
        sourceAvailable: true,
    };
    const changed = JSON.stringify(row) !== JSON.stringify(prior);
    if (!changed)
        return { file, changed, row, resetSuppressed };
    if (!prior && file.rows.length >= MAX_TRIGGER_FEEDBACK_ROWS)
        throw new Error('trigger_feedback_capacity');
    const rows = [...file.rows];
    if (index >= 0)
        rows[index] = row;
    else
        rows.push(row);
    rows.sort((left, right) => left.userScope.localeCompare(right.userScope) || left.state.snapshot.runId.localeCompare(right.state.snapshot.runId));
    return { file: { ...file, version: 2, rows }, changed, row, resetSuppressed };
}
export function triggerFeedbackRecords(file, userScopes, workspaceScope, epochId) {
    return file.rows.flatMap((row) => {
        if (!userScopes.has(row.userScope) || row.workspaceScope !== workspaceScope || row.epochId !== epochId || row.sourceAvailable === false)
            return [];
        const snapshot = row.state.snapshot;
        const fitness = algo.triggerEffectiveScore(snapshot);
        if (fitness === null || snapshot.evaluatedAt === null || snapshot.learningEligible === false)
            return [];
        const signals = algo.normalizeMemorySignals(snapshot.signals);
        return snapshot.genes.map((geneId) => ({
            version: 2, kind: 'outcome', provenance: 'v2_local', workspaceScope, userScope: row.userScope,
            signalFingerprint: algo.memorySignalFingerprint(signals), signals, geneId,
            status: snapshot.machine?.status === 'success' ? 'success' : 'failed', score: fitness, fitness, at: snapshot.evaluatedAt,
        }));
    });
}
function parseStoredSnapshot(raw) {
    const row = object(raw);
    const commit = row['commit'] === null ? null : object(row['commit']);
    const machine = row['machine'] === null ? null : object(row['machine']);
    return algo.parseKernelTriggerFeedback({
        schema_version: row['schemaVersion'], run_id: row['runId'], trigger_id: row['triggerId'],
        committed: commit && { run_id: commit['runId'], trigger_id: commit['triggerId'], revision: commit['revision'], operation_id: commit['operationId'], rating: commit['rating'] },
        machine_outcome: machine && { status: machine['status'], score: machine['score'], user_override: machine['override'], override_source: { kind: machine['overrideSource'] } },
        baseline_event_id: row['baselineEventId'], evaluated_at: row['evaluatedAt'], genes_used: row['genes'], signals: row['signals'], workspace: row['workspace'], learning_eligible: row['learningEligible'],
    }, text(row['runId']));
}
function object(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('trigger_feedback_invalid_store');
    return raw;
}
function text(raw) { if (typeof raw !== 'string' || !raw.trim() || raw.length > 256)
    throw new Error('trigger_feedback_invalid_store'); return raw; }
function scope(raw) { const value = text(raw); if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error('trigger_feedback_invalid_scope'); return value; }