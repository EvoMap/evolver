import { hub, mailbox } from '@evomap/evolver-core';
export interface CollaborationFacadeDeps {
    store: mailbox.MailboxStore;
    hub: hub.HubCapability;
    runtimeNamespace?: string;
    operationTimeoutMs?: number;
    now: () => number;
    notifyOutbound: () => void;
}
export declare class CollaborationFacade {
    private readonly deps;
    private readonly pendingClaims;
    private readonly pendingCompletes;
    private readonly pendingDmSends;
    private readonly pendingSubscriptions;
    constructor(deps: CollaborationFacadeDeps);
    handle(ctx: mailbox.IpcRouteContext): Promise<boolean>;
    /** Completes V1 durable task intents replayed by SyncEngine after a restart or transient Hub failure. */
    handleOutboundSucceeded(envelope: mailbox.Envelope, handlerResult: unknown): void;
    /** Maps a Public Hub task result echo onto the same durable row as the facade-generated result. */
    normalizeInboundEnvelope(envelope: mailbox.Envelope): mailbox.Envelope;
    /** Caches a sanitized terminal result for durable task intents failed by SyncEngine. */
    handleOutboundTerminal(envelope: mailbox.Envelope, error: unknown): void;
    private taskSubscribe;
    private taskUnsubscribe;
    private taskList;
    private taskClaim;
    private taskComplete;
    private taskMetrics;
    private dmSend;
    private dmPoll;
    private mailboxPoll;
    private mailboxAck;
    private dmList;
    private ensureTaskIntent;
    private executeClaim;
    private executeComplete;
    private activeCompleteIntent;
    private facadeIntentForResult;
    private finalizeClaim;
    private finalizeComplete;
    private enqueueTaskResult;
    private recordMetricOnce;
    private recordTerminalIntentFailure;
    private cacheTerminalIntentFailure;
    private completeIntent;
    private enqueue;
    private getOrStart;
    private messages;
    private dmMessages;
    private timeoutMs;
    private loadMetrics;
    private updateMetrics;
    private observeReceivedTasks;
    private recordCompletion;
}