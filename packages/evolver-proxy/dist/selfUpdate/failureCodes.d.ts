export declare const SELF_UPDATE_FAILURE_CODES: Readonly<{
    readonly INSTALL_GUARD_NAME_MISMATCH: "install_guard_name_mismatch";
    readonly INSTALL_GUARD_UNREADABLE: "install_guard_unreadable";
    readonly BAD_REQUIRED_VERSION: "bad_required_version";
    readonly CURRENT_VERSION_UNPARSABLE: "current_version_unparsable";
    readonly NPX_NOT_FOUND: "npx_not_found";
    readonly DEGIT_TIMEOUT: "degit_timeout";
    readonly DEGIT_FAILED: "degit_failed";
    readonly DOWNLOAD_INCOMPLETE: "download_incomplete";
    readonly DOWNLOADED_VERSION_MISMATCH: "downloaded_version_mismatch";
    readonly COPY_FAILED: "copy_failed";
    readonly ALL_CHANNELS_EXHAUSTED: "all_channels_exhausted";
    readonly DOWNLOAD_FAILED: "download_failed";
    readonly REJECTED_DECISION: "rejected_decision";
    readonly REJECTED_VERIFICATION: "rejected_verification";
    readonly REPLACE_FAILED: "replace_failed";
    readonly FALLBACK_DOWNLOAD_FAILED: "fallback_download_failed";
    readonly FALLBACK_EXTRACT_FAILED: "fallback_extract_failed";
    readonly FALLBACK_MISSING_BINARY: "fallback_missing_binary";
    readonly UPDATE_LOCKED: "update_locked";
    readonly RECOVERY_REQUIRED: "recovery_required";
    readonly UNSAFE_UPDATE_PATH: "unsafe_update_path";
    readonly RESTART_FAILED: "restart_failed";
    readonly READ_BACK_FAILED: "read_back_failed";
    readonly ROLLBACK_FAILED: "rollback_failed";
}>;
export type SelfUpdateFailureCode = typeof SELF_UPDATE_FAILURE_CODES[keyof typeof SELF_UPDATE_FAILURE_CODES];
export interface ClassifiedSelfUpdateError {
    failureCode: SelfUpdateFailureCode;
    detail: string;
}
export declare class SelfUpdateFailureError extends Error {
    readonly failureCode: SelfUpdateFailureCode;
    constructor(failureCode: SelfUpdateFailureCode, detail: string, options?: ErrorOptions);
}
export declare function selfUpdateFailure(failureCode: SelfUpdateFailureCode, detail: string, options?: ErrorOptions): SelfUpdateFailureError;
export declare function classifySelfUpdateError(err: unknown, fallback: SelfUpdateFailureCode): ClassifiedSelfUpdateError;
export declare function codeForDecisionReject(reason: string): SelfUpdateFailureCode;
export declare function renderFailureError(code: SelfUpdateFailureCode | undefined, detail: string): string;