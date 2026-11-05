import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLock, releaseLock } from '@evomap/evolver-core/prompt-recall';
import { hookStdoutNotSubmitted, writeHookStdout } from './promptRecallShared.js';
export const PROTECTED_AUDIT_INSTALL_GUIDE = 'an administrator must install the protected audit service with install-protected-audit-service.sh '
    + 'from the same sealed release as this evolver binary (docs/release-smoke.md, section "POSIX 用户实际安装边界")';
const NOT_PROVISIONED_REASONS = new Set(['service_not_provisioned', 'client_config_missing']);
const MAX_NOTIFIED_SESSIONS = 256;
const NOTICE_OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function protectedAuditInstallState(readiness) {
    if (readiness.state !== 'unavailable')
        return readiness.state;
    return NOT_PROVISIONED_REASONS.has(readiness.reason) ? 'not_provisioned' : 'unavailable';
}
export function protectedAuditInstallReport(readiness) {
    const state = protectedAuditInstallState(readiness);
    if (state === 'ready' || state === 'not_required')
        return { protected_audit: state };
    const reason = readiness.state === 'unavailable' ? readiness.reason : state;
    return {
        protected_audit: state,
        protected_audit_next_step: `Evolver cannot record audit events until the protected audit service is available (${reason}); ${PROTECTED_AUDIT_INSTALL_GUIDE}.`,
    };
}
export function protectedAuditNoticeStatePath(evomapHome) {
    return join(evomapHome, 'evolution', 'protected-audit-session-notice.json');
}
function decodeNoticeState(text) {
    const data = JSON.parse(text);
    const sessions = data.sessions;
    if (!Array.isArray(sessions) || sessions.length > MAX_NOTIFIED_SESSIONS
        || sessions.some((key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)))
        throw new Error('invalid_audit_notice_state');
    if (data.version === 1)
        return { sessions, pending: {} };
    const pending = data.pending;
    if (data.version !== 2 || !pending || typeof pending !== 'object' || Array.isArray(pending)
        || Object.entries(pending).some(([key, owner]) => !sessions.includes(key) || typeof owner !== 'string' || !NOTICE_OWNER.test(owner))) {
        throw new Error('invalid_audit_notice_state');
    }
    return { sessions, pending };
}
function readNoticeState(path) {
    try {
        return decodeNoticeState(readFileSync(path, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { sessions: [], pending: {} };
        throw error;
    }
}
function writeOwnedNoticeFile(path, text) {
    const fd = openSync(path, 'wx', 0o600);
    try {
        try {
            writeFileSync(fd, text, 'utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        removeNoticeFile(path);
        throw error;
    }
}
function removeNoticeFile(path) {
    try {
        unlinkSync(path);
    }
    catch { /* The state file remains authoritative. */ }
}
function writeNoticeState(path, state) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeOwnedNoticeFile(temporary, `${JSON.stringify({ version: 2, ...state })}\n`);
    try {
        renameSync(temporary, path);
    }
    catch (error) {
        removeNoticeFile(temporary);
        throw error;
    }
}
function applyNoticeSettlement(state, key, owner, outcome) {
    if (state.pending[key] !== owner)
        return false;
    delete state.pending[key];
    if (outcome === 'not_submitted')
        state.sessions.splice(state.sessions.indexOf(key), 1);
    return true;
}
function noticeSettlementPath(path, owner) {
    return `${path}.${owner}.settled`;
}
function readNoticeSettlement(path, key) {
    try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.size > 80)
                return undefined;
            const bytes = Buffer.alloc(80);
            const length = readSync(fd, bytes, 0, bytes.length, 0);
            if (length !== info.size)
                return undefined;
            const receipt = bytes.toString('utf8', 0, length);
            if (receipt === `${key}:written\n`)
                return 'written';
            if (receipt === `${key}:not_submitted\n`)
                return 'not_submitted';
        }
        finally {
            closeSync(fd);
        }
    }
    catch { /* An unavailable receipt cannot authorize replay. */ }
    return undefined;
}
function recoverNoticeSettlements(path, state, key) {
    const candidates = state.sessions.length === MAX_NOTIFIED_SESSIONS ? Object.keys(state.pending) : [key];
    const consumed = [];
    for (const session of candidates) {
        const owner = state.pending[session];
        if (!owner)
            continue;
        const receipt = noticeSettlementPath(path, owner);
        const outcome = readNoticeSettlement(receipt, session);
        if (outcome && applyNoticeSettlement(state, session, owner, outcome))
            consumed.push(receipt);
    }
    return consumed;
}
function updateNoticeState(path, update, recoveryKey) {
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const lockPath = `${path}.lock`;
        const owner = acquireLock(lockPath, { maxTries: 1, waitMs: 0 });
        let changed = false, released = false;
        try {
            const state = readNoticeState(path);
            const consumed = recoveryKey ? recoverNoticeSettlements(path, state, recoveryKey) : [];
            changed = update(state);
            if (changed || consumed.length > 0)
                writeNoticeState(path, state);
            for (const receipt of consumed)
                removeNoticeFile(receipt);
        }
        finally {
            released = releaseLock(lockPath, owner).released;
        }
        return changed && released;
    }
    catch {
        return false;
    }
}
function settleNotice(path, key, owner, outcome) {
    // The callback can outlive the caller or lose the state lock to another hook.
    // An exclusive receipt preserves the exact outcome without waiting on that lock.
    try {
        writeOwnedNoticeFile(noticeSettlementPath(path, owner), `${key}:${outcome}\n`);
    }
    catch (error) {
        if (error.code !== 'EEXIST') {
            updateNoticeState(path, (state) => applyNoticeSettlement(state, key, owner, outcome));
            return;
        }
    }
    updateNoticeState(path, () => false, key);
}
function claimProtectedAuditSessionNotice(sessionId, readiness, path) {
    if (readiness.state !== 'unavailable' || !sessionId)
        return undefined;
    const key = createHash('sha256').update(sessionId).digest('hex');
    const owner = randomUUID();
    const claimed = updateNoticeState(path, (state) => {
        if (state.sessions.includes(key))
            return false;
        if (state.sessions.length === MAX_NOTIFIED_SESSIONS) {
            // An interrupted write may have delivered bytes. Never evict an unconfirmed reservation.
            const oldestConfirmed = state.sessions.findIndex((session) => !Object.hasOwn(state.pending, session));
            if (oldestConfirmed < 0)
                return false;
            state.sessions.splice(oldestConfirmed, 1);
        }
        state.sessions.push(key);
        state.pending[key] = owner;
        return true;
    }, key);
    if (!claimed)
        return undefined;
    return {
        message: `[evolver] Memory recall and recording are paused: the protected audit service is unavailable (${readiness.reason}); ${PROTECTED_AUDIT_INSTALL_GUIDE}.`,
        settle: (outcome) => settleNotice(path, key, owner, outcome),
    };
}
/** Reserve before attempting one write; only the actual transport acknowledgement confirms it. */
export async function writeProtectedAuditSessionNotice(sessionId, readiness, path, writer, emptyOutput = '') {
    const notice = claimProtectedAuditSessionNotice(sessionId, readiness, path);
    const text = notice ? `${JSON.stringify({ systemMessage: notice.message })}\n` : emptyOutput;
    if (!text)
        return;
    let settled = false, outputWritten = false;
    const actual = (written) => {
        if (settled)
            return;
        settled = true;
        if (!written)
            return;
        outputWritten = true;
        notice?.settle('written');
        try {
            writer.onOutputWritten?.();
        }
        catch { /* An observer cannot invalidate confirmed stdout. */ }
    };
    try {
        if (writer.stdoutWithSettlement)
            await writer.stdoutWithSettlement(text, actual);
        else if (writer.stdout) {
            await writer.stdout(text);
            actual(true);
        }
        else
            await writeHookStdout(text, { onSettled: actual });
    }
    catch (error) {
        // EPIPE, timeout and other post-dispatch errors can follow a partial delivery.
        if (!outputWritten && hookStdoutNotSubmitted(error))
            notice?.settle('not_submitted');
    }
}