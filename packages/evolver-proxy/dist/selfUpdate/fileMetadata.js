import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { SELF_UPDATE_FAILURE_CODES, selfUpdateFailure } from './failureCodes.js';
export async function selfUpdateFileMetadata(path, access = constants.O_RDONLY) {
    const before = await lstat(path, { bigint: true });
    if (process.platform !== 'win32' || before.dev !== 0n || before.isSymbolicLink() || !before.isFile())
        return before;
    // Windows pathname metadata can omit the volume supplied by the descriptor.
    // Use the caller's existing access, never creation/truncation or missing-dev equality.
    const handle = await open(path, access | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0));
    try {
        const opened = await handle.stat({ bigint: true });
        const after = await lstat(path, { bigint: true });
        if (!opened.isFile() || opened.dev <= 0n || opened.ino <= 0n || after.isSymbolicLink() || !after.isFile()
            || opened.ino !== before.ino || opened.ino !== after.ino
            || opened.birthtimeNs !== before.birthtimeNs || opened.birthtimeNs !== after.birthtimeNs
            || after.dev !== 0n && opened.dev !== after.dev) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.UNSAFE_UPDATE_PATH, 'file_identity_changed');
        }
        return opened;
    }
    finally {
        await handle.close();
    }
}