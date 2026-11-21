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
 * LegacyAuthShim exposes node_secret as a transport-neutral credential field. HubFetch promotes it to
 * Authorization: Bearer for GET and strict GEP envelope endpoints before egress.
 */
export class LegacyAuthShim {
    nodeSecret;
    onRotate;
    onVersionUpdate;
    onDiverged;
    reload;
    kind = 'oauth_device_token';
    nodeSecretVersion;
    constructor(nodeSecret, onRotate, initialNodeSecretVersion, onVersionUpdate, onDiverged, reload) {
        this.nodeSecret = nodeSecret;
        this.onRotate = onRotate;
        this.onVersionUpdate = onVersionUpdate;
        this.onDiverged = onDiverged;
        this.reload = reload;
        // An absent secret is the enrollment state, not an error: a node with no credential yet, and one whose
        // secret notifyNodeSecretDiverged just dropped, both hello unauthenticated so the hub can mint one.
        // Rejecting it here would fence off the re-acquisition this class is written to perform.
        if (nodeSecret !== undefined && !isNodeSecret(nodeSecret))
            throw new Error('node_secret 必须是 64-hex');
        this.nodeSecretVersion = parseNodeSecretVersion(initialNodeSecretVersion);
    }
    async login() {
        this.reloadNodeSecret();
        return { id: 'legacy-node-secret', kind: 'oauth_device_token', token: this.nodeSecret ?? '' };
    }
    async authenticate() {
        this.reloadNodeSecret();
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
        this.reloadNodeSecret();
        return this.nodeSecretVersion;
    }
    adoptNodeSecret(nodeSecret, nodeSecretVersion) {
        if (!isNodeSecret(nodeSecret))
            throw new Error('node_secret 必须是 64-hex');
        this.nodeSecret = nodeSecret;
        this.nodeSecretVersion = parseNodeSecretVersion(nodeSecretVersion);
        this.onRotate?.(nodeSecret, this.nodeSecretVersion);
    }
    // Taken from durable state another process already wrote, so it is not reported back through onRotate. The Hub
    // numbers a node's secrets upward, so one older than the secret held here was superseded and would only earn a 401.
    reloadNodeSecret() {
        const fresh = this.reload?.();
        if (!fresh || !isNodeSecret(fresh.nodeSecret))
            return;
        const version = parseNodeSecretVersion(fresh.nodeSecretVersion);
        if (version !== undefined && this.nodeSecretVersion !== undefined && version < this.nodeSecretVersion)
            return;
        this.nodeSecret = fresh.nodeSecret;
        this.nodeSecretVersion = version;
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