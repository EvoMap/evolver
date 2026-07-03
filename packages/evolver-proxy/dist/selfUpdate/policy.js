/** Resolve EVOLVER_SELF_UPDATE to a policy. Unset/unrecognized → 'off' (fail-closed). */
export function resolveSelfUpdatePolicy(env = process.env) {
    const raw = (env['EVOLVER_SELF_UPDATE'] ?? '').trim().toLowerCase();
    if (raw === 'prompt')
        return 'prompt';
    if (raw === 'auto')
        return 'auto';
    return 'off';
}