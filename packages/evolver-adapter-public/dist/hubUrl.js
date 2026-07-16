export const DEFAULT_PUBLIC_HUB_URL = 'https://evomap.ai';
const HUB_URL_KEYS = ['A2A_HUB_URL', 'EVOMAP_HUB_URL', 'EVOLVER_DEFAULT_HUB_URL'];
function normalizeHubUrl(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    const normalized = trimmed.replace(/\/+$/, '');
    return normalized || undefined;
}
export function resolveConfiguredHubUrl(env) {
    for (const key of HUB_URL_KEYS) {
        const resolved = normalizeHubUrl(env[key]);
        if (resolved)
            return resolved;
    }
    return undefined;
}
export function resolveHubUrl(env) {
    return resolveConfiguredHubUrl(env) ?? DEFAULT_PUBLIC_HUB_URL;
}