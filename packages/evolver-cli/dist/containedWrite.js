import { closeSync, constants, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
// Windows has no O_NOFOLLOW; there the lstat check before open is the only guard against a linked target.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
export function relativePathInsideRoot(root, requested) {
    const fromRoot = relative(resolve(root), resolve(root, requested));
    const escapes = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
    if (escapes)
        return null;
    return fromRoot || '.';
}
export function writeFileInsideRoot(root, relPath, content, overwrite) {
    const parts = relPath.split(sep).filter((part) => part && part !== '.');
    const fileName = parts.pop();
    if (!fileName || parts.includes('..'))
        return { ok: false, reason: 'unsafe_path' };
    let dir = resolve(root);
    for (const part of parts) {
        dir = join(dir, part);
        if (!ensureRealDirectory(dir))
            return { ok: false, reason: 'unsafe_path' };
    }
    return writeRegularFile(join(dir, fileName), content, overwrite);
}
function ensureRealDirectory(path) {
    if (!lstatOrNull(path)) {
        try {
            mkdirSync(path);
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
        }
    }
    const stat = lstatOrNull(path);
    return Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());
}
function writeRegularFile(path, content, overwrite) {
    const existing = lstatOrNull(path);
    if (existing && !isUnsharedRegularFile(existing))
        return { ok: false, reason: 'unsafe_path' };
    if (existing && !overwrite)
        return { ok: false, reason: 'exists' };
    const createMode = overwrite ? constants.O_TRUNC : constants.O_EXCL;
    let fd;
    try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | createMode | NO_FOLLOW, 0o644);
    }
    catch (error) {
        if (isErrno(error, 'EEXIST'))
            return { ok: false, reason: 'exists' };
        if (isErrno(error, 'ELOOP'))
            return { ok: false, reason: 'unsafe_path' };
        throw error;
    }
    try {
        writeFileSync(fd, content, 'utf8');
    }
    finally {
        closeSync(fd);
    }
    return { ok: true };
}
function isUnsharedRegularFile(stat) {
    return stat.isFile() && stat.nlink === 1;
}
function lstatOrNull(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}