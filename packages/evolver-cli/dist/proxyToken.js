import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const USAGE = 'Usage: evolver proxy-token [--settings FILE]\n';
function proxyTokenUsage() {
    return USAGE;
}
function resolveProxyTokenSettingsPath(env = process.env, homeDir = homedir(), explicitSettings) {
    const explicit = explicitSettings?.trim();
    if (explicit)
        return explicit;
    const proxySettingsFile = env['EVOLVER_PROXY_SETTINGS_FILE']?.trim();
    if (proxySettingsFile)
        return proxySettingsFile;
    const settingsDir = env['EVOLVER_SETTINGS_DIR']?.trim() || join(homeDir, '.evolver');
    return join(settingsDir, 'settings.json');
}
function readProxyTokenFromSettingsFile(settingsPath, deps = {}) {
    const stat = deps.lstat ?? lstatSync;
    const read = deps.readFile ?? readFileSync;
    try {
        if (!stat(settingsPath).isFile())
            return undefined;
        const parsed = JSON.parse(read(settingsPath, 'utf8'));
        const proxy = recordValue(recordValue(parsed)['proxy']);
        const token = typeof proxy['token'] === 'string' ? proxy['token'].trim() : '';
        return token || undefined;
    }
    catch {
        return undefined;
    }
}
export async function runProxyToken(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    const env = deps.env ?? process.env;
    let settingsFile;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            stdout(proxyTokenUsage());
            return 0;
        }
        if (arg === '--settings') {
            const value = argv[i + 1];
            if (value === undefined || value.length === 0) {
                stderr(USAGE);
                stderr('[proxy-token] missing value for --settings\n');
                return 2;
            }
            settingsFile = value;
            i++;
            continue;
        }
        if (arg?.startsWith('--settings=')) {
            const value = arg.slice('--settings='.length);
            if (!value) {
                stderr(USAGE);
                stderr('[proxy-token] missing value for --settings\n');
                return 2;
            }
            settingsFile = value;
            continue;
        }
        stderr(USAGE);
        stderr('[proxy-token] unknown argument\n');
        return 2;
    }
    const path = resolveProxyTokenSettingsPath(env, deps.homeDir ?? homedir(), settingsFile);
    const token = readProxyTokenFromSettingsFile(path, deps);
    if (!token) {
        stderr('[proxy-token] no active proxy token found; start evolver-proxy first\n');
        return 1;
    }
    stdout(`${token}\n`);
    return 0;
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}