import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export function defaultProxySettingsPath(homeDir = homedir()) {
    return join(homeDir, '.evolver', 'settings.json');
}
export function publishProxySettings(options) {
    const settingsPath = options.settingsPath ?? defaultProxySettingsPath(options.homeDir);
    const record = options.record;
    if (!record.token.trim())
        return false;
    try {
        if (!settingsPathIsRegularFileOrMissing(settingsPath))
            return false;
        if (proxySettingsMatch(settingsPath, record)) {
            chmodSync(settingsPath, 0o600);
            return true;
        }
        const existing = readSettingsObject(settingsPath);
        const existingProxy = recordValue(existing['proxy']);
        const nextProxy = {
            ...existingProxy,
            url: record.url,
            pid: record.pid,
            started_at: record.started_at,
            token: record.token,
            ...(record.version ? { version: record.version } : {}),
        };
        if (!settingsPathIsRegularFileOrMissing(settingsPath))
            return false;
        writeSettingsAtomic(settingsPath, { ...existing, proxy: nextProxy });
        return true;
    }
    catch {
        return false;
    }
}
export function proxySettingsMatch(settingsPath, record) {
    if (!settingsPathIsRegularFileOrMissing(settingsPath))
        return false;
    const proxy = recordValue(readSettingsObject(settingsPath)['proxy']);
    return proxy['url'] === record.url
        && proxy['token'] === record.token
        && proxy['pid'] === record.pid
        && proxy['started_at'] === record.started_at
        && (record.version === undefined || proxy['version'] === record.version);
}
function readSettingsObject(settingsPath) {
    try {
        if (!settingsPathIsRegularFileOrMissing(settingsPath))
            return {};
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
        return recordValue(parsed);
    }
    catch {
        return {};
    }
}
function recordValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function settingsPathIsRegularFileOrMissing(settingsPath) {
    try {
        return lstatSync(settingsPath).isFile();
    }
    catch (err) {
        return err.code === 'ENOENT';
    }
}
function writeSettingsAtomic(settingsPath, settings) {
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    const tmp = `${settingsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        chmodSync(tmp, 0o600);
        renameSync(tmp, settingsPath);
        chmodSync(settingsPath, 0o600);
    }
    catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}