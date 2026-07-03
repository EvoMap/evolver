import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assetstore } from '@evomap/evolver-core';
import { mapV1Asset } from './fieldMap.js';
const FILES = { Gene: 'genes.jsonl', Capsule: 'capsules.jsonl', EvolutionEvent: 'events.jsonl' };
const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
function maxJsonlLineBytes() {
    const raw = Number(process.env['EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES']);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES;
}
async function* readJsonl(path) {
    if (!existsSync(path))
        return;
    const maxLineBytes = maxJsonlLineBytes();
    let parts = [];
    let lineBytes = 0;
    let dropping = false;
    const finish = function* () {
        if (dropping || lineBytes === 0) {
            parts = [];
            lineBytes = 0;
            dropping = false;
            return;
        }
        const text = Buffer.concat(parts, lineBytes).toString('utf8').trim();
        parts = [];
        lineBytes = 0;
        if (!text)
            return;
        try {
            yield JSON.parse(text);
        }
        catch { /* skip corrupt rows */ }
    };
    for await (const chunk of createReadStream(path)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        for (let i = 0; i < buf.length; i += 1) {
            if (buf[i] !== 0x0a)
                continue;
            const segment = buf.subarray(start, i);
            if (!dropping) {
                if (lineBytes + segment.length > maxLineBytes) {
                    parts = [];
                    lineBytes = 0;
                    dropping = true;
                }
                else {
                    parts.push(Buffer.from(segment));
                    lineBytes += segment.length;
                }
            }
            for (const record of finish())
                yield record;
            start = i + 1;
        }
        if (start < buf.length && !dropping) {
            const segment = buf.subarray(start);
            if (lineBytes + segment.length > maxLineBytes) {
                parts = [];
                lineBytes = 0;
                dropping = true;
            }
            else {
                parts.push(Buffer.from(segment));
                lineBytes += segment.length;
            }
        }
    }
    for (const record of finish())
        yield record;
}
/**
 * v1→v2 只读迁移(M8-2). 只读 v1(无双写); 冻结存量 asset_id; 非 schema 字段(avoid)落 sidecar;
 * memory_graph 不强转(语义不符)→ 归档只读; candidates 候选池不属 wire 资产 → 跳过.
 */
export async function importV1(v1Dir, store, outDir) {
    const sidecarPath = join(outDir, 'migration', 'v1_extensions.jsonl');
    const rep = {
        imported: { Gene: 0, Capsule: 0, EvolutionEvent: 0 }, frozen: 0, recomputed: 0, deduped: 0,
        sidecarExtensions: 0, memoryGraphArchived: false, candidatesSkipped: false,
    };
    const gepDir = join(v1Dir, 'assets', 'gep');
    for (const kind of ['Gene', 'Capsule', 'EvolutionEvent']) {
        for await (const v1 of readJsonl(join(gepDir, FILES[kind]))) {
            const mapped = mapV1Asset(kind, v1);
            const res = await store.putFrozen(mapped.record);
            if (res.stored) {
                rep.imported[kind] += 1;
                if (mapped.recomputed)
                    rep.recomputed += 1;
                else
                    rep.frozen += 1;
                if (Object.keys(mapped.dropped).length > 0) {
                    mkdirSync(dirname(sidecarPath), { recursive: true });
                    appendFileSync(sidecarPath, `${JSON.stringify({ asset_id: res.asset_id, dropped: mapped.dropped })}\n`);
                    rep.sidecarExtensions += 1;
                }
            }
            else {
                rep.deduped += 1;
            }
        }
    }
    // memory_graph: 不迁移成 EvolutionEvent(缺 required + 无 intent/genes_used 语义, 强转=污染谱系). 归档只读.
    const mg = join(v1Dir, 'memory', 'evolution', 'memory_graph.jsonl');
    if (existsSync(mg)) {
        const dest = join(outDir, 'migration', 'legacy_memory_graph.jsonl');
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(mg, dest);
        rep.memoryGraphArchived = true;
    }
    // candidates 候选池非 wire 资产 → 不迁移(留作 selection 输入)
    if (existsSync(join(gepDir, 'candidates.jsonl')))
        rep.candidatesSkipped = true;
    return rep;
}