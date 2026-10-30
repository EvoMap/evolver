import { util } from '@evomap/evolver-core';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let windowsCaseQuery;
function caseInsensitiveDirectory(directory) {
    if (!windowsCaseQuery) {
        const koffi = require('koffi');
        const library = koffi.load('kernel32.dll');
        const open = library.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr_t']);
        const info = library.func('__stdcall', 'GetFileInformationByHandleEx', 'int', ['intptr_t', 'uint32_t', 'void *', 'uint32_t']);
        const close = library.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']);
        const owner = { library, open, info, close };
        windowsCaseQuery = path => {
            const handle = owner.open(path, 0x80, 7, null, 3, 0x02200000, 0);
            if (handle === -1 || handle === -1n)
                return false;
            try {
                const flags = Buffer.alloc(4);
                // FileCaseSensitiveInfo. If the filesystem cannot prove its policy,
                // keep case-sensitive comparison rather than granting a broader path.
                return !!owner.info(handle, 23, flags, flags.length) && (flags.readUInt32LE() & 1) === 0;
            }
            finally {
                owner.close(handle);
            }
        };
    }
    return windowsCaseQuery(directory);
}
function canonical(path) {
    return realpathSync.native(path).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/^[a-z]:/, drive => drive.toUpperCase());
}
function existingPrefix(path) {
    let current = resolve(path);
    const suffix = [];
    while (true) {
        try {
            return { root: canonical(current), suffix };
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            suffix.unshift(basename(current));
            current = parent;
        }
    }
}
/** Compare existing aliases and safe missing targets without folding NTFS case-sensitive names. */
export function sameRuntimePath(left, right) {
    if (resolve(left) === resolve(right) || process.platform !== 'win32') {
        try {
            return util.canonicalEventPath(left) === util.canonicalEventPath(right);
        }
        catch {
            return false;
        }
    }
    try {
        const a = existingPrefix(left), b = existingPrefix(right);
        if (a.root !== b.root || a.suffix.length !== b.suffix.length)
            return false;
        if (a.suffix.length === 0)
            return true;
        if (!lstatSync(a.root).isDirectory())
            return false;
        const insensitive = caseInsensitiveDirectory(a.root);
        return a.suffix.every((name, index) => insensitive ? name.toLowerCase() === b.suffix[index].toLowerCase() : name === b.suffix[index]);
    }
    catch {
        return false;
    }
}