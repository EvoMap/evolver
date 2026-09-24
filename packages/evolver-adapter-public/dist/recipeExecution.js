import { createHash } from 'node:crypto';
import { hub } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubFetch, HubUnreachableError, authenticateHubRequest } from './hubFetch.js';
import { isHubDryRunEnabled } from './hubCapability.js';
const correctableFinalizationCodes = new Set(['invalid_output_schema', 'invalid_final_output', 'invalid_execution_evidence', 'execution_evidence_required', 'execution_evidence_digest_mismatch', 'execution_artifacts_required', 'invalid_text_transform_output', 'execution_steps_incomplete']);
export function recipeHubError(error, operation) {
    if (error instanceof hub.RecipeExecutionError)
        return error;
    if (error instanceof HubClientError || error instanceof AuthError) {
        const body = error.body && typeof error.body === 'object' ? error.body : {};
        const raw = body['code'] ?? body['error'];
        const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(raw) ? raw : 'recipe_hub_request_failed';
        const retryAfterMs = error instanceof HubClientError && Number.isFinite(error.retryAfterMs) && (error.retryAfterMs ?? -1) >= 0 ? error.retryAfterMs : undefined;
        const rejected = operation === 'finalize' && (error.status === 400 || error.status === 409) && correctableFinalizationCodes.has(code);
        return new hub.RecipeExecutionError(code, error.status, retryAfterMs, rejected ? 'rejected' : 'unknown');
    }
    if (error instanceof HubUnreachableError)
        return new hub.RecipeExecutionError('recipe_hub_unreachable', 503, error.retryAfterMs);
    return new hub.RecipeExecutionError('recipe_execution_failed', 502);
}
export function createRecipeExecution(opts) {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const scope = () => {
        const sender = opts.senderId();
        if (!sender)
            throw new hub.RecipeExecutionError('recipe_node_identity_required', 409);
        return createHash('sha256').update(JSON.stringify([baseUrl, sender])).digest('hex');
    };
    const prepare = async (operation, input, expectedScope) => {
        const parsed = hub.parseRecipeExecutionInput(operation, input);
        if (isHubDryRunEnabled())
            throw new hub.RecipeExecutionError('recipe_execution_disabled_in_dry_run', 409, undefined, 'rejected', 'not_sent');
        const frozenScope = expectedScope ?? scope();
        const sender = opts.senderId();
        const assertIdentity = () => {
            if (!sender || opts.senderId() !== sender || scope() !== frozenScope)
                throw new hub.RecipeExecutionError('recipe_identity_scope_mismatch', 409, undefined, 'rejected', 'not_sent');
        };
        assertIdentity();
        const target = encodeURIComponent(String(parsed['recipeId'] ?? parsed['organismId'] ?? parsed['taskId'] ?? ''));
        const path = operation === 'express' ? `/a2a/recipe/${target}/express`
            : operation === 'get' ? `/a2a/organism/${target}/private`
                : operation === 'list' ? '/a2a/organism/mine'
                    : operation === 'task' ? `/a2a/recipe-execution/task/${target}`
                        : `/a2a/organism/${target}/${operation}`;
        const names = { inputPayload: 'input_payload', requestKey: 'request_key', maxCredits: 'max_credits', executionMode: 'execution_mode', leaseId: 'lease_id', assetId: 'asset_id' };
        const body = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => !['recipeId', 'organismId', 'taskId'].includes(key) && value !== undefined).map(([key, value]) => [names[key] ?? key, value]));
        const read = ['get', 'list', 'task'].includes(operation);
        let signed;
        let headers;
        try {
            signed = await authenticateHubRequest(opts, read ? 'GET' : 'POST', path, read ? undefined : body);
            assertIdentity();
            const fields = signed.bodyFields ?? {};
            if (Object.keys(fields).some((key) => key !== 'node_secret'))
                throw new hub.RecipeExecutionError('recipe_auth_body_fields_unsupported', 400, undefined, 'rejected', 'not_sent');
            headers = { ...signed.headers };
            if (fields['node_secret'] !== undefined) {
                if (typeof fields['node_secret'] !== 'string' || !fields['node_secret'])
                    throw new hub.RecipeExecutionError('recipe_auth_invalid', 400, undefined, 'rejected', 'not_sent');
                if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization'))
                    headers['Authorization'] = `Bearer ${fields['node_secret']}`;
            }
        }
        catch (error) {
            throw recipeHubError(error, operation);
        }
        const auth = {
            kind: opts.auth.kind,
            login: () => opts.auth.login(), rotate: () => opts.auth.rotate(), revoke: (id) => opts.auth.revoke(id),
            authenticate: async () => {
                assertIdentity();
                return { ...signed, headers, bodyFields: {} };
            },
        };
        const http = new HubFetch({ ...opts, baseUrl, auth, senderId: () => sender, fetchFn: (url, init) => { assertIdentity(); return opts.fetchFn(url, init); } });
        return {
            invoke: async () => {
                try {
                    const response = await http.call(read ? 'GET' : 'POST', path, read ? undefined : body, read ? body : undefined);
                    const validated = hub.recipeExecutionResponses[operation].safeParse(response);
                    if (!validated.success)
                        throw new hub.RecipeExecutionError(`recipe_${operation}_response_invalid`, 502);
                    return validated.data;
                }
                catch (error) {
                    throw recipeHubError(error, operation);
                }
            },
        };
    };
    return {
        protocolVersion: 1,
        scope,
        prepare,
        async invoke(operation, input, expectedScope) {
            return await (await prepare(operation, input, expectedScope)).invoke();
        },
    };
}