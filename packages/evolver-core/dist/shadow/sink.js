/** 内存镜像 + 序号基类(各 sink 复用). */
export class BaseShadowSink {
    nowFn;
    seq = 0;
    mirror = new Set();
    constructor(nowFn = () => Date.now()) {
        this.nowFn = nowFn;
    }
    now() { return this.nowFn(); }
    record(r) {
        this.seq += 1;
        const full = { ...r, seq: this.seq, at: this.now() };
        this.write(full);
        return full;
    }
    seen(assetId) { return this.mirror.has(assetId); }
    markSeen(assetId) { this.mirror.add(assetId); }
}