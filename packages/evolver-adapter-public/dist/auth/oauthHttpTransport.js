import { assertHubUrlSecure, globalFetchLike } from '../hubFetch.js';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** First-party public client seeded on the hub (scripts/seed-evolver-oauth-client.js). */
export const DEFAULT_CLIENT_ID = 'evolver-cli';
/**
 * Default scopes requested by `evolver login`. `a2a` is the converged
 * replacement for node_secret on the agent surface (Phase 2); the recipe/gene
 * scopes cover the publish path. The hub clamps to the client's allowedScopes,
 * so over-asking is safe.
 */
export const DEFAULT_SCOPES = ['a2a', 'recipe:read', 'recipe:write', 'recipe:publish', 'gene:read', 'reuse:query'];
/**
 * Real HTTP transport (M6-6) for the RFC 8628 device authorization grant. The
 * device_authorization + token endpoints are PUBLIC (the device_code itself is
 * the credential), so this posts plain JSON and does NOT go through HubFetch's
 * AuthProvider header injection. Egress still runs through the secure FetchLike
 * (https-only guard + forced-TLS dispatcher) — same chokepoint as /a2a.
 *
 * Wire shapes are pinned to the deployed hub (verified on prod): the hub speaks
 * JSON (it mounts express.json() only), returns RFC 8628 fields, and signals
 * polling state via `{ "error": "authorization_pending" | "slow_down" }` (HTTP
 * 400). `slow_down`/`authorization_pending` map to `{ pending: true }`; any other
 * error (access_denied / expired_token / invalid_grant) throws.
 */
export function createOAuthHttpTransport(opts) {
    const base = opts.hubUrl.replace(/\/$/, '');
    const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
    const scope = (opts.scopes ?? DEFAULT_SCOPES).join(' ');
    const fetchFn = opts.fetchFn ?? globalFetchLike;
    async function postJson(path, body) {
        const url = `${base}${path}`;
        assertHubUrlSecure(url); // defense in depth; also enforced inside globalFetchLike
        const res = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({})));
        return { status: res.status, json };
    }
    return {
        async requestDeviceCode(_fingerprint) {
            // The hub binds the device authorization to the client + the approving
            // user, not to a machine fingerprint, so the fingerprint is not sent here;
            // it is bound locally on the resulting credential (x-evomap-device header).
            const { status, json } = await postJson('/oauth/device_authorization', {
                client_id: clientId,
                scope,
            });
            if (status >= 400 || !json.device_code || !json.user_code) {
                throw new Error(`device_authorization failed (HTTP ${status}): ${json.error ?? 'no device_code'}`);
            }
            return {
                deviceCode: json.device_code,
                userCode: json.user_code,
                verificationUri: json.verification_uri_complete ?? json.verification_uri ?? '',
                intervalMs: (json.interval ?? 5) * 1000,
            };
        },
        async pollToken(deviceCode) {
            const { status, json } = await postJson('/oauth/token', {
                grant_type: DEVICE_GRANT,
                device_code: deviceCode,
                client_id: clientId,
            });
            if (json.access_token) {
                return tokenResp(json);
            }
            if (json.error === 'authorization_pending' || json.error === 'slow_down') {
                return { pending: true };
            }
            throw new Error(`token poll failed (HTTP ${status}): ${json.error ?? 'unknown'}`);
        },
        async refresh(refreshToken) {
            const { status, json } = await postJson('/oauth/token', {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: clientId,
            });
            if (!json.access_token) {
                throw new Error(`refresh failed (HTTP ${status}): ${json.error ?? 'no access_token'}`);
            }
            return tokenResp(json);
        },
    };
}
function tokenResp(json) {
    return {
        token: json.access_token,
        ...(json.expires_in ? { expiresInMs: json.expires_in * 1000 } : {}),
        ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    };
}