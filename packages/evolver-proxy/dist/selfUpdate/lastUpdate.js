import { hub as hubNs, mailbox, ops } from '@evomap/evolver-core';
import { renderFailureError } from './failureCodes.js';
const LAST_UPDATE_STATE_KEY = 'self_update:last_update';
const FINISHED_AT_MIN_MS = 1_700_000_000_000;
const LAST_UPDATE_TTL_MS = 7 * 24 * 60 * 60_000;
const LAST_UPDATE_TO_VERSION_MAX = 32;
const LAST_UPDATE_FROM_VERSION_MAX = 32;
const LAST_UPDATE_DIRECTIVE_ID_MAX = 64;
const LAST_UPDATE_ERROR_MAX = 1000;
const STATUS_SET = new Set(['success', 'failed', 'skipped', 'pending']);
export function readPendingLastUpdate(store, now = Date.now()) {
    const raw = store.getState(LAST_UPDATE_STATE_KEY);
    if (!raw)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        clearPendingLastUpdate(store);
        return undefined;
    }
    const payload = normalizeLastUpdate(parsed);
    if (!payload) {
        clearPendingLastUpdate(store);
        return undefined;
    }
    if (payload.finished_at >= FINISHED_AT_MIN_MS && now - payload.finished_at > LAST_UPDATE_TTL_MS) {
        clearPendingLastUpdate(store);
        return undefined;
    }
    return payload;
}
function clearPendingLastUpdate(store) {
    store.setState(LAST_UPDATE_STATE_KEY, '');
}
export function clearLastUpdateOnAck(store, sent, now = Date.now()) {
    const current = readPendingLastUpdate(store, now);
    if (!current)
        return false;
    if (!sameIdentity(current, sent))
        return false;
    clearPendingLastUpdate(store);
    return true;
}
export function writeLastUpdate(store, payload, now = Date.now()) {
    const normalized = normalizeLastUpdate(payload);
    if (!normalized)
        return false;
    if (normalized.status === 'skipped' || normalized.status === 'pending') {
        const pending = readPendingLastUpdate(store, now);
        if (pending?.status === 'success' || pending?.status === 'failed')
            return false;
    }
    store.setState(LAST_UPDATE_STATE_KEY, JSON.stringify(normalized));
    return true;
}
export function shouldClearForLastUpdateAck(ack) {
    if (!ack || typeof ack !== 'object')
        return false;
    return ack.ok === true;
}
export function isLastUpdateRelatedError(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return /last[_\-.]?update/i.test(text);
}
export function reportSelfUpdateLastUpdate(store, directive, result, opts = { fromVersion: '0.0.0' }) {
    const payload = lastUpdateFromSelfUpdateResult(directive, result, {
        fromVersion: opts.fromVersion,
        now: opts.now ?? Date.now(),
    });
    if (!payload)
        return false;
    return writeLastUpdate(store, payload, opts.now ?? Date.now());
}
export function reportPendingSelfUpdateLastUpdate(store, directive, opts = { fromVersion: '0.0.0' }) {
    const now = opts.now ?? Date.now();
    const toVersion = targetVersionForDirective(directive);
    if (!toVersion)
        return false;
    return writeLastUpdate(store, {
        to_version: toVersion,
        status: 'pending',
        finished_at: Math.max(now, FINISHED_AT_MIN_MS),
        from_version: clampString(opts.fromVersion, LAST_UPDATE_FROM_VERSION_MAX),
        ...(directive.directive_id ? { directive_id: String(directive.directive_id) } : {}),
    }, now);
}
export function finalizeSelfUpdateRecoveryLastUpdate(store, recovery, now = Date.now()) {
    if (recovery.outcome !== 'confirmed'
        && recovery.outcome !== 'rolled_back'
        && recovery.outcome !== 'blocked')
        return false;
    const toVersion = concreteVersion(recovery.targetVersion);
    const fromVersion = concreteVersion(recovery.fromVersion);
    if (!toVersion)
        return false;
    const current = readPendingLastUpdate(store, now);
    if (current && current.to_version !== toVersion)
        return false;
    const common = {
        to_version: toVersion,
        finished_at: Math.max(now, FINISHED_AT_MIN_MS),
        ...(current?.directive_id ? { directive_id: current.directive_id } : {}),
        ...(current?.from_version ? { from_version: current.from_version } : fromVersion ? { from_version: fromVersion } : {}),
    };
    if (recovery.outcome === 'confirmed') {
        return writeLastUpdate(store, {
            ...common,
            status: 'success',
            ...(current?.applied_via ? { applied_via: current.applied_via } : {}),
        }, now);
    }
    return writeLastUpdate(store, {
        ...common,
        status: 'failed',
        error: clampString(hubNs.redactString(`${recovery.failureCode ?? 'self_update_recovery_failed'}: ${recovery.outcome}`), LAST_UPDATE_ERROR_MAX),
    }, now);
}
export function lastUpdateFromSelfUpdateResult(directive, result, opts) {
    if (result.outcome === 'already_in_progress' || result.outcome === 'disabled')
        return undefined;
    const toVersion = targetVersionForReport(directive, result);
    if (!toVersion)
        return undefined;
    const base = {
        to_version: toVersion,
        status: statusForResult(result),
        finished_at: Math.max(opts.now, FINISHED_AT_MIN_MS),
        ...(directive.directive_id ? { directive_id: String(directive.directive_id) } : {}),
    };
    if (base.status === 'success' || base.status === 'pending') {
        return {
            ...base,
            from_version: clampString(opts.fromVersion, LAST_UPDATE_FROM_VERSION_MAX),
            ...(result.appliedVia ? { applied_via: result.appliedVia } : {}),
        };
    }
    if (base.status === 'failed') {
        return {
            ...base,
            from_version: clampString(opts.fromVersion, LAST_UPDATE_FROM_VERSION_MAX),
            error: clampString(hubNs.redactString(renderFailureError(result.failureCode, result.reason)), LAST_UPDATE_ERROR_MAX),
        };
    }
    return base;
}
function statusForResult(result) {
    if (result.outcome === 'applied')
        return result.confirmationPending ? 'pending' : 'success';
    if (result.outcome === 'noop')
        return 'skipped';
    return 'failed';
}
function targetVersionForReport(directive, result) {
    const fromResult = reportableVersion(result.targetVersion);
    if (fromResult)
        return fromResult;
    if (result.outcome !== 'applied' && result.outcome !== 'noop')
        return requiredVersionForReport(directive);
    return targetVersionForDirective(directive);
}
function targetVersionForDirective(directive) {
    const manifest = directive.manifest;
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        const version = concreteVersion(manifest.version);
        if (version)
            return version;
    }
    return ops.normalizeRequiredVersion(directive.required_version);
}
function requiredVersionForReport(directive) {
    const normalized = ops.normalizeRequiredVersion(directive.required_version);
    if (!normalized || normalized.length > LAST_UPDATE_TO_VERSION_MAX)
        return undefined;
    return normalized;
}
function normalizeLastUpdate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const input = value;
    const toVersion = concreteVersion(input['to_version']);
    const status = typeof input['status'] === 'string' && STATUS_SET.has(input['status'])
        ? input['status']
        : undefined;
    const finishedAt = typeof input['finished_at'] === 'number' && Number.isFinite(input['finished_at'])
        ? Math.max(Math.trunc(input['finished_at']), FINISHED_AT_MIN_MS)
        : undefined;
    if (!toVersion || !status || finishedAt === undefined)
        return undefined;
    const appliedVia = input['applied_via'];
    return {
        to_version: toVersion,
        status,
        finished_at: finishedAt,
        ...(typeof input['from_version'] === 'string' ? { from_version: clampString(input['from_version'], LAST_UPDATE_FROM_VERSION_MAX) } : {}),
        ...(typeof input['directive_id'] === 'string' && input['directive_id'].length > 0
            ? { directive_id: clampString(input['directive_id'], LAST_UPDATE_DIRECTIVE_ID_MAX) }
            : {}),
        ...(typeof input['error'] === 'string' && input['error'].length > 0
            ? { error: clampString(hubNs.redactString(input['error']), LAST_UPDATE_ERROR_MAX) }
            : {}),
        ...(appliedVia === 'binary' || appliedVia === 'tarball' ? { applied_via: appliedVia } : {}),
    };
}
function sameIdentity(a, b) {
    return a.status === b.status
        && a.finished_at === b.finished_at
        && a.to_version === b.to_version
        && (a.directive_id ?? '') === (b.directive_id ?? '');
}
function concreteVersion(value) {
    const normalized = ops.normalizeConcreteVersion(value);
    if (!normalized || normalized.length > LAST_UPDATE_TO_VERSION_MAX)
        return undefined;
    return normalized;
}
function reportableVersion(value) {
    const normalized = ops.normalizeRequiredVersion(value) ?? ops.normalizeConcreteVersion(value);
    if (!normalized || normalized.length > LAST_UPDATE_TO_VERSION_MAX)
        return undefined;
    return normalized;
}
function clampString(value, max) {
    return value.length <= max ? value : value.slice(0, max);
}