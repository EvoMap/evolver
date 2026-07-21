import { personality } from '@evomap/evolver-core';
import { redactDiagnosticText } from './diagnosticSanitize.js';
export const PERSONALITY_DIAGNOSTICS_MAX_STATS = 40;
export const PERSONALITY_DIAGNOSTICS_MAX_HISTORY = 60;
const MAX_TEXT_CHARS = 240;
function boundedInteger(value, fallback, maximum) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(value)));
}
function finiteNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function nonnegativeInteger(value) {
    return Math.max(0, Math.floor(finiteNumber(value)));
}
function replaceControlCharacters(value) {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? ' ' : char;
    }
    return out;
}
function boundedText(value, maxChars = MAX_TEXT_CHARS) {
    return replaceControlCharacters(String(value ?? '')).slice(0, maxChars);
}
function nullableTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    const text = boundedText(value, 64);
    return Number.isNaN(Date.parse(text)) ? null : text;
}
function axisValue(value) {
    return Math.max(0, Math.min(1, finiteNumber(value)));
}
function currentAxes(value) {
    const record = value && typeof value === 'object' ? value : {};
    return {
        rigor: axisValue(record['rigor']),
        creativity: axisValue(record['creativity']),
        verbosity: axisValue(record['verbosity']),
        risk_tolerance: axisValue(record['risk_tolerance']),
        obedience: axisValue(record['obedience']),
    };
}
function statRows(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
    return Object.entries(value).map(([key, raw]) => {
        const record = raw && typeof raw === 'object' ? raw : {};
        return {
            key: redactDiagnosticText(key, MAX_TEXT_CHARS),
            success: nonnegativeInteger(record['success']),
            fail: nonnegativeInteger(record['fail']),
            avgScore: axisValue(record['avgScore']),
            n: nonnegativeInteger(record['n']),
            updatedAt: nullableTimestamp(record['updatedAt']),
        };
    }).sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
}
function historyRows(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((raw) => {
        const record = raw && typeof raw === 'object' ? raw : {};
        return {
            at: nullableTimestamp(record['at']) ?? '',
            key: redactDiagnosticText(record['key'], MAX_TEXT_CHARS),
            outcome: redactDiagnosticText(record['outcome'], MAX_TEXT_CHARS),
            score: record['score'] === null ? null : axisValue(record['score']),
        };
    });
}
export async function readPersonalityDiagnostics(reader, options = {}) {
    if (!reader)
        return { available: false, error: 'personality_unavailable' };
    try {
        const raw = await reader();
        const parsed = personality.personalityModel.safeParse(raw);
        if (!parsed.success)
            return { available: false, error: 'personality_unavailable' };
        const maxStats = boundedInteger(options.maxStats, PERSONALITY_DIAGNOSTICS_MAX_STATS, PERSONALITY_DIAGNOSTICS_MAX_STATS);
        const maxHistory = boundedInteger(options.maxHistory, PERSONALITY_DIAGNOSTICS_MAX_HISTORY, PERSONALITY_DIAGNOSTICS_MAX_HISTORY);
        const stats = statRows(parsed.data.stats);
        const history = historyRows(parsed.data.history);
        return {
            available: true,
            data: {
                current: currentAxes(parsed.data.current),
                updatedAt: nullableTimestamp(parsed.data.updatedAt),
                stats: stats.slice(0, maxStats),
                history: history.slice(-maxHistory).reverse(),
                truncated: { stats: stats.length > maxStats, history: history.length > maxHistory },
            },
        };
    }
    catch {
        return { available: false, error: 'personality_unavailable' };
    }
}