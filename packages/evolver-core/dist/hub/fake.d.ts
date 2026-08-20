import type { HubCapability, PublishReceipt, AgentEvent, TaskEvent, AuthProvider, HubQuery, AssetRecord, TaskCompleteContext, PublishOptions } from './capability.js';
export interface FakeHubOptions {
    /** 脚本化 publish gate: 返回 reject/quarantine 以测 PublishReceipt 终态路径. */
    publishGate?: (asset: AssetRecord) => Pick<PublishReceipt, 'status' | 'reason' | 'terminal'>;
}
/**
 * 内存 HubCapability(M6-1, 测试用). 复用 InMemoryTransport 思路, 但走完整 HubCapability 形状,
 * 让 SyncEngine/LifecycleManager/bindings 不连真 hub 即可端到端测.
 */
export declare class FakeHubCapability implements HubCapability {
    private readonly opts;
    private readonly assets;
    private readonly inbox;
    private readonly acked;
    readonly pushed: AgentEvent[];
    readonly claims: Array<{
        taskId: string;
        claimId: string;
    }>;
    readonly completed: Array<{
        claimId: string;
        result: unknown;
        context?: TaskCompleteContext;
    }>;
    readonly auth: AuthProvider;
    agentDirectory?: import('./agentDirectory.js').AgentDirectoryCapability;
    recipes?: import('./capability.js').RecipeCapability;
    nextPollAfterMs: number | undefined;
    constructor(opts?: FakeHubOptions);
    /** 测试注入: 排一条 inbound 事件供 poll 拉. */
    seedInbound(e: AgentEvent): void;
    publish(bundle: AssetRecord[], _options?: PublishOptions): Promise<PublishReceipt>;
    fetch(query: HubQuery): Promise<AssetRecord[]>;
    search(query: HubQuery): Promise<AssetRecord[]>;
    task: {
        claim: (taskId: string) => Promise<{
            claimId: string;
        }>;
        complete: (claimId: string, result: unknown, context?: TaskCompleteContext) => Promise<{
            status: "completed";
        }>;
        subscribe: (filter: unknown) => AsyncIterable<TaskEvent>;
    };
    mailbox: HubCapability['mailbox'];
    /** 测试断言用. */
    isAcked(id: string): boolean;
    publishedCount(): number;
}