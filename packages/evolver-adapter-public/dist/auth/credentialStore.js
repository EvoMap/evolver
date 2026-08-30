import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, resolve, win32 } from 'node:path';
import { POWERSHELL_STDIN_SCRIPT_COMMAND, windowsAclFailureDetail, } from './windowsPowerShell.js';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export class CredentialStoreError extends Error {
    constructor(message, options) {
        super(`Unsafe credential path: ${message}`, options);
        this.name = 'CredentialStoreError';
    }
}
/** Persists OAuth tokens and keypair private keys behind a local secret-file boundary. */
export class CredentialStore {
    path;
    platform;
    windowsAclOps;
    darwinAclReader;
    windowsParentStateReader;
    linkFile;
    renameFile;
    // ctime detects in-place ACL drift while dev/ino detects entry replacement.
    securedDirectoryState = null;
    securedCredentialState = null;
    securedAncestorStates = new Map();
    trustedWindowsParentStates = new Map();
    constructor(path, options = {}) {
        this.path = resolve(path);
        this.platform = options.platform ?? process.platform;
        this.windowsAclOps = this.platform === 'win32'
            ? (options.windowsAclOps ?? new PowerShellWindowsAclOps())
            : undefined;
        this.darwinAclReader = options.darwinAclReader ?? readDarwinAcl;
        this.windowsParentStateReader = options.windowsParentStateReader ?? parentSecurityStates;
        this.linkFile = options.linkFile ?? linkSync;
        this.renameFile = options.renameFile ?? renameSync;
    }
    load() {
        if (!this.prepareDirectory(false))
            return null;
        const directory = dirname(this.path);
        const directoryIdentity = this.directoryIdentity(directory);
        const fd = this.openCredentialFile();
        if (fd === null)
            return null;
        try {
            this.assertDirectoryIdentity(directory, directoryIdentity);
            this.secureCredentialFd(fd);
            const raw = readFileSync(fd, 'utf8');
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                    return null;
                return parsed;
            }
            catch (error) {
                if (error instanceof SyntaxError)
                    return null;
                throw error;
            }
        }
        finally {
            closeSync(fd);
        }
    }
    /** Validate an existing credential path without changing its mode, DACL, ACL, or contents. */
    inspectTrustedExisting() {
        if (!this.prepareDirectory(false, false))
            return null;
        const directory = dirname(this.path);
        const directoryIdentity = this.directoryIdentity(directory);
        const fd = this.openCredentialFile();
        if (fd === null)
            return null;
        try {
            this.assertDirectoryIdentity(directory, directoryIdentity);
            const stat = this.assertCredentialFdTrustedReadOnly(fd);
            this.assertDirectoryIdentity(directory, directoryIdentity);
            return {
                dev: stat.dev,
                ino: stat.ino,
                birthtimeNs: stat.birthtimeNs,
                ctimeNs: stat.ctimeNs,
                mtimeNs: stat.mtimeNs,
                size: stat.size,
                mode: stat.mode,
                uid: stat.uid,
            };
        }
        finally {
            closeSync(fd);
        }
    }
    /** Validate the existing parent chain for a future create without creating or hardening it. */
    inspectTrustedParentForCreate() {
        const directory = dirname(this.path);
        if (dirname(directory) === directory) {
            throw new CredentialStoreError('filesystem root cannot be used as the credential directory');
        }
        const missing = this.missingDirectoryComponents(directory);
        if (missing.length === 0) {
            void this.prepareDirectory(false, false);
            return;
        }
        if (!this.isPosix()) {
            const highestMissing = missing.at(-1);
            if (highestMissing === undefined) {
                throw new CredentialStoreError('credential parent inspection failed');
            }
            this.assertTrustedWindowsParent(dirname(highestMissing), true);
        }
    }
    save(cred) {
        void this.saveCredential(cred, true);
    }
    /** Persist a credential only when no filesystem entry already occupies its path. */
    saveIfAbsent(cred) {
        return this.saveCredential(cred, false);
    }
    saveCredential(cred, replaceExisting) {
        this.prepareDirectory(true);
        const existingFd = this.openCredentialFile();
        if (existingFd !== null) {
            try {
                this.secureCredentialFd(existingFd);
            }
            finally {
                closeSync(existingFd);
            }
            if (!replaceExisting)
                return false;
        }
        const directory = dirname(this.path);
        const directoryIdentity = this.directoryIdentity(directory);
        const temporaryPath = resolve(directory, `.${basename(this.path)}.tmp-${randomBytes(16).toString('hex')}`);
        let temporaryIdentity = null;
        let fd = null;
        try {
            fd = openSync(temporaryPath, this.exclusiveWriteFlags(), FILE_MODE);
            const temporaryStat = bigFstat(fd);
            if (!temporaryStat.isFile())
                throw new CredentialStoreError('temporary entry is not a regular file');
            temporaryIdentity = identityOf(temporaryStat);
            if (this.isPosix()) {
                this.clearDarwinAcl(fd, temporaryIdentity, 'temporary');
                fchmodSync(fd, FILE_MODE);
            }
            else
                this.secureWindowsFile(temporaryPath, fd, temporaryIdentity);
            writeFileSync(fd, JSON.stringify(cred), 'utf8');
            fsyncSync(fd);
            closeSync(fd);
            fd = null;
            this.assertDirectoryIdentity(directory, directoryIdentity);
            if (replaceExisting) {
                this.assertSafeDestination();
                this.renameFile(temporaryPath, this.path);
            }
            else if (!this.publishIfAbsent(temporaryPath)) {
                const incumbentFd = this.openCredentialFile();
                if (incumbentFd === null) {
                    throw new CredentialStoreError('credential changed during no-clobber publication');
                }
                try {
                    this.secureCredentialFd(incumbentFd);
                }
                finally {
                    closeSync(incumbentFd);
                }
                return false;
            }
            this.verifySavedFile(temporaryIdentity);
            if (!replaceExisting)
                this.unlinkIfSameFile(temporaryPath, temporaryIdentity);
            temporaryIdentity = null;
            this.syncDirectory(directory);
            return true;
        }
        finally {
            if (fd !== null)
                closeSync(fd);
            if (temporaryIdentity !== null)
                this.unlinkIfSameFile(temporaryPath, temporaryIdentity);
        }
    }
    prepareDirectory(create, harden = true) {
        const directory = dirname(this.path);
        if (dirname(directory) === directory) {
            throw new CredentialStoreError('filesystem root cannot be used as the credential directory');
        }
        const missing = this.missingDirectoryComponents(directory);
        if (missing.length > 0) {
            if (!create)
                return false;
            for (const component of missing.reverse())
                this.createDirectoryComponent(component);
            if (this.missingDirectoryComponents(directory).length > 0) {
                throw new CredentialStoreError('parent directory disappeared during creation');
            }
        }
        const stat = bigLstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new CredentialStoreError('parent is a symlink or not a directory');
        }
        if (!this.isPosix()) {
            if (harden) {
                this.secureWindowsDirectory(directory, stat);
            }
            else {
                this.assertTrustedWindowsParent(dirname(directory), true);
                this.assertTrustedWindowsParent(directory, true);
            }
            return true;
        }
        const uid = BigInt(currentUid());
        if (stat.uid !== uid)
            throw new CredentialStoreError('parent directory is not owned by the current user');
        const flags = constants.O_RDONLY | optionalConstant('O_DIRECTORY') | optionalConstant('O_NOFOLLOW');
        const fd = openSync(directory, flags);
        try {
            const opened = bigFstat(fd);
            if (!opened.isDirectory() || !sameIdentity(stat, opened)) {
                throw new CredentialStoreError('parent directory changed during validation');
            }
            if (opened.uid !== uid)
                throw new CredentialStoreError('parent directory is not owned by the current user');
            if ((permissionMode(opened) & 0o022) !== 0) {
                throw new CredentialStoreError('parent directory is writable by group or other');
            }
            this.assertSafeDarwinAncestor(directory, opened, false);
            if (!harden)
                return true;
            this.clearDarwinAcl(fd, identityOf(opened), 'directory');
            if (permissionMode(bigFstat(fd)) !== DIRECTORY_MODE)
                fchmodSync(fd, DIRECTORY_MODE);
            if (permissionMode(bigFstat(fd)) !== DIRECTORY_MODE) {
                throw new CredentialStoreError('parent directory permissions could not be restricted to 0700');
            }
        }
        finally {
            closeSync(fd);
        }
        return true;
    }
    missingDirectoryComponents(directory) {
        let current = directory;
        let isCredentialDirectory = true;
        const missing = [];
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        for (;;) {
            let stat;
            try {
                stat = bigLstat(current);
            }
            catch (error) {
                if (!isErrno(error, 'ENOENT'))
                    throw error;
                missing.push(current);
                isCredentialDirectory = false;
                const parent = dirname(current);
                if (parent === current)
                    return missing;
                current = parent;
                continue;
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new CredentialStoreError(`parent component ${current} is a symlink or not a directory`);
            }
            if (this.isPosix()) {
                if (uid === undefined)
                    throw new CredentialStoreError('current user ownership cannot be determined');
                if (isCredentialDirectory && (stat.mode & 2n) !== 0n && (stat.mode & 512n) !== 0n) {
                    throw new CredentialStoreError(`credential directory ${current} is a shared sticky directory`);
                }
                if (stat.uid !== BigInt(uid) && stat.uid !== 0n) {
                    throw new CredentialStoreError(`parent component ${current} has an untrusted owner`);
                }
                if (!isCredentialDirectory && (stat.uid === BigInt(uid) || stat.uid === 0n)) {
                    this.assertSafeDarwinAncestor(current, stat, stat.uid === BigInt(uid) && stat.uid !== 0n);
                }
                if (!isCredentialDirectory && (stat.mode & 18n) !== 0n && (stat.mode & 512n) === 0n) {
                    throw new CredentialStoreError(`parent component ${current} is writable by untrusted users`);
                }
            }
            const parent = dirname(current);
            if (parent === current)
                return missing;
            // Root-owned directories are a stable trust anchor. Stopping here also
            // avoids rejecting platform-managed aliases above that anchor (e.g. /var).
            if (uid !== undefined && stat.uid === 0n)
                return missing;
            isCredentialDirectory = false;
            current = parent;
        }
    }
    createDirectoryComponent(component) {
        if (!this.isPosix())
            this.assertTrustedWindowsParent(dirname(component), true);
        try {
            mkdirSync(component, { mode: DIRECTORY_MODE });
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
        }
        const stat = bigLstat(component);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new CredentialStoreError(`parent component ${component} is a symlink or not a directory`);
        }
        if (!this.isPosix()) {
            this.secureWindowsDirectory(component, stat);
            return;
        }
        if (stat.uid !== BigInt(currentUid())) {
            throw new CredentialStoreError(`created parent component ${component} is not owned by the current user`);
        }
        const fd = openSync(component, constants.O_RDONLY | optionalConstant('O_DIRECTORY') | optionalConstant('O_NOFOLLOW'));
        try {
            const opened = bigFstat(fd);
            if (!opened.isDirectory() || !sameIdentity(stat, opened) || opened.uid !== BigInt(currentUid())) {
                throw new CredentialStoreError(`parent component ${component} changed during creation`);
            }
            this.clearDarwinAcl(fd, identityOf(opened), 'directory');
            if (permissionMode(bigFstat(fd)) !== DIRECTORY_MODE)
                fchmodSync(fd, DIRECTORY_MODE);
        }
        finally {
            closeSync(fd);
        }
    }
    openCredentialFile() {
        const before = safeLstat(this.path);
        if (!before)
            return null;
        if (before.isSymbolicLink() || !before.isFile()) {
            throw new CredentialStoreError('credential entry is a symlink or not a regular file');
        }
        let fd;
        try {
            fd = openSync(this.path, constants.O_RDONLY | optionalConstant('O_NOFOLLOW') | optionalConstant('O_NONBLOCK'));
        }
        catch (error) {
            if (isErrno(error, 'ENOENT'))
                return null;
            if (isErrno(error, 'ELOOP'))
                throw new CredentialStoreError('credential entry is a symlink');
            throw error;
        }
        try {
            const opened = bigFstat(fd);
            const after = bigLstat(this.path);
            if (!opened.isFile() || after.isSymbolicLink() || !after.isFile() ||
                !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
                throw new CredentialStoreError('credential entry changed during validation');
            }
            return fd;
        }
        catch (error) {
            closeSync(fd);
            throw error;
        }
    }
    secureCredentialFd(fd) {
        const stat = bigFstat(fd);
        if (!stat.isFile())
            throw new CredentialStoreError('credential entry is not a regular file');
        if (!this.isPosix()) {
            this.secureWindowsFile(this.path, fd, identityOf(stat));
            return;
        }
        if (stat.uid !== BigInt(currentUid()))
            throw new CredentialStoreError('credential file is not owned by the current user');
        // Reject group/other-writable modes before fchmod and before trusting content.
        // Migrating 0644→0600 is still allowed (read exposure only); write exposure is fail-closed.
        if ((permissionMode(stat) & 0o022) !== 0) {
            throw new CredentialStoreError('credential file is writable by group or other');
        }
        this.clearDarwinAcl(fd, identityOf(stat), 'credential');
        if (permissionMode(bigFstat(fd)) !== FILE_MODE)
            fchmodSync(fd, FILE_MODE);
        if (permissionMode(bigFstat(fd)) !== FILE_MODE) {
            throw new CredentialStoreError('credential file permissions could not be restricted to 0600');
        }
    }
    assertCredentialFdTrustedReadOnly(fd) {
        const stat = bigFstat(fd);
        if (!stat.isFile())
            throw new CredentialStoreError('credential entry is not a regular file');
        if (!this.isPosix()) {
            if (!this.windowsAclOps)
                throw new CredentialStoreError('Windows file ACL policy is unavailable');
            const identity = identityOf(stat);
            this.assertTrustedWindowsParent(dirname(this.path), false);
            try {
                this.windowsAclOps.assertTrustedFile(this.path);
            }
            catch (cause) {
                throw windowsCredentialStoreError('Windows credential file ACL is not trusted', cause);
            }
            const pathStat = bigLstat(this.path);
            const fdStat = bigFstat(fd);
            if (pathStat.isSymbolicLink() || !pathStat.isFile() || !fdStat.isFile() ||
                !sameIdentity(pathStat, identity) || !sameIdentity(fdStat, identity)) {
                throw new CredentialStoreError('credential file changed during read-only ACL validation');
            }
            return fdStat;
        }
        if (stat.uid !== BigInt(currentUid())) {
            throw new CredentialStoreError('credential file is not owned by the current user');
        }
        if ((permissionMode(stat) & 0o022) !== 0) {
            throw new CredentialStoreError('credential file is writable by group or other');
        }
        this.assertTrustedDarwinFile(fd, identityOf(stat));
        return bigFstat(fd);
    }
    assertSafeDestination() {
        const fd = this.openCredentialFile();
        if (fd === null)
            return;
        try {
            this.secureCredentialFd(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    verifySavedFile(expectedIdentity) {
        const fd = this.openCredentialFile();
        if (fd === null)
            throw new CredentialStoreError('credential file disappeared after atomic replacement');
        try {
            if (!sameIdentity(bigFstat(fd), expectedIdentity)) {
                throw new CredentialStoreError('credential file changed during atomic replacement');
            }
            this.securedCredentialState = securityStateOf(bigFstat(fd));
            // A same-directory rename preserves the DACL already verified on the
            // temporary inode. Avoid a post-commit ACL mutation that could fail after
            // the old credential has already been replaced.
            if (this.isPosix())
                this.secureCredentialFd(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    directoryIdentity(directory) {
        const stat = bigLstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new CredentialStoreError('parent is unsafe');
        return identityOf(stat);
    }
    assertDirectoryIdentity(directory, identity) {
        const stat = bigLstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, identity)) {
            throw new CredentialStoreError('parent directory changed during write');
        }
    }
    exclusiveWriteFlags() {
        return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | optionalConstant('O_NOFOLLOW');
    }
    publishIfAbsent(temporaryPath) {
        try {
            // A same-directory hard link publishes the already-fsynced inode without
            // replacing a destination that appears after the absence preflight.
            this.linkFile(temporaryPath, this.path);
            return true;
        }
        catch (error) {
            if (isErrno(error, 'EEXIST'))
                return false;
            try {
                if (safeLstat(this.path) !== null)
                    return false;
            }
            catch {
                // Report a stable fail-closed error below.
            }
            throw new CredentialStoreError('atomic no-clobber publication is unavailable');
        }
    }
    syncDirectory(directory) {
        if (!this.isPosix())
            return;
        const fd = openSync(directory, constants.O_RDONLY | optionalConstant('O_DIRECTORY') | optionalConstant('O_NOFOLLOW'));
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    unlinkIfSameFile(path, identity) {
        const stat = safeLstat(path);
        if (!stat || stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(stat, identity))
            return;
        unlinkSync(path);
    }
    secureWindowsDirectory(path, stat) {
        if (!this.windowsAclOps)
            throw new CredentialStoreError('Windows directory ACL policy is unavailable');
        const identity = identityOf(stat);
        // An existing directory may itself grant DELETE to another SID. Requiring
        // strict create rights on its direct parent prevents delete-and-recreate
        // with a junction before the pathname-based ACL update completes.
        this.assertTrustedWindowsParent(dirname(path), true);
        // Reject unsafe grants on an existing directory instead of trying to
        // migrate them in place. Tightening a DACL cannot revoke access already
        // granted to a handle opened by an untrusted principal.
        this.assertTrustedWindowsParent(path, true);
        if (this.securedDirectoryState && sameSecurityState(this.securedDirectoryState, stat))
            return;
        try {
            this.windowsAclOps.secureDirectory(path);
        }
        catch (cause) {
            throw windowsCredentialStoreError('Windows directory ACL could not be secured', cause);
        }
        const after = bigLstat(path);
        if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, identity)) {
            throw new CredentialStoreError('parent directory changed while securing its Windows ACL');
        }
        this.securedDirectoryState = securityStateOf(after);
    }
    secureWindowsFile(path, fd, identity) {
        if (!this.windowsAclOps)
            throw new CredentialStoreError('Windows file ACL policy is unavailable');
        const isCredentialPath = path === this.path;
        const before = bigFstat(fd);
        this.assertTrustedWindowsParent(dirname(path), false);
        // Reject unsafe grants on an existing file instead of migrating them in
        // place and then consuming. Tightening a DACL cannot revoke access already
        // granted to a handle opened by an untrusted principal.
        try {
            this.windowsAclOps.assertTrustedFile(path);
        }
        catch (cause) {
            throw windowsCredentialStoreError('Windows credential file ACL is not trusted', cause);
        }
        if (isCredentialPath && this.securedCredentialState &&
            sameSecurityState(this.securedCredentialState, before))
            return;
        try {
            this.windowsAclOps.secureFile(path);
        }
        catch (cause) {
            throw windowsCredentialStoreError('Windows file ACL could not be secured', cause);
        }
        const pathStat = bigLstat(path);
        const fdStat = bigFstat(fd);
        if (pathStat.isSymbolicLink() || !pathStat.isFile() || !fdStat.isFile() ||
            !sameIdentity(pathStat, identity) || !sameIdentity(fdStat, identity)) {
            throw new CredentialStoreError('credential file changed while securing its Windows ACL');
        }
        if (isCredentialPath)
            this.securedCredentialState = securityStateOf(fdStat);
    }
    clearDarwinAcl(fd, identity, kind) {
        if (this.platform !== 'darwin')
            return;
        const cached = kind === 'directory'
            ? this.securedDirectoryState
            : kind === 'credential' ? this.securedCredentialState : null;
        if (cached && sameSecurityState(cached, bigFstat(fd)))
            return;
        try {
            execFileSync('/bin/chmod', ['-N', '/dev/fd/3'], {
                shell: false,
                stdio: ['ignore', 'ignore', 'ignore', fd],
                timeout: 10_000,
            });
        }
        catch {
            throw new CredentialStoreError(`${kind} extended ACL could not be removed`);
        }
        const after = bigFstat(fd);
        if (!sameIdentity(after, identity)) {
            throw new CredentialStoreError(`${kind} changed while removing its extended ACL`);
        }
        if (kind === 'directory')
            this.securedDirectoryState = securityStateOf(after);
        else if (kind === 'credential')
            this.securedCredentialState = securityStateOf(after);
    }
    assertSafeDarwinAncestor(path, stat, rejectAnyAllow) {
        if (this.platform !== 'darwin')
            return;
        const cached = this.securedAncestorStates.get(path);
        if (cached && sameSecurityState(cached, stat))
            return;
        const identity = identityOf(stat);
        const flags = constants.O_RDONLY | optionalConstant('O_DIRECTORY') | optionalConstant('O_NOFOLLOW');
        const fd = openSync(path, flags);
        try {
            const opened = bigFstat(fd);
            if (!opened.isDirectory() || !sameIdentity(opened, identity)) {
                throw new CredentialStoreError(`ancestor directory ${path} changed during ACL validation`);
            }
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const initialMetadata = bigFstat(fd);
                const initialState = securityStateOf(initialMetadata);
                let output;
                try {
                    output = this.darwinAclReader(path);
                }
                catch {
                    throw new CredentialStoreError(`ancestor directory ${path} ACL could not be inspected`);
                }
                if (hasUnsafeDarwinAllowAcl(output, rejectAnyAllow)) {
                    throw new CredentialStoreError(`ancestor directory ${path} grants access through an extended ACL`);
                }
                const after = bigLstat(path);
                const openedAfter = bigFstat(fd);
                if (after.isSymbolicLink() || !after.isDirectory() ||
                    !sameIdentity(after, identity) || !sameIdentity(openedAfter, identity)) {
                    throw new CredentialStoreError(`ancestor directory ${path} changed during ACL validation`);
                }
                if (sameSecurityState(initialState, after) && sameSecurityState(initialState, openedAfter)) {
                    this.securedAncestorStates.set(path, securityStateOf(openedAfter));
                    return;
                }
                if (sameDarwinAncestorMetadata(initialMetadata, after)
                    && sameDarwinAncestorMetadata(initialMetadata, openedAfter)) {
                    let confirmedOutput;
                    try {
                        confirmedOutput = this.darwinAclReader(path);
                    }
                    catch {
                        throw new CredentialStoreError(`ancestor directory ${path} ACL could not be inspected`);
                    }
                    if (hasUnsafeDarwinAllowAcl(confirmedOutput, rejectAnyAllow)) {
                        throw new CredentialStoreError(`ancestor directory ${path} grants access through an extended ACL`);
                    }
                    const confirmedPath = bigLstat(path);
                    const confirmedOpened = bigFstat(fd);
                    if (confirmedOutput === output
                        && !confirmedPath.isSymbolicLink()
                        && confirmedPath.isDirectory()
                        && sameDarwinAncestorMetadata(initialMetadata, confirmedPath)
                        && sameDarwinAncestorMetadata(initialMetadata, confirmedOpened)) {
                        this.securedAncestorStates.set(path, securityStateOf(confirmedOpened));
                        return;
                    }
                }
            }
            throw new CredentialStoreError(`ancestor directory ${path} changed during ACL validation`);
        }
        finally {
            closeSync(fd);
        }
    }
    assertTrustedDarwinFile(fd, identity) {
        if (this.platform !== 'darwin')
            return;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const initialState = securityStateOf(bigFstat(fd));
            let output;
            try {
                output = this.darwinAclReader(this.path);
            }
            catch {
                throw new CredentialStoreError('credential file ACL could not be inspected');
            }
            if (hasUnsafeDarwinAllowAcl(output, true)) {
                throw new CredentialStoreError('credential file grants access through an extended ACL');
            }
            const after = bigLstat(this.path);
            const openedAfter = bigFstat(fd);
            if (after.isSymbolicLink() || !after.isFile() ||
                !sameIdentity(after, identity) || !sameIdentity(openedAfter, identity)) {
                throw new CredentialStoreError('credential file changed during ACL validation');
            }
            if (sameSecurityState(initialState, after) &&
                sameSecurityState(initialState, openedAfter))
                return;
        }
        throw new CredentialStoreError('credential file changed during ACL validation');
    }
    assertTrustedWindowsParent(path, strictCreate) {
        if (!this.windowsAclOps)
            throw new CredentialStoreError('Windows parent ACL policy is unavailable');
        const cacheKey = `${strictCreate ? 'create' : 'existing'}:${path}`;
        try {
            const before = this.windowsParentStateReader(path);
            const cached = this.trustedWindowsParentStates.get(cacheKey);
            if (cached && samePathSecurityStates(cached, before))
                return;
            this.windowsAclOps.assertTrustedParent(path, strictCreate);
            const after = this.windowsParentStateReader(path);
            if (samePathSecurityStates(before, after)) {
                this.trustedWindowsParentStates.set(cacheKey, after);
            }
        }
        catch (cause) {
            throw windowsCredentialStoreError('Windows parent directory chain is not trusted', cause);
        }
    }
    isPosix() {
        return this.platform !== 'win32';
    }
}
function windowsCredentialStoreError(message, cause) {
    const detail = cause instanceof Error ? windowsAclFailureDetail(cause) : '';
    return new CredentialStoreError(detail ? `${message} (${detail})` : message, { cause });
}
const WINDOWS_ACL_SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
# Progress records can be serialized as CLIXML onto redirected stderr and
# obscure the actual failure. Suppress them so stderr carries only real errors.
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-OneLineAclDiagnostic([object]$Value) {
  if ($null -eq $Value) { return '' }
  return ([string]$Value -replace '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+', ' ').Trim()
}

