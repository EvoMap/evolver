export function traceDisabledByValue(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off' || raw === 'none' || raw === 'no';
}
function truthyState(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}
function falseyState(value) {
    return value === false || value === 'false' || value === 0 || value === '0';
}
function storeState(store, key) {
    try {
        return store?.getState?.(key) ?? undefined;
    }
    catch {
        return undefined;
    }
}
export function traceCollectionEnabled(env = process.env, store) {
    const state = storeState(store, 'trace_collection_enabled') ?? storeState(store, 'proxy_trace_collection_enabled');
    if (falseyState(state))
        return false;
    if (env['EVOLVER_LLM_TRACE'] !== undefined)
        return !traceDisabledByValue(env['EVOLVER_LLM_TRACE']);
    if (env['EVOMAP_PROXY_TRACE'] !== undefined)
        return !traceDisabledByValue(env['EVOMAP_PROXY_TRACE']);
    return true;
}
export function traceProfileAnalysisEnabled(env = process.env, store) {
    if (env['EVOLVER_LLM_TRACE_PROFILE_ANALYSIS'] !== undefined)
        return !traceDisabledByValue(env['EVOLVER_LLM_TRACE_PROFILE_ANALYSIS']);
    if (env['EVOMAP_PROXY_TRACE_PROFILE_ANALYSIS'] !== undefined)
        return !traceDisabledByValue(env['EVOMAP_PROXY_TRACE_PROFILE_ANALYSIS']);
    const state = storeState(store, 'trace_profile_analysis_enabled') ?? storeState(store, 'proxy_trace_profile_analysis_enabled');
    return truthyState(state);
}
export function traceHubPublicKey(env = process.env, store) {
    const key = String(env['EVOLVER_LLM_TRACE_HUB_PUBLIC_KEY']
        || env['EVOMAP_PROXY_TRACE_HUB_PUBLIC_KEY']
        || storeState(store, 'trace_hub_public_key')
        || storeState(store, 'proxy_trace_hub_public_key')
        || '').trim();
    return key || null;
}