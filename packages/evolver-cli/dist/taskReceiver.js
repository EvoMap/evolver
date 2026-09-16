/**
 * taskReceiver — pulls tasks the Hub offers this node, scores them, claims the
 * one worth doing, and shapes it for the execute queue.
 *
 * Ported from evolver v1 (`src/gep/taskReceiver.js`), which v2 dropped: the
 * adapter kept `listMyTasks` but nothing could fetch, score, claim or complete,
 * so a v2 node saw its tasks and could never take one.
 */
import { randomUUID } from 'node:crypto';
import { AtpHubClient } from '@evomap/evolver-adapter-public';
import { createAtpClientFromEnv, resolveAtpSenderId } from './atp.js';
import { completionLedgerPath, defaultReadQueueTask, defaultWriteQueueTask, fileClaim, liveCommitments, rememberUnqueued, unsentCommitments, HUB_QUEUE_PREFIX, } from './taskCommitments.js';
export { COMPLETION_LEDGER_FILENAME, HUB_QUEUE_PREFIX, completionLedgerPath, hubTaskIdOf, readCompletionLedger, } from './taskCommitments.js';
export const TASK_STRATEGIES = ['greedy', 'balanced', 'conservative'];
const STRATEGY_WEIGHTS = {
    greedy: { roi: 0.1, capability: 0.05, completion: 0.05, bounty: 0.8 },
    balanced: { roi: 0.35, capability: 0.3, completion: 0.2, bounty: 0.15 },
    conservative: { roi: 0.25, capability: 0.45, completion: 0.25, bounty: 0.05 },
};
const MIN_COMMITMENT_MS = 5 * 60_000;
const MAX_COMMITMENT_MS = 24 * 60 * 60_000;
const DEADLINE_SAFETY_MS = 60_000;
const DIFFICULTY_DURATION = [
    { threshold: 0.3, durationMs: 15 * 60_000 },
    { threshold: 0.5, durationMs: 30 * 60_000 },
    { threshold: 0.7, durationMs: 60 * 60_000 },
    { threshold: 1.0, durationMs: 120 * 60_000 },
];
const ROI_REFERENCE = 200;
const BOUNTY_REFERENCE = 100;
const SIGNAL_SIMILARITY_FLOOR = 0.15;
const HISTORY_WINDOW = 200;
/**
 * The node's own record of what it has finished, folded out of the cycle log: each terminal
 * cycle joined to the signals that drove it. Without this, capability matching scores every
 * task against an empty history and the strategy weights never touch a real decision.
 */