function Throw-CredentialAclFailure(
  [string]$Reason,
  [string]$Path = '',
  [string]$Sid = '',
  [object]$Rights = $null,
  [string]$Principal = ''
) {
  $parts = @($Reason)
  $safePath = ConvertTo-OneLineAclDiagnostic $Path
  $safeSid = ConvertTo-OneLineAclDiagnostic $Sid
  $safeRights = ConvertTo-OneLineAclDiagnostic $Rights
  $safePrincipal = ConvertTo-OneLineAclDiagnostic $Principal
  if (-not [string]::IsNullOrWhiteSpace($safePath)) { $parts += ('path=' + $safePath) }
  if (-not [string]::IsNullOrWhiteSpace($safeSid)) { $parts += ('sid=' + $safeSid) }
  if (-not [string]::IsNullOrWhiteSpace($safePrincipal)) { $parts += ('principal=' + $safePrincipal) }
  if (-not [string]::IsNullOrWhiteSpace($safeRights)) { $parts += ('rights=' + $safeRights) }
  throw ($parts -join '; ')
}

# Windows PowerShell can serialize ordinary error-stream writes as CLIXML when
# stderr is redirected. Write the terminating exception directly to native stderr so
# Node receives the actionable message rather than only a serialized record.
trap {
  $message = ConvertTo-OneLineAclDiagnostic $_.Exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) { $message = 'Credential ACL check failed' }
  [Console]::Error.WriteLine($message)
  exit 1
}

