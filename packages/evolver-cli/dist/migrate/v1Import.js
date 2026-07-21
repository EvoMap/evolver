import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { assetstore } from '@evomap/evolver-core';
import { mapV1Asset } from './fieldMap.js';
import { LocalMemoryGraph, MemoryGraphBusyError, MemoryGraphImportStateRejectedError, resolveLocalMemoryUserId, } from '../localMemoryGraph.js';
const FILES = { Gene: 'genes.jsonl', Capsule: 'capsules.jsonl', EvolutionEvent: 'events.jsonl' };
const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
let migrationArchiveNonce = 0;
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
export async function importV1(v1Dir, store, outDir, options = {}) {
    const sidecarPath = join(outDir, 'migration', 'v1_extensions.jsonl');
    const rep = {
        imported: { Gene: 0, Capsule: 0, EvolutionEvent: 0 }, frozen: 0, recomputed: 0, deduped: 0,
        sidecarExtensions: 0, memoryGraphArchived: false, memoryGraphImported: 0, memoryGraphDeferred: false, candidatesSkipped: false,
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
    // memory_graph remains a sidecar: never convert it into EvolutionEvent or mutate Gene/Capsule identity.
    const mg = join(v1Dir, 'memory', 'evolution', 'memory_graph.jsonl');
    if (secureRegularFileWithin(v1Dir, mg)) {
        const dest = join(outDir, 'migration', 'legacy_memory_graph.jsonl');
        mkdirSync(dirname(dest), { recursive: true });
        archiveRegularFile(mg, dest);
        rep.memoryGraphArchived = true;
        const workspace = options.workspace ? canonicalDirectory(options.workspace) : null;
        if (!workspace) {
            rep.memoryGraphDeferred = true;
        }
        else {
            const source = realpathSync(mg);
            const userId = options.userId ?? resolveLocalMemoryUserId();
            const marker = scopedMemoryGraphMarker(outDir, workspace, userId, source);
            if (!existsSync(marker)) {
                const graph = new LocalMemoryGraph({ dir: join(outDir, 'evolution'), userId });
                try {
                    for await (const record of readJsonl(mg)) {
                        if (graph.importV1Outcome(workspace, record, source))
                            rep.memoryGraphImported += 1;
                    }
                }
                catch (error) {
                    if (!(error instanceof MemoryGraphImportStateRejectedError) && !(error instanceof MemoryGraphBusyError))
                        throw error;
                    rep.memoryGraphDeferred = true;
                }
                if (!rep.memoryGraphDeferred)
                    writeFileSync(marker, `${rep.memoryGraphImported}\n`, { mode: 0o600 });
            }
        }
    }
    // candidates 候选池非 wire 资产 → 不迁移(留作 selection 输入)
    if (existsSync(join(gepDir, 'candidates.jsonl')))
        rep.candidatesSkipped = true;
    return rep;
}
function canonicalDirectory(path) {
    try {
        const absolute = resolve(path);
        const stat = lstatSync(absolute);
        return stat.isDirectory() && !stat.isSymbolicLink() ? realpathSync(absolute) : null;
    }
    catch {
        return null;
    }
}
function scopedMemoryGraphMarker(outDir, workspace, userId, source) {
    const scope = createHash('sha256').update(JSON.stringify({ workspace, userId, source })).digest('hex');
    return join(outDir, 'migration', `v1_memory_graph_import.${scope}.complete`);
}
function secureRegularFileWithin(root, path) {
    try {
        const absoluteRoot = resolve(root);
        const absolutePath = resolve(path);
        const rootStat = lstatSync(absoluteRoot);
        const fileStat = lstatSync(absolutePath);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink())
            return false;
        const canonicalRoot = realpathSync(absoluteRoot);
        const canonicalPath = realpathSync(absolutePath);
        return canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`);
    }
    catch {
        return false;
    }
}
function archiveRegularFile(source, destination) {
    if (existsSync(destination)) {
        const existing = lstatSync(destination);
        if (!existing.isFile() || existing.isSymbolicLink())
            throw new Error('memory_graph_archive_path_rejected');
        return;
    }
    const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const temp = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now()}.${migrationArchiveNonce++}.tmp`);
    let tempFd;
    let copyError;
    try {
        if (!fstatSync(sourceFd).isFile())
            throw new Error('memory_graph_source_path_rejected');
        tempFd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            let offset = 0;
            while (offset < bytesRead)
                offset += writeSync(tempFd, buffer, offset, bytesRead - offset);
        }
        fsyncSync(tempFd);
    }
    catch (error) {
        copyError = error;
    }
    finally {
        closeSync(sourceFd);
        if (tempFd !== undefined)
            closeSync(tempFd);
    }
    if (copyError !== undefined) {
        try {
            if (existsSync(temp))
                unlinkSync(temp);
        }
        catch {
            // Preserve the source/copy failure; cleanup is best-effort.
        }
        throw copyError;
    }
    try {
        if (existsSync(destination)) {
            const existing = lstatSync(destination);
            if (!existing.isFile() || existing.isSymbolicLink())
                throw new Error('memory_graph_archive_path_rejected');
            unlinkSync(temp);
            return;
        }
        // A same-directory hard link publishes without replacing a path created by a concurrent process.
        linkSync(temp, destination);
        unlinkSync(temp);
    }
    catch (error) {
        try {
            if (existsSync(temp))
                unlinkSync(temp);
        }
        catch {
            // Preserve the publication failure; cleanup is best-effort.
        }
        throw error;
    }
}