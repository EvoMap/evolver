export declare const LOG_DIAGNOSTICS_MAX_BYTES: number;
export declare const LOG_DIAGNOSTICS_MAX_LINES = 200;
export interface LogDiagnosticsData {
    lines: string[];
    truncated: boolean;
}
export type LogDiagnosticsResult = {
    available: true;
    data: LogDiagnosticsData;
} | {
    available: false;
    error: 'log_not_found' | 'log_unavailable';
};
export interface LogDiagnosticsOptions {
    maxBytes?: number;
    maxLines?: number;
}
export declare function readLogDiagnostics(logFile: string, options?: LogDiagnosticsOptions): LogDiagnosticsResult;