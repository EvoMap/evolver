const MAX_RECALL_CONTEXT_BYTES = 4096;
/** A recall context is forwarded whole when it is a plain JSON object of bounded size; anything else is dropped. */
export function recallContextOf(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const serialized = JSON.stringify(value);
    if (serialized === '{}' || Buffer.byteLength(serialized) > MAX_RECALL_CONTEXT_BYTES)
        return undefined;
    return value;
}