const DEFAULT_PRIVATE_ADAPTER_MODULE = '@evomap/evolver-adapter-private';
export function resolvePrivateEnterpriseToken(env) {
    return firstEnv(env, 'EVOMAP_ENTERPRISE_TOKEN', 'EVOMAP_PRIVATE_HUB_TOKEN', 'PHUB_ENTERPRISE_TOKEN', 'PRIVATE_HUB_ENTERPRISE_TOKEN');
}
export function resolvePrivateEnterpriseSubject(env) {
    return firstEnv(env, 'EVOMAP_ENTERPRISE_SUBJECT', 'EVOMAP_PRIVATE_SUBJECT', 'PHUB_ENTERPRISE_SUBJECT', 'USER') ?? 'evolver-proxy';
}
export async function connectPrivateProxyHub(opts) {
    const token = resolvePrivateEnterpriseToken(opts.env);
    if (!token) {
        throw new Error('EVOMAP_HUB_MODE=private 需要 EVOMAP_ENTERPRISE_TOKEN（也兼容 EVOMAP_PRIVATE_HUB_TOKEN / PHUB_ENTERPRISE_TOKEN）');
    }
    const moduleName = opts.env['EVOMAP_PRIVATE_ADAPTER_MODULE']?.trim() || DEFAULT_PRIVATE_ADAPTER_MODULE;
    const connectPrivateHub = await loadConnectPrivateHub(moduleName, opts.importer ?? ((specifier) => import(specifier)));
    const now = opts.now ?? (() => Date.now());
    const subject = resolvePrivateEnterpriseSubject(opts.env);
    const { hub, auth } = connectPrivateHub({
        hubUrl: opts.hubUrl,
        senderId: opts.senderId,
        env: opts.env,
        now,
        sso: {
            identity: () => ({ subject }),
            exchange: async () => ({ token }),
            now,
        },
    });
    assertPrivateLifecycle(hub, moduleName);
    return { hub, auth };
}
async function loadConnectPrivateHub(moduleName, importer) {
    let loaded;
    try {
        loaded = await importer(moduleName);
    }
    catch (err) {
        throw new Error(`EVOMAP_HUB_MODE=private 需要安装/链接 ${moduleName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mod = asRecord(loaded);
    const connect = mod?.['connectPrivateHub'];
    if (typeof connect !== 'function') {
        throw new Error(`${moduleName} 未导出 connectPrivateHub，无法装配 private hub runtime`);
    }
    return connect;
}
function assertPrivateLifecycle(hub, moduleName) {
    const candidate = asRecord(hub);
    if (typeof candidate?.['hello'] !== 'function' || typeof candidate['heartbeat'] !== 'function') {
        throw new Error(`${moduleName} 的 hub 缺少 hello/heartbeat lifecycle 方法，无法接入 evolver-proxy`);
    }
}
function firstEnv(env, ...keys) {
    for (const key of keys) {
        const value = env[key]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}