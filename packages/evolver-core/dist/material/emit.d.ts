import type { Material } from '../schema/material.js';
export interface MailboxEnvelope {
    type: string;
    payload: unknown;
}
/** M2 mailbox 引擎的最小接口; M1 用 jsonl 兜底, M2 替换(接口不变). */
export interface MailboxSink {
    enqueue(e: MailboxEnvelope): Promise<{
        receiptId: string;
    }>;
}
/** material 事件 payload (批注#40). source_agent 仅 runtime_session 有 (proxy trace agent-无关, #95). */
export interface MaterialEventPayload {
    material_id: string;
    source_agent?: string;
    source_kind: string;
    source_path: string;
    kind: string;
    size: number;
    hash: string;
    discovered_at: string;
}
export declare function toMaterialEventPayload(m: Material): MaterialEventPayload;
/** jsonl 兜底 MailboxSink (M2 落地后替换为真引擎). */
export declare class JsonlMailboxSink implements MailboxSink {
    private readonly path;
    constructor(path: string);
    enqueue(e: MailboxEnvelope): Promise<{
        receiptId: string;
    }>;
    readAll(): Array<{
        receiptId: string;
        type: string;
        payload: unknown;
    }>;
}
/** 攒批 + 投递 pending_materials (批注#40, mailbox 草案 §4). */
export declare class MaterialEmitter {
    private readonly sink;
    private readonly batchSize;
    private readonly buffer;
    constructor(sink: MailboxSink, batchSize?: number);
    add(m: Material): void;
    size(): number;
    flush(): Promise<{
        receiptId: string;
        batchId: string;
        count: number;
    } | null>;
    addAndMaybeFlush(m: Material): Promise<{
        receiptId: string;
        batchId: string;
        count: number;
    } | null>;
}