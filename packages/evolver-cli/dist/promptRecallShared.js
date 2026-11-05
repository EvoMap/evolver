import { createHash } from 'node:crypto';
/** Reject oversized prompt payloads rather than retaining partial private JSON. */
export const MAX_PROMPT_RECALL_STDIN_BYTES = 64 * 1024;
export const MAX_PROMPT_RECALL_LOCAL_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES = 8 * 1024 * 1024;
/** Called after hook settlement; diagnostics cannot spend the admission budget. */
export function writeContextReadDiagnostic(report) {
    const stream = process.stderr;
    const line = `context-read-stage-diagnostic ${JSON.stringify(report)}\n`;
    if (Buffer.byteLength(line) > 2048)
        return;
    const ignoreError = () => undefined;
    stream.once('error', ignoreError);
    try {
        stream.write(line, error => {
            if (!error)
                stream.removeListener('error', ignoreError);
        });
    }
    catch {
        stream.removeListener('error', ignoreError);
    }
}
/** Bound caller latency while the original continuation retains actual operation ownership. */
export async function waitContextDelivery(promise, timeoutMs = 220) {
    let timer;
    try {
        return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export function promptRecallMode(env = process.env) {
    const value = String(env['EVOLVER_RECALL_MODE'] ?? '').trim().toLowerCase();
    return value === 'shadow' || value === 'enforce' ? value : 'off';
}
const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
/** Rebind section offsets/digest to the actual prompt, including wrappers; never slice an assembled body. */
export function wrapGeneContext(context, prefix, suffix) {
    if (!context.text)
        return context;
    const text = prefix + context.text + suffix;
    return { ...context, text, digest: digestText(text), sections: context.sections.map((s) => ({ ...s, start: s.start + prefix.length, end: s.end + prefix.length })) };
}
// One submitted write owns the stream until callback/close, including after
// caller timeout. Refuse retries instead of accumulating listeners and queued bytes.
const pendingStdoutWrites = new WeakMap();
class HookStdoutNotSubmittedError extends Error {
    constructor() { super('hook_stdout_unconfirmed'); }
}
/** Only the transport's own pre-dispatch refusal proves no bytes were submitted. */
export function hookStdoutNotSubmitted(error) {
    return error instanceof HookStdoutNotSubmittedError;
}
/** A successful callback means stdout_written, not host_received. One attempt only, even on EPIPE. */
export function writeHookStdout(text, options = {}) {
    return new Promise((resolve, reject) => {
        const stdout = process.stdout;
        if (pendingStdoutWrites.has(stdout) || stdout.destroyed || stdout.writableEnded) {
            try {
                options.onSettled?.(false);
            }
            catch { /* The observer does not own the stream. */ }
            reject(new HookStdoutNotSubmittedError());
            return;
        }
        const owner = {};
        pendingStdoutWrites.set(stdout, owner);
        let settled = false;
        let actualSettled = false;
        const actual = (written) => {
            if (actualSettled)
                return;
            actualSettled = true;
            try {
                options.onSettled?.(written);
            }
            catch { /* Callback owns its durable retry, never the stream. */ }
        };
        const release = () => {
            stdout.removeListener('error', onError);
            stdout.removeListener('close', onClose);
            if (pendingStdoutWrites.get(stdout) === owner)
                pendingStdoutWrites.delete(stdout);
        };
        const onClose = () => { actual(false); finish(new Error('hook_stdout_unconfirmed')); release(); };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve();
        };
        // Timeout settles the caller, not the submitted stream write. Own its late error
        // until callback/close, even when library code cannot destroy shared stdout.
        // A shared stream may emit an error independently of this write's callback;
        // the event rejects our caller but is not evidence that queued bytes settled.
        const onError = (error) => { finish(error); };
        const written = (error) => {
            actual(!error);
            finish(error);
            // Writable emits error after its failed callback, before the next immediate.
            if (error)
                setImmediate(release);
            else
                release();
        };
        const timer = setTimeout(() => {
            // Only the disposable executable owns the process-wide stream. A library
            // call cannot destroy stdout used by other requests or embedding code.
            if (options.destroyOnTimeout)
                stdout.destroy();
            finish(new Error('hook_stdout_unconfirmed'));
        }, 1000);
        stdout.on('error', onError);
        stdout.once('close', onClose);
        try {
            stdout.write(text, written);
        }
        catch (error) {
            written(error instanceof Error ? error : new Error('hook_stdout_failed'));
        }
    });
}