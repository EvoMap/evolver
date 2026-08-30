import { statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
/** hash 文件前 length 字节. */
function prefixHash(path, length) {
    const fd = openSync(path, 'r');
    try {
        const n = Math.max(0, length);
        const buf = Buffer.alloc(n);
        if (n > 0)
            readSync(fd, buf, 0, n, 0);
        return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
    }
    finally {
        closeSync(fd);
    }
}
export function fileWatermark(path, hashBytes = 4096) {
    const st = statSync(path);
    return { path, mtime: st.mtimeMs, size: st.size, contentHash: prefixHash(path, Math.min(hashBytes, st.size)) };
}
/** 增量去重 (批注#15/#16): 快路径 (mtime,size,hash); 前缀完好+size 增→append 增量; 否则全量(rewrite/rename/truncate). */
export function scanFile(path, prev, hashBytes = 4096) {
    const wm = fileWatermark(path, hashBytes);
    if (!prev)
        return { changed: true, newBytes: { start: 0, end: wm.size }, watermark: wm };
    if (prev.mtime === wm.mtime && prev.size === wm.size && prev.contentHash === wm.contentHash)
        return { changed: false, newBytes: null, watermark: wm };
    if (wm.size >= prev.size) {
        const cover = Math.min(hashBytes, prev.size);
        if (prev.contentHash === prefixHash(path, cover)) { // prev 前缀完好 → append
            const newBytes = wm.size > prev.size ? { start: prev.size, end: wm.size } : null;
            return { changed: newBytes !== null, newBytes, watermark: wm };
        }
    }
    return { changed: true, newBytes: { start: 0, end: wm.size }, watermark: wm };
}
export function readRange(path, start, end) {
    const fd = openSync(path, 'r');
    try {
        const buf = Buffer.alloc(end - start);
        if (buf.length > 0)
            readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
    }
    finally {
        closeSync(fd);
    }
}
/** watermark 游标持久化. */
export class WatermarkStore {
    path;
    map = new Map();
    constructor(path) {
        this.path = path;
        // A corrupt watermark file (crash mid-write) must NOT crash the daemon at startup: degrade to empty → re-scan
        // every source file. materialStore dedups by content/watermark, so a full re-scan is idempotent, not harmful.
        if (existsSync(path)) {
            try {
                const o = JSON.parse(readFileSync(path, 'utf8'));
                for (const [k, v] of Object.entries(o))
                    this.map.set(k, v);
            }
            catch { /* corrupt watermark → start empty (idempotent re-scan) */ }
        }
    }
    get(filePath) { return this.map.get(filePath); }
    set(filePath, wm) {
        this.map.set(filePath, wm);
        mkdirSync(dirname(this.path), { recursive: true });
        // Atomic write: a crash mid-write keeps the previous watermark, never a truncated/corrupt file.
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
        renameSync(tmp, this.path);
    }
}