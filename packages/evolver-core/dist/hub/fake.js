import { computeAssetId } from '../wire/index.js';
const fakeAuth = {
    kind: 'oauth_device_token',
    login: async () => ({ id: 'fake-cred', kind: 'oauth_device_token', token: 'fake-token' }),
    authenticate: async () => ({ headers: { authorization: 'Bearer fake-token' } }),
    rotate: async () => ({ id: 'fake-cred-2', kind: 'oauth_device_token', token: 'fake-token-2' }),
    revoke: async () => { },
};
/**
 * 内存 HubCapability(M6-1, 测试用). 复用 InMemoryTransport 思路, 但走完整 HubCapability 形状,
 * 让 SyncEngine/LifecycleManager/bindings 不连真 hub 即可端到端测.
 */
export class FakeHubCapability {
    opts;
    assets = new Map();
    inbox = [];
    acked = new Set();
    pushed = [];
    claims = [];
    completed = [];
    auth = fakeAuth;
    agentDirectory;
    nextPollAfterMs;
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** 测试注入: 排一条 inbound 事件供 poll 拉. */
    seedInbound(e) { this.inbox.push(e); }
    async publish(bundle) {
        const assetIds = bundle.map((a) => computeAssetId(a));
        const gate = this.opts.publishGate?.(bundle[0] ?? {}) ?? { status: 'accepted' };
        if (gate.status === 'accepted')
            bundle.forEach((a, i) => this.assets.set(assetIds[i], { ...a, asset_id: assetIds[i] }));
        return { receiptId: `rcpt-${(assetIds[0] ?? 'x').slice(7, 15)}`, status: gate.status, assetId: assetIds[0], assetIds, bundleId: `bundle-${(assetIds[0] ?? 'x').slice(7, 15)}`, ...(gate.reason ? { reason: gate.reason } : {}), ...(gate.terminal !== undefined ? { terminal: gate.terminal } : {}) };
    }
    async fetch(query) {
        return [...this.assets.values()].filter((a) => !query.kind || a.type === query.kind).slice(0, query.limit ?? 1000);
    }
    search(query) { return this.fetch(query); }
    task = {
        claim: async (taskId) => {
            const claimId = `claim-${taskId}`;
            this.claims.push({ taskId, claimId });
            return { claimId };
        },
        complete: async (claimId, result, context) => {
            this.completed.push({ claimId, result, ...(context ? { context } : {}) });
            return { status: 'completed' };
        },
        subscribe: async function* () {
            /* 内存桩: 空流 */
        }.bind(this),
    };
    mailbox = {
        poll: async () => {
            const events = this.inbox.splice(0);
            return { events, ...(this.nextPollAfterMs !== undefined ? { nextPollAfterMs: this.nextPollAfterMs } : {}), hasMore: this.inbox.length > 0 };
        },
        ack: async (eventId) => { this.acked.add(eventId); },
        push: async (event) => { this.pushed.push(event); },
        pushMany: async (events) => {
            this.pushed.push(...events);
            return { outcomes: events.map((event) => ({ id: event.id, status: 'accepted' })) };
        },
        status: async () => ({ pending: this.inbox.length }),
    };
    /** 测试断言用. */
    isAcked(id) { return this.acked.has(id); }
    publishedCount() { return this.assets.size; }
}