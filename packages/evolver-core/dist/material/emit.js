import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ulid as makeUlid } from 'ulid';
export function toMaterialEventPayload(m) {
    return {
        material_id: m.materialId, ...(m.sourceAgent ? { source_agent: m.sourceAgent } : {}), source_kind: m.sourceKind,
        source_path: m.sourcePath,
        kind: m.kind, size: m.watermark.size, hash: m.watermark.contentHash ?? '', discovered_at: m.capturedAt,
    };
}
/** jsonl 兜底 MailboxSink (M2 落地后替换为真引擎). */
export class JsonlMailboxSink {
    path;
    constructor(path) {
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
    }
    async enqueue(e) {
        const receiptId = makeUlid();
        appendFileSync(this.path, `${JSON.stringify({ receiptId, ...e })}\n`);
        return { receiptId };
    }
    readAll() {
        if (!existsSync(this.path))
            return [];
        return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
}
/** 攒批 + 投递 pending_materials (批注#40, mailbox 草案 §4). */
export class MaterialEmitter {
    sink;
    batchSize;
    buffer = [];
    constructor(sink, batchSize = 20) {
        this.sink = sink;
        this.batchSize = batchSize;
    }
    add(m) { this.buffer.push(toMaterialEventPayload(m)); }
    size() { return this.buffer.length; }
    async flush() {
        if (this.buffer.length === 0)
            return null;
        const batchId = makeUlid();
        const materials = this.buffer.splice(0);
        const { receiptId } = await this.sink.enqueue({ type: 'pending_materials', payload: { batchId, materials } });
        return { receiptId, batchId, count: materials.length };
    }
    async addAndMaybeFlush(m) {
        this.add(m);
        return this.buffer.length >= this.batchSize ? this.flush() : null;
    }
}