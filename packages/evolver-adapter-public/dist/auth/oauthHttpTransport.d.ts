import { type FetchLike } from '../hubFetch.js';
import type { OAuthTransport } from './oauthDeviceToken.js';
/** First-party public client seeded on the hub (scripts/seed-evolver-oauth-client.js). */
export declare const DEFAULT_CLIENT_ID = "evolver-cli";
/**
 * Default scopes requested by `evolver login`. `a2a` is the converged
 * replacement for node_secret on the agent surface (Phase 2); the recipe/gene
 * scopes cover the publish path. The hub clamps to the client's allowedScopes,
 * so over-asking is safe.
 */
export declare const DEFAULT_SCOPES: string[];
export interface OAuthHttpTransportOptions {
    /** Hub base URL, e.g. https://evomap.ai (same EVOMAP_HUB_URL the /a2a calls use). */
    hubUrl: string;
    clientId?: string;
    scopes?: string[];
    /** Injected for tests; defaults to the secure global fetch (https guard + forced TLS). */
    fetchFn?: FetchLike;
}
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
export declare function createOAuthHttpTransport(opts: OAuthHttpTransportOptions): OAuthTransport;