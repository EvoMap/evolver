import { readSharedFileSnapshot, sameSharedFileIdentity } from './sharedFileCommit.js';
import { sameRuntimePath } from './runtimePathIdentity.js';
let postimages;
/** Read-only verification may recognize an exact restored user entry, not grant ownership of it. */
export function withUninstallPostimages(images, run) {
    const previous = postimages;
    postimages = images;
    try {
        return run();
    }
    finally {
        postimages = previous;
    }
}
export function matchesUninstallPostimage(path, raw) {
    const expected = postimages?.find(image => sameRuntimePath(image.path, path))?.snapshot;
    if (!expected || raw !== undefined && expected.raw !== raw)
        return false;
    const actual = readSharedFileSnapshot(path);
    return actual.raw === expected.raw && sameSharedFileIdentity(actual.identity, expected.identity);
}