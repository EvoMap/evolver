import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function deepFreeze(o) {
    if (o && typeof o === 'object') {
        for (const v of Object.values(o))
            deepFreeze(v);
        Object.freeze(o);
    }
    return o;
}
/** AE→MV 分层 (军杰 §3.6). MV 由 root_events 确定性重建, 写保护(#write 私有 + 读深冻结). */
export class Replayer {
    dir;
    projectors;
    constructor(opts) {
        this.dir = opts.dir;
        this.projectors = new Map(opts.projectors.map((p) => [p.name, p]));
        mkdirSync(this.dir, { recursive: true });
    }
    mvPath(name) { return join(this.dir, `${name}.json`); }
    /** 唯一写 MV 路径 (ES 私有, 业务代码无法调用). */
    #write(name, state) {
        writeFileSync(this.mvPath(name), `${JSON.stringify({ _mv: true, _projector: name, state }, null, 2)}\n`);
    }
    /** 全量重放重建全部 MV (rebuild-views). */
    rebuild(events) {
        for (const p of this.projectors.values()) {
            let s = p.initial();
            for (const e of events)
                s = p.reduce(s, e);
            this.#write(p.name, s);
        }
    }
    /** 增量: 单事件更新全部 MV. */
    apply(event) {
        for (const p of this.projectors.values()) {
            const cur = this.#readRaw(p.name);
            this.#write(p.name, p.reduce((cur === undefined ? p.initial() : cur), event));
        }
    }
    #readRaw(name) {
        const path = this.mvPath(name);
        if (!existsSync(path))
            return undefined;
        const o = JSON.parse(readFileSync(path, 'utf8'));
        return o.state;
    }
    /** 读 MV (深冻结 → 业务代码 mutate 即抛). */
    read(name) {
        const raw = this.#readRaw(name);
        if (raw === undefined) {
            const p = this.projectors.get(name);
            if (!p)
                throw new Error(`未注册 projector: ${name}`);
            return deepFreeze(p.initial());
        }
        return deepFreeze(raw);
    }
    /** 删除全部 MV (rebuild-views 前). */
    clear() {
        if (!existsSync(this.dir))
            return;
        for (const f of readdirSync(this.dir))
            if (f.endsWith('.json'))
                rmSync(join(this.dir, f));
    }
}