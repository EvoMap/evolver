import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { HUB_GENERAL_TIMEOUT_MS, resolveHubOperationTimeouts, } from '@evomap/evolver-adapter-public';
import { AtpSpendConsentError, atpConsentPath, getAtpConsent, placeAtpOrderWithConsent, } from './atp.js';
export const ATP_AUTOBUY_DEFAULT_DAILY_CAP = 50;
export const ATP_AUTOBUY_DEFAULT_PER_ORDER_CAP = 10;
export const ATP_AUTOBUY_DEFAULT_TIMEOUT_MS = 3_000;
export const ATP_AUTOBUY_COLD_START_MS = 5 * 60 * 1_000;
export const ATP_AUTOBUY_SUCCESS_DEDUP_MS = 24 * 60 * 60 * 1_000;
export const ATP_AUTOBUY_FAILURE_DEDUP_MS = 5 * 60 * 1_000;
export const ATP_AUTOBUY_LEDGER_FILENAME = 'atp-autobuyer-ledger.json';
export const ATP_AUTOBUY_LEDGER_MAX_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{24}$/;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export class AtpAutoBuyerLedgerError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = 'AtpAutoBuyerLedgerError';
    }
}
const SYSTEM_TIMER = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function corrupt(message, cause) {
    return new AtpAutoBuyerLedgerError(message, 'CORRUPT_LEDGER', cause === undefined ? undefined : { cause });
}
function unavailable(message, cause) {
    return new AtpAutoBuyerLedgerError(message, 'LEDGER_UNAVAILABLE', cause === undefined ? undefined : { cause });
}
function dayKey(now) {
    return new Date(now).toISOString().slice(0, 10);
}
function validDayKey(value) {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function finiteInteger(value, minimum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function boundedInteger(value, fallback, minimum = 0) {
    const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
    return typeof parsed === 'number' && Number.isSafeInteger(Math.floor(parsed)) && parsed >= minimum
        ? Math.floor(parsed)
        : fallback;
}
function noFollowFlag() {
    return constants['O_NOFOLLOW'] ?? 0;
}
function errorText(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, 500);
}
function emptyLedger(now) {
    return { version: 2, dayKey: dayKey(now), spent: 0, dedup: {}, reservations: {}, resolutions: [] };
}
function parseResolution(value) {
    if (!isRecord(value)
        || typeof value['reservationId'] !== 'string'
        || typeof value['hash'] !== 'string'
        || !HASH_PATTERN.test(value['hash'])
        || !finiteInteger(value['budget'], 1)
        || (value['outcome'] !== 'success' && value['outcome'] !== 'failure')
        || !finiteInteger(value['resolvedAt'], 0)
        || (value['source'] !== 'operator' && value['source'] !== 'late_result')) {
        throw corrupt('invalid ATP auto-buyer resolution');
    }
    return {
        reservationId: value['reservationId'],
        hash: value['hash'],
        budget: value['budget'],
        outcome: value['outcome'],
        resolvedAt: value['resolvedAt'],
        source: value['source'],
    };
}
function parseDedupEntry(hash, value) {
    if (!isRecord(value) || !finiteInteger(value['ts'], 0)) {
        throw corrupt(`invalid dedup entry for ${hash}`);
    }
    const state = value['state'];
    if (state !== 'success' && state !== 'failure' && state !== 'reserved') {
        throw corrupt(`invalid dedup state for ${hash}`);
    }
    const reservationId = value['reservationId'];
    if (reservationId !== undefined && (typeof reservationId !== 'string' || reservationId.length === 0)) {
        throw corrupt(`invalid dedup reservation for ${hash}`);
    }
    if (state === 'reserved' && typeof reservationId !== 'string') {
        throw corrupt(`reserved dedup entry is missing its reservation for ${hash}`);
    }
    return { ts: value['ts'], state, ...(reservationId === undefined ? {} : { reservationId }) };
}
function parseReservation(id, value) {
    if (!isRecord(value))
        throw corrupt(`invalid reservation ${id}`);
    const hash = value['hash'];
    const state = value['state'];
    const error = value['error'];
    const resolveAfter = value['resolveAfter'];
    if (value['id'] !== id || typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
        throw corrupt(`invalid reservation identity ${id}`);
    }
    if (!finiteInteger(value['budget'], 1) || !validDayKey(value['dayKey'])) {
        throw corrupt(`invalid reservation budget or day for ${id}`);
    }
    if (!finiteInteger(value['createdAt'], 0) || !finiteInteger(value['updatedAt'], 0)) {
        throw corrupt(`invalid reservation timestamps for ${id}`);
    }
    if (resolveAfter !== undefined && !finiteInteger(resolveAfter, value['createdAt'])) {
        throw corrupt(`invalid reservation recovery deadline for ${id}`);
    }
    if (state !== 'pending' && state !== 'ambiguous')
        throw corrupt(`invalid reservation state for ${id}`);
    if (error !== undefined && typeof error !== 'string')
        throw corrupt(`invalid reservation error for ${id}`);
    return {
        id,
        hash,
        budget: value['budget'],
        dayKey: value['dayKey'],
        createdAt: value['createdAt'],
        updatedAt: value['updatedAt'],
        ...(resolveAfter === undefined ? {} : { resolveAfter }),
        state,
        ...(error === undefined ? {} : { error }),
    };
}
function parseLegacyLedger(value) {
    if (!validDayKey(value['dayKey']) || !finiteInteger(value['spent'], 0) || !isRecord(value['dedup'])) {
        throw corrupt('invalid legacy ATP auto-buyer ledger');
    }
    const dedup = {};
    for (const [hash, entry] of Object.entries(value['dedup'])) {
        if (!HASH_PATTERN.test(hash))
            throw corrupt(`invalid legacy dedup hash ${hash}`);
        if (finiteInteger(entry, 0)) {
            dedup[hash] = { ts: entry, state: 'success' };
            continue;
        }
        if (!isRecord(entry) || !finiteInteger(entry['ts'], 0) || typeof entry['failed'] !== 'boolean') {
            throw corrupt(`invalid legacy dedup entry for ${hash}`);
        }
        dedup[hash] = { ts: entry['ts'], state: entry['failed'] ? 'failure' : 'success' };
    }
    return { version: 2, dayKey: value['dayKey'], spent: value['spent'], dedup, reservations: {}, resolutions: [] };
}
function parseLedger(value) {
    if (!isRecord(value))
        throw corrupt('ATP auto-buyer ledger is not an object');
    if (value['version'] === 1)
        return parseLegacyLedger(value);
    if (value['version'] !== 2
        || !validDayKey(value['dayKey'])
        || !finiteInteger(value['spent'], 0)
        || !isRecord(value['dedup'])
        || !isRecord(value['reservations'])) {
        throw corrupt('invalid ATP auto-buyer ledger schema');
    }
    const dedup = {};
    for (const [hash, entry] of Object.entries(value['dedup'])) {
        if (!HASH_PATTERN.test(hash))
            throw corrupt(`invalid dedup hash ${hash}`);
        dedup[hash] = parseDedupEntry(hash, entry);
    }
    const reservations = {};
    for (const [id, entry] of Object.entries(value['reservations'])) {
        if (id.length === 0)
            throw corrupt('empty reservation id');
        reservations[id] = parseReservation(id, entry);
    }
    for (const [hash, entry] of Object.entries(dedup)) {
        if (entry.state !== 'reserved')
            continue;
        const reservation = reservations[entry.reservationId];
        if (reservation === undefined || reservation.hash !== hash) {
            throw corrupt(`dedup reservation mismatch for ${hash}`);
        }
    }
    for (const reservation of Object.values(reservations)) {
        const entry = dedup[reservation.hash];
        if (entry?.state !== 'reserved' || entry.reservationId !== reservation.id) {
            throw corrupt(`reservation dedup mismatch for ${reservation.id}`);
        }
    }
    const rawResolutions = value['resolutions'] ?? [];
    if (!Array.isArray(rawResolutions) || rawResolutions.length > 256) {
        throw corrupt('invalid ATP auto-buyer resolution history');
    }
    const resolutions = rawResolutions.map(parseResolution);
    return { version: 2, dayKey: value['dayKey'], spent: value['spent'], dedup, reservations, resolutions };
}
function readLedgerFile(path, optional) {
    let before;
    try {
        before = lstatSync(path);
    }
    catch (error) {
        if (optional && isErrno(error, 'ENOENT'))
            return undefined;
        throw unavailable(`cannot stat ATP auto-buyer ledger: ${path}`, error);
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size > ATP_AUTOBUY_LEDGER_MAX_BYTES) {
        throw corrupt(`unsafe or oversized ATP auto-buyer ledger: ${path}`);
    }
    let descriptor;
    let raw;
    try {
        descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > ATP_AUTOBUY_LEDGER_MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw corrupt(`ATP auto-buyer ledger changed while opening: ${path}`);
        }
        raw = readFileSync(descriptor, 'utf8');
    }
    catch (error) {
        if (error instanceof AtpAutoBuyerLedgerError)
            throw error;
        throw unavailable(`cannot read ATP auto-buyer ledger: ${path}`, error);
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
    try {
        return parseLedger(JSON.parse(raw));
    }
    catch (error) {
        if (error instanceof AtpAutoBuyerLedgerError)
            throw error;
        throw corrupt(`invalid JSON in ATP auto-buyer ledger: ${path}`, error);
    }
}
export function readAtpAutoBuyerLedger(path) {
    return readLedgerFile(path, false);
}
function writeLedgerAtomic(path, ledger) {
    const payload = `${JSON.stringify(ledger)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > ATP_AUTOBUY_LEDGER_MAX_BYTES) {
        throw unavailable('ATP auto-buyer ledger capacity exceeded; reconcile ambiguous reservations before new orders');
    }
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
        const current = lstatSync(path);
        if (current.isSymbolicLink() || !current.isFile())
            throw corrupt(`unsafe ATP auto-buyer ledger path: ${path}`);
    }
    const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    let pendingError;
    try {
        descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
        writeFileSync(descriptor, payload, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temp, path);
        if (process.platform !== 'win32') {
            chmodSync(path, 0o600);
            const directory = openSync(parent, constants.O_RDONLY);
            try {
                fsyncSync(directory);
            }
            finally {
                closeSync(directory);
            }
        }
    }
    catch (error) {
        pendingError = error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
        try {
            unlinkSync(temp);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT') && pendingError === undefined)
                pendingError = error;
        }
    }
    if (pendingError !== undefined)
        throw unavailable(`cannot persist ATP auto-buyer ledger: ${path}`, pendingError);
}
export function resolveAtpAutoBuyerLedgerPath(env = process.env, consentPath = atpConsentPath(env)) {
    return join(dirname(consentPath), ATP_AUTOBUY_LEDGER_FILENAME);
}
export function hashAtpCapabilityGap(request) {
    const capabilities = request.capabilities.map((capability) => String(capability).trim()).filter(Boolean).sort();
    const question = String(request.question ?? '').slice(0, 2_000);
    return createHash('sha256').update(`${capabilities.join(',')}|${question}`).digest('hex').slice(0, 24);
}
function rotateLedger(ledger, now) {
    const currentDay = dayKey(now);
    if (ledger.dayKey === currentDay)
        return;
    ledger.dayKey = currentDay;
    ledger.spent = 0;
}
function pruneDedup(ledger, now, config) {
    for (const [hash, entry] of Object.entries(ledger.dedup)) {
        if (entry.state === 'reserved')
            continue;
        const ttl = entry.state === 'failure' ? config.failureDedupMs : config.successDedupMs;
        if (entry.ts < now - ttl)
            delete ledger.dedup[hash];
    }
}
function effectiveCap(value, now, startedAt, coldStartMs) {
    return now - startedAt < coldStartMs ? Math.floor(value / 2) : value;
}
function requestedBudget(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : fallback;
}
function isAmbiguousOrderResult(result) {
    return !result.ok && (result.status === 408 || (result.status !== undefined && result.status >= 500));
}
function isGrant(decision) {
    return 'reservation' in decision;
}
export class AtpAutoBuyer {
    ledgerPath;
    lockPath;
    client;
    consentPath;
    env;
    now;
    timer;
    reservationId;
    config;
    queue = Promise.resolve();
    startedAt;
    constructor(options) {
        this.client = options.client;
        this.env = options.env ?? process.env;
        this.consentPath = options.consentPath ?? atpConsentPath(this.env);
        this.ledgerPath = options.ledgerPath ?? resolveAtpAutoBuyerLedgerPath(this.env, this.consentPath);
        this.lockPath = options.lockPath ?? `${this.ledgerPath}.lock`;
        this.now = options.now ?? Date.now;
        this.timer = options.timer ?? SYSTEM_TIMER;
        this.reservationId = options.reservationId ?? randomUUID;
        this.config = {
            dailyCap: boundedInteger(options.dailyCap ?? this.env['ATP_AUTOBUY_DAILY_CAP_CREDITS'], ATP_AUTOBUY_DEFAULT_DAILY_CAP),
            perOrderCap: boundedInteger(options.perOrderCap ?? this.env['ATP_AUTOBUY_PER_ORDER_CAP_CREDITS'], ATP_AUTOBUY_DEFAULT_PER_ORDER_CAP),
            timeoutMs: boundedInteger(options.timeoutMs, ATP_AUTOBUY_DEFAULT_TIMEOUT_MS, 1),
            coldStartMs: boundedInteger(options.coldStartMs, ATP_AUTOBUY_COLD_START_MS),
            successDedupMs: boundedInteger(options.successDedupMs, ATP_AUTOBUY_SUCCESS_DEDUP_MS, 1),
            failureDedupMs: boundedInteger(options.failureDedupMs, ATP_AUTOBUY_FAILURE_DEDUP_MS, 1),
            transportSettleMs: boundedInteger(options.transportSettleMs ?? resolveHubOperationTimeouts(this.env).generalMs, HUB_GENERAL_TIMEOUT_MS, 1),
            lockMaxTries: boundedInteger(options.lockMaxTries, 300, 1),
            lockWaitMs: boundedInteger(options.lockWaitMs, 10),
        };
    }
    consider(request) {
        if (!isRecord(request) || request.kind !== 'capability_gap') {
            return Promise.resolve({ ok: false, skipped: true, reason: 'not_capability_gap' });
        }
        const capabilities = Array.isArray(request.capabilities)
            ? request.capabilities.map((capability) => String(capability).trim()).filter(Boolean)
            : [];
        if (capabilities.length === 0) {
            return Promise.resolve({ ok: false, skipped: true, reason: 'no_capabilities' });
        }
        const normalized = { ...request, capabilities };
        const next = this.queue.then(() => this.considerSerialized(normalized), () => this.considerSerialized(normalized));
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }
    reconcileReservation(reservationId, result) {
        return this.withLedgerLock(() => {
            const now = this.now();
            const ledger = this.loadLedger(now);
            rotateLedger(ledger, now);
            pruneDedup(ledger, now, this.config);
            const reservation = ledger.reservations[reservationId];
            if (reservation === undefined)
                return false;
            if (isAmbiguousOrderResult(result)) {
                reservation.state = 'ambiguous';
                reservation.updatedAt = now;
                reservation.error = result.error ?? `hub_${result.status ?? 'unknown'}`;
                writeLedgerAtomic(this.ledgerPath, ledger);
                return true;
            }
            delete ledger.reservations[reservationId];
            if (result.ok) {
                if (reservation.dayKey === ledger.dayKey)
                    ledger.spent += reservation.budget;
                ledger.dedup[reservation.hash] = { ts: now, state: 'success' };
            }
            else {
                ledger.dedup[reservation.hash] = { ts: now, state: 'failure' };
            }
            writeLedgerAtomic(this.ledgerPath, ledger);
            return true;
        });
    }
    resolveReservation(reservationId, outcome) {
        return this.withLedgerLock(() => {
            const now = this.now();
            const ledger = this.loadLedger(now);
            rotateLedger(ledger, now);
            pruneDedup(ledger, now, this.config);
            const reservation = ledger.reservations[reservationId];
            if (reservation === undefined)
                return false;
            if (reservation.state === 'pending'
                && now < (reservation.resolveAfter ?? this.pendingResolveAfter(reservation.createdAt)))
                return false;
            if (reservation.state === 'ambiguous'
                && outcome === 'failure'
                && reservation.error === 'autobuyer_timeout'
                && now < reservation.createdAt + this.config.transportSettleMs)
                return false;
            delete ledger.reservations[reservationId];
            // An operator cannot prove that an ambiguous POST produced no economic side effect. Charge either outcome
            // against the original day's cap; a confirmed terminal Hub failure uses reconcileReservation instead and
            // remains retryable. This prevents an operator release + retry + late success from overspending the cap.
            if (reservation.dayKey === ledger.dayKey)
                ledger.spent += reservation.budget;
            if (outcome === 'success') {
                ledger.dedup[reservation.hash] = { ts: now, state: 'success' };
            }
            else {
                ledger.dedup[reservation.hash] = { ts: now, state: 'failure' };
            }
            ledger.resolutions.push({
                reservationId,
                hash: reservation.hash,
                budget: reservation.budget,
                outcome,
                resolvedAt: now,
                source: 'operator',
            });
            if (ledger.resolutions.length > 256)
                ledger.resolutions.splice(0, ledger.resolutions.length - 256);
            writeLedgerAtomic(this.ledgerPath, ledger);
            return true;
        });
    }
    async considerSerialized(request) {
        const consent = getAtpConsent(this.env, this.consentPath);
        if (!consent.enabled)
            return { ok: false, skipped: true, reason: 'consent_disabled' };
        const now = this.now();
        this.startedAt ??= now;
        let decision;
        try {
            decision = this.reserve(request, now, this.startedAt);
        }
        catch (error) {
            return this.ledgerFailure(error, true);
        }
        if (!isGrant(decision))
            return decision.result;
        const { reservation, order } = decision;
        const orderPromise = placeAtpOrderWithConsent(this.client, order, {
            env: this.env,
            consentPath: this.consentPath,
        });
        const outcome = await this.awaitOrder(orderPromise, reservation);
        if (outcome.kind === 'timeout') {
            return {
                ok: false,
                skipped: false,
                reason: 'order_timeout',
                error: 'autobuyer_timeout',
                hash: reservation.hash,
                reservationId: reservation.id,
                reserved: reservation.budget,
            };
        }
        if (outcome.kind === 'throw') {
            if (outcome.error instanceof AtpSpendConsentError) {
                try {
                    this.releaseReservation(reservation.id);
                }
                catch (error) {
                    return this.ledgerFailure(error, false, reservation);
                }
                return { ok: false, skipped: true, reason: 'consent_disabled' };
            }
            try {
                this.markAmbiguous(reservation.id, outcome.error);
            }
            catch (error) {
                return this.ledgerFailure(error, false, reservation);
            }
            return {
                ok: false,
                skipped: false,
                reason: 'order_ambiguous',
                error: errorText(outcome.error),
                hash: reservation.hash,
                reservationId: reservation.id,
                reserved: reservation.budget,
            };
        }
        const ambiguous = isAmbiguousOrderResult(outcome.result);
        let reconciled;
        try {
            reconciled = this.reconcileReservation(reservation.id, outcome.result);
        }
        catch (error) {
            return this.ledgerFailure(error, false, reservation);
        }
        if (!reconciled) {
            return this.ledgerFailure(unavailable('ATP auto-buyer reservation disappeared before the order result was recorded'), false, reservation);
        }
        if (outcome.result.ok) {
            return {
                ok: true,
                skipped: false,
                data: outcome.result.data,
                hash: reservation.hash,
                reservationId: reservation.id,
                spent: reservation.budget,
            };
        }
        if (ambiguous) {
            return {
                ok: false,
                skipped: false,
                reason: 'order_ambiguous',
                error: outcome.result.error ?? 'ambiguous_hub_response',
                status: outcome.result.status,
                hash: reservation.hash,
                reservationId: reservation.id,
                reserved: reservation.budget,
            };
        }
        return {
            ok: false,
            skipped: false,
            error: outcome.result.error ?? 'unknown_error',
            status: outcome.result.status,
            hash: reservation.hash,
            reservationId: reservation.id,
        };
    }
    reserve(request, now, startedAt) {
        return this.withLedgerLock(() => {
            const ledger = this.loadLedger(now);
            rotateLedger(ledger, now);
            pruneDedup(ledger, now, this.config);
            const hash = hashAtpCapabilityGap(request);
            if (ledger.dedup[hash] !== undefined) {
                return { result: { ok: false, skipped: true, reason: 'dedup_hit', hash } };
            }
            const dailyCap = effectiveCap(this.config.dailyCap, now, startedAt, this.config.coldStartMs);
            const perOrderCap = effectiveCap(this.config.perOrderCap, now, startedAt, this.config.coldStartMs);
            const reservedToday = Object.values(ledger.reservations)
                .filter((reservation) => reservation.dayKey === ledger.dayKey)
                .reduce((sum, reservation) => sum + reservation.budget, 0);
            const used = ledger.spent + reservedToday;
            const remaining = Math.max(0, dailyCap - used);
            if (remaining <= 0) {
                return {
                    result: { ok: false, skipped: true, reason: 'daily_cap_reached', spent: used, cap: dailyCap },
                };
            }
            const requested = requestedBudget(request.budget, perOrderCap);
            const budget = Math.min(requested, perOrderCap, remaining);
            if (budget <= 0) {
                return { result: { ok: false, skipped: true, reason: 'budget_clamped_to_zero' } };
            }
            const id = this.reservationId();
            if (typeof id !== 'string' || id.length === 0 || ledger.reservations[id] !== undefined) {
                throw unavailable('ATP auto-buyer could not allocate a unique reservation id');
            }
            const reservation = {
                id,
                hash,
                budget,
                dayKey: ledger.dayKey,
                createdAt: now,
                updatedAt: now,
                resolveAfter: this.pendingResolveAfter(now),
                state: 'pending',
            };
            ledger.reservations[id] = reservation;
            ledger.dedup[hash] = { ts: now, state: 'reserved', reservationId: id };
            writeLedgerAtomic(this.ledgerPath, ledger);
            const order = {
                capabilities: request.capabilities,
                budget,
                routingMode: request.routingMode || 'fastest',
                verifyMode: request.verifyMode || 'auto',
                question: request.question,
                signals: request.signals,
                minReputation: request.minReputation,
            };
            return { reservation, order };
        });
    }
    awaitOrder(orderPromise, reservation) {
        return new Promise((resolve) => {
            let completed = false;
            let timedOut = false;
            let handle;
            const onTimeout = () => {
                if (completed)
                    return;
                completed = true;
                timedOut = true;
                try {
                    this.markAmbiguous(reservation.id, new Error('autobuyer_timeout'));
                }
                catch {
                    // The already-durable pending reservation remains fail-closed even if this annotation cannot be written.
                }
                resolve({ kind: 'timeout' });
            };
            try {
                handle = this.timer.setTimeout(onTimeout, this.config.timeoutMs);
            }
            catch {
                onTimeout();
            }
            void orderPromise.then((result) => {
                if (timedOut) {
                    this.reconcileLate(reservation, result);
                    return;
                }
                if (completed)
                    return;
                completed = true;
                try {
                    this.timer.clearTimeout(handle);
                }
                catch {
                    // A broken injected timer must not change an already-settled order result.
                }
                resolve({ kind: 'result', result });
            }, (error) => {
                if (timedOut) {
                    try {
                        this.markAmbiguous(reservation.id, error);
                    }
                    catch {
                        // Preserve the existing durable reservation on a failed annotation.
                    }
                    return;
                }
                if (completed)
                    return;
                completed = true;
                try {
                    this.timer.clearTimeout(handle);
                }
                catch {
                    // A broken injected timer must not change the transport outcome.
                }
                resolve({ kind: 'throw', error });
            });
        });
    }
    reconcileLate(reservation, result) {
        try {
            if (this.reconcileReservation(reservation.id, result) || !result.ok)
                return;
            // An operator can settle an ambiguous timeout while the original POST is still
            // in flight. A later positive receipt is stronger evidence and must restore the
            // spend/dedup record so the same capability gap cannot be purchased again.
            this.withLedgerLock(() => {
                const now = this.now();
                const ledger = this.loadLedger(now);
                rotateLedger(ledger, now);
                pruneDedup(ledger, now, this.config);
                const priorResolution = [...ledger.resolutions]
                    .reverse()
                    .find((resolution) => resolution.reservationId === reservation.id);
                if (priorResolution?.outcome !== 'failure')
                    return;
                if (ledger.resolutions.some((resolution) => (resolution.reservationId === reservation.id && resolution.source === 'late_result')))
                    return;
                const currentDedup = ledger.dedup[reservation.hash];
                const newerReservationPending = currentDedup?.state === 'reserved'
                    && currentDedup.reservationId !== reservation.id;
                if (!newerReservationPending) {
                    delete ledger.reservations[reservation.id];
                    ledger.dedup[reservation.hash] = { ts: now, state: 'success' };
                }
                // resolveReservation already charged an operator-resolved ambiguous order against the daily cap. The
                // late receipt strengthens its outcome/dedup evidence but must not count the same reservation twice.
                ledger.resolutions.push({
                    reservationId: reservation.id,
                    hash: reservation.hash,
                    budget: reservation.budget,
                    outcome: 'success',
                    resolvedAt: now,
                    source: 'late_result',
                });
                if (ledger.resolutions.length > 256)
                    ledger.resolutions.splice(0, ledger.resolutions.length - 256);
                writeLedgerAtomic(this.ledgerPath, ledger);
            });
        }
        catch {
            // Leave durable state unchanged when the late receipt cannot be recorded safely.
        }
    }
    markAmbiguous(reservationId, error) {
        this.withLedgerLock(() => {
            const now = this.now();
            const ledger = this.loadLedger(now);
            rotateLedger(ledger, now);
            pruneDedup(ledger, now, this.config);
            const reservation = ledger.reservations[reservationId];
            if (reservation === undefined)
                return;
            reservation.state = 'ambiguous';
            reservation.updatedAt = now;
            reservation.error = errorText(error);
            writeLedgerAtomic(this.ledgerPath, ledger);
        });
    }
    releaseReservation(reservationId) {
        this.withLedgerLock(() => {
            const now = this.now();
            const ledger = this.loadLedger(now);
            rotateLedger(ledger, now);
            pruneDedup(ledger, now, this.config);
            const reservation = ledger.reservations[reservationId];
            if (reservation === undefined)
                return;
            delete ledger.reservations[reservationId];
            const dedup = ledger.dedup[reservation.hash];
            if (dedup?.state === 'reserved' && dedup.reservationId === reservationId) {
                delete ledger.dedup[reservation.hash];
            }
            writeLedgerAtomic(this.ledgerPath, ledger);
        });
    }
    pendingResolveAfter(createdAt) {
        return Math.min(Number.MAX_SAFE_INTEGER, createdAt + Math.max(this.config.timeoutMs, this.config.transportSettleMs));
    }
    loadLedger(now) {
        return readLedgerFile(this.ledgerPath, true) ?? emptyLedger(now);
    }
    withLedgerLock(operation) {
        try {
            mkdirSync(dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
            mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
            util.acquireLock(this.lockPath, {
                maxTries: this.config.lockMaxTries,
                waitMs: this.config.lockWaitMs,
            });
        }
        catch (error) {
            if (error instanceof util.LockTimeoutError)
                throw error;
            throw unavailable(`cannot acquire ATP auto-buyer ledger lock: ${this.lockPath}`, error);
        }
        let value;
        let operationError;
        try {
            value = operation();
        }
        catch (error) {
            operationError = error;
        }
        let releaseError;
        try {
            const released = util.releaseLock(this.lockPath);
            if (!released.released)
                releaseError = new util.LockReleaseError(released.reason);
        }
        catch (error) {
            releaseError = error;
        }
        if (releaseError !== undefined) {
            throw unavailable(`cannot release ATP auto-buyer ledger lock: ${this.lockPath}`, releaseError);
        }
        if (operationError !== undefined)
            throw operationError;
        return value;
    }
    ledgerFailure(error, skipped, reservation) {
        const reason = error instanceof util.LockTimeoutError
            ? 'ledger_busy'
            : error instanceof AtpAutoBuyerLedgerError && error.code === 'CORRUPT_LEDGER'
                ? 'ledger_corrupt'
                : 'ledger_unavailable';
        return {
            ok: false,
            skipped,
            reason,
            error: errorText(error),
            ...(reservation === undefined
                ? {}
                : {
                    hash: reservation.hash,
                    reservationId: reservation.id,
                    reserved: reservation.budget,
                }),
        };
    }
}