import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const RUNTIME_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DRAFTS_FILE = /^([a-z0-9][a-z0-9-]{0,39})-distill-drafts\.json$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function stateDir(env) {
    return join(env['HOME'] || env['USERPROFILE'] || homedir(), '.evolver', 'state');
}
const MAX_DATE_MS = 8.64e15;
/** One malformed timestamp blanks that draft's date; it must not make the whole file unreadable. */
function isoTime(value) {
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) && Math.abs(time) <= MAX_DATE_MS ? new Date(time).toISOString() : '';
}
function assetOf(assets, type) {
    return Array.isArray(assets) ? assets.find((asset) => isRecord(asset) && asset['type'] === type) ?? null : null;
}
/**
 * Reads through one descriptor, so the size checked is the size read. The path must be a regular file before opening and the
 * opened file must be that same file, which also holds where `O_NOFOLLOW` does not exist (Windows).
 */
function readBounded(path) {
    const before = lstatSync(path);
    if (!before.isFile())
        throw new Error('drafts_file_unreadable');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_FILE_BYTES)
            throw new Error('drafts_file_unreadable');
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        for (let read = -1; read !== 0 && length <= MAX_FILE_BYTES;) {
            read = readSync(fd, buffer, length, buffer.length - length, length);
            length += read;
        }
        if (length > MAX_FILE_BYTES)
            throw new Error('drafts_file_unreadable');
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    }
    finally {
        closeSync(fd);
    }
}
function draftsIn(path, runtime) {
    const rows = JSON.parse(readBounded(path));
    if (!Array.isArray(rows))
        throw new Error('drafts_file_unreadable');
    return rows.filter(isRecord).filter((row) => typeof row['id'] === 'string' || typeof row['id'] === 'number').map((row) => ({
        id: String(row['id']),
        runtime,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        summary: typeof row['summary'] === 'string' ? row['summary'] : '',
        score: typeof row['score'] === 'number' ? row['score'] : null,
        createdAt: isoTime(row['createdAt']),
        gene: assetOf(row['assets'], 'Gene'),
        capsule: assetOf(row['assets'], 'Capsule'),
    }));
}
/** The agent plugin's unconfirmed distillation drafts (`~/.evolver/state/<runtime>-distill-drafts.json`), read in place. */
export function pluginDrafts(env, runtime) {
    let names;
    try {
        names = readdirSync(stateDir(env));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { drafts: [], unreadable: [] };
        throw new Error('drafts_state_unreadable', { cause: error });
    }
    const drafts = [];
    const unreadable = [];
    for (const name of names) {
        const owner = DRAFTS_FILE.exec(name)?.[1];
        if (!owner || (runtime !== undefined && owner !== runtime))
            continue;
        try {
            drafts.push(...draftsIn(join(stateDir(env), name), owner));
        }
        catch {
            unreadable.push(owner);
        }
    }
    return { drafts: drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unreadable };
}