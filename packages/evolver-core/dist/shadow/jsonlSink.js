import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { BaseShadowSink } from './sink.js';
/** append-only jsonl shadow 账本(WAL-safe append). 默认不存 payload 全文(只 payloadSize, M8-5). */
export class JsonlShadowSink extends BaseShadowSink {
    path;
    constructor(path, nowFn) {
        super(nowFn);
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
    }
    write(r) { appendFileSync(this.path, `${JSON.stringify(r)}\n`); }
    readAll() {
        if (!existsSync(this.path))
            return [];
        return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
}
/** 完全不落账本(EVOLVER_SHADOW_TELEMETRY=off). seen/markSeen 仍维护(去重不依赖落盘). */
export class NullShadowSink extends BaseShadowSink {
    write() { }
}
/** 内存账本(测试). */
export class InMemoryShadowSink extends BaseShadowSink {
    records = [];
    write(r) { this.records.push(r); }
}