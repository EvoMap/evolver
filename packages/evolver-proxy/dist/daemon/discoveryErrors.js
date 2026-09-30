import { AuthError, HubClientError, HubUnreachableError } from '@evomap/evolver-adapter-public';
/**
 * Maps only known upstream failures from read-only discovery calls. Unknown errors
 * deliberately continue to the IPC server's existing invalid-request behavior.
 */
export function classifyDiscoveryUpstreamError(error) {
    if (error instanceof AuthError && (error.status === 401 || error.status === 403)) {
        return failure(error.status, 'permission_denied', false);
    }
    if (isDiscoverySearchDegradedError(error)) {
        return failure(503, 'hub_unavailable', true);
    }
    if (isInvalidDiscoveryResponseError(error)) {
        return failure(502, 'invalid_response', false);
    }
    if (error instanceof HubClientError && error.status === 429) {
        return failure(429, 'hub_rate_limited', true, {
            retryAfterMs: retryAfterMs(error.retryAfterMs),
        });
    }
    if (error instanceof HubUnreachableError) {
        const { details } = error;
        const upstreamRetryAfterMs = details.retryAfterSource === 'local_backoff'
            ? undefined
            : retryAfterMs(details.retryAfterMs);
        const operation = details.operation;
        if (details.timeoutMs !== undefined || details.status === 504) {
            return failure(504, 'hub_timeout', true, {
                retryAfterMs: upstreamRetryAfterMs,
                timeoutMs: details.timeoutMs,
                operation,
            });
        }
        return failure(503, 'hub_unavailable', true, {
            retryAfterMs: upstreamRetryAfterMs,
            operation,
        });
    }
    // HubFetch intentionally exposes JSON 5xx as this exact Error shape. Do not
    // broaden this: arbitrary programmer errors and non-5xx response errors must
    // retain the IPC server's non-retryable fallback behavior.
    if (error instanceof Error && error.message === 'hub 504')
        return failure(504, 'hub_timeout', true);
    if (error instanceof Error && /^hub (?:500|502|503)$/.test(error.message)) {
        return failure(503, 'hub_unavailable', true);
    }
    return undefined;
}
function isDiscoverySearchDegradedError(error) {
    return hasErrorName(error, 'SemanticSearchDegradedError')
        || hasExactErrorMessage(error, 'semantic_search_degraded')
        || hasExactErrorMessage(error, 'recipe_search_degraded');
}
function isInvalidDiscoveryResponseError(error) {
    return hasErrorName(error, 'MalformedRecipeSearchPageError')
        || hasErrorName(error, 'SemanticSearchInvalidResponseError')
        || hasExactErrorMessage(error, 'semantic_search_status_invalid');
}
function hasErrorName(error, name) {
    return typeof error === 'object' && error !== null && error.name === name;
}
function hasExactErrorMessage(error, message) {
    return error instanceof Error && error.message === message;
}
function failure(status, code, retryable, details = {}) {
    return {
        status,
        body: {
            error: code,
            code,
            retryable,
            ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
            ...(details.timeoutMs !== undefined ? { timeoutMs: details.timeoutMs } : {}),
            ...(details.operation !== undefined ? { operation: details.operation } : {}),
        },
    };
}
function retryAfterMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}