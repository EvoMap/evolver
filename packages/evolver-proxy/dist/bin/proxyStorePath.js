import { homedir } from 'node:os';
import { join } from 'node:path';
export function resolveProxyStorePath(env = process.env, homeDir = homedir()) {
    const configuredStore = env['EVOLVER_PROXY_STORE'];
    if (configuredStore && configuredStore.length > 0)
        return configuredStore;
    const configuredHome = env['EVOLVER_HOME'];
    const evomapHome = configuredHome && configuredHome.length > 0
        ? configuredHome
        : join(resolveLocalHome(env, homeDir), '.evomap');
    return join(evomapHome, 'proxy', 'mailbox.db');
}
function resolveLocalHome(env, homeDir) {
    const configuredHome = env['HOME'];
    return configuredHome && configuredHome.length > 0 ? configuredHome : homeDir;
}