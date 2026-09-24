import { hub } from '@evomap/evolver-core';
import { recipeHubError } from '@evomap/evolver-adapter-public';
export function recipeIpcScope(capability) {
    try {
        return hub.requireRecipeExecution(capability).scope() || null;
    }
    catch {
        return null;
    }
}
export async function invokeRecipeIpc(capability, governance, operation, raw, hubMode) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { status: 400, body: { error: 'invalid_recipe_input' } };
    const { expected_hub_mode: expected, expected_recipe_scope: expectedScope, ...input } = raw;
    if (expected !== undefined && expected !== 'public' && expected !== 'private')
        return { status: 400, body: { error: 'invalid_expected_hub_mode' } };
    if (expected !== undefined && expected !== (hubMode ?? 'public'))
        return { status: 409, body: { error: 'proxy_hub_mode_mismatch' } };
    try {
        const parsed = hub.parseRecipeExecutionInput(operation, input);
        if (expectedScope !== undefined && (typeof expectedScope !== 'string' || !expectedScope || expectedScope !== recipeIpcScope(capability?.execution)))
            throw new hub.RecipeExecutionError('recipe_identity_scope_mismatch', 409);
        const result = await governance.invoke(capability?.execution, operation, parsed);
        return { status: 200, body: result };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        const status = message.startsWith('recipe_paid_consent_required:') || message === 'recipe_host_credit_ceiling_exceeded' ? 403
            : message === 'recipe_execution_protocol_unsupported' ? 501
                : message === 'recipe_intent_payload_conflict' ? 409 : undefined;
        if (status !== undefined) {
            const code = message.split(':')[0];
            return { status, body: { error: code, code, status } };
        }
        const mapped = recipeHubError(error, operation);
        return { status: mapped.status, body: { error: mapped.code, code: mapped.code, status: mapped.status, ...(mapped.retryAfterMs !== undefined ? { retryAfterMs: mapped.retryAfterMs } : {}) } };
    }
}