$Target = [Environment]::GetEnvironmentVariable('EVOMAP_CREDENTIAL_ACL_TARGET', 'Process')
$Kind = [Environment]::GetEnvironmentVariable('EVOMAP_CREDENTIAL_ACL_KIND', 'Process')
if ([string]::IsNullOrEmpty($Target) -or
    ($Kind -ne 'assert-parent' -and $Kind -ne 'assert-create-parent' -and
     $Kind -ne 'assert-file' -and $Kind -ne 'directory' -and $Kind -ne 'file')) {
  throw 'Invalid credential ACL input'
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trustedSids = @(
  $sid.Value,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$dangerousRights = [System.Security.AccessControl.FileSystemRights](
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)
$dangerousFileRights = [System.Security.AccessControl.FileSystemRights](
  [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
)

function Assert-TrustedParent([string]$ParentPath, [bool]$StrictCreate) {
  $full = [System.IO.Path]::GetFullPath($ParentPath)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root) -or $root -notmatch '^[A-Za-z]:\\$') {
    Throw-CredentialAclFailure -Reason 'Credential parent must be on a local drive' -Path $full
  }
  if ([System.IO.DriveInfo]::new($root).DriveType -ne [System.IO.DriveType]::Fixed) {
    Throw-CredentialAclFailure -Reason 'Credential parent must be on a fixed local drive' -Path $full
  }
  $current = $root
  $relative = $full.Substring($root.Length)
  $segments = $relative.Split(
    [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
    [System.StringSplitOptions]::RemoveEmptyEntries
  )
  $paths = @($root)
  foreach ($segment in $segments) {
    $current = [System.IO.Path]::Combine($current, $segment)
    $paths += $current
  }
  $trimSeparators = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $finalParent = $full.TrimEnd($trimSeparators)
  foreach ($current in $paths) {
    $isCreateParent = $StrictCreate -and [string]::Equals(
      $current.TrimEnd($trimSeparators),
      $finalParent,
      [System.StringComparison]::OrdinalIgnoreCase
    )
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      Throw-CredentialAclFailure -Reason 'Credential parent contains a reparse point or non-directory' -Path $current
    }
    $parentAcl = Get-Acl -LiteralPath $current
    $ownerSid = $parentAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($trustedSids -notcontains $ownerSid.Value) {
      Throw-CredentialAclFailure -Reason 'Credential parent has an untrusted owner' -Path $current -Sid $ownerSid.Value
    }
    foreach ($parentRule in @($parentAcl.Access)) {
      if ($parentRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        continue
      }
      $rights = $parentRule.FileSystemRights
      $inheritOnly = (($parentRule.PropagationFlags -band
        [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
      $containerInherit = (($parentRule.InheritanceFlags -band
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0)
      $objectInherit = (($parentRule.InheritanceFlags -band
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0)
      $hasGranularDanger = (($rights -band $dangerousRights) -ne 0)
      $hasCreateDanger = (($rights -band (
        [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [System.Security.AccessControl.FileSystemRights]::CreateFiles
      )) -ne 0)
      $hasCompositeDanger =
        (($rights -band [System.Security.AccessControl.FileSystemRights]::Write) -eq
          [System.Security.AccessControl.FileSystemRights]::Write) -or
        (($rights -band [System.Security.AccessControl.FileSystemRights]::Modify) -eq
          [System.Security.AccessControl.FileSystemRights]::Modify) -or
        (($rights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl)
      if ($inheritOnly) {
        $dangerousGrant = $isCreateParent -and ($containerInherit -or $objectInherit) -and
          ($hasGranularDanger -or $hasCreateDanger -or $hasCompositeDanger)
      } else {
        $dangerousGrant = $hasGranularDanger -or ($isCreateParent -and $hasCreateDanger)
      }
      if (-not $dangerousGrant) { continue }
      try {
        $parentRuleSid = $parentRule.IdentityReference.Translate(
          [System.Security.Principal.SecurityIdentifier]
        )
      } catch {
        Throw-CredentialAclFailure -Reason 'Credential parent contains an unresolvable write principal' -Path $current -Principal $parentRule.IdentityReference.Value -Rights $rights
      }
      if ($trustedSids -notcontains $parentRuleSid.Value) {
        Throw-CredentialAclFailure -Reason 'Credential parent grants write access to an untrusted principal' -Path $current -Sid $parentRuleSid.Value -Rights $rights
      }
    }
  }
}

function Assert-TrustedFile([string]$FilePath) {
  $item = Get-Item -LiteralPath $FilePath -Force
  if ($item.PSIsContainer -or
      (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Throw-CredentialAclFailure -Reason 'Credential file is a reparse point or not a regular file' -Path $FilePath
  }
  $fileAcl = Get-Acl -LiteralPath $FilePath
  $ownerSid = $fileAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($trustedSids -notcontains $ownerSid.Value) {
    Throw-CredentialAclFailure -Reason 'Credential file has an untrusted owner' -Path $FilePath -Sid $ownerSid.Value
  }
  foreach ($fileRule in @($fileAcl.Access)) {
    if ($fileRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    $rights = $fileRule.FileSystemRights
    $hasGranularDanger = (($rights -band $dangerousFileRights) -ne 0)
    $hasCompositeDanger =
      (($rights -band [System.Security.AccessControl.FileSystemRights]::Write) -eq
        [System.Security.AccessControl.FileSystemRights]::Write) -or
      (($rights -band [System.Security.AccessControl.FileSystemRights]::Modify) -eq
        [System.Security.AccessControl.FileSystemRights]::Modify) -or
      (($rights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
        [System.Security.AccessControl.FileSystemRights]::FullControl)
    if (-not ($hasGranularDanger -or $hasCompositeDanger)) { continue }
    try {
      $fileRuleSid = $fileRule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      )
    } catch {
      Throw-CredentialAclFailure -Reason 'Credential file contains an unresolvable write principal' -Path $FilePath -Principal $fileRule.IdentityReference.Value -Rights $rights
    }
    if ($trustedSids -notcontains $fileRuleSid.Value) {
      Throw-CredentialAclFailure -Reason 'Credential file grants write access to an untrusted principal' -Path $FilePath -Sid $fileRuleSid.Value -Rights $rights
    }
  }
}

function Test-CanonicalCredentialAcl(
  [System.Security.AccessControl.FileSystemSecurity]$CandidateAcl,
  [System.Security.Principal.SecurityIdentifier]$ExpectedOwner,
  [System.Security.AccessControl.InheritanceFlags]$ExpectedInheritance
) {
  try {
    $candidateRules = @($CandidateAcl.Access)
    if (-not $CandidateAcl.AreAccessRulesProtected -or $candidateRules.Count -ne 1) {
      return $false
    }
    $candidateOwner = $CandidateAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
    $candidateRule = $candidateRules[0]
    $candidateRuleSid = $candidateRule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]
    )
    return (
      $candidateOwner.Value -eq $ExpectedOwner.Value -and
      $candidateRuleSid.Value -eq $ExpectedOwner.Value -and
      $candidateRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $candidateRule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
      $candidateRule.InheritanceFlags -eq $ExpectedInheritance -and
      $candidateRule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
      -not $candidateRule.IsInherited
    )
  } catch {
    return $false
  }
}

if ($Kind -eq 'assert-parent' -or $Kind -eq 'assert-create-parent') {
  # Existing entries only require protection against replacement. Immediately
  # before mkdir, also reject principals that could atomically squat the name.
  Assert-TrustedParent $Target ($Kind -eq 'assert-create-parent')
  exit 0
}

if ($Kind -eq 'assert-file') {
  # Fail-closed: refuse untrusted write/modify/delete grants before Set-Acl
  # and before trusting file content. Do not migrate unsafe grants in place.
  Assert-TrustedFile $Target
  exit 0
}

$expectedInheritance = if ($Kind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$acl = Get-Acl -LiteralPath $Target
if (Test-CanonicalCredentialAcl $acl $sid $expectedInheritance) {
  exit 0
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$access = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $expectedInheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($access)
Set-Acl -LiteralPath $Target -AclObject $acl
$verified = Get-Acl -LiteralPath $Target
if (-not (Test-CanonicalCredentialAcl $verified $sid $expectedInheritance)) {
  Throw-CredentialAclFailure -Reason 'Credential ACL verification failed' -Path $Target -Sid $sid.Value
}
`;
class PowerShellWindowsAclOps {
    executable;
    systemRoot;
    constructor() {
        const systemRoot = process.env['SystemRoot'];
        if (!systemRoot || !win32.isAbsolute(systemRoot)) {
            throw new CredentialStoreError('Windows SystemRoot is unavailable or invalid');
        }
        this.systemRoot = systemRoot;
        this.executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    secureDirectory(path) {
        this.run(path, 'directory');
    }
    secureFile(path) {
        this.run(path, 'file');
    }
    assertTrustedParent(path, strictCreate) {
        this.run(path, strictCreate ? 'assert-create-parent' : 'assert-parent');
    }
    assertTrustedFile(path) {
        this.run(path, 'assert-file');
    }
    run(path, kind) {
        try {
            execFileSync(this.executable, [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                // The fixed wrapper parses stdin once. Bare -Command - can execute
                // PowerShell 5.1 input statement by statement and mask an earlier error.
                '-Command', POWERSHELL_STDIN_SCRIPT_COMMAND,
            ], {
                encoding: 'utf8',
                env: {
                    SystemRoot: this.systemRoot,
                    EVOMAP_CREDENTIAL_ACL_TARGET: path,
                    EVOMAP_CREDENTIAL_ACL_KIND: kind,
                },
                shell: false,
                // Capture both streams rather than discarding them: the script's own
                // message names which path level and which SID failed, and without it
                // every rejection is indistinguishable from "PowerShell is missing".
                // The script prints nothing on success, so this stays quiet normally.
                input: WINDOWS_ACL_SCRIPT,
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 15_000,
                windowsHide: true,
            });
        }
        catch (cause) {
            const detail = windowsAclFailureDetail(cause);
            throw new Error(detail ? `${kind} check failed: ${detail}` : `${kind} check failed`, { cause });
        }
    }
}
function readDarwinAcl(path) {
    return execFileSync('/bin/ls', ['-lde', path], {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
    });
}
function hasUnsafeDarwinAllowAcl(output, rejectAnyAllow) {
    const dangerousDirectoryRights = /\b(?:add_file|add_subdirectory|append|delete|delete_child|write|writeattr|writeextattr|writesecurity|chown)\b/;
    return output.split('\n').some((line) => {
        if (!/^ \d+:.* allow /.test(line))
            return false;
        return rejectAnyAllow || dangerousDirectoryRights.test(line);
    });
}
function currentUid() {
    if (typeof process.getuid !== 'function') {
        throw new CredentialStoreError('current user ownership cannot be determined');
    }
    return process.getuid();
}
function optionalConstant(name) {
    return constants[name] ?? 0;
}
function bigLstat(path) {
    return lstatSync(path, { bigint: true });
}
function bigFstat(fd) {
    return fstatSync(fd, { bigint: true });
}
function permissionMode(stat) {
    return Number(stat.mode & 511n);
}
function identityOf(stat) {
    return { dev: stat.dev, ino: stat.ino };
}
function securityStateOf(stat) {
    return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs };
}
function parentSecurityStates(path) {
    const states = [];
    let current = path;
    for (;;) {
        states.push({ path: current, ...securityStateOf(bigLstat(current)) });
        const parent = dirname(current);
        if (parent === current)
            return states;
        current = parent;
    }
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function sameSecurityState(left, right) {
    return sameIdentity(left, right) && left.ctimeNs === right.ctimeNs;
}
function sameDarwinAncestorMetadata(left, right) {
    return sameIdentity(left, right)
        && right.isDirectory()
        && !right.isSymbolicLink()
        && left.uid === right.uid
        && left.mode === right.mode;
}
function samePathSecurityStates(left, right) {
    return left.length === right.length && left.every((state, index) => {
        const candidate = right[index];
        return candidate !== undefined && state.path === candidate.path &&
            sameIdentity(state, candidate) && state.ctimeNs === candidate.ctimeNs;
    });
}
function safeLstat(path) {
    try {
        return bigLstat(path);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return null;
        throw error;
    }
}
function isErrno(error, code) {
    return error.code === code;
}