export const PROXY_TRACE_UPLOAD_SCHEMA = 'prism_trace_row.v1';
function parseNodeSecretVersion(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
export function buildProxyTraceUploadPayload(record) {
    const secretVersion = parseNodeSecretVersion(record.secret_version);
    return {
        schema: PROXY_TRACE_UPLOAD_SCHEMA,
        encrypted: true,
        trace: record,
        ...(secretVersion !== undefined ? { node_secret_version: secretVersion } : {}),
        ...(record.producer_generation ? { producer_generation: record.producer_generation } : {}),
        ...(record.producer_version ? { producer_version: record.producer_version } : {}),
        ...(record.producer_component ? { producer_component: record.producer_component } : {}),
    };
}
export function proxyTraceUploadPayloadSizeBytes(record) {
    return Buffer.byteLength(JSON.stringify(buildProxyTraceUploadPayload(record)), 'utf8');
}