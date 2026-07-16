import { hub as hubNs } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError } from './hubFetch.js';
const MAX_TEXT_LENGTH = 500;
const MAX_CAPABILITY_COUNT = 50;
export const PUBLIC_TASK_DISCOVERY_MAX_CANDIDATES = hubNs.AGENT_DIRECTORY_MAX_LIMIT * 2;
export function publicAgentSearchQuery(request) {
    const normalized = hubNs.normalizeAgentSearchRequest(request);
    return {
        ...(normalized.query ? { q: normalized.query } : {}),
        ...(normalized.signals && normalized.signals.length > 0 ? { signals: normalized.signals.join(',') } : {}),
        limit: hubNs.AGENT_DIRECTORY_MAX_LIMIT,
        online_only: normalized.availability === 'offline' ? 'false' : 'true',
    };
}
export function unsupportedPublicAvailability(availability) {
    if (availability === 'busy' || availability === 'offline' || availability === 'unknown') {
        return hubNs.capabilityUnavailable(`public_hub_availability_${availability}_not_supported`);
    }
    return undefined;
}
export function unsupportedPublicSort(sort) {
    if (sort === 'recent')
        return hubNs.capabilityUnavailable('public_hub_sort_recent_not_supported');
    return undefined;
}
export function publicTaskDiscoveryQuery(request) {
    return publicAgentSearchQuery(hubNs.normalizeAgentTaskDiscoveryRequest(request));
}
export function parsePublicAgentPage(body) {
    const record = asRecord(body);
    const payload = asRecord(record?.['payload']) ?? record;
    const rawItems = Array.isArray(payload?.['results'])
        ? payload['results']
        : Array.isArray(payload?.['agents'])
            ? payload['agents']
            : Array.isArray(body)
                ? body
                : undefined;
    if (!rawItems)
        return invalidResponse('agent_directory_results_missing');
    const items = [];
    for (const raw of rawItems) {
        const parsed = parseAgentEntry(raw);
        if (!parsed)
            return invalidResponse('agent_directory_entry_invalid');
        items.push(parsed);
    }
    const nextCursor = optionalString(payload?.['next_cursor'] ?? payload?.['nextCursor'], 256);
    const hasMoreValue = payload?.['has_more'] ?? payload?.['hasMore'];
    if (hasMoreValue !== undefined && typeof hasMoreValue !== 'boolean')
        return invalidResponse('agent_directory_has_more_invalid');
    return { ok: true, value: { items, ...(nextCursor ? { nextCursor } : {}), hasMore: typeof hasMoreValue === 'boolean' ? hasMoreValue : Boolean(nextCursor) } };
}
export function paginatePublicAgentPage(page, request, maxOffset = hubNs.AGENT_DIRECTORY_MAX_LIMIT) {
    if (!page.ok)
        return page;
    const normalized = hubNs.normalizeAgentSearchRequest(request);
    const offset = cursorOffset(normalized.cursor, maxOffset);
    const filtered = normalized.availability
        ? page.value.items.filter((item) => item.availability === normalized.availability)
        : page.value.items;
    const items = [...filtered].sort(agentComparator(normalized.sort, normalized.order));
    const slice = items.slice(offset, offset + normalized.limit);
    const nextOffset = offset + slice.length;
    return {
        ok: true,
        value: {
            items: slice,
            ...(nextOffset < items.length ? { nextCursor: `offset:${nextOffset}` } : {}),
            hasMore: nextOffset < items.length,
        },
    };
}
export function mergePublicAgentPages(pages) {
    const failed = pages.find((page) => !page.ok);
    if (failed && !failed.ok)
        return failed;
    const items = new Map();
    for (const page of pages) {
        if (!page.ok)
            continue;
        for (const item of page.value.items) {
            const previous = items.get(item.agentId);
            if (!previous || (item.score ?? -1) > (previous.score ?? -1))
                items.set(item.agentId, item);
        }
    }
    return { ok: true, value: { items: [...items.values()], hasMore: false } };
}
export function parsePublicAgentProfile(body) {
    if (body === null)
        return { ok: true, value: null };
    const record = asRecord(body);
    const payload = asRecord(record?.['payload']) ?? record;
    const profile = asRecord(payload?.['profile']) ?? payload;
    if (!profile)
        return invalidResponse('agent_profile_invalid');
    const entry = parseAgentEntry(profile);
    if (!entry)
        return invalidResponse('agent_profile_invalid');
    const taskStatsCompletedCount = completedTaskCountFromTaskStats(profile['task_stats']);
    if (taskStatsCompletedCount === null)
        return invalidResponse('agent_profile_invalid');
    const { score: _score, ...safeProfile } = entry;
    return {
        ok: true,
        value: {
            ...safeProfile,
            ...(safeProfile.completedTaskCount === undefined && taskStatsCompletedCount !== undefined
                ? { completedTaskCount: taskStatsCompletedCount }
                : {}),
        },
    };
}
export function agentDirectoryFailure(error) {
    if (error instanceof hubNs.AgentDirectoryInputError)
        return { ok: false, error: { code: 'invalid_request', retryable: false, message: error.message } };
    if (error instanceof DirectoryTimeoutError)
        return { ok: false, error: { code: 'timeout', retryable: true, message: 'agent_directory_timeout' } };
    if (error instanceof AuthError)
        return { ok: false, error: { code: 'permission_denied', retryable: false, message: 'agent_directory_permission_denied' } };
    if (error instanceof HubClientError && (error.status === 404 || error.status === 405 || error.status === 501))
        return hubNs.capabilityUnavailable();
    if (error instanceof HubUnreachableError || isNetworkError(error))
        return { ok: false, error: { code: 'hub_unavailable', retryable: true, message: 'agent_directory_hub_unavailable' } };
    if (error instanceof HubClientError)
        return { ok: false, error: { code: 'invalid_request', retryable: false, message: `agent_directory_hub_${error.status}` } };
    return { ok: false, error: { code: 'hub_unavailable', retryable: true, message: 'agent_directory_request_failed' } };
}
export async function withDirectoryTimeout(operation, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new DirectoryTimeoutError()), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
class DirectoryTimeoutError extends Error {
}
function parseAgentEntry(value) {
    const record = asRecord(value);
    if (!record)
        return undefined;
    const agentId = optionalString(record['agent_id'] ?? record['agentId'] ?? record['node_id'] ?? record['nodeId'], 128);
    if (!agentId)
        return undefined;
    const capabilitiesValue = record['capabilities'];
    const capabilities = stringList(capabilitiesValue === undefined || capabilitiesValue === null ? record['signals'] : capabilitiesValue);
    const domains = stringArray(record['domains']);
    if (capabilities === null || domains === null)
        return undefined;
    const availability = availabilityValue(record['availability'], record['online']);
    const score = optionalBoundedNumber(record['score'], 0, 1);
    const reputation = optionalBoundedNumber(record['reputation'], 0, 1_000_000);
    const completedTaskCount = optionalInteger(record['completed_tasks'] ?? record['completedTaskCount'], 0);
    const lastSeenAt = optionalTimestamp(record['last_seen_at'] ?? record['lastSeenAt']);
    if (availability === null || score === null || reputation === null || completedTaskCount === null || lastSeenAt === null)
        return undefined;
    return {
        agentId,
        ...(optionalString(record['display_name'] ?? record['displayName'] ?? record['name'] ?? record['alias'], 120) ? { displayName: optionalString(record['display_name'] ?? record['displayName'] ?? record['name'] ?? record['alias'], 120) } : {}),
        ...(optionalString(record['summary'] ?? record['description'], MAX_TEXT_LENGTH) ? { summary: optionalString(record['summary'] ?? record['description'], MAX_TEXT_LENGTH) } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(domains !== undefined ? { domains } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(reputation !== undefined ? { reputation } : {}),
        ...(completedTaskCount !== undefined ? { completedTaskCount } : {}),
        ...(availability ? { availability } : {}),
        ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    };
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function hasOwn(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
}
function optionalString(value, maxLength) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text && text.length <= maxLength ? text : undefined;
}
function stringArray(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.length > MAX_CAPABILITY_COUNT)
        return null;
    const output = [];
    for (const item of value) {
        const text = optionalString(item, 64);
        if (!text)
            return null;
        if (!output.includes(text))
            output.push(text);
    }
    return output;
}
function stringList(value) {
    if (typeof value === 'string')
        return stringArray(value.split(',').map((item) => item.trim()).filter(Boolean));
    return stringArray(value);
}
function completedTaskCountFromTaskStats(value) {
    if (value === undefined)
        return undefined;
    const taskStats = asRecord(value);
    if (!taskStats)
        return null;
    if (!hasOwn(taskStats, 'completed'))
        return undefined;
    const completed = taskStats['completed'];
    if (!Number.isInteger(completed) || Number(completed) < 0)
        return null;
    return Number(completed);
}
function availabilityValue(value, online) {
    if (value === 'online' || value === 'busy' || value === 'offline' || value === 'unknown')
        return value;
    if (value !== undefined)
        return null;
    if (online === true)
        return 'online';
    if (online === false)
        return 'offline';
    if (online !== undefined)
        return null;
    return undefined;
}
function optionalBoundedNumber(value, min, max) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        return null;
    return value;
}
function optionalInteger(value, min) {
    if (value === undefined || value === null)
        return undefined;
    if (!Number.isInteger(value) || Number(value) < min)
        return null;
    return Number(value);
}
function optionalTimestamp(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        return value;
    if (typeof value === 'string' && value.length <= 64) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function invalidResponse(message) {
    return { ok: false, error: { code: 'invalid_response', retryable: false, message } };
}
function cursorOffset(cursor, maxOffset) {
    if (!cursor)
        return 0;
    const match = /^offset:(\d+)$/.exec(cursor);
    const offset = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(offset) || offset < 0 || offset > maxOffset) {
        throw new hubNs.AgentDirectoryInputError('cursor_invalid');
    }
    return offset;
}
function agentComparator(sort, order) {
    const direction = order === 'asc' ? 1 : -1;
    return (left, right) => direction * (sortValue(left, sort) - sortValue(right, sort)) || left.agentId.localeCompare(right.agentId);
}
function sortValue(entry, sort) {
    if (sort === 'reputation')
        return entry.reputation ?? -1;
    if (sort === 'recent')
        return entry.lastSeenAt ?? -1;
    if (sort === 'availability')
        return entry.availability === 'online' ? 3 : entry.availability === 'busy' ? 2 : entry.availability === 'unknown' ? 1 : 0;
    return entry.score ?? -1;
}
function isNetworkError(error) {
    const record = asRecord(error);
    return record?.['name'] === 'AbortError' || record?.['name'] === 'TimeoutError' || record?.['code'] === 'HUB_UNREACHABLE';
}