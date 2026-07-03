import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atpRetryClass } from '@evomap/evolver-adapter-public';
import { createAtpClientFromEnv, resolveAtpHome } from './atp.js';
export const ATP_AUTODELIVER_DEFAULT_POLL_MS = 60_000;
export const ATP_AUTODELIVER_MIN_POLL_MS = 15_000;
export const ATP_AUTODELIVER_LEDGER_FILENAME = 'atp-autodeliver-ledger.json';
export const ATP_AUTODELIVER_LEDGER_MAX_ENTRIES = 500;
// Cooldown backoff for a 429 (hub rate-limit). Exponential per consecutive 429 on the same order so we back off
// well beyond the cooldown window instead of re-submitting every tick (money-safety #177): base doubles each hit,
// capped. The first 429 waits BASE; subsequent ones BASE*2^(hits-1) up to CAP.
export const ATP_AUTODELIVER_COOLDOWN_BASE_MS = 5 * 60_000; // 5 min
export const ATP_AUTODELIVER_COOLDOWN_CAP_MS = 6 * 60 * 60_000; // 6 h
const EMPTY_TICK = { checked: 0, delivered: 0, skippedTasks: 0, terminalFailures: 0, transientFailures: 0, cooldownFailures: 0 };
export function isAtpAutoDeliverEnabled(env = process.env) {
    const raw = (env['EVOLVER_ATP_AUTODELIVER'] ?? 'on').toLowerCase().trim();
    return raw !== 'off' && raw !== '0' && raw !== 'false';
}
export function atpAutoDeliverLedgerPath(env = process.env) {
    return join(resolveAtpHome(env), 'evolution', ATP_AUTODELIVER_LEDGER_FILENAME);
}
export function resolveAtpAutoDeliver(env = process.env, deps = {}) {
    if (!isAtpAutoDeliverEnabled(env))
        return { enabled: false, reason: 'off', tick: async () => EMPTY_TICK };
    let client;
    try {
        client = deps.client ?? (deps.createClient ?? createAtpClientFromEnv)(env);
    }
    catch {
        return { enabled: false, reason: 'client_error', tick: async () => EMPTY_TICK };
    }
    return { enabled: true, tick: () => runAtpAutoDeliverTick({ ...deps, client, env }) };
}
export async function runAtpAutoDeliverTick(deps = {}) {
    const env = deps.env ?? process.env;
    const client = deps.client ?? (deps.createClient ?? createAtpClientFromEnv)(env);
    const ledgerPath = deps.ledgerPath ?? atpAutoDeliverLedgerPath(env);
    const nowMs = deps.nowMs ?? (() => Date.now());
    const log = deps.log ?? (() => { });
    const out = { ...EMPTY_TICK };
    try {
        const listed = await client.listMyTasks(deps.limit ?? 20);
        if (!listed.ok)
            return out;
        const tasks = tasksFrom(listed.data);
        out.checked = tasks.length;
        if (tasks.length === 0)
            return out;
        const ledger = readAtpAutoDeliverLedger(ledgerPath);
        let wroteLedger = false;
        for (const task of tasks) {
            const orderId = taskString(task, 'atp_order_id') ?? taskString(task, 'order_id');
            if (!orderId) {
                out.skippedTasks += 1;
                continue;
            }
            if (ledger.submitted[orderId]) {
                out.skippedTasks += 1;
                continue;
            }
            // Still inside a 429 backoff window → skip this tick (do NOT hit the economic endpoint, #177).
            const retryAfter = ledger.retryAfter[orderId];
            if (retryAfter && nowMs() < retryAfter) {
                out.skippedTasks += 1;
                continue;
            }
            if (!taskString(task, 'result_asset_id') && !taskString(task, 'resultAssetId')) {
                out.skippedTasks += 1;
                continue;
            }
            const status = taskString(task, 'status') ?? taskString(task, 'task_status');
            if (status && status !== 'claimed' && status !== 'completed') {
                out.skippedTasks += 1;
                continue;
            }
            const resp = await client.submitDelivery(orderId, buildAtpAutoDeliverProofPayload(task, deps.nowDate));
            if (resp.ok) {
                ledger.submitted[orderId] = nowMs();
                delete ledger.retryAfter[orderId]; // a prior cooldown cleared
                delete ledger.cooldownHits[orderId];
                wroteLedger = true;
                out.delivered += 1;
                continue;
            }
            // Retry policy comes from the SHARED classifier (adapter-public atpRetryClass) so publish and auto-deliver
            // can't drift on what each status means (#177 root cause). permanent = NO retry ever helps (the proof is
            // structurally dead); cooldown = the hub is rate-limiting (429), so back off exponentially instead of
            // re-submitting every tick (money-safety: stop hammering the economic endpoint AND honor the cooldown);
            // recoverable = environment-recoverable (402 credit / 403 rebind / 5xx), retry next tick is correct.
            const cls = atpRetryClass(resp.status ?? 0);
            if (cls === 'permanent') {
                ledger.submitted[orderId] = -nowMs();
                delete ledger.retryAfter[orderId];
                delete ledger.cooldownHits[orderId];
                wroteLedger = true;
                out.terminalFailures += 1;
            }
            else if (cls === 'cooldown') {
                const hits = (ledger.cooldownHits[orderId] ?? 0) + 1;
                const backoff = Math.min(ATP_AUTODELIVER_COOLDOWN_BASE_MS * 2 ** (hits - 1), ATP_AUTODELIVER_COOLDOWN_CAP_MS);
                ledger.cooldownHits[orderId] = hits;
                ledger.retryAfter[orderId] = nowMs() + backoff;
                wroteLedger = true;
                out.cooldownFailures += 1;
            }
            else {
                out.transientFailures += 1; // recoverable: retry next tick (operator fixes credit/rebind); no ledger write
            }
            log(`[ATP-AutoDeliver] Delivery failed order=${orderId} status=${resp.status ?? 'n/a'} class=${cls} err=${String(resp.error ?? 'unknown_error').slice(0, 120)}`);
        }
        if (wroteLedger)
            writeAtpAutoDeliverLedger(ledgerPath, ledger);
        return out;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[ATP-AutoDeliver] Tick threw (non-fatal): ${msg}`);
        return out;
    }
}
export function readAtpAutoDeliverLedger(path) {
    try {
        if (!existsSync(path))
            return emptyLedger();
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const rec = asRecord(parsed);
        const submitted = asRecord(rec?.['submitted']);
        if (!submitted)
            return emptyLedger();
        // retryAfter/cooldownHits are v2 fields — a v1 ledger lacks them, so default to empty (back-compat).
        return { version: 2, submitted: cleanNumberMap(submitted), retryAfter: cleanNumberMap(asRecord(rec?.['retryAfter'])), cooldownHits: cleanNumberMap(asRecord(rec?.['cooldownHits'])) };
    }
    catch {
        return emptyLedger();
    }
}
/** Keep only finite-number entries from an unknown record (corrupt/non-number values dropped). */
function cleanNumberMap(rec) {
    const out = {};
    if (rec)
        for (const [k, v] of Object.entries(rec))
            if (typeof v === 'number' && Number.isFinite(v))
                out[k] = v;
    return out;
}
export function writeAtpAutoDeliverLedger(path, ledger) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        // Each map is capped independently to the most-recent entries (cooldown orders live in retryAfter/cooldownHits,
        // NOT in submitted, so they must be trimmed on their own — they're cleared on success/terminal in steady state).
        const body = {
            version: 2,
            submitted: capMap(ledger.submitted),
            retryAfter: capMap(ledger.retryAfter),
            cooldownHits: capMap(ledger.cooldownHits),
        };
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(body, null, 2));
        renameSync(tmp, path);
    }
    catch {
        // Best effort: hub-side submitDelivery is idempotent per order id, so a later tick can retry safely.
    }
}
/** Keep at most MAX_ENTRIES, dropping the oldest (insertion-order) — bounds unbounded ledger growth. */
function capMap(rec) {
    const entries = Object.entries(rec);
    return entries.length > ATP_AUTODELIVER_LEDGER_MAX_ENTRIES ? Object.fromEntries(entries.slice(-ATP_AUTODELIVER_LEDGER_MAX_ENTRIES)) : rec;
}
export function buildAtpAutoDeliverProofPayload(task, nowDate = () => new Date()) {
    const assetId = taskString(task, 'result_asset_id') ?? taskString(task, 'resultAssetId') ?? null;
    return {
        result: 'completed',
        asset_id: assetId,
        completed_at: taskString(task, 'claimed_at') ?? nowDate().toISOString(),
        pass_rate: 1.0,
        signals: Array.isArray(task['signals']) ? task['signals'].filter((s) => typeof s === 'string').slice(0, 10) : [],
        submitter: 'evolver_auto_deliver',
    };
}
function emptyLedger() {
    return { version: 2, submitted: {}, retryAfter: {}, cooldownHits: {} };
}
function tasksFrom(value) {
    if (Array.isArray(value))
        return value.map(asRecord).filter((x) => Boolean(x));
    const rec = asRecord(value);
    const tasks = rec?.['tasks'];
    return Array.isArray(tasks) ? tasks.map(asRecord).filter((x) => Boolean(x)) : [];
}
function taskString(task, key) {
    const v = task[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}