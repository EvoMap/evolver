export const SELF_UPDATE_FAILURE_CODES = Object.freeze({
    INSTALL_GUARD_NAME_MISMATCH: 'install_guard_name_mismatch',
    INSTALL_GUARD_UNREADABLE: 'install_guard_unreadable',
    BAD_REQUIRED_VERSION: 'bad_required_version',
    CURRENT_VERSION_UNPARSABLE: 'current_version_unparsable',
    NPX_NOT_FOUND: 'npx_not_found',
    DEGIT_TIMEOUT: 'degit_timeout',
    DEGIT_FAILED: 'degit_failed',
    DOWNLOAD_INCOMPLETE: 'download_incomplete',
    DOWNLOADED_VERSION_MISMATCH: 'downloaded_version_mismatch',
    COPY_FAILED: 'copy_failed',
    ALL_CHANNELS_EXHAUSTED: 'all_channels_exhausted',
    DOWNLOAD_FAILED: 'download_failed',
    REJECTED_DECISION: 'rejected_decision',
    REJECTED_VERIFICATION: 'rejected_verification',
    REPLACE_FAILED: 'replace_failed',
    // V1 telemetry convention: tarball-fallback leg surfaces as `fallback_<reason>`
    // so the hub can distinguish primary-channel failures from Channel 1b failures
    // without inspecting the detail string. The enum string values are the wire
    // contract; renaming the TS identifier without renaming the value would silently
    // break aggregation. See V1 #282.
    FALLBACK_DOWNLOAD_FAILED: 'fallback_download_failed',
    FALLBACK_EXTRACT_FAILED: 'fallback_extract_failed',
    FALLBACK_MISSING_BINARY: 'fallback_missing_binary',
    UPDATE_LOCKED: 'update_locked',
    RECOVERY_REQUIRED: 'recovery_required',
    UNSAFE_UPDATE_PATH: 'unsafe_update_path',
    RESTART_FAILED: 'restart_failed',
    READ_BACK_FAILED: 'read_back_failed',
    ROLLBACK_FAILED: 'rollback_failed',
});
export class SelfUpdateFailureError extends Error {
    failureCode;
    constructor(failureCode, detail, options) {
        super(detail, options);
        this.name = 'SelfUpdateFailureError';
        this.failureCode = failureCode;
    }
}
export function selfUpdateFailure(failureCode, detail, options) {
    return new SelfUpdateFailureError(failureCode, detail, options);
}
export function classifySelfUpdateError(err, fallback) {
    if (err instanceof SelfUpdateFailureError) {
        return { failureCode: err.failureCode, detail: err.message };
    }
    if (isTimeoutError(err)) {
        return { failureCode: SELF_UPDATE_FAILURE_CODES.DEGIT_TIMEOUT, detail: errorDetail(err) };
    }
    return { failureCode: fallback, detail: errorDetail(err) };
}
export function codeForDecisionReject(reason) {
    if (reason === 'required_version_invalid')
        return SELF_UPDATE_FAILURE_CODES.BAD_REQUIRED_VERSION;
    if (reason === 'current_version_invalid')
        return SELF_UPDATE_FAILURE_CODES.CURRENT_VERSION_UNPARSABLE;
    if (reason === 'manifest_below_required')
        return SELF_UPDATE_FAILURE_CODES.DOWNLOADED_VERSION_MISMATCH;
    if (reason === 'manifest_missing'
        || reason === 'manifest_no_version'
        || reason === 'manifest_bad_version'
        || reason === 'manifest_no_artifacts'
        || reason === 'manifest_bad_artifact_path'
        || reason === 'manifest_bad_artifact_sha256') {
        return SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE;
    }
    return SELF_UPDATE_FAILURE_CODES.REJECTED_DECISION;
}
export function renderFailureError(code, detail) {
    if (!code)
        return detail;
    const trimmed = detail.trim();
    return trimmed.length > 0 ? `${code}: ${trimmed}` : code;
}
function isTimeoutError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const input = err;
    const code = typeof input.code === 'string' ? input.code : '';
    if (input.name === 'AbortError' || input.killed === true || input.signal === 'SIGTERM')
        return true;
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
        return true;
    return isTimeoutError(input.cause);
}
function errorDetail(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}