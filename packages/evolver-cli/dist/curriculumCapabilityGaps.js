import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { events, mailbox, signals } from '@evomap/evolver-core';
export function resolveCurriculumMailboxPath(env = process.env) {
    const configured = env['EVOLVER_PROXY_STORE']?.trim();
    return configured && configured.length > 0
        ? configured
        : join(events.evomapHome(env), 'proxy', 'mailbox.db');
}
/** Read one immutable lifecycle snapshot per curriculum preparation without creating a proxy database. */
export function readPersistedCapabilityGaps(env = process.env) {
    const path = resolveCurriculumMailboxPath(env);
    if (!existsSync(path))
        return [];
    try {
        return signals.capabilityGapsFromState(mailbox.readMailboxState(path, signals.CAPABILITY_GAPS_STATE_KEY));
    }
    catch {
        return [];
    }
}
export function makeCurriculumCapabilityGapsProvider(env = process.env) {
    return () => readPersistedCapabilityGaps(env);
}