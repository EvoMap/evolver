/** OS 级 machineId 读取器(按平台). 返回首个非空, 读不到返 undefined. */
export type OsIdReader = () => string | undefined;
/** Linux: /etc/machine-id | /var/lib/dbus/machine-id; macOS/Windows 由调用方注入. */
export declare const DEFAULT_OS_READERS: OsIdReader[];
export interface MachineIdOptions {
    /** 软兜底 UUID 路径(默认 ~/.evomap/machine-id). */
    softIdPath: string;
    /** OS 读取器(默认 Linux); 测试可注入. */
    osReaders?: OsIdReader[];
}
/**
 * 机器标识(CEO 决策, 2026-06-06): **优先 OS machineId(/etc/machine-id 等), 读不到回退安装时软 UUID**.
 * 容器/CI 不脆、不依赖 MAC、跨平台一致. 软 UUID 首次生成存 0600.
 */
export declare function resolveMachineId(opts: MachineIdOptions): {
    id: string;
    source: 'os' | 'soft';
};
/** device token 绑定用的指纹 = sha256(machineId). 不直接外泄 machineId. */
export declare function machineFingerprint(machineId: string): string;