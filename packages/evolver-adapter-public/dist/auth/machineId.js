import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
/** Linux: /etc/machine-id | /var/lib/dbus/machine-id; macOS/Windows 由调用方注入. */
export const DEFAULT_OS_READERS = [
    () => tryRead('/etc/machine-id'),
    () => tryRead('/var/lib/dbus/machine-id'),
];
function tryRead(p) {
    try {
        const v = readFileSync(p, 'utf8').trim();
        return v || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 机器标识(CEO 决策, 2026-06-06): **优先 OS machineId(/etc/machine-id 等), 读不到回退安装时软 UUID**.
 * 容器/CI 不脆、不依赖 MAC、跨平台一致. 软 UUID 首次生成存 0600.
 */
export function resolveMachineId(opts) {
    for (const r of opts.osReaders ?? DEFAULT_OS_READERS) {
        const v = r();
        if (v)
            return { id: v, source: 'os' };
    }
    if (existsSync(opts.softIdPath))
        return { id: readFileSync(opts.softIdPath, 'utf8').trim(), source: 'soft' };
    const fresh = randomUUID();
    mkdirSync(dirname(opts.softIdPath), { recursive: true });
    writeFileSync(opts.softIdPath, fresh, { mode: 0o600 });
    return { id: fresh, source: 'soft' };
}
/** device token 绑定用的指纹 = sha256(machineId). 不直接外泄 machineId. */
export function machineFingerprint(machineId) {
    return createHash('sha256').update(machineId).digest('hex');
}