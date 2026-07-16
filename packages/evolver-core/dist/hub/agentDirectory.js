export const AGENT_DIRECTORY_DEFAULT_LIMIT = 20;
export const AGENT_DIRECTORY_MAX_LIMIT = 50;
export const AGENT_DIRECTORY_DEFAULT_TIMEOUT_MS = 8_000;
export const AGENT_DIRECTORY_MAX_TIMEOUT_MS = 30_000;
export const AGENT_DIRECTORY_MAX_QUERY_LENGTH = 500;
export const AGENT_DIRECTORY_MAX_SIGNAL_COUNT = 20;
export const AGENT_DIRECTORY_MAX_SIGNAL_LENGTH = 64;
export const AGENT_DIRECTORY_MAX_CURSOR_LENGTH = 256;
export const AGENT_DIRECTORY_MAX_AGENT_ID_LENGTH = 128;
export class AgentDirectoryInputError extends Error {
    code = 'invalid_request';
}
export function normalizeAgentSearchRequest(input) {
    const query = optionalText(input.query, 'query', AGENT_DIRECTORY_MAX_QUERY_LENGTH);
    const signals = normalizeSignals(input.signals);
    const availability = input.availability ? enumValue(input.availability, ['online', 'busy', 'offline', 'unknown'], 'availability') : undefined;
    if (!query && signals.length === 0)
        throw new AgentDirectoryInputError('query_or_signals_required');
    return {
        ...(query ? { query } : {}),
        ...(signals.length > 0 ? { signals } : {}),
        ...(availability ? { availability } : {}),
        ...(input.cursor ? { cursor: requiredText(input.cursor, 'cursor', AGENT_DIRECTORY_MAX_CURSOR_LENGTH) } : {}),
        limit: boundedInteger(input.limit, AGENT_DIRECTORY_DEFAULT_LIMIT, 1, AGENT_DIRECTORY_MAX_LIMIT, 'limit'),
        timeoutMs: boundedInteger(input.timeoutMs, AGENT_DIRECTORY_DEFAULT_TIMEOUT_MS, 100, AGENT_DIRECTORY_MAX_TIMEOUT_MS, 'timeout_ms'),
        sort: input.sort ? enumValue(input.sort, ['relevance', 'reputation', 'recent', 'availability'], 'sort') : 'relevance',
        order: input.order ? enumValue(input.order, ['asc', 'desc'], 'order') : 'desc',
    };
}
export function normalizeAgentTaskDiscoveryRequest(input) {
    const title = requiredText(input.title, 'title', AGENT_DIRECTORY_MAX_QUERY_LENGTH);
    const description = optionalText(input.description, 'description', AGENT_DIRECTORY_MAX_QUERY_LENGTH);
    const search = normalizeAgentSearchRequest({
        query: [title, description].filter(Boolean).join('\n'),
        signals: input.signals,
        availability: input.availability,
        sort: input.sort,
        order: input.order,
        cursor: input.cursor,
        limit: input.limit,
        timeoutMs: input.timeoutMs,
    });
    return { ...search, title, ...(description ? { description } : {}) };
}
export function normalizeAgentId(value) {
    return requiredText(value, 'agent_id', AGENT_DIRECTORY_MAX_AGENT_ID_LENGTH);
}
export function normalizeAgentDirectoryTimeout(value) {
    return boundedInteger(value, AGENT_DIRECTORY_DEFAULT_TIMEOUT_MS, 100, AGENT_DIRECTORY_MAX_TIMEOUT_MS, 'timeout_ms');
}
export function capabilityUnavailable(message = 'agent_directory_not_supported') {
    return { ok: false, error: { code: 'capability_unavailable', retryable: false, message } };
}
export function unsupportedAgentDirectoryCapability(message) {
    return {
        search: async () => capabilityUnavailable(message),
        getProfile: async () => capabilityUnavailable(message),
        discoverForTask: async () => capabilityUnavailable(message),
    };
}
function normalizeSignals(input) {
    if (input === undefined)
        return [];
    if (!Array.isArray(input))
        throw new AgentDirectoryInputError('signals_must_be_array');
    if (input.length > AGENT_DIRECTORY_MAX_SIGNAL_COUNT)
        throw new AgentDirectoryInputError('too_many_signals');
    const out = [];
    for (const value of input) {
        if (typeof value !== 'string')
            throw new AgentDirectoryInputError('signal_must_be_string');
        const signal = requiredText(value, 'signal', AGENT_DIRECTORY_MAX_SIGNAL_LENGTH);
        if (!out.includes(signal))
            out.push(signal);
    }
    return out;
}
function optionalText(value, field, maxLength) {
    if (value === undefined)
        return undefined;
    return requiredText(value, field, maxLength);
}
function requiredText(value, field, maxLength) {
    if (typeof value !== 'string')
        throw new AgentDirectoryInputError(`${field}_must_be_string`);
    const text = value.trim();
    if (!text)
        throw new AgentDirectoryInputError(`${field}_required`);
    if (text.length > maxLength)
        throw new AgentDirectoryInputError(`${field}_too_long`);
    return text;
}
function boundedInteger(value, fallback, min, max, field) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < min || value > max)
        throw new AgentDirectoryInputError(`${field}_out_of_range`);
    return value;
}
function enumValue(value, allowed, field) {
    if (!allowed.includes(value))
        throw new AgentDirectoryInputError(`${field}_invalid`);
    return value;
}