export function memoryEventsFromCycleLog(events, window = HISTORY_WINDOW) {
    const statusByCycle = new Map();
    const signalsByCycle = new Map();
    for (const event of events) {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
        const cycleId = typeof payload?.['cycleId'] === 'string' ? payload['cycleId'] : null;
        if (!cycleId)
            continue;
        if (event.type === 'cycle.solidified')
            statusByCycle.set(cycleId, 'success');
        else if (event.type === 'cycle.failed')
            statusByCycle.set(cycleId, 'failed');
        else if (event.type === 'cycle.signals_collected') {
            const base = payload?.['baseSignals'] ?? payload?.['signals'];
            if (Array.isArray(base))
                signalsByCycle.set(cycleId, base.filter((signal) => typeof signal === 'string'));
        }
    }
    return [...statusByCycle.entries()]
        .slice(-window)
        .map(([cycleId, status]) => ({ status, signals: signalsByCycle.get(cycleId) ?? [] }));
}
export function taskStrategy(env = process.env) {
    const raw = String(env.TASK_STRATEGY ?? 'balanced').toLowerCase().trim();
    return TASK_STRATEGIES.includes(raw) ? raw : 'balanced';
}
export function minCapabilityMatch(env = process.env) {
    const parsed = Number(env.TASK_MIN_CAPABILITY_MATCH);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.1;
}
export function parseSignals(signals) {
    if (Array.isArray(signals))
        return signals.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (typeof signals === 'string')
        return signals.split(/[,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return [];
}
function jaccard(left, right) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const a = new Set(left);
    const b = new Set(right);
    let shared = 0;
    for (const value of a)
        if (b.has(value))
            shared += 1;
    return shared / (a.size + b.size - shared);
}
/** How much this node's own history looks like the task, in [0, 1]. */
export function estimateCapabilityMatch(task, memoryEvents = []) {
    const taskSignals = parseSignals(task.signals);
    if (taskSignals.length === 0 || memoryEvents.length === 0)
        return 0;
    const seen = new Set();
    const totals = new Map();
    for (const event of memoryEvents) {
        const signals = parseSignals(event.signals);
        if (signals.length === 0)
            continue;
        for (const signal of signals)
            seen.add(signal);
        const key = signals.join('|');
        const entry = totals.get(key) ?? { total: 0, success: 0 };
        entry.total += 1;
        if (event.status === 'success')
            entry.success += 1;
        totals.set(key, entry);
    }
    const overlap = jaccard(taskSignals, [...seen]);
    let weighted = 0;
    let weight = 0;
    for (const [key, entry] of totals) {
        const similarity = jaccard(taskSignals, key.split('|'));
        if (similarity < SIGNAL_SIMILARITY_FLOOR)
            continue;
        // Laplace smoothing keeps a single lucky success from reading as certainty.
        weighted += ((entry.success + 1) / (entry.total + 2)) * similarity;
        weight += similarity;
    }
    const successScore = weight > 0 ? weighted / weight : 0.5;
    return Math.min(1, overlap * 0.4 + successScore * 0.6);
}
export function localDifficultyEstimate(task) {
    const signalFactor = Math.min(parseSignals(task.signals).length / 8, 1);
    const words = String(task.title ?? '').split(/\s+/).filter(Boolean).length;
    return Math.min(1, signalFactor * 0.6 + Math.min(words / 15, 1) * 0.4);
}
export function scoreTask(task, capabilityMatch, strategy = 'balanced') {
    const weights = STRATEGY_WEIGHTS[strategy];
    const difficulty = task.complexity_score ?? localDifficultyEstimate(task);
    const bounty = task.bounty_amount ?? 0;
    const completion = task.historical_completion_rate ?? 0.5;
    const roi = Math.min(bounty / (difficulty + 0.1) / ROI_REFERENCE, 1);
    const bountyNorm = Math.min(bounty / BOUNTY_REFERENCE, 1);
    const composite = weights.roi * roi + weights.capability * capabilityMatch + weights.completion * completion + weights.bounty * bountyNorm;
    return {
        composite: round(composite, 3),
        factors: { roi: round(roi, 2), capability: round(capabilityMatch, 2), completion: round(completion, 2), bounty: round(bountyNorm, 2), difficulty: round(difficulty, 2) },
    };
}
function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/**
 * Pick what to work on. A task this node already holds always wins — finishing
 * a commitment beats starting a better one.
 */
export function selectBestTask(tasks, nodeId, memoryEvents = [], env = process.env) {
    return rankTasks(tasks, nodeId, memoryEvents, env)[0] ?? null;
}
/**
 * Every task worth trying, best first. A ranked list rather than one winner: the
 * top candidate can turn out to be unusable — a lapsed commitment, a window too
 * short to promise — and one bad head must not hide the rest of the batch.
 */
export function rankTasks(tasks, nodeId, memoryEvents = [], env = process.env) {
    const mine = tasks
        .filter((task) => task.status === 'claimed' && task.claimed_by === nodeId)
        .map((task) => ({ task, reason: 'resume' }));
    const open = tasks.filter((task) => task.status === 'open');
    const strategy = taskStrategy(env);
    if (strategy === 'greedy' && memoryEvents.length === 0) {
        const byBounty = [...open].sort((left, right) => Number(Boolean(right.bounty_id)) - Number(Boolean(left.bounty_id)) || (right.bounty_amount ?? 0) - (left.bounty_amount ?? 0));
        return [...mine, ...byBounty.map((task) => ({ task, reason: 'scored', score: scoreTask(task, 0, strategy) }))];
    }
    const floor = minCapabilityMatch(env);
    const scored = open
        .map((task) => ({ task, reason: 'scored', score: scoreTask(task, estimateCapabilityMatch(task, memoryEvents), strategy) }))
        .filter((entry) => entry.score.factors.capability >= floor || memoryEvents.length === 0)
        .sort((left, right) => right.score.composite - left.score.composite);
    return [...mine, ...scored];
}
/**
 * What this node can honestly promise: harder tasks get longer, but never past
 * the task's own expiry, and never a window too short to be worth claiming.
 */
export function estimateCommitmentDeadline(task, now = Date.now()) {
    const difficulty = task.complexity_score ?? localDifficultyEstimate(task);
    const band = DIFFICULTY_DURATION.find((entry) => difficulty <= entry.threshold);
    const durationMs = Math.max(MIN_COMMITMENT_MS, Math.min(MAX_COMMITMENT_MS, band?.durationMs ?? MAX_COMMITMENT_MS));
    let deadline = now + durationMs;
    if (task.expires_at) {
        const expiresAt = Date.parse(task.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt < deadline) {
            const adjusted = expiresAt - DEADLINE_SAFETY_MS;
            if (adjusted - now < MIN_COMMITMENT_MS)
                return null;
            deadline = adjusted;
        }
    }
    return new Date(deadline).toISOString();
}
const PRIVACY_OPEN = '[PRIVACY_PARAMS]';
const PRIVACY_CLOSE = '[/PRIVACY_PARAMS]';
/**
 * A privacy task carries its parameters as a fenced block in the body. Ported
 * from v1 `privacyClient.parsePrivacyParams`; the rest of that client (blob
 * upload, sealed execution) has no v2 counterpart yet.
 */
export function detectPrivacyTask(task) {
    const body = task.body ?? task.description ?? '';
    if (typeof body !== 'string')
        return null;
    const start = body.indexOf(PRIVACY_OPEN);
    const end = body.indexOf(PRIVACY_CLOSE);
    if (start === -1 || end === -1 || end <= start)
        return null;
    const params = new Map();
    for (const line of body.slice(start + PRIVACY_OPEN.length, end).split('\n')) {
        const trimmed = line.trim();
        const colon = trimmed.indexOf(':');
        if (colon === -1)
            continue;
        params.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
    }
    const toolId = params.get('tool_id');
    if (!toolId)
        return null;
    return { toolId, blobIds: (params.get('blob_ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean) };
}
/** Signals an execute-queue task should carry so the loop knows what it is. */
export function taskToSignals(task) {
    const signals = parseSignals(task.signals);
    const fromTitle = String(task.title ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length > 3).slice(0, 5);
    return [...new Set([...signals, ...fromTitle])];
}
/** Same signals, plus the two a sealed-tool task needs so the loop routes it. */
export function taskToSignalsWithPrivacy(task) {
    const signals = taskToSignals(task);
    if (!detectPrivacyTask(task))
        return signals;
    return [...new Set([...signals, 'privacy_computing', 'sealed_tool'])];
}
/**
 * One receive pass: ask, choose, claim. Returns what the execute queue should
 * run, or why nothing was taken.
 */
export async function receiveTask(client, opts) {
    const env = opts.env ?? process.env;
    const now = opts.now ?? Date.now;
    const fetched = await call(() => client.fetchTasks());
    // A failed fetch is not an idle Hub. Saying "none" here hid a 401 behind silence.
    if (!fetched.ok)
        return { claimed: false, reason: 'fetch_failed', seen: 0, error: errorOf(fetched) };
    // A task id lands in a queue filename: anything outside the safe charset (a `..`
    // segment above all) would write outside the queue directory, so drop it here.
    const offered = Array.isArray(fetched.data?.tasks) ? fetched.data.tasks : [];
    const tasks = offered.map(normalizeHubTask).filter((task) => task !== null);
    const seen = { seen: tasks.length, ...(offered.length > tasks.length ? { rejected: offered.length - tasks.length } : {}) };
    let blocked = null;
    for (const selection of rankTasks(tasks, opts.nodeId, opts.memoryEvents ?? [], env)) {
        const taken = selection.reason === 'resume'
            ? resumeClaim(selection, opts, now())
            : await takeClaim(client, selection, opts, now());
        if (taken.claimed)
            return { ...taken, ...seen };
        // One unusable head must not hide the rest of the batch: remember why, keep looking.
        blocked ??= taken;
    }
    return blocked ? { ...blocked, ...seen } : { claimed: false, reason: 'none', ...seen };
}
/** A task this node already holds: no second claim, but the promise must still stand. */
function resumeClaim(selection, opts, nowMs) {
    const held = opts.claimFor?.(`${HUB_QUEUE_PREFIX}${selection.task.task_id}`);
    const deadline = held?.commitmentDeadline ?? commitmentDeadlineOf(selection.task);
    // No record of the promise, and the Hub did not restate it. Inventing a fresh window
    // here would make a commitment that lapsed weeks ago look alive on every restart, so
    // the claim is not resumed — the Hub releases it at its own deadline either way.
    if (!deadline) {
        return { claimed: false, reason: 'expired', seen: 0, task: selection.task, commitmentDeadline: null };
    }
    const parsed = Date.parse(deadline);
    if (Number.isFinite(parsed) && parsed <= nowMs) {
        return { claimed: false, reason: 'expired', seen: 0, task: selection.task, commitmentDeadline: deadline };
    }
    // Resuming is the same filing, not a new one: keep the generation the claim was filed
    // under, or a result from the run already in flight would look stale on return.
    return { claimed: true, reason: 'resume', seen: 0, task: selection.task, score: selection.score, queueTask: queueTaskFor(selection.task, opts.repo, deadline, held?.generation ?? newGeneration()) };
}
/**
 * The Hub's own view of how long it is holding a task for its claimant. Not `expires_at`:
 * the bounty outlives the commitment by days, and resuming on it is how a node keeps
 * working on something that was re-dispatched hours ago.
 */
function commitmentDeadlineOf(task) {
    const raw = task.commitment_deadline ?? null;
    return typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? raw : null;
}
/** A task no one holds: promise a deadline this node can keep, then take it. */
async function takeClaim(client, selection, opts, nowMs) {
    const commitmentDeadline = estimateCommitmentDeadline(selection.task, nowMs);
    if (!commitmentDeadline) {
        return { claimed: false, reason: 'no_deadline', seen: 0, task: selection.task, score: selection.score, commitmentDeadline: null };
    }
    const claim = await call(() => client.claimTask(selection.task.task_id, { commitmentDeadline }));
    if (!claim.ok) {
        return { claimed: false, reason: 'claim_failed', seen: 0, task: selection.task, score: selection.score, commitmentDeadline, error: errorOf(claim) };
    }
    return { claimed: true, reason: 'scored', seen: 0, task: selection.task, score: selection.score, commitmentDeadline, queueTask: queueTaskFor(selection.task, opts.repo, commitmentDeadline, newGeneration()) };
}
/** The execute-queue entry under this id, if the loop has not taken it yet. */
function queuedTask(queueDir, id) {
    return defaultReadQueueTask(queueDir, id);
}
function newGeneration() {
    return randomUUID().slice(0, 8);
}
function queueTaskFor(task, repo, commitmentDeadline, generation) {
    return {
        id: `${HUB_QUEUE_PREFIX}${task.task_id}`,
        hubTaskId: task.task_id,
        generation,
        repo,
        target: String(task.title ?? task.task_id).slice(0, 200),
        expectedEffect: `complete hub task ${task.task_id}`,
        signals: taskToSignalsWithPrivacy(task),
        ...(commitmentDeadline ? { commitmentDeadline } : {}),
    };
}
/** A thrown transport error is the same event as `{ ok: false }` and must read as one. */
async function call(rpc) {
    try {
        return await rpc();
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function errorOf(result) {
    return result.error ?? `hub ${result.status ?? 0}`;
}
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function isSafeTaskId(taskId) {
    return typeof taskId === 'string' && SAFE_TASK_ID.test(taskId);
}
/**
 * The Hub and the proxies in front of it serialize tasks either way, and the neighbouring
 * `/a2a/task/my` reader already accepts both. Read one shape here so a camelCase response
 * is not silently an empty task list.
 */
export function normalizeHubTask(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const task = raw;
    const pick = (...keys) => {
        for (const key of keys)
            if (task[key] !== undefined && task[key] !== null)
                return task[key];
        return undefined;
    };
    const taskId = pick('task_id', 'taskId');
    if (!isSafeTaskId(taskId))
        return null;
    return {
        ...task,
        task_id: taskId,
        ...(pick('claimed_by', 'claimedBy') === undefined ? {} : { claimed_by: pick('claimed_by', 'claimedBy') }),
        ...(pick('bounty_amount', 'bountyAmount') === undefined ? {} : { bounty_amount: pick('bounty_amount', 'bountyAmount') }),
        ...(pick('bounty_id', 'bountyId') === undefined ? {} : { bounty_id: pick('bounty_id', 'bountyId') }),
        ...(pick('expires_at', 'expiresAt') === undefined ? {} : { expires_at: pick('expires_at', 'expiresAt') }),
        ...(pick('commitment_deadline', 'commitmentDeadline') === undefined ? {} : { commitment_deadline: pick('commitment_deadline', 'commitmentDeadline') }),
        ...(pick('complexity_score', 'complexityScore') === undefined ? {} : { complexity_score: pick('complexity_score', 'complexityScore') }),
        ...(pick('historical_completion_rate', 'historicalCompletionRate') === undefined ? {} : { historical_completion_rate: pick('historical_completion_rate', 'historicalCompletionRate') }),
        ...(pick('result_asset_id', 'resultAssetId') === undefined ? {} : { result_asset_id: pick('result_asset_id', 'resultAssetId') }),
    };
}
const IDLE = { claimed: false, reason: 'none', seen: 0 };
export function isTaskReceiverEnabled(env = process.env) {
    return String(env['EVOLVER_TASK_RECEIVER'] ?? 'on').toLowerCase().trim() !== '0';
}
function hubClientOrNull(env, deps) {
    try {
        return deps.client ?? createAtpClientFromEnv(env);
    }
    catch {
        return null;
    }
}
export function resolveTaskReceiver(env = process.env, deps = {}) {
    const ledgerPath = deps.completionLedgerPath ?? completionLedgerPath(env);
    const now = deps.now ?? (() => Date.now());
    const write = deps.writeQueueTask ?? defaultWriteQueueTask;
    // One identity, and it is the client's: filtering tasks as one node while claiming and
    // completing them as another is how a node skips its own work and takes someone else's.
    // With a client present its answer is final — an env or caller value is not bound to the
    // credentials that will do the claiming, so it only stands in when there is no client.
    const client = hubClientOrNull(env, deps);
    const nodeId = client ? client.nodeId?.() : deps.nodeId ?? resolveAtpSenderId(env);
    // A promise made in an earlier run outlives the switch, the identity and the process that
    // made it, so the debt is carried on every wiring — receiving new work is what turns off.
    const commitmentDeps = { ledgerPath, now, write, ...(deps.queueDir ? { queueDir: deps.queueDir } : {}) };
    const commitments = client ? liveCommitments(client, commitmentDeps) : unsentCommitments(ledgerPath, now);
    const off = (reason) => ({ enabled: false, reason, tick: async () => IDLE, ...commitments });
    if (!isTaskReceiverEnabled(env))
        return off('off');
    if (!nodeId)
        return off('no_node');
    if (!client)
        return off('client_error');
    if (!deps.repo || !deps.queueDir)
        return off('no_repo');
    const repo = deps.repo;
    const queueDir = deps.queueDir;
    // Bound here so the pass below keeps the narrowing the guards above established.
    const hub = client;
    const node = nodeId;
    // One pass at a time, whoever calls. Two overlapping passes both see a task as
    // unclaimed, both claim it, and the Hub commitment ends up with two queue entries.
    // autoexec happens to single-flight its tick; the guarantee belongs here, not there.
    let inProgress = null;
    return {
        enabled: true,
        ...commitments,
        tick: async () => {
            if (inProgress)
                return inProgress;
            inProgress = receivePass();
            try {
                return await inProgress;
            }
            finally {
                inProgress = null;
            }
        },
    };
    async function receivePass() {
        const received = await receiveTask(hub, { nodeId: node, repo, claimFor: commitments.claimFor, memoryEvents: deps.memoryEvents?.() ?? [], env, now: deps.now });
        if (!received.claimed || !received.queueTask)
            return received;
        // Resuming is not re-filing. A claim already registered under this generation is
        // either sitting in the queue or being executed right now; writing it again would
        // either be read as a stranger's queue entry or hand the executor a duplicate.
        // "Still in the loop's hands" is the queue entry OR a run already under way: the
        // executor moves the file out of the queue when it starts, and re-filing then would
        // hand it the same task twice.
        const held = commitments.claimFor(received.queueTask.id);
        const queued = queuedTask(queueDir, received.queueTask.id)?.generation === held?.generation;
        const inFlight = deps.inFlight?.(received.queueTask.id) ?? false;
        if (received.reason === 'resume' && held !== null && (queued || inFlight))
            return received;
        // We hold a claim the moment the Hub grants it. Anything that keeps the loop from
        // seeing the task leaves the Hub waiting on work that cannot start, so the failure
        // is written down and retried on later beats rather than dropped with the claim.
        try {
            const filed = fileClaim(commitmentDeps, queueDir, received.queueTask);
            if (filed === 'name_taken' || filed === 'unrecorded') {
                const why = filed === 'name_taken'
                    ? `queue id ${received.queueTask.id} is taken by another task`
                    : `ownership of ${received.queueTask.id} could not be recorded`;
                rememberUnqueued(ledgerPath, received.queueTask, why);
                return { ...received, claimed: false, reason: 'queue_failed', error: why };
            }
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            rememberUnqueued(ledgerPath, received.queueTask, reason);
            return { ...received, claimed: false, reason: 'queue_failed', error: reason };
        }
        return received;
    }
}