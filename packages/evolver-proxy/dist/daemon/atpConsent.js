import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export class AtpProxySpendConsentError extends Error {
    source;
    constructor(source) {
        super(`autonomous ATP order refused: auto-spend consent is disabled (source: ${source})`);
        this.source = source;
        this.name = 'AtpProxySpendConsentError';
    }
}
function atpProxyConsentPath(env = process.env) {
    const home = [env['EVOMAP_DIR'], env['EVOLVER_HOME'], env['EVOMAP_HOME']]
        .map((value) => value?.trim())
        .find((value) => Boolean(value))
        ?? join(homedir(), '.evomap');
    return join(home, 'evolution', 'atp-autobuy-ack.json');
}
export function getAtpProxyConsent(env = process.env, ackPath = atpProxyConsentPath(env)) {
    const override = envOverride(env);
    if (override !== null)
        return { enabled: override, source: 'env' };
    const ack = readAck(ackPath);
    if (typeof ack === 'boolean')
        return { enabled: ack, source: 'ack' };
    return { enabled: false, source: 'default' };
}
export function createAtpOrderConsentGate(env = process.env, ackPath = atpProxyConsentPath(env)) {
    return {
        assertAllowed() {
            const consent = getAtpProxyConsent(env, ackPath);
            if (!consent.enabled)
                throw new AtpProxySpendConsentError(consent.source);
        },
    };
}
function readAck(path) {
    try {
        if (!existsSync(path))
            return null;
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') {
            return raw.enabled;
        }
    }
    catch {
        return null;
    }
    return null;
}
function envOverride(env) {
    const raw = env['EVOLVER_ATP_AUTOBUY'];
    if (typeof raw !== 'string')
        return null;
    const s = raw.trim().toLowerCase();
    if (!s)
        return null;
    if (s === 'on' || s === '1' || s === 'true' || s === 'yes' || s === 'enable' || s === 'enabled')
        return true;
    if (s === 'off' || s === '0' || s === 'false' || s === 'no' || s === 'disable' || s === 'disabled' || s === 'none')
        return false;
    return false;
}