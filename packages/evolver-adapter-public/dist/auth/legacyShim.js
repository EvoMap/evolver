export function isNodeSecret(value) {
    return /^[a-f0-9]{64}$/i.test(value);
}
export function parseNodeSecretVersion(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
/**
 * node_secret 双轨过渡(M6-5, 6 个月). 包旧 64-hex node_secret 成 AuthProvider.
 * **node_secret 走 request body**(gep-a2a 契约, 实测 dev: requireNodeSecret 读 body 非 header), 不轮换.
 */
export class LegacyAuthShim {
    nodeSecret;
    onRotate;
    onVersionUpdate;
    onDiverged;
    kind = 'oauth_device_token';
    nodeSecretVersion;
    constructor(nodeSecret, onRotate, initialNodeSecretVersion, onVersionUpdate, onDiverged) {
        this.nodeSecret = nodeSecret;
        this.onRotate = onRotate;
        this.onVersionUpdate = onVersionUpdate;
        this.onDiverged = onDiverged;
        if (!nodeSecret || !isNodeSecret(nodeSecret))
            throw new Error('node_secret 必须是 64-hex');
        this.nodeSecretVersion = parseNodeSecretVersion(initialNodeSecretVersion);
    }
    async login() { return { id: 'legacy-node-secret', kind: 'oauth_device_token', token: this.nodeSecret ?? '' }; }
    async authenticate() {
        return {
            headers: this.nodeSecretVersion !== undefined
                ? { 'X-EvoMap-Node-Secret-Version': String(this.nodeSecretVersion) }
                : {},
            // node_secret_version travels via the X-EvoMap-Node-Secret-Version header on every request (above)
            // and is added to the heartbeat body explicitly by PublicHubCapability. It is intentionally NOT
            // injected into generic request bodies — matching v1, which carries it in the body only on heartbeat.
            bodyFields: {
                ...(this.nodeSecret ? { node_secret: this.nodeSecret } : {}),
            },
        };
    }
    async rotate() { return this.login(); }
    async revoke() { }
    getNodeSecretVersion() {
        return this.nodeSecretVersion;
    }
    adoptNodeSecret(nodeSecret, nodeSecretVersion) {
        if (!isNodeSecret(nodeSecret))
            throw new Error('node_secret 必须是 64-hex');
        this.nodeSecret = nodeSecret;
        this.nodeSecretVersion = parseNodeSecretVersion(nodeSecretVersion);
        this.onRotate?.(nodeSecret, this.nodeSecretVersion);
    }
    adoptNodeSecretVersion(nodeSecretVersion) {
        this.nodeSecretVersion = parseNodeSecretVersion(nodeSecretVersion);
        this.onVersionUpdate?.(this.nodeSecretVersion);
    }
    clearNodeSecret() {
        this.nodeSecret = undefined;
        this.nodeSecretVersion = undefined;
        this.onVersionUpdate?.(undefined);
    }
    /**
     * Hub rejected our cached node_secret as diverged (v1 a2aProtocol.js L1983-2017).
     * Drop the in-memory secret + version so buildHubHeaders/authenticate fall back to
     * unauthenticated on the next /a2a/hello, then hand off to onDiverged for the durable
     * clear (store keys + on-disk legacy files). Does NOT route through onVersionUpdate —
     * the divergence handler performs the full clear, including the version, atomically.
     */
    notifyNodeSecretDiverged() {
        this.nodeSecret = undefined;
        this.nodeSecretVersion = undefined;
        this.onDiverged?.();
    }
}