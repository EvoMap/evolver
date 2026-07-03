import { events as ev, assetstore, mailbox as mb, ops } from '@evomap/evolver-core';
export interface WebUIServerDeps {
    eventsPath: string;
    ingestor?: ev.Ingestor;
    store?: assetstore.AssetStoreProvider;
    /** 人审队列用的 review ledger(#117 人审门）。缺省由 LocalJsonlProvider store 的 baseDir 推导。 */
    review?: assetstore.ReviewLedger;
    mailbox?: mb.MailboxStore;
    now?: () => number;
    host?: string;
    /** 人工操作记的 actor id. */
    actorId?: string;
    /** Bearer token required for all /api/* routes; auto-generated if absent. Loopback alone is not an
     *  auth boundary on shared hosts. The launcher prints it; the console gets it via the ?token= URL param. */
    token?: string;
    /** Value-card data provider (#113). Injected by the composition layer wired to ops.loadValueSummary over the
     *  proxy traces + root_events + the adapter's price table — the WebUI stays a THIN shell (it never prices or
     *  re-derives savings; M7 克制). Absent → /api/value reports an empty summary instead of failing. */
    valueSummary?: (window: ops.SummaryWindow) => ops.ValueSummary;
}
/**
 * WebUI 控台(M7): 可观测 + 保活. node:http + 自包含 HTML, 仅绑 loopback.
 * 复用 core events/reports 报表 + assetstore + mailbox; 人工操作 Observe/Nudge/Intervene/Teach 走 ingest(actor.kind=human).
 */
export declare class WebUIServer {
    private readonly deps;
    private readonly server;
    private readonly ingestor;
    private readonly host;
    private readonly now;
    private readonly actorId;
    /** Review ledger backing the human-review queue. Undefined when no LocalJsonlProvider store is available. */
    private readonly review;
    /** Token guarding /api/*; printed by the launcher, supplied by the browser via ?token= or Bearer. */
    readonly token: string;
    constructor(deps: WebUIServerDeps);
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
    private handle;
    private readJson;
    private json;
    private send;
}