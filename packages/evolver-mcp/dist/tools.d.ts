import { assetstore, mailbox as mb } from '@evomap/evolver-core';
import type { EvolverProxyClient } from './proxyClient.js';
/** Minimal root_events writer the reuse-feedback path needs (#268). Structural so the stdio server can pass the
 *  real `events.Ingestor` and tests can pass a fake — tools.ts stays decoupled from the concrete class. */
export interface ReuseHitIngestor {
    ingest(raw: {
        type: string;
        human: {
            title: string;
            detail?: string;
        };
        payload?: Record<string, unknown>;
    }): Promise<unknown>;
}
/** MCP 工具(自带描述, agent runtime 在 tool list 自然发现, 按需调用 — 优于扔大 skill/--help). */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}
export interface EvolverToolDeps {
    store: assetstore.AssetStoreProvider;
    mailbox?: mb.MailboxStore;
    proxy?: EvolverProxyClient;
    now?: () => number;
    /** Root_events writer for the MCP reuse-feedback loop (#268). When wired, a SUCCESS reuse-result emits a local
     *  `value.reuse_hit` so the local ledger credits reuse driven by an MCP agent (not just the hook/daemon path).
     *  Absent → no local emission (the tool still works, just no local feedback). */
    ingestor?: ReuseHitIngestor;
    /** Server-minted correlation id for this MCP connection (#268). Used as the reuse_hit `cycleId` audit anchor and,
     *  with the agent's optional taskId, as the idempotency key. One stdio process ~ one MCP session. */
    cycleId?: string;
}
/**
 * Evolver MCP 工具集(M5-2). asset.search/fetch/publish + gep.build + mailbox.*.
 * schema 单一来源走 gep-sdk(经 evolver-core 重导出), 不重复实现.
 */
export declare function buildEvolverTools(deps: EvolverToolDeps): McpTool[];