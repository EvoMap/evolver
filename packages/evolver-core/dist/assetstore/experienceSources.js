import { join } from 'node:path';
import { replaceUtf8Durable, assertAssetStoreDirectory, assertNoExperienceTransaction, readRegularBuffer, readUtf8Regular, withAssetStoreLock } from './assetStoreStorage.js';
import { journalDigest } from '../util/durableJournal.js';
const MAX_BYTES = 32 * 1024 * 1024;
function validSource(assetId, source) {
    return typeof assetId === 'string' && /^sha256:[a-f0-9]{64}$/.test(assetId)
        && !!source && typeof source.task === 'string' && source.task.length <= 1200 && !source.task.includes('\0')
        && typeof source.material === 'string' && source.material.length <= 16000 && !source.material.includes('\0');
}
/** Original task material stays outside the Gene and never enters MCP asset responses. */
export class ExperienceSources {
    baseDir;
    path;
    constructor(baseDir) {
        this.baseDir = baseDir;
        this.path = join(baseDir, 'experience-sources.jsonl');
    }
    read() {
        assertNoExperienceTransaction(this.baseDir);
        const bytes = readRegularBuffer(this.path, MAX_BYTES);
        let raw;
        try {
            raw = bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined;
        }
        catch {
            throw new Error('invalid_experience_source');
        }
        const result = new Map();
        if (!raw)
            return result;
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            const row = JSON.parse(line);
            if (row['schema'] === 2 && row['kind'] === 'detached') {
                const assetId = row['assetId'], current = result.get(String(assetId));
                if (!current || journalDigest(current) !== row['sourceDigest'] || typeof row['operationId'] !== 'string'
                    || !/^[a-f0-9-]{36}$/.test(row['operationId']))
                    throw new Error('invalid_experience_source_detachment');
                result.delete(String(assetId));
                continue;
            }
            if (row['schema'] !== 1 || !validSource(row['assetId'], { task: row['task'], material: row['material'] })) {
                throw new Error('invalid_experience_source');
            }
            const source = { task: row['task'], material: row['material'] };
            const previous = result.get(row['assetId']);
            if (previous && (previous.task !== source.task || previous.material !== source.material)) {
                throw new Error('conflicting_experience_source');
            }
            result.set(row['assetId'], source);
        }
        return result;
    }
    save(assetId, source) {
        if (!validSource(assetId, source))
            throw new Error('invalid_experience_source');
        assertAssetStoreDirectory(this.baseDir);
        withAssetStoreLock(join(this.baseDir, '.assetstore.lock'), () => {
            const existing = this.read().get(assetId);
            if (existing) {
                if (existing.task !== source.task || existing.material !== source.material)
                    throw new Error('experience_source_conflict');
                return;
            }
            const before = readUtf8Regular(this.path, MAX_BYTES) ?? '';
            const row = JSON.stringify({ schema: 1, assetId, task: source.task, material: source.material });
            const separator = before && !before.endsWith('\n') ? '\n' : '';
            if (Buffer.byteLength(before) + Buffer.byteLength(separator) + Buffer.byteLength(row) + 1 > MAX_BYTES)
                throw new Error('experience_source_budget_exceeded');
            replaceUtf8Durable(this.path, `${before}${separator}${row}\n`);
        });
    }
}