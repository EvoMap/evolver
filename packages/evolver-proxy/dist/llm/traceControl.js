import { verify } from 'node:crypto';
export const DEFAULT_TRACE_CONFIG_SIGNING_PUBLIC_KEY = [
    '-----BEGIN PUBLIC KEY-----',
    'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA7kJvWUP3HC4FJPQtkh74', // gitleaks:allow -- public verification key, not a credential.
    'y75h9Rzc2NSZC9e4fiIWdax4iv+yWeMeIHGNsMr7YI8Ws7ck1BimJWt026gwRW8I',
    'c2A7h97oZQ0Z0zFcjEZ8FpYFSu++Yz/dGrARAV7uCQg289jvo89F5fWNdX2k+lTH',
    'hBoBm0G71vkiAYlbQEjq1xm1WzYf8CVXmbr+J1z+ydQf9jczcFL79u3eQZhIPs3R',
    '8Sr83YrXWyCVOBIPTW4EbyR1RrHNs9pyrcHo7tyKdpKYreM/0de5A5Ya1VFaakVd',
    'RsE3UModswJeMzyHOj7wZ+OZVb466Bttr0wDHhg93sWg5h5m0YqNfEcdqFXKlxy3',
    'RCAu+hINcwt27CcIEU82jhDusiKEfM/EHS/uN3GTuvNaUFpmIOPNFYINKdjdiMJK',
    '50lyW9E3SN+Q3HT6flseEAI+hMvFx6wxGqzf64jWbuUlatl8M9v3NNZAOgG4SnTt',
    'PiOh2Uxc0qFAKPpcz8gaGYm0yMuFGsr5zb0IMDSBr++PAgMBAAE=',
    '-----END PUBLIC KEY-----',
].join('\n');
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function canonicalTraceConfigPayload(payload = {}) {
    const clean = {};
    for (const key of Object.keys(payload).sort()) {
        if (key === 'signature' || key === 'trace_config_signature' || key === 'signature_algorithm')
            continue;
        if (key === 'hub_public_key')
            continue;
        const value = payload[key];
        if (value !== undefined)
            clean[key] = value;
    }
    return JSON.stringify(clean);
}
export function verifyTraceConfigSignature(payload, env = process.env) {
    if (!isRecord(payload))
        return false;
    const publicKey = String(env['EVOMAP_TRACE_CONFIG_SIGNING_PUBLIC_KEY']
        || env['EVOMAP_PROXY_TRACE_CONFIG_SIGNING_PUBLIC_KEY']
        || DEFAULT_TRACE_CONFIG_SIGNING_PUBLIC_KEY).trim();
    const signature = String(payload['signature'] || payload['trace_config_signature'] || '').trim();
    if (!publicKey || !signature)
        return false;
    try {
        return verify('sha256', Buffer.from(canonicalTraceConfigPayload(payload), 'utf8'), publicKey, Buffer.from(signature, 'base64'));
    }
    catch {
        return false;
    }
}
export function applyTraceCollectionConfig(payload, store, env = process.env, logger = console) {
    if (!isRecord(payload)) {
        logger.warn?.('[trace-control] ignoring non-object trace config');
        return { ack: true, applied: false };
    }
    const enabled = payload['enabled'] ?? payload['trace_collection_enabled'] ?? payload['proxy_trace_collection_enabled'];
    if (typeof enabled !== 'boolean') {
        logger.warn?.('[trace-control] ignoring config without boolean enabled');
        return { ack: true, applied: false };
    }
    const signed = verifyTraceConfigSignature(payload, env);
    let profileEnabled = payload['profile_analysis_enabled'] ?? payload['trace_profile_analysis_enabled'];
    const traceHubPublicKey = typeof payload['trace_hub_public_key'] === 'string' ? payload['trace_hub_public_key'].trim() : '';
    const runtimeHubKey = typeof payload['hub_public_key'] === 'string' ? payload['hub_public_key'].trim() : '';
    if (!signed && enabled === true) {
        logger.warn?.('[trace-control] rejected unsigned trace config that could enable collection/profile analysis');
        return { ack: true, applied: false };
    }
    if (!signed && profileEnabled === true) {
        logger.warn?.('[trace-control] ignored unsigned profile analysis enable while applying trace disable');
        profileEnabled = false;
    }
    store.setState('trace_collection_enabled', enabled ? 'true' : 'false');
    if (typeof profileEnabled === 'boolean') {
        store.setState('trace_profile_analysis_enabled', profileEnabled ? 'true' : 'false');
    }
    if (signed && traceHubPublicKey && traceHubPublicKey.includes('PUBLIC KEY')) {
        store.setState('trace_hub_public_key', traceHubPublicKey);
    }
    else if (!signed && traceHubPublicKey) {
        logger.warn?.('[trace-control] ignored trace_hub_public_key from an unsigned config');
    }
    if (runtimeHubKey) {
        logger.warn?.('[trace-control] ignored runtime hub_public_key; use pinned EVOMAP_PROXY_TRACE_HUB_PUBLIC_KEY or signed trace_hub_public_key');
    }
    store.setState('trace_collection_updated_at', new Date().toISOString());
    logger.log?.(`[trace-control] trace collection ${enabled ? 'enabled' : 'disabled'}`);
    return { ack: true, applied: true };
}