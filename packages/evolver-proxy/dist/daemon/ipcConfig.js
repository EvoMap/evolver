export function resolveIpcPort(env) {
    const explicitRaw = env['EVOLVER_IPC_PORT']?.trim();
    const legacyRaw = env['EVOMAP_PROXY_PORT']?.trim();
    const raw = explicitRaw || legacyRaw;
    if (!raw)
        return undefined;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        const key = explicitRaw ? 'EVOLVER_IPC_PORT' : 'EVOMAP_PROXY_PORT';
        throw new Error(`${key} invalid: ${raw} (expected integer 0..65535)`);
    }
    return port;
}