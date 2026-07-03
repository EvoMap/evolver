export const DEFAULT_UNHANDLED_REJECTION_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_UNHANDLED_REJECTION_THRESHOLD = 5;
export function createUnhandledRejectionWindowHandler(options = {}) {
    const windowMs = positiveNumber(options.windowMs, DEFAULT_UNHANDLED_REJECTION_WINDOW_MS);
    const threshold = positiveNumber(options.threshold, DEFAULT_UNHANDLED_REJECTION_THRESHOLD);
    const now = options.now ?? (() => Date.now());
    const write = options.write ?? ((line) => { process.stderr.write(`${line}\n`); });
    const exit = options.exit ?? ((code) => { process.exit(code); });
    let timestamps = [];
    let exiting = false;
    return (reason) => {
        if (exiting)
            return;
        const at = now();
        timestamps.push(at);
        timestamps = timestamps.filter((t) => at - t < windowMs);
        write(`[FATAL] Unhandled promise rejection (${timestamps.length} in window): ${formatReason(reason)}`);
        if (timestamps.length < threshold)
            return;
        exiting = true;
        write(`[FATAL] ${timestamps.length} unhandled rejections within ${windowMs / 1000}s. Exiting to avoid corrupt state.`);
        try {
            options.beforeExit?.();
        }
        catch (e) {
            write(`[FATAL] unhandled rejection shutdown hook failed: ${formatReason(e)}`);
        }
        exit(1);
    };
}
export function installUnhandledRejectionWindow(options = {}) {
    const proc = options.process ?? process;
    const handler = createUnhandledRejectionWindowHandler(options);
    proc.on('unhandledRejection', handler);
    return () => {
        if (proc.off) {
            proc.off('unhandledRejection', handler);
            return;
        }
        proc.removeListener?.('unhandledRejection', handler);
    };
}
function positiveNumber(value, fallback) {
    if (value === undefined || !Number.isFinite(value) || value <= 0)
        return fallback;
    return value;
}
function formatReason(reason) {
    if (reason instanceof Error && reason.stack)
        return reason.stack;
    return String(reason);
}