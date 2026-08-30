export const TASK_DOMAIN_SIGNAL_PREFIX = 'task_domain:';
const TASK_DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Identify the namespace even when the value is malformed, so it cannot leak into generic matching. */
export function isTaskDomainSignal(raw) {
    return raw.trim().toLowerCase().startsWith(TASK_DOMAIN_SIGNAL_PREFIX);
}
/** Remove task-domain tokens from generic matching while preserving their original wire representation elsewhere. */
export function withoutTaskDomainSignals(signals) {
    return signals.filter((signal) => !isTaskDomainSignal(signal));
}
/**
 * Resolve one canonical task domain from signal tokens. Parsing is order-independent and fail-closed:
 * malformed tokens invalidate the whole dimension, and distinct valid slugs are ambiguous.
 */
export function resolveTaskDomainSignals(signals) {
    const slugs = new Set();
    let found = false;
    for (const raw of signals) {
        const signal = raw.trim();
        const lower = signal.toLowerCase();
        if (!lower.startsWith(TASK_DOMAIN_SIGNAL_PREFIX))
            continue;
        found = true;
        if (signal !== raw)
            return { status: 'invalid' };
        const slug = lower.slice(TASK_DOMAIN_SIGNAL_PREFIX.length);
        if (!TASK_DOMAIN_SLUG_RE.test(slug))
            return { status: 'invalid' };
        slugs.add(slug);
    }
    if (!found)
        return { status: 'absent' };
    if (slugs.size !== 1)
        return { status: 'ambiguous' };
    return { status: 'resolved', slug: slugs.values().next().value };
}
/** Emit a canonical wire token. Callers must supply an already-normalized lowercase slug. */
export function taskDomainSignal(slug) {
    if (!TASK_DOMAIN_SLUG_RE.test(slug)) {
        throw new Error(`invalid task_domain slug: ${slug}`);
    }
    return `${TASK_DOMAIN_SIGNAL_PREFIX}${slug}`;
}