import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { hub, util } from '@evomap/evolver-core';
import { windowsAclFailureDetail } from './windowsPowerShell.js';
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
            ? (options.windowsAclOps ?? createWindowsCredentialAclOps())
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
            if (!replaceExisting)
                this.unlinkIfSameFile(temporaryPath, temporaryIdentity);
            this.verifySavedFile(temporaryIdentity);
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
        const entry = safeLstat(this.path);
        if (!entry)
            return null;
        if (entry.isSymbolicLink() || !entry.isFile()) {
            throw new CredentialStoreError('credential entry is a symlink or not a regular file');
        }
        const before = credentialFileStat(this.path);
        if (before.nlink !== 1n)
            throw new CredentialStoreError('credential entry has multiple hardlinks');
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
            const after = credentialFileStat(this.path);
            if (!opened.isFile() || after.isSymbolicLink() || !after.isFile() ||
                opened.nlink !== 1n || after.nlink !== 1n ||
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
            return this.assertWindowsFileIdentity(this.path, fd, identity);
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
        if (!stat || stat.isSymbolicLink() || !stat.isFile())
            return;
        if (!sameIdentity(credentialFileStat(path), identity))
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
        this.assertWindowsFileIdentity(path, fd, identity);
        if (isCredentialPath && this.securedCredentialState &&
            sameSecurityState(this.securedCredentialState, before))
            return;
        try {
            this.windowsAclOps.secureFile(path);
        }
        catch (cause) {
            throw windowsCredentialStoreError('Windows file ACL could not be secured', cause);
        }
        const fdStat = this.assertWindowsFileIdentity(path, fd, identity);
        if (isCredentialPath)
            this.securedCredentialState = securityStateOf(fdStat);
    }
    assertWindowsFileIdentity(path, fd, identity) {
        const pathStat = credentialFileStat(path);
        const fdStat = bigFstat(fd);
        if (pathStat.isSymbolicLink() || !pathStat.isFile() || !fdStat.isFile() ||
            pathStat.nlink !== 1n || fdStat.nlink !== 1n ||
            !sameIdentity(pathStat, identity) || !sameIdentity(fdStat, identity)) {
            throw new CredentialStoreError('credential file changed during Windows ACL validation');
        }
        return fdStat;
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
function createWindowsCredentialAclOps() {
    try {
        return new hub.PowerShellWindowsAclOps();
    }
    catch (cause) {
        throw new CredentialStoreError(cause instanceof Error ? cause.message : 'Windows ACL policy is unavailable', { cause });
    }
}
function windowsCredentialStoreError(message, cause) {
    const detail = cause instanceof Error ? windowsAclFailureDetail(cause) : '';
    return new CredentialStoreError(detail ? `${message} (${detail})` : message, { cause });
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
function credentialFileStat(path) {
    try {
        return util.statRegularFileIdentity(path);
    }
    catch (cause) {
        if (cause instanceof util.UnsafeLockPathError) {
            throw new CredentialStoreError(`credential file identity changed: ${cause.reason}`, { cause });
        }
        throw cause;
    }
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