import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pluginHome } from './pluginRuntime.js';
const ZCODE_DESKTOP_CLI = ['resources', 'glm', 'zcode.cjs'];
const ZCODE_MAC_CLI = ['ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'];
const isFile = (path) => {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
};
/** ZCode ships its CLI as a Node script inside Desktop; ZCODE_CLI_PATH names another copy of that zcode.cjs script. */
function zcodeCliCandidates(runtime) {
    const explicit = runtime.env['ZCODE_CLI_PATH']?.trim();
    if (explicit)
        return isAbsolute(explicit) ? [explicit] : [];
    const home = pluginHome(runtime);
    if (runtime.platform === 'win32')
        return [join(runtime.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'Programs', 'ZCode', ...ZCODE_DESKTOP_CLI)];
    if (runtime.platform === 'darwin')
        return [join(home, 'Applications', ...ZCODE_MAC_CLI), join('/Applications', ...ZCODE_MAC_CLI)];
    return [];
}
/** The argv prefix that runs the host's own CLI, or undefined when it is not present on this machine. ZCode's CLI is
 * a Node script, never a `zcode` executable on PATH. */
export function hostLauncher(runtime, host) {
    if (host.id === 'zcode') {
        const cli = zcodeCliCandidates(runtime).find(isFile);
        return cli && runtime.available('node') ? ['node', cli] : undefined;
    }
    return host.command && runtime.available(host.command) ? [host.command] : undefined;
}
/** What a preview shows when the host CLI is absent: the command a real install would run. */
export function expectedHostLauncher(runtime, host) {
    if (host.id === 'zcode')
        return ['node', zcodeCliCandidates(runtime)[0] ?? '<ZCode Desktop>/resources/glm/zcode.cjs'];
    return host.command ? [host.command] : [];
}