import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, posix, resolve, win32 } from 'node:path';
import { bootstrap as coreBootstrap, util } from '@evomap/evolver-core';
export const BOOTSTRAP_JOURNAL_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_JOURNAL_FILE;
export const BOOTSTRAP_LOCK_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE;
export const BOOTSTRAP_SUCCESS_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_SUCCESS_FILE;
const BOOTSTRAP_MANUAL_TRANSITION_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_FILE;
const BOOTSTRAP_JOURNAL_SCHEMA = 'evolver.lifecycle-bootstrap-transaction.v1';
export const LEGACY_BOOTSTRAP_REMOVAL_OPERATION = 'legacy-v907-remove';
const LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING = 'legacy-v907-absent';
const BOOTSTRAP_REGISTRATION_INTENT_FILE = coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_FILE;
const JOURNAL_STAGES = new Set([
    'prepared', 'installing', 'installed', 'activating', 'activated', 'committing',
    'committed', 'rollback_pending', 'rolled_back',
]);
const TARGETS = new Set(['launchd', 'systemd', 'windows']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_MARKER_BYTES = 128 * 1024;
const MAX_READINESS_BYTES = 16 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const HOST_WINDOWS_SYSTEM_ROOT = process.env['SystemRoot']?.trim() || 'C:\\Windows';
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function filesystemEntryPresent(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function boundedText(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !containsControlCharacter(value);
}
function containsControlCharacter(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f)
            return true;
    }
    return false;
}
function trustedWindowsSystemExecutable(name) {
    if (!win32.isAbsolute(HOST_WINDOWS_SYSTEM_ROOT) || /[\r\n\0]/.test(HOST_WINDOWS_SYSTEM_ROOT)) {
        throw new Error('Windows SystemRoot is not an absolute trusted path');
    }
    return win32.join(HOST_WINDOWS_SYSTEM_ROOT, 'System32', name);
}
let bootstrapWindowsAclTrustForTest;
/** Test-only ACL dependency seam. Production callers never configure this override. */
export function _setBootstrapWindowsAclTrustForTest(assertion) {
    bootstrapWindowsAclTrustForTest = assertion;
}
function assertWindowsAclChecksTrusted(checks) {
    if (process.platform !== 'win32')
        return;
    if (bootstrapWindowsAclTrustForTest) {
        bootstrapWindowsAclTrustForTest(checks);
        return;
    }
    const serializedChecks = checks.map((check) => (`@{ Path = '${check.path.replaceAll("'", "''")}'; ParentOnly = $${check.parentOnly ? 'true' : 'false'}; OwnerCurrentOnly = $${check.ownerCurrentOnly ? 'true' : 'false'} }`)).join(', ');
    const script = [
        `$checks = @(${serializedChecks})`,
        '$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        "$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'",
        "$trustedOwners = @($userSid, 'S-1-5-18', 'S-1-5-32-544', $trustedInstaller)",
        "$trustedWriters = @($userSid, 'S-1-5-18', 'S-1-5-32-544', $trustedInstaller, 'S-1-3-0', 'S-1-3-4')",
        '$parentDanger = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership',
        '$contentDanger = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories',
        'foreach ($check in $checks) {',
        '  $acl = Get-Acl -LiteralPath $check.Path',
        '  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
        '  if (($check.OwnerCurrentOnly -and $owner -ne $userSid) -or (-not $check.OwnerCurrentOnly -and $trustedOwners -notcontains $owner)) { exit 21 }',
        '  $danger = if ($check.ParentOnly) { $parentDanger } else { $parentDanger -bor $contentDanger }',
        '  foreach ($rule in @($acl.Access)) {',
        '    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }',
        '    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }',
        '    if (($rule.FileSystemRights -band $danger) -eq 0) { continue }',
        '    try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { exit 22 }',
        '    if ($trustedWriters -notcontains $sid) { exit 23 }',
        '  }',
        '}',
    ].join('; ');
    try {
        execFileSync(trustedWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
            stdio: 'ignore', timeout: 10_000, windowsHide: true,
        });
    }
    catch (error) {
        throw new Error(`bootstrap Windows ACL chain is not trusted: ${checks[0]?.path ?? '<empty>'}`, { cause: error });
    }
}
function assertWindowsAclTrusted(path, ownerCurrentOnly = false) {
    assertWindowsAclChecksTrusted([{ path, parentOnly: false, ownerCurrentOnly }]);
}
function assertWindowsAclChainTrusted(path) {
    const checks = [];
    let current = resolve(path);
    const root = parse(current).root;
    for (;;) {
        checks.push({ path: current, parentOnly: checks.length > 0 });
        if (current === root)
            break;
        current = dirname(current);
    }
    assertWindowsAclChecksTrusted(checks);
}
function assertSecureStateDirectory(stateDir) {
    const stat = lstatSync(stateDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`bootstrap state directory is not a trusted directory: ${stateDir}`);
    }
    if (process.platform === 'win32') {
        assertWindowsAclChainTrusted(stateDir);
        return;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
        throw new Error(`bootstrap state directory has an unexpected owner: ${stateDir}`);
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new Error(`bootstrap state directory must be owner-only: ${stateDir}`);
    }
    assertTrustedPosixDirectoryChain(dirname(resolve(stateDir)), process.platform, uid, 'bootstrap state directory parent', true);
}
function effectivePosixUid(platform, uid) {
    if (uid !== undefined)
        return uid;
    if (platform === process.platform && typeof process.getuid === 'function')
        return process.getuid();
    return undefined;
}
function assertTrustedPosixDirectoryChain(directory, platform, uid, label, initialPrivateUserAnchor = false) {
    const trustedUid = effectivePosixUid(platform, uid);
    if (trustedUid === undefined) {
        throw new Error(`${label} owner cannot be verified`);
    }
    let current = resolve(directory);
    const root = parse(current).root;
    let privateUserAnchor = initialPrivateUserAnchor;
    for (;;) {
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(`${label} is not a trusted directory: ${current}`);
            }
            if (stat.uid !== trustedUid && stat.uid !== 0) {
                throw new Error(`${label} has an unexpected owner: ${current}`);
            }
            const writableByOthers = (stat.mode & 0o022) !== 0;
            const trustedStickyAncestor = privateUserAnchor
                && stat.uid === 0
                && (stat.mode & 0o1000) !== 0;
            if (writableByOthers && !trustedStickyAncestor) {
                throw new Error(`${label} is group/world writable: ${current}`);
            }
            if (stat.uid === trustedUid && (stat.mode & 0o077) === 0) {
                privateUserAnchor = true;
            }
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
        if (current === root)
            break;
        current = dirname(current);
    }
}
function readBoundedRegularText(path, maxBytes, label, options = {}) {
    const platform = options.platform ?? process.platform;
    const uid = platform === 'win32' || typeof process.getuid !== 'function'
        ? undefined
        : BigInt(process.getuid());
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)
        || (options.requireOwnerOnly === true && before.nlink !== 1n)
        || before.dev <= 0n || before.ino <= 0n) {
        throw new Error(`${label} is not a bounded regular file: ${path}`);
    }
    if (options.requireOwnerOnly === true && platform !== 'win32') {
        if ((uid !== undefined && before.uid !== uid) || (before.mode & 63n) !== 0n) {
            throw new Error(`${label} is not owner-only: ${path}`);
        }
    }
    if (platform === 'win32') {
        (options.assertWindowsAcl ?? assertWindowsAclTrusted)(path);
    }
    options.afterAclCheck?.();
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
            || (options.requireOwnerOnly === true && opened.nlink !== 1n)
            || (options.requireOwnerOnly === true && platform !== 'win32'
                && ((uid !== undefined && opened.uid !== uid) || (opened.mode & 63n) !== 0n))
            || opened.dev <= 0n || opened.ino <= 0n || opened.size > BigInt(maxBytes)
            || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs
            || opened.ctimeNs !== before.ctimeNs) {
            throw new Error(`${label} changed while opening: ${path}`);
        }
        const bytes = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
            if (count === 0)
                break;
            offset += count;
        }
        if (offset > maxBytes) {
            throw new Error(`${label} is not a bounded regular file: ${path}`);
        }
        const value = bytes.subarray(0, offset).toString('utf8');
        const after = fstatSync(descriptor, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || (options.requireOwnerOnly === true && after.nlink !== 1n)
            || (options.requireOwnerOnly === true && platform !== 'win32'
                && ((uid !== undefined && after.uid !== uid) || (after.mode & 63n) !== 0n))) {
            throw new Error(`${label} changed while reading: ${path}`);
        }
        options.afterRead?.();
        if (platform === 'win32') {
            (options.assertWindowsAcl ?? assertWindowsAclTrusted)(path);
        }
        const settled = lstatSync(path, { bigint: true });
        if (!settled.isFile() || settled.isSymbolicLink()
            || settled.dev !== opened.dev || settled.ino !== opened.ino || settled.size !== opened.size
            || settled.mtimeNs !== opened.mtimeNs || settled.ctimeNs !== opened.ctimeNs
            || (options.requireOwnerOnly === true && settled.nlink !== 1n)
            || (options.requireOwnerOnly === true && platform !== 'win32'
                && ((uid !== undefined && settled.uid !== uid) || (settled.mode & 63n) !== 0n))) {
            throw new Error(`${label} changed after reading: ${path}`);
        }
        return value;
    }
    finally {
        closeSync(descriptor);
    }
}
export function _readBoundedRegularTextForTest(path, maxBytes, label, options) {
    return readBoundedRegularText(path, maxBytes, label, options);
}
function syncDirectory(path) {
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY);
        fsyncSync(descriptor);
    }
    catch (error) {
        if (isErrno(error, 'EINVAL'))
            return;
        if (process.platform === 'win32' && (isErrno(error, 'EPERM') || isErrno(error, 'EACCES')))
            return;
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
export function writeDurableText(path, content, mode = 0o600) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    try {
        descriptor = openSync(temporary, 'wx', mode);
        writeFileSync(descriptor, content, { encoding: 'utf8' });
        fchmodSync(descriptor, mode);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, path);
        syncDirectory(directory);
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
        rmSync(temporary, { force: true });
    }
}
function bootstrapArtifactOwnershipReceiptPath(path, claimPath) {
    const canonicalPath = resolve(path);
    const canonicalClaimPath = resolve(claimPath);
    const prefix = `.${basename(canonicalPath)}.bootstrap-`;
    const claimName = basename(canonicalClaimPath);
    if (dirname(canonicalClaimPath) !== dirname(canonicalPath)
        || !claimName.startsWith(prefix)
        || !claimName.endsWith('.claim')) {
        throw new Error('bootstrap artifact claim does not encode a transaction owner');
    }
    const transactionId = claimName.slice(prefix.length, -'.claim'.length);
    if (!UUID_RE.test(transactionId)
        || bootstrapArtifactClaimPath(canonicalPath, transactionId) !== canonicalClaimPath) {
        throw new Error('bootstrap artifact claim does not encode a transaction owner');
    }
    return bootstrapArtifactRollbackPath(canonicalPath, transactionId);
}
function writeDurableExclusive(path, content, mode, publication) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const claimPath = publication?.claimPath;
    if (claimPath && dirname(resolve(claimPath)) !== resolve(directory)) {
        throw new Error('bootstrap artifact claim must share the artifact directory');
    }
    const ownershipReceipt = claimPath
        ? bootstrapArtifactOwnershipReceiptPath(path, claimPath)
        : undefined;
    // The transaction-namespaced receipt is the staging name. It is populated and
    // fsynced before an atomic hard-link publishes the canonical claim name, so a
    // process death can never expose a zero or partially written claim.
    const temporary = ownershipReceipt
        ?? join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    let stagingCreated = false;
    let claimPublished = false;
    try {
        descriptor = openSync(temporary, 'wx', mode);
        stagingCreated = true;
        if (typeof content === 'string')
            writeFileSync(descriptor, content, { encoding: 'utf8' });
        else
            writeFileSync(descriptor, content);
        fchmodSync(descriptor, mode);
        fsyncSync(descriptor);
        if (publication && claimPath && ownershipReceipt) {
            syncDirectory(directory);
            const opened = fstatSync(descriptor, { bigint: true });
            const receipt = lstatSync(ownershipReceipt, { bigint: true });
            if (!opened.isFile() || opened.dev <= 0n || opened.ino <= 0n
                || receipt.dev !== opened.dev || receipt.ino !== opened.ino) {
                throw new Error('bootstrap artifact ownership receipt does not bind the staged claim');
            }
            linkSync(ownershipReceipt, claimPath);
            syncDirectory(directory);
            claimPublished = true;
            const claim = lstatSync(claimPath, { bigint: true });
            if (claim.dev !== opened.dev || claim.ino !== opened.ino) {
                throw new Error('bootstrap artifact claim does not bind the staged ownership receipt');
            }
            publication.onPublished(path, claimPath);
        }
        closeSync(descriptor);
        descriptor = undefined;
        linkSync(claimPath ?? temporary, path);
        syncDirectory(directory);
        publication?.onPublished(path, claimPath);
        if (ownershipReceipt) {
            rmSync(ownershipReceipt, { force: true });
            syncDirectory(directory);
        }
        if (claimPath)
            rmSync(claimPath, { force: true });
        else
            rmSync(temporary, { force: true });
        syncDirectory(directory);
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
        if (!publication) {
            rmSync(temporary, { force: true });
        }
        else if (stagingCreated && !claimPublished) {
            // A synchronous failure before claim publication cannot require restart
            // recovery; the current process still owns this unpublished staging name.
            rmSync(temporary, { force: true });
            syncDirectory(directory);
        }
    }
}
export function writeDurableTextExclusive(path, content, mode = 0o600, publication) {
    writeDurableExclusive(path, content, mode, publication);
}
export function writeDurableBytesExclusive(path, content, mode = 0o600, publication) {
    writeDurableExclusive(path, content, mode, publication);
}
function writeDurableJson(path, value, mode = 0o600) {
    writeDurableText(path, `${JSON.stringify(value)}\n`, mode);
}
export function writeDurableJsonExclusive(path, value, mode = 0o600) {
    writeDurableTextExclusive(path, `${JSON.stringify(value)}\n`, mode);
}
export function removeDurableFile(path) {
    try {
        rmSync(path, { force: true });
        syncDirectory(dirname(path));
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
export function acquireBootstrapOwnerLock(stateDir, options = {}) {
    if (!existsSync(stateDir)) {
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        assertTrustedArtifactParent(join(stateDir, '.bootstrap-owner'), process.platform, uid);
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    assertSecureStateDirectory(stateDir);
    const path = join(stateDir, BOOTSTRAP_LOCK_FILE);
    const owner = util.acquireLock(path, { maxTries: options.maxTries ?? 2_400, waitMs: options.waitMs ?? 100 });
    return bootstrapLockHandle(path, owner);
}
export function acquireBootstrapReadinessLock(stateDir, options = {}) {
    assertSecureStateDirectory(stateDir);
    const path = join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE);
    const owner = util.acquireLock(path, { maxTries: options.maxTries ?? 500, waitMs: options.waitMs ?? 10 });
    return bootstrapLockHandle(path, owner);
}
function bootstrapLockHandle(path, owner) {
    const expectedBytes = Buffer.from(`${JSON.stringify({
        v: 2,
        pid: owner.pid,
        token: owner.token,
        processStart: owner.processStartIdentity,
    })}\n`, 'utf8');
    let receipt;
    try {
        receipt = readBootstrapArtifactFile(path, util.MAX_LOCK_OWNER_BYTES, { role: 'owned' });
        if (!receipt.bytes.equals(expectedBytes)) {
            throw new Error('bootstrap owner lock acquisition did not publish the exact owner');
        }
    }
    catch (error) {
        const released = util.releaseLock(path);
        if (!released.released) {
            throw new Error(`bootstrap owner lock initialization failed; release failed: ${released.reason}`, { cause: error });
        }
        throw error;
    }
    let released = false;
    const assertOwned = () => {
        if (released) {
            throw new Error('bootstrap owner lock assertion failed: not_owned');
        }
        let current;
        try {
            current = readBootstrapArtifactFile(path, util.MAX_LOCK_OWNER_BYTES, { role: 'owned' });
        }
        catch {
            throw new Error('bootstrap owner lock assertion failed: ownership_changed');
        }
        if (!current.bytes.equals(expectedBytes)
            || current.identity.size !== receipt.identity.size
            || current.identity.sha256 !== receipt.identity.sha256
            || current.identity.device !== receipt.identity.device
            || current.identity.inode !== receipt.identity.inode) {
            throw new Error('bootstrap owner lock assertion failed: ownership_changed');
        }
    };
    return {
        path,
        owner,
        assertOwned,
        release: () => {
            if (released)
                return;
            try {
                assertOwned();
            }
            catch {
                throw new Error('bootstrap owner lock release failed: ownership_changed');
            }
            const result = util.releaseLock(path);
            if (!result.released
                || (result.reason !== 'released' && result.reason !== 'released_with_cleanup_error')) {
                throw new Error(`bootstrap owner lock release failed: ${result.reason}`);
            }
            released = true;
        },
    };
}
export function createBootstrapJournal(input) {
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(input.owner.pid) || input.owner.pid <= 0
        || !UUID_RE.test(input.owner.token)
        || !parseProcessStartIdentity(input.owner.processStartIdentity)) {
        throw new Error('bootstrap transaction owner must match a validated file-lock owner');
    }
    const uniquePaths = [...new Set(input.artifactPaths.map((path) => resolve(path)))];
    if (uniquePaths.length === 0 || uniquePaths.length > 32) {
        throw new Error('bootstrap transaction must declare between 1 and 32 artifacts');
    }
    const transactionId = input.transactionId ?? randomUUID();
    if (!UUID_RE.test(transactionId))
        throw new Error('bootstrap transaction id must be a UUID');
    const managerArtifactPath = resolve(input.managerArtifactPath);
    if (!uniquePaths.includes(managerArtifactPath)) {
        throw new Error('bootstrap manager binding must reference an owned artifact');
    }
    const namespacePaths = uniquePaths.flatMap((path) => [
        path,
        bootstrapArtifactClaimPath(path, transactionId),
        bootstrapArtifactRollbackPath(path, transactionId),
    ]);
    const namespaceKeys = namespacePaths.map((path) => bootstrapPathKey(path, input.target));
    if (new Set(namespaceKeys).size !== namespaceKeys.length) {
        throw new Error('bootstrap transaction artifact namespace overlaps');
    }
    return {
        schema: BOOTSTRAP_JOURNAL_SCHEMA,
        transactionId,
        owner: { ...input.owner, processStartIdentity: { ...input.owner.processStartIdentity }, acquiredAt: new Date(now).toISOString() },
        target: input.target,
        service: input.service,
        managerBefore: 'absent',
        managerBinding: { artifactPath: managerArtifactPath, kind: 'transaction' },
        stage: 'prepared',
        deadlineMs: input.deadlineMs,
        artifacts: uniquePaths.map((path) => {
            const identity = input.artifactIdentities[path];
            if (!identity || !validArtifactIdentity(identity, false)) {
                throw new Error(`bootstrap transaction is missing an expected artifact identity: ${path}`);
            }
            return {
                path,
                claimPath: bootstrapArtifactClaimPath(path, transactionId),
                rollbackPath: bootstrapArtifactRollbackPath(path, transactionId),
                before: 'absent',
                identity: { ...identity },
            };
        }),
        updatedAt: new Date(now).toISOString(),
    };
}
export function bootstrapJournalFromMarker(marker, owner, deadlineMs, now = Date.now()) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !UUID_RE.test(owner.token)
        || !parseProcessStartIdentity(owner.processStartIdentity)) {
        throw new Error('bootstrap marker recovery owner must match a validated file-lock owner');
    }
    return {
        schema: BOOTSTRAP_JOURNAL_SCHEMA,
        transactionId: marker.transactionId,
        owner: { ...owner, processStartIdentity: { ...owner.processStartIdentity }, acquiredAt: new Date(now).toISOString() },
        target: marker.target,
        service: marker.service,
        managerBefore: 'absent',
        managerBinding: {
            artifactPath: resolve(marker.managerArtifactPath),
            kind: marker.managerBindingKind ?? 'transaction',
        },
        stage: 'activated',
        deadlineMs,
        artifacts: marker.artifacts.map((artifact) => ({
            path: resolve(artifact.path),
            claimPath: bootstrapArtifactClaimPath(artifact.path, marker.transactionId),
            rollbackPath: bootstrapArtifactRollbackPath(artifact.path, marker.transactionId),
            before: 'absent',
            identity: {
                size: artifact.size,
                sha256: artifact.sha256,
                ...(artifact.device ? { device: artifact.device } : {}),
                ...(artifact.inode ? { inode: artifact.inode } : {}),
            },
        })),
        ...(marker.preservedArtifacts && marker.preservedArtifacts.length > 0
            ? { preservedArtifacts: marker.preservedArtifacts.map((artifact) => ({ ...artifact })) }
            : {}),
        successMarkerIdentity: bootstrapArtifactIdentityForBytes(Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8')),
        activationStarted: true,
        updatedAt: new Date(now).toISOString(),
    };
}
export function bootstrapJournalManagerArtifactPath(journal) {
    if (!('artifactPath' in journal.managerBinding)) {
        throw new Error('bootstrap recovery journal records an absent manager without an artifact binding');
    }
    return journal.managerBinding.artifactPath;
}
export function createLegacyBootstrapRemovalJournal(input) {
    const now = input.now ?? Date.now();
    const transactionId = randomUUID();
    if (!Number.isSafeInteger(input.owner.pid) || input.owner.pid <= 0
        || !UUID_RE.test(input.owner.token)
        || !parseProcessStartIdentity(input.owner.processStartIdentity)
        || input.artifacts.length === 0) {
        throw new Error('legacy bootstrap removal receipt is invalid');
    }
    const artifacts = input.artifacts.map((artifact) => ({
        path: resolve(artifact.path),
        claimPath: bootstrapArtifactClaimPath(artifact.path, transactionId),
        rollbackPath: bootstrapArtifactRollbackPath(artifact.path, transactionId),
        before: 'legacy_owned',
        identity: {
            size: artifact.size,
            sha256: artifact.sha256,
            ...(artifact.device ? { device: artifact.device } : {}),
            ...(artifact.inode ? { inode: artifact.inode } : {}),
        },
    }));
    const managerArtifactPath = input.managerArtifactPath === undefined
        ? undefined
        : resolve(input.managerArtifactPath);
    if (input.managerState === 'absent') {
        if (managerArtifactPath !== undefined) {
            throw new Error('absent legacy manager cannot declare an artifact binding');
        }
    }
    else if (!managerArtifactPath
        || !artifacts.some((artifact) => artifact.path === managerArtifactPath)) {
        throw new Error('legacy bootstrap removal manager artifact is not owned');
    }
    const journal = {
        schema: BOOTSTRAP_JOURNAL_SCHEMA,
        transactionId,
        owner: {
            ...input.owner,
            processStartIdentity: { ...input.owner.processStartIdentity },
            acquiredAt: new Date(now).toISOString(),
        },
        target: input.target,
        service: input.service,
        managerBefore: input.managerState,
        managerBinding: input.managerState === 'absent'
            ? { kind: LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING, state: 'absent' }
            : {
                artifactPath: managerArtifactPath,
                kind: coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING,
            },
        operation: LEGACY_BOOTSTRAP_REMOVAL_OPERATION,
        stage: 'prepared',
        deadlineMs: input.deadlineMs,
        artifacts,
        ...(input.preservedArtifacts && input.preservedArtifacts.length > 0
            ? { preservedArtifacts: input.preservedArtifacts.map((artifact) => ({ ...artifact, path: resolve(artifact.path) })) }
            : {}),
        activationStarted: input.managerState !== 'absent',
        artifactsRestored: false,
        terminalAction: 'remove_committed',
        updatedAt: new Date(now).toISOString(),
    };
    if (!parseBootstrapJournal(journal)) {
        throw new Error('legacy bootstrap removal receipt is invalid');
    }
    return journal;
}
export function bootstrapArtifactClaimPath(path, transactionId) {
    return join(dirname(resolve(path)), `.${basename(path)}.bootstrap-${transactionId}.claim`);
}
export function bootstrapArtifactRollbackPath(path, transactionId) {
    return join(dirname(resolve(path)), `.${basename(path)}.bootstrap-${transactionId}.rollback`);
}
function bootstrapArtifactStagingCleanupPath(artifact) {
    return `${artifact.rollbackPath}.staging-cleanup`;
}
export function updateBootstrapJournal(journal, patch, now = Date.now()) {
    const artifacts = patch.artifactsRestored === true || patch.stage === 'rolled_back'
        ? journal.artifacts.map((artifact) => {
            const { claimOwnership: _claimOwnership, ...restoredArtifact } = artifact;
            return restoredArtifact;
        })
        : patch.stage === 'installing'
            ? journal.artifacts.map((artifact) => (artifact.before === 'absent'
                && artifact.identity?.device === undefined
                && artifact.claimOwnership === undefined
                ? { ...artifact, claimOwnership: { phase: 'armed' } }
                : artifact))
            : journal.artifacts;
    return { ...journal, ...patch, artifacts, updatedAt: new Date(now).toISOString() };
}
export function bootstrapJournalPath(stateDir) {
    return join(stateDir, BOOTSTRAP_JOURNAL_FILE);
}
export function bootstrapMarkerPath(stateDir) {
    return join(stateDir, BOOTSTRAP_SUCCESS_FILE);
}
export function bootstrapReadinessPath(stateDir) {
    return join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_FILE);
}
export function bootstrapManualTransitionPath(stateDir) {
    return join(stateDir, BOOTSTRAP_MANUAL_TRANSITION_FILE);
}
function bootstrapRegistrationIntentPath(stateDir) {
    return join(stateDir, BOOTSTRAP_REGISTRATION_INTENT_FILE);
}
/**
 * Validate the parent's active registration token while the caller owns bootstrap-owner.lock.
 * Absence, a terminal receipt, or any malformed/untrusted presentation blocks before mutation.
 */
export function assertActiveBootstrapRegistrationIntentToken(stateDir, tokenValue) {
    const token = coreBootstrap.parseLifecycleBootstrapRegistrationToken(tokenValue);
    if (!token)
        throw new Error('bootstrap registration token is invalid');
    assertSecureStateDirectory(stateDir);
    const path = bootstrapRegistrationIntentPath(stateDir);
    let parsed;
    try {
        parsed = coreBootstrap.parseLifecycleBootstrapRegistrationIntentJson(readBoundedRegularText(path, coreBootstrap.MAX_LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_BYTES, 'bootstrap registration intent', { requireOwnerOnly: true }));
    }
    catch (error) {
        throw new Error('bootstrap registration intent is unavailable or untrusted', { cause: error });
    }
    if (!parsed || parsed.state !== 'registering' || parsed.owner.token !== token) {
        throw new Error('bootstrap registration intent does not authorize this child');
    }
    return parsed;
}
export function readBootstrapManualTransition(stateDir) {
    const path = bootstrapManualTransitionPath(stateDir);
    try {
        assertSecureStateDirectory(stateDir);
        const transition = coreBootstrap.parseLifecycleBootstrapManualTransitionJson(readBoundedRegularText(path, coreBootstrap.MAX_LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_BYTES, 'bootstrap manual-transition tombstone', { requireOwnerOnly: true }));
        if (!transition) {
            throw new Error(`bootstrap manual-transition tombstone is corrupt: ${path}`);
        }
        return transition;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function sameBootstrapManualTransitionSource(transition, source) {
    return transition.removedTransactionId === source.transactionId
        && transition.target === source.target
        && transition.service === source.service;
}
/**
 * Persist the operator's remove -> explicit install handoff before any committed
 * manager or artifact mutation. A matching tombstone is an idempotent retry.
 */
export function ensureBootstrapManualTransition(stateDir, source, now = Date.now()) {
    assertSecureStateDirectory(stateDir);
    const existing = readBootstrapManualTransition(stateDir);
    if (existing) {
        if (!sameBootstrapManualTransitionSource(existing, source)) {
            throw new Error('bootstrap manual-transition tombstone belongs to another committed service');
        }
        return existing;
    }
    const transition = {
        schema: coreBootstrap.LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA,
        transitionId: randomUUID(),
        removedTransactionId: source.transactionId,
        target: source.target,
        service: source.service,
        createdAt: new Date(now).toISOString(),
    };
    if (!coreBootstrap.parseLifecycleBootstrapManualTransition(transition)) {
        throw new Error('bootstrap refused to persist an invalid manual-transition tombstone');
    }
    const path = bootstrapManualTransitionPath(stateDir);
    try {
        writeDurableJsonExclusive(path, transition);
    }
    catch (error) {
        if (!filesystemEntryPresent(path))
            throw error;
        const raced = readBootstrapManualTransition(stateDir);
        if (!raced || !sameBootstrapManualTransitionSource(raced, source))
            throw error;
        return raced;
    }
    const durable = readBootstrapManualTransition(stateDir);
    if (!durable || durable.transitionId !== transition.transitionId) {
        throw new Error('bootstrap manual-transition tombstone publication is unconfirmed');
    }
    return durable;
}
export function removeBootstrapManualTransition(stateDir, transitionId) {
    const transition = readBootstrapManualTransition(stateDir);
    if (!transition || transition.transitionId !== transitionId) {
        throw new Error('bootstrap refused to consume a manual-transition tombstone it does not own');
    }
    const path = bootstrapManualTransitionPath(stateDir);
    removeDurableFile(path);
    if (filesystemEntryPresent(path)) {
        throw new Error('bootstrap manual-transition tombstone retirement is unconfirmed');
    }
}
function bootstrapCanonicalQuarantinePath(stateDir, kind, transactionId) {
    if (!UUID_RE.test(transactionId))
        throw new Error('bootstrap transaction id must be a UUID');
    return join(resolve(stateDir), `.bootstrap-${kind}.${transactionId}.quarantine`);
}
function bootstrapPathKey(path, target) {
    return process.platform === 'win32' || target === 'windows' ? path.toLowerCase() : path;
}
function bootstrapArtifactNamespaceIsUnique(artifacts, target) {
    const keys = artifacts.flatMap((artifact) => [
        artifact.path,
        artifact.claimPath,
        artifact.rollbackPath,
        bootstrapArtifactStagingCleanupPath(artifact),
    ])
        .map((path) => bootstrapPathKey(path, target));
    return new Set(keys).size === keys.length;
}
function protectedBootstrapStatePathKeys(stateDir, target) {
    return new Set([
        bootstrapJournalPath(stateDir),
        bootstrapMarkerPath(stateDir),
        bootstrapReadinessPath(stateDir),
        bootstrapManualTransitionPath(stateDir),
        bootstrapRegistrationIntentPath(stateDir),
        join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE),
        join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE),
        join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE),
        join(stateDir, BOOTSTRAP_LOCK_FILE),
    ].map((path) => bootstrapPathKey(resolve(path), target)));
}
function assertBootstrapPathsDoNotOwnProtectedState(stateDir, target, paths, label) {
    const protectedPaths = protectedBootstrapStatePathKeys(stateDir, target);
    if (paths.some((path) => protectedPaths.has(bootstrapPathKey(path, target)))) {
        throw new Error(`${label} owns a protected state path`);
    }
}
function assertBootstrapCanonicalQuarantineLayout(stateDir, journal) {
    const entries = journal.canonicalQuarantine ?? [];
    if (entries.length === 0)
        return;
    const kinds = entries.map((entry) => entry.kind);
    if (new Set(kinds).size !== kinds.length) {
        throw new Error('bootstrap canonical quarantine contains duplicate state kinds');
    }
    const artifactNamespace = new Set(journal.artifacts.flatMap((artifact) => [
        artifact.path,
        artifact.claimPath,
        artifact.rollbackPath,
        bootstrapArtifactStagingCleanupPath(artifact),
    ]).map((path) => bootstrapPathKey(path, journal.target)));
    for (const entry of entries) {
        const expectedSource = resolve(entry.kind === 'marker'
            ? bootstrapMarkerPath(stateDir)
            : bootstrapReadinessPath(stateDir));
        const expectedQuarantine = bootstrapCanonicalQuarantinePath(stateDir, entry.kind, journal.transactionId);
        if (entry.sourcePath !== expectedSource || entry.quarantinePath !== expectedQuarantine) {
            throw new Error('bootstrap canonical quarantine path is outside its durable state namespace');
        }
        if (artifactNamespace.has(bootstrapPathKey(entry.sourcePath, journal.target))
            || artifactNamespace.has(bootstrapPathKey(entry.quarantinePath, journal.target))) {
            throw new Error('bootstrap artifact namespace overlaps canonical quarantine state');
        }
    }
}
export function writeBootstrapJournal(stateDir, journal) {
    if (!parseBootstrapJournal(journal)) {
        throw new Error('bootstrap refused to persist an invalid recovery journal');
    }
    assertBootstrapPathsDoNotOwnProtectedState(stateDir, journal.target, [
        ...journal.artifacts.flatMap((artifact) => [
            artifact.path,
            artifact.claimPath,
            artifact.rollbackPath,
            bootstrapArtifactStagingCleanupPath(artifact),
        ]),
        ...(journal.preservedArtifacts ?? []).map((artifact) => artifact.path),
    ], 'bootstrap recovery journal');
    assertBootstrapCanonicalQuarantineLayout(stateDir, journal);
    writeDurableJson(bootstrapJournalPath(stateDir), journal, 0o600);
}
export function removeBootstrapJournal(stateDir) {
    removeDurableFile(bootstrapJournalPath(stateDir));
}
function parseArtifact(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const claimOwnership = parseArtifactClaimOwnership(record['claimOwnership']);
    if ((record['claimOwnership'] !== undefined && claimOwnership === undefined)
        || !exactRecordKeys(record, [
            'path',
            'claimPath',
            'rollbackPath',
            'before',
            'identity',
            ...(record['claimOwnership'] === undefined ? [] : ['claimOwnership']),
        ])
        || !boundedText(record['path'], 4_096) || !isAbsolute(record['path'])
        || resolve(record['path']) !== record['path']
        || (record['before'] !== 'absent' && record['before'] !== 'legacy_owned'))
        return undefined;
    if (!boundedText(record['claimPath'], 4_096) || !isAbsolute(record['claimPath'])
        || resolve(record['claimPath']) !== record['claimPath'])
        return undefined;
    if (!boundedText(record['rollbackPath'], 4_096) || !isAbsolute(record['rollbackPath'])
        || resolve(record['rollbackPath']) !== record['rollbackPath'])
        return undefined;
    const identity = record['identity'];
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
        return undefined;
    const identityRecord = identity;
    const identityKeys = identityRecord['device'] === undefined
        ? ['size', 'sha256']
        : ['size', 'sha256', 'device', 'inode'];
    if (!exactRecordKeys(identityRecord, identityKeys)
        || !validArtifactIdentity(identityRecord, true)
        || (record['before'] === 'legacy_owned'
            && (typeof identityRecord['device'] !== 'string'
                || typeof identityRecord['inode'] !== 'string')))
        return undefined;
    return {
        path: record['path'],
        claimPath: record['claimPath'],
        rollbackPath: record['rollbackPath'],
        before: record['before'],
        identity: {
            size: identityRecord['size'],
            sha256: identityRecord['sha256'],
            ...(typeof identityRecord['device'] === 'string' ? { device: identityRecord['device'] } : {}),
            ...(typeof identityRecord['inode'] === 'string' ? { inode: identityRecord['inode'] } : {}),
        },
        ...(claimOwnership ? { claimOwnership } : {}),
    };
}
function parseArtifactClaimOwnership(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record['phase'] === 'armed') {
        return exactRecordKeys(record, ['phase']) ? { phase: 'armed' } : undefined;
    }
    if (record['phase'] !== 'created'
        || !exactRecordKeys(record, ['phase', 'device', 'inode'])
        || typeof record['device'] !== 'string'
        || typeof record['inode'] !== 'string'
        || !/^[0-9]+$/.test(record['device'])
        || !/^[0-9]+$/.test(record['inode'])
        || BigInt(record['device']) <= 0n
        || BigInt(record['inode']) <= 0n) {
        return undefined;
    }
    return { phase: 'created', device: record['device'], inode: record['inode'] };
}
function exactRecordKeys(record, expected) {
    const actual = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index]);
}
function parsePreservedArtifact(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactRecordKeys(record, ['path', 'size', 'sha256', 'device', 'inode'])
        || !boundedText(record['path'], 4_096) || !isAbsolute(record['path'])
        || resolve(record['path']) !== record['path']
        || !validArtifactIdentity(record, true)
        || typeof record['device'] !== 'string'
        || typeof record['inode'] !== 'string')
        return undefined;
    return {
        path: record['path'],
        size: record['size'],
        sha256: record['sha256'],
        device: record['device'],
        inode: record['inode'],
    };
}
function parseCanonicalQuarantine(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if ((record['kind'] !== 'marker' && record['kind'] !== 'readiness')
        || !boundedText(record['sourcePath'], 4_096) || !isAbsolute(record['sourcePath'])
        || resolve(record['sourcePath']) !== record['sourcePath']
        || !boundedText(record['quarantinePath'], 4_096) || !isAbsolute(record['quarantinePath'])
        || resolve(record['quarantinePath']) !== record['quarantinePath'])
        return undefined;
    const identity = record['identity'];
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
        return undefined;
    const identityRecord = identity;
    if (!validArtifactIdentity(identityRecord, true)
        || typeof identityRecord['device'] !== 'string'
        || typeof identityRecord['inode'] !== 'string')
        return undefined;
    return {
        kind: record['kind'],
        sourcePath: record['sourcePath'],
        quarantinePath: record['quarantinePath'],
        identity: {
            size: identityRecord['size'],
            sha256: identityRecord['sha256'],
            device: identityRecord['device'],
            inode: identityRecord['inode'],
        },
    };
}
function validArtifactIdentity(value, allowFileId) {
    const record = value;
    if (!Number.isSafeInteger(record['size']) || record['size'] < 0)
        return false;
    if (typeof record['sha256'] !== 'string' || !SHA256_RE.test(record['sha256']))
        return false;
    if (!allowFileId && (record['device'] !== undefined || record['inode'] !== undefined))
        return false;
    if ((record['device'] === undefined) !== (record['inode'] === undefined))
        return false;
    if (record['device'] !== undefined && (!/^[0-9]+$/.test(String(record['device']))
        || !/^[0-9]+$/.test(String(record['inode']))
        || BigInt(String(record['device'])) <= 0n
        || BigInt(String(record['inode'])) <= 0n))
        return false;
    return true;
}
function parseProcessStartIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record['source'] === 'linux-proc'
        && typeof record['bootId'] === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record['bootId'])
        && typeof record['startTicks'] === 'string' && /^[1-9]\d*$/.test(record['startTicks'])) {
        return { source: 'linux-proc', bootId: record['bootId'], startTicks: record['startTicks'] };
    }
    if (record['source'] === 'windows-powershell'
        && typeof record['startTimeTicks'] === 'string' && /^[1-9]\d*$/.test(record['startTimeTicks'])) {
        return { source: 'windows-powershell', startTimeTicks: record['startTimeTicks'] };
    }
    if (record['source'] === 'darwin-ps'
        && boundedText(record['startTime'], 128)) {
        return { source: 'darwin-ps', startTime: record['startTime'] };
    }
    return undefined;
}
export function parseBootstrapJournal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const owner = record['owner'];
    const managerBinding = record['managerBinding'];
    const legacyRemoval = record['operation'] === LEGACY_BOOTSTRAP_REMOVAL_OPERATION;
    if (record['operation'] !== undefined && !legacyRemoval)
        return undefined;
    if (record['schema'] !== BOOTSTRAP_JOURNAL_SCHEMA
        || typeof record['transactionId'] !== 'string' || !UUID_RE.test(record['transactionId'])
        || !owner || typeof owner !== 'object' || Array.isArray(owner)
        || typeof record['target'] !== 'string' || !TARGETS.has(record['target'])
        || !boundedText(record['service'], 128)
        || (!legacyRemoval && record['managerBefore'] !== 'absent')
        || (legacyRemoval && !['absent', 'present', 'disabled'].includes(record['managerBefore']))
        || !managerBinding || typeof managerBinding !== 'object' || Array.isArray(managerBinding)
        || typeof record['stage'] !== 'string' || !JOURNAL_STAGES.has(record['stage'])
        || !Number.isSafeInteger(record['deadlineMs']) || record['deadlineMs'] <= 0
        || !Array.isArray(record['artifacts']) || record['artifacts'].length === 0 || record['artifacts'].length > 32
        || typeof record['updatedAt'] !== 'string' || Number.isNaN(Date.parse(record['updatedAt'])))
        return undefined;
    const ownerRecord = owner;
    const managerBindingRecord = managerBinding;
    const processStartIdentity = parseProcessStartIdentity(ownerRecord['processStartIdentity']);
    if (!Number.isSafeInteger(ownerRecord['pid']) || ownerRecord['pid'] <= 0
        || typeof ownerRecord['token'] !== 'string' || !UUID_RE.test(ownerRecord['token'])
        || !processStartIdentity
        || typeof ownerRecord['acquiredAt'] !== 'string' || Number.isNaN(Date.parse(ownerRecord['acquiredAt'])))
        return undefined;
    const absentManagerBinding = managerBindingRecord['kind'] === LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING;
    if (absentManagerBinding) {
        if (!legacyRemoval || record['managerBefore'] !== 'absent'
            || !exactRecordKeys(managerBindingRecord, ['kind', 'state'])
            || managerBindingRecord['state'] !== 'absent')
            return undefined;
    }
    else {
        if (!boundedText(managerBindingRecord['artifactPath'], 4_096)
            || !isAbsolute(managerBindingRecord['artifactPath'])
            || resolve(managerBindingRecord['artifactPath']) !== managerBindingRecord['artifactPath'])
            return undefined;
        if (managerBindingRecord['kind'] !== undefined
            && managerBindingRecord['kind'] !== 'transaction'
            && managerBindingRecord['kind'] !== coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING)
            return undefined;
    }
    const artifacts = record['artifacts'].map(parseArtifact);
    if (artifacts.some((artifact) => artifact === undefined))
        return undefined;
    if (legacyRemoval !== artifacts.every((artifact) => artifact.before === 'legacy_owned'))
        return undefined;
    if (artifacts.some((artifact) => artifact.claimOwnership !== undefined)
        && (legacyRemoval
            || (record['stage'] !== 'installing' && record['stage'] !== 'rollback_pending'))) {
        return undefined;
    }
    const preservedValue = record['preservedArtifacts'];
    if (preservedValue !== undefined
        && (!(legacyRemoval
            || managerBindingRecord['kind'] === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING)
            || !Array.isArray(preservedValue)
            || preservedValue.length === 0 || preservedValue.length > 32))
        return undefined;
    const preservedArtifacts = Array.isArray(preservedValue)
        ? preservedValue.map(parsePreservedArtifact)
        : [];
    if (preservedArtifacts.some((artifact) => artifact === undefined))
        return undefined;
    const successMarkerIdentity = record['successMarkerIdentity'];
    if (successMarkerIdentity !== undefined
        && (!successMarkerIdentity || typeof successMarkerIdentity !== 'object'
            || Array.isArray(successMarkerIdentity)
            || !exactRecordKeys(successMarkerIdentity, ['size', 'sha256'])
            || !validArtifactIdentity(successMarkerIdentity, false)))
        return undefined;
    if (!legacyRemoval
        && managerBindingRecord['kind'] === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING
        && successMarkerIdentity === undefined)
        return undefined;
    const quarantineValue = record['canonicalQuarantine'];
    if (quarantineValue !== undefined
        && (!Array.isArray(quarantineValue) || quarantineValue.length === 0 || quarantineValue.length > 2))
        return undefined;
    const canonicalQuarantine = Array.isArray(quarantineValue)
        ? quarantineValue.map(parseCanonicalQuarantine)
        : [];
    if (canonicalQuarantine.some((entry) => entry === undefined))
        return undefined;
    const quarantineKinds = canonicalQuarantine.map((entry) => entry.kind);
    if (new Set(quarantineKinds).size !== quarantineKinds.length)
        return undefined;
    if (record['managerDetached'] !== undefined && typeof record['managerDetached'] !== 'boolean')
        return undefined;
    if (record['artifactsRestored'] !== undefined && typeof record['artifactsRestored'] !== 'boolean')
        return undefined;
    if (record['activationStarted'] !== undefined && typeof record['activationStarted'] !== 'boolean')
        return undefined;
    if (record['terminalAction'] !== undefined && record['terminalAction'] !== 'remove_committed')
        return undefined;
    if (record['terminalAction'] === 'remove_committed'
        && record['stage'] !== 'rollback_pending' && record['stage'] !== 'rolled_back'
        && !(legacyRemoval && record['stage'] === 'prepared'))
        return undefined;
    if (legacyRemoval && record['terminalAction'] !== 'remove_committed')
        return undefined;
    if (legacyRemoval && !['prepared', 'rollback_pending', 'rolled_back'].includes(record['stage'])) {
        return undefined;
    }
    if (record['lastError'] !== undefined && !boundedText(record['lastError'], 512))
        return undefined;
    const paths = artifacts.map((artifact) => artifact.path);
    const pathKeys = paths.map((path) => bootstrapPathKey(path, record['target']));
    if (new Set(pathKeys).size !== pathKeys.length)
        return undefined;
    if (!bootstrapArtifactNamespaceIsUnique(artifacts, record['target']))
        return undefined;
    if (artifacts.some((artifact) => (bootstrapArtifactStagingCleanupPath(artifact).length > 4_096)))
        return undefined;
    if (artifacts.some((artifact) => artifact.claimPath !== bootstrapArtifactClaimPath(artifact.path, record['transactionId'])
        || artifact.rollbackPath !== bootstrapArtifactRollbackPath(artifact.path, record['transactionId'])))
        return undefined;
    const artifactNamespaceKeys = artifacts.flatMap((artifact) => [
        artifact.path,
        artifact.claimPath,
        artifact.rollbackPath,
        bootstrapArtifactStagingCleanupPath(artifact),
    ]).map((path) => bootstrapPathKey(path, record['target']));
    const preservedKeys = preservedArtifacts.map((artifact) => bootstrapPathKey(artifact.path, record['target']));
    if (new Set([...artifactNamespaceKeys, ...preservedKeys]).size
        !== artifactNamespaceKeys.length + preservedKeys.length)
        return undefined;
    if (!absentManagerBinding) {
        const managerKey = bootstrapPathKey(managerBindingRecord['artifactPath'], record['target']);
        if (!pathKeys.includes(managerKey))
            return undefined;
    }
    return record;
}
export function readBootstrapJournal(stateDir) {
    const path = bootstrapJournalPath(stateDir);
    try {
        assertSecureStateDirectory(stateDir);
        const parsed = parseBootstrapJournal(JSON.parse(readBoundedRegularText(path, MAX_JOURNAL_BYTES, 'bootstrap recovery journal', { requireOwnerOnly: true })));
        if (!parsed)
            throw new Error(`bootstrap recovery journal is corrupt: ${path}`);
        assertBootstrapPathsDoNotOwnProtectedState(stateDir, parsed.target, [
            ...parsed.artifacts.flatMap((artifact) => [
                artifact.path,
                artifact.claimPath,
                artifact.rollbackPath,
                bootstrapArtifactStagingCleanupPath(artifact),
            ]),
            ...(parsed.preservedArtifacts ?? []).map((artifact) => artifact.path),
        ], 'bootstrap recovery journal');
        assertBootstrapCanonicalQuarantineLayout(stateDir, parsed);
        return parsed;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        if (error instanceof Error && error.message.startsWith('bootstrap recovery journal is corrupt:'))
            throw error;
        throw new Error(`bootstrap recovery journal is corrupt: ${path}`, { cause: error });
    }
}
export function readBootstrapMarker(stateDir) {
    try {
        assertSecureStateDirectory(stateDir);
        const marker = coreBootstrap.parseLifecycleBootstrapMarkerJson(readBoundedRegularText(bootstrapMarkerPath(stateDir), MAX_MARKER_BYTES, 'bootstrap success marker', { requireOwnerOnly: true }));
        if (!marker)
            throw new Error(`bootstrap success marker is corrupt: ${bootstrapMarkerPath(stateDir)}`);
        assertBootstrapPathsDoNotOwnProtectedState(stateDir, marker.target, [
            marker.managerArtifactPath,
            ...marker.artifacts.map((artifact) => artifact.path),
            ...(marker.preservedArtifacts ?? []).map((artifact) => artifact.path),
        ], 'bootstrap success marker');
        return marker;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
export function readLegacyBootstrapMarker(stateDir) {
    const path = bootstrapMarkerPath(stateDir);
    try {
        assertSecureStateDirectory(stateDir);
        const raw = readBoundedRegularText(path, MAX_MARKER_BYTES, 'legacy bootstrap success marker', { requireOwnerOnly: true });
        const marker = coreBootstrap.parseLegacyLifecycleBootstrapMarkerJson(raw);
        if (!marker)
            throw new Error(`legacy bootstrap success marker is corrupt: ${path}`);
        assertBootstrapPathsDoNotOwnProtectedState(stateDir, marker.target, marker.files, 'legacy bootstrap success marker');
        const identity = identityFor(path);
        const rawIdentity = bootstrapArtifactIdentityForBytes(Buffer.from(raw, 'utf8'));
        if (identity.size !== rawIdentity.size || identity.sha256 !== rawIdentity.sha256
            || identity.device === undefined || identity.inode === undefined) {
            throw new Error(`legacy bootstrap success marker changed while reading: ${path}`);
        }
        return {
            marker,
            raw,
            identity: identity,
        };
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function sameLegacyBootstrapMarkerRead(left, right) {
    return left.raw === right.raw
        && left.identity.size === right.identity.size
        && left.identity.sha256 === right.identity.sha256
        && left.identity.device === right.identity.device
        && left.identity.inode === right.identity.inode;
}
function sameLegacyMarkerReceipt(legacy, adopted) {
    const ownedPaths = adopted.artifacts.map((artifact) => artifact.path);
    const preservedPaths = (adopted.preservedArtifacts ?? []).map((artifact) => artifact.path);
    const historicalOwnedPaths = ownedPaths.filter((path) => legacy.files.includes(path));
    const derivedOwnedPaths = ownedPaths.filter((path) => !legacy.files.includes(path));
    const historicalPreservedPaths = preservedPaths.filter((path) => legacy.files.includes(path));
    const derivedPreservedPaths = preservedPaths.filter((path) => !legacy.files.includes(path));
    const stateRootProofPath = adopted.legacyStateRootProof?.envFilePath;
    const allowedWindowsDerived = derivedOwnedPaths.every((path) => ['evolver-proxy-task-launcher.vbs', 'evolver-recovery-controller.exe']
        .includes(win32.basename(path).toLowerCase()));
    const legacyPartition = [...historicalOwnedPaths, ...historicalPreservedPaths];
    const expectedHistoricalOwned = legacy.files.filter((path) => !historicalPreservedPaths.includes(path));
    const expectedPreserved = legacy.files.filter((path) => historicalPreservedPaths.includes(path));
    const historicalAutoexec = legacy.files.filter((path) => {
        const name = (legacy.target === 'windows' ? win32 : posix).basename(path).toLowerCase();
        return legacy.target === 'systemd'
            ? name === 'evolver-autoexec.service'
            : legacy.target === 'launchd'
                ? name === 'com.evomap.evolver-autoexec.plist'
                : /^install-evolver-autoexec-windows(?:-[0-9a-f-]+)?\.ps1$/i.test(name);
    });
    return adopted.managerBindingKind === coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING
        && legacy.bootstrappedAt === adopted.bootstrappedAt
        && legacy.target === adopted.target
        && legacy.service === adopted.service
        && adopted.files.length === ownedPaths.length + preservedPaths.length
        && adopted.files.every((path, index) => path === [...ownedPaths, ...preservedPaths][index])
        && legacy.files.length === legacyPartition.length
        && legacy.files.every((path) => legacyPartition.includes(path))
        && expectedHistoricalOwned.every((path, index) => path === historicalOwnedPaths[index])
        && expectedPreserved.every((path, index) => path === historicalPreservedPaths[index])
        && historicalAutoexec.length === historicalPreservedPaths.length
        && historicalAutoexec.every((path, index) => path === historicalPreservedPaths[index])
        && new Set(legacyPartition).size === legacyPartition.length
        && (stateRootProofPath === undefined
            ? derivedPreservedPaths.length === 0
            : derivedPreservedPaths.length === 1
                && derivedPreservedPaths[0] === stateRootProofPath
                && preservedPaths[preservedPaths.length - 1] === stateRootProofPath)
        && (derivedOwnedPaths.length === 0
            || (legacy.target === 'windows' && derivedOwnedPaths.length <= 2 && allowedWindowsDerived));
}
/** Adopt an exact legacy marker through the durable canonical-state transaction. */
export async function adoptLegacyBootstrapMarker(stateDir, expectedLegacy, marker, initialJournal, now = Date.now, hooks = {}) {
    if (marker.managerBindingKind !== coreBootstrap.LIFECYCLE_BOOTSTRAP_LEGACY_BINDING) {
        throw new Error('legacy bootstrap adoption requires an explicit legacy manager binding');
    }
    if (!coreBootstrap.parseLifecycleBootstrapMarker(marker)) {
        throw new Error('legacy bootstrap adoption marker is invalid');
    }
    if (!sameLegacyMarkerReceipt(expectedLegacy.marker, marker)) {
        throw new Error('legacy bootstrap adoption marker does not bind the legacy receipt');
    }
    if (initialJournal.managerBinding.kind === LEGACY_BOOTSTRAP_ABSENT_MANAGER_BINDING) {
        throw new Error('legacy bootstrap adoption requires a present manager binding');
    }
    if (initialJournal.stage !== 'prepared'
        || initialJournal.activationStarted === true
        || initialJournal.artifactsRestored !== true
        || (initialJournal.managerBinding.kind ?? 'transaction') !== marker.managerBindingKind
        || !initialJournal.successMarkerIdentity
        || initialJournal.successMarkerIdentity.size !== Buffer.byteLength(`${JSON.stringify(marker)}\n`, 'utf8')
        || initialJournal.successMarkerIdentity.sha256 !== bootstrapArtifactIdentityForBytes(Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8')).sha256
        || initialJournal.transactionId !== marker.transactionId
        || initialJournal.target !== marker.target
        || initialJournal.service !== marker.service
        || initialJournal.managerBinding.artifactPath !== resolve(marker.managerArtifactPath)
        || initialJournal.artifacts.length !== marker.artifacts.length
        || initialJournal.artifacts.some((artifact, index) => {
            const receipt = marker.artifacts[index];
            return !receipt || !artifact.identity
                || artifact.path !== resolve(receipt.path)
                || artifact.identity.size !== receipt.size
                || artifact.identity.sha256 !== receipt.sha256
                || artifact.identity.device !== receipt.device
                || artifact.identity.inode !== receipt.inode;
        })) {
        throw new Error('legacy bootstrap adoption journal does not bind the adopted receipt');
    }
    const current = readLegacyBootstrapMarker(stateDir);
    if (!current || !sameLegacyBootstrapMarkerRead(current, expectedLegacy)) {
        throw new Error('legacy bootstrap success marker changed before adoption');
    }
    let journal = planBootstrapCanonicalQuarantine(stateDir, initialJournal, ['marker']);
    const quarantine = journal.canonicalQuarantine?.[0];
    if (!quarantine
        || quarantine.kind !== 'marker'
        || quarantine.identity.size !== expectedLegacy.identity.size
        || quarantine.identity.sha256 !== expectedLegacy.identity.sha256
        || quarantine.identity.device !== expectedLegacy.identity.device
        || quarantine.identity.inode !== expectedLegacy.identity.inode) {
        throw new Error('legacy bootstrap adoption quarantine does not bind the exact legacy marker');
    }
    assertBootstrapTransactionClaimsAbsent(journal);
    hooks.assertOwner?.();
    writeBootstrapJournal(stateDir, journal);
    hooks.beforeQuarantine?.(journal);
    hooks.assertOwner?.();
    applyBootstrapCanonicalQuarantine(stateDir, journal, () => hooks.assertOwner?.());
    hooks.afterQuarantine?.();
    journal = updateBootstrapJournal(journal, { stage: 'committing' }, now());
    hooks.assertOwner?.();
    writeBootstrapJournal(stateDir, journal);
    await hooks.beforePublish?.(journal);
    hooks.assertOwner?.();
    writeDurableJsonExclusive(bootstrapMarkerPath(stateDir), marker, 0o600);
    hooks.afterPublish?.();
    const adopted = readBootstrapMarker(stateDir);
    if (!adopted || JSON.stringify(adopted) !== JSON.stringify(marker)) {
        throw new Error('legacy bootstrap adoption marker publication is ambiguous');
    }
    journal = updateBootstrapJournal(journal, { stage: 'committed' }, now());
    hooks.assertOwner?.();
    writeBootstrapJournal(stateDir, journal);
    hooks.beforeFinalize?.();
    hooks.assertOwner?.();
    finalizeBootstrapCanonicalQuarantine(stateDir, journal, {
        beforeMove: () => hooks.assertOwner?.(),
        afterMove: () => hooks.assertOwner?.(),
        beforeDelete: () => hooks.assertOwner?.(),
    });
    hooks.assertOwner?.();
    removeBootstrapJournal(stateDir);
}
export function readBootstrapReadiness(stateDir) {
    const path = bootstrapReadinessPath(stateDir);
    try {
        assertSecureStateDirectory(stateDir);
        const readiness = coreBootstrap.parseLifecycleBootstrapReadinessJson(readBoundedRegularText(path, MAX_READINESS_BYTES, 'bootstrap readiness receipt', { requireOwnerOnly: true }));
        if (!readiness)
            throw new Error(`bootstrap readiness receipt is corrupt: ${path}`);
        return readiness;
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
export function removeBootstrapReadiness(stateDir, transactionId, beforeMutation = () => { }) {
    beforeMutation();
    const lock = acquireBootstrapReadinessLock(stateDir);
    let operationError;
    try {
        const readiness = readBootstrapReadiness(stateDir);
        if (readiness) {
            if (readiness.transactionId !== transactionId) {
                throw new Error('bootstrap refused to remove readiness owned by another transaction');
            }
            beforeMutation();
            removeDurableFile(bootstrapReadinessPath(stateDir));
        }
    }
    catch (error) {
        operationError = error;
    }
    beforeMutation();
    releaseBootstrapLockAfterOperation(lock, operationError, 'readiness');
    if (operationError !== undefined)
        throw operationError;
}
function releaseBootstrapLockAfterOperation(lock, operationError, label) {
    try {
        lock.release();
    }
    catch (releaseError) {
        throw new Error(`bootstrap ${label} lock release failed`, {
            cause: operationError === undefined ? releaseError : new AggregateError([operationError, releaseError]),
        });
    }
}
export function assertTrustedArtifactParent(path, platform, uid) {
    const parent = dirname(resolve(path));
    if (platform !== 'win32') {
        assertTrustedPosixDirectoryChain(parent, platform, uid, 'bootstrap artifact parent');
        return;
    }
    let current = parent;
    const root = parse(current).root;
    const windowsChecks = [];
    for (;;) {
        try {
            const stat = lstatSync(current);
            if (platform === 'win32') {
                windowsChecks.push({ path: current, parentOnly: windowsChecks.length > 0 });
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(`bootstrap artifact parent is not a trusted directory: ${current}`);
            }
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
        if (current === root)
            break;
        current = dirname(current);
    }
    assertWindowsAclChecksTrusted(windowsChecks);
}
export function assertPlannedArtifactsAbsent(paths, platform, uid) {
    const normalized = paths.map((path) => resolve(path));
    const keys = normalized.map((path) => platform === 'win32' ? path.toLowerCase() : path);
    if (paths.some((path, index) => !isAbsolute(path) || path !== normalized[index])
        || new Set(keys).size !== keys.length) {
        throw new Error('bootstrap artifact inventory must contain unique canonical absolute paths');
    }
    for (const path of normalized) {
        assertTrustedArtifactParent(path, platform, uid);
        try {
            lstatSync(path);
            throw new Error(`bootstrap refuses to overwrite pre-existing artifact: ${path}`);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT'))
                throw error;
        }
    }
}
export function assertBootstrapTransactionClaimsAbsent(journal) {
    for (const artifact of journal.artifacts) {
        for (const path of [
            artifact.claimPath,
            artifact.rollbackPath,
            bootstrapArtifactStagingCleanupPath(artifact),
        ]) {
            try {
                lstatSync(path);
                throw new Error(`bootstrap transaction path already exists: ${path}`);
            }
            catch (error) {
                if (!isErrno(error, 'ENOENT'))
                    throw error;
            }
        }
    }
    for (const entry of journal.canonicalQuarantine ?? []) {
        for (const path of [entry.quarantinePath, bootstrapCanonicalFinalizePath(entry)]) {
            try {
                lstatSync(path);
                throw new Error(`bootstrap transaction path already exists: ${path}`);
            }
            catch (error) {
                if (!isErrno(error, 'ENOENT'))
                    throw error;
            }
        }
    }
}
function assertTrustedBootstrapArtifactLeaf(stat, platform, uid, path, role) {
    if (role === 'transaction')
        return;
    const ownerTrusted = role === 'owned'
        ? uid !== undefined && stat.uid === uid
        : uid !== undefined && (stat.uid === uid || stat.uid === 0n);
    if ((role === 'owned' && stat.nlink !== 1n)
        || (platform !== 'win32'
            && (!ownerTrusted || (stat.mode & 18n) !== 0n))) {
        throw new Error(`bootstrap artifact leaf is not exclusively owner-controlled: ${path}`);
    }
}
export const _assertTrustedBootstrapArtifactLeafForTest = assertTrustedBootstrapArtifactLeaf;
export function readBootstrapArtifactFile(path, maxBytes = MAX_ARTIFACT_BYTES, hooks = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
        throw new Error('bootstrap artifact read limit is invalid');
    }
    const trustedUid = process.platform === 'win32' || typeof process.getuid !== 'function'
        ? undefined
        : BigInt(process.getuid());
    const role = hooks.role ?? 'transaction';
    const assertTrustedLeaf = (stat) => assertTrustedBootstrapArtifactLeaf(stat, process.platform, trustedUid, path, role);
    if (process.platform === 'win32')
        assertWindowsAclTrusted(path, role === 'owned');
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)
        || before.dev <= 0n || before.ino <= 0n) {
        throw new Error(`bootstrap artifact is not a regular owned file: ${path}`);
    }
    assertTrustedLeaf(before);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
            || opened.dev <= 0n || opened.ino <= 0n || opened.size > BigInt(maxBytes)) {
            throw new Error(`bootstrap artifact changed while opening: ${path}`);
        }
        assertTrustedLeaf(opened);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const chunks = [];
        let size = 0;
        for (;;) {
            const count = readSync(descriptor, buffer, 0, buffer.length, null);
            if (count === 0)
                break;
            size += count;
            if (size > maxBytes) {
                throw new Error(`bootstrap artifact exceeds the hashing limit: ${path}`);
            }
            const chunk = Buffer.from(buffer.subarray(0, count));
            chunks.push(chunk);
            hash.update(chunk);
        }
        const after = fstatSync(descriptor, { bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || BigInt(size) !== opened.size) {
            throw new Error(`bootstrap artifact changed while hashing: ${path}`);
        }
        assertTrustedLeaf(after);
        hooks.afterRead?.();
        if (process.platform === 'win32')
            assertWindowsAclTrusted(path, role === 'owned');
        const settled = lstatSync(path, { bigint: true });
        if (!settled.isFile() || settled.isSymbolicLink()
            || settled.dev !== opened.dev || settled.ino !== opened.ino
            || settled.size !== opened.size || settled.mtimeNs !== opened.mtimeNs
            || settled.ctimeNs !== opened.ctimeNs) {
            throw new Error(`bootstrap artifact changed after reading: ${path}`);
        }
        assertTrustedLeaf(settled);
        return {
            bytes: Buffer.concat(chunks, size),
            identity: {
                size,
                sha256: hash.digest('hex'),
                device: String(opened.dev),
                inode: String(opened.ino),
            },
        };
    }
    finally {
        closeSync(descriptor);
    }
}
function identityFor(path) {
    return readBootstrapArtifactFile(path).identity;
}
export function bootstrapArtifactIdentityForBytes(bytes) {
    return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function bootstrapArtifactContentIdentityForFile(path) {
    const identity = identityFor(path);
    return { size: identity.size, sha256: identity.sha256 };
}
export function bootstrapArtifactIdentityForFile(path) {
    const identity = identityFor(path);
    if (identity.device === undefined || identity.inode === undefined) {
        throw new Error(`bootstrap artifact file identity is unavailable: ${path}`);
    }
    return identity;
}
function sameFileId(left, right) {
    return left.device !== undefined && left.inode !== undefined
        && left.device === right.device && left.inode === right.inode;
}
function assertExpectedArtifactIdentity(expected, actual, path) {
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
        throw new Error(`bootstrap artifact content does not match its durable plan: ${path}`);
    }
    if (expected.device !== undefined && !sameFileId(expected, actual)) {
        throw new Error(`bootstrap artifact file identity changed: ${path}`);
    }
}
function assertCanonicalQuarantineIdentity(path, expected) {
    const actual = identityFor(path);
    assertExpectedArtifactIdentity(expected, actual, path);
    if (!sameFileId(expected, actual)) {
        throw new Error(`bootstrap canonical quarantine file identity changed: ${path}`);
    }
}
function bootstrapCanonicalFinalizePath(entry) {
    return `${entry.quarantinePath}.finalizing`;
}
function preserveMovedCanonicalState(entry, movedPath, cause) {
    const movedIdentity = identityFor(movedPath);
    if (!filesystemEntryPresent(entry.sourcePath)) {
        try {
            linkSync(movedPath, entry.sourcePath);
            syncDirectory(dirname(entry.sourcePath));
        }
        catch (error) {
            if (!isErrno(error, 'EEXIST'))
                throw error;
        }
    }
    if (filesystemEntryPresent(entry.sourcePath)) {
        const restoredIdentity = identityFor(entry.sourcePath);
        if (sameFileId(restoredIdentity, movedIdentity)) {
            throw new Error(`bootstrap canonical state changed during quarantine and was restored without deleting its preserved inode: ${entry.sourcePath}`, { cause });
        }
    }
    throw new Error(`bootstrap canonical state changed during quarantine; both canonical and preserved paths remain for recovery: ${entry.sourcePath}`, { cause });
}
function withBootstrapCanonicalStateLock(stateDir, kind, operation) {
    if (kind === 'marker')
        return operation();
    const lock = acquireBootstrapReadinessLock(stateDir);
    let result;
    let operationError;
    try {
        result = operation();
    }
    catch (error) {
        operationError = error;
    }
    releaseBootstrapLockAfterOperation(lock, operationError, 'readiness');
    if (operationError !== undefined)
        throw operationError;
    return result;
}
export function planBootstrapCanonicalQuarantine(stateDir, journal, kinds) {
    if (journal.stage !== 'prepared') {
        throw new Error('bootstrap canonical quarantine must be planned before installation');
    }
    if (journal.canonicalQuarantine !== undefined) {
        throw new Error('bootstrap canonical quarantine was already planned');
    }
    if (new Set(kinds).size !== kinds.length || kinds.length > 2) {
        throw new Error('bootstrap canonical quarantine kinds must be unique');
    }
    if (kinds.length === 0)
        return journal;
    const canonicalQuarantine = kinds.map((kind) => {
        const sourcePath = resolve(kind === 'marker'
            ? bootstrapMarkerPath(stateDir)
            : bootstrapReadinessPath(stateDir));
        const quarantinePath = bootstrapCanonicalQuarantinePath(stateDir, kind, journal.transactionId);
        if (filesystemEntryPresent(quarantinePath)) {
            throw new Error(`bootstrap transaction path already exists: ${quarantinePath}`);
        }
        const identity = withBootstrapCanonicalStateLock(stateDir, kind, () => identityFor(sourcePath));
        if (!identity.device || !identity.inode) {
            throw new Error(`bootstrap canonical state has no durable file identity: ${sourcePath}`);
        }
        return {
            kind,
            sourcePath,
            quarantinePath,
            identity: { ...identity, device: identity.device, inode: identity.inode },
        };
    });
    const planned = { ...journal, canonicalQuarantine };
    assertBootstrapCanonicalQuarantineLayout(stateDir, planned);
    return planned;
}
export function applyBootstrapCanonicalQuarantine(stateDir, journal, beforeMutation = () => { }) {
    if (journal.stage !== 'prepared') {
        throw new Error('bootstrap canonical quarantine must be applied before installation');
    }
    assertBootstrapCanonicalQuarantineLayout(stateDir, journal);
    for (const entry of journal.canonicalQuarantine ?? []) {
        withBootstrapCanonicalStateLock(stateDir, entry.kind, () => {
            const sourcePresent = filesystemEntryPresent(entry.sourcePath);
            const quarantinePresent = filesystemEntryPresent(entry.quarantinePath);
            const finalizePresent = filesystemEntryPresent(bootstrapCanonicalFinalizePath(entry));
            if (finalizePresent) {
                throw new Error(`bootstrap canonical quarantine has an unfinished finalize path: ${entry.sourcePath}`);
            }
            if (sourcePresent && quarantinePresent) {
                throw new Error(`bootstrap canonical quarantine has both source and destination: ${entry.sourcePath}`);
            }
            if (quarantinePresent) {
                assertCanonicalQuarantineIdentity(entry.quarantinePath, entry.identity);
                return;
            }
            if (!sourcePresent) {
                throw new Error(`bootstrap canonical state disappeared before quarantine: ${entry.sourcePath}`);
            }
            assertCanonicalQuarantineIdentity(entry.sourcePath, entry.identity);
            beforeMutation();
            renameSync(entry.sourcePath, entry.quarantinePath);
            syncDirectory(dirname(entry.sourcePath));
            try {
                assertCanonicalQuarantineIdentity(entry.quarantinePath, entry.identity);
            }
            catch (error) {
                preserveMovedCanonicalState(entry, entry.quarantinePath, error);
            }
        });
    }
}
export function restoreBootstrapCanonicalQuarantine(stateDir, journal, hooks = {}) {
    assertBootstrapCanonicalQuarantineLayout(stateDir, journal);
    for (const entry of [...(journal.canonicalQuarantine ?? [])].reverse()) {
        withBootstrapCanonicalStateLock(stateDir, entry.kind, () => {
            const sourcePresent = filesystemEntryPresent(entry.sourcePath);
            const quarantinePresent = filesystemEntryPresent(entry.quarantinePath);
            const finalizePath = bootstrapCanonicalFinalizePath(entry);
            const finalizePresent = filesystemEntryPresent(finalizePath);
            if (quarantinePresent && finalizePresent) {
                throw new Error(`bootstrap canonical quarantine has two recovery paths: ${entry.sourcePath}`);
            }
            const recoveryPath = quarantinePresent ? entry.quarantinePath : finalizePresent ? finalizePath : undefined;
            if (sourcePresent && recoveryPath) {
                throw new Error(`bootstrap canonical quarantine cannot overwrite current state: ${entry.sourcePath}`);
            }
            if (!recoveryPath) {
                if (!sourcePresent) {
                    throw new Error(`bootstrap canonical state and quarantine are both missing: ${entry.sourcePath}`);
                }
                assertCanonicalQuarantineIdentity(entry.sourcePath, entry.identity);
                return;
            }
            assertCanonicalQuarantineIdentity(recoveryPath, entry.identity);
            hooks.beforeMove?.(entry);
            renameSync(recoveryPath, entry.sourcePath);
            syncDirectory(dirname(entry.sourcePath));
            hooks.afterMove?.(entry);
            try {
                assertCanonicalQuarantineIdentity(entry.sourcePath, entry.identity);
            }
            catch (error) {
                if (!filesystemEntryPresent(recoveryPath)) {
                    try {
                        linkSync(entry.sourcePath, recoveryPath);
                        syncDirectory(dirname(recoveryPath));
                    }
                    catch (linkError) {
                        if (!isErrno(linkError, 'EEXIST'))
                            throw linkError;
                    }
                }
                throw new Error(`bootstrap canonical restore preserved an unexpected inode at both recovery paths: ${entry.sourcePath}`, { cause: error });
            }
        });
    }
}
export function finalizeBootstrapCanonicalQuarantine(stateDir, journal, hooks = {}) {
    assertBootstrapCanonicalQuarantineLayout(stateDir, journal);
    for (const entry of journal.canonicalQuarantine ?? []) {
        withBootstrapCanonicalStateLock(stateDir, entry.kind, () => {
            const finalizePath = bootstrapCanonicalFinalizePath(entry);
            const quarantinePresent = filesystemEntryPresent(entry.quarantinePath);
            const finalizePresent = filesystemEntryPresent(finalizePath);
            if (quarantinePresent && finalizePresent) {
                throw new Error(`bootstrap canonical quarantine has two finalize paths: ${entry.sourcePath}`);
            }
            if (!quarantinePresent && !finalizePresent)
                return;
            let ownedPath = finalizePresent ? finalizePath : entry.quarantinePath;
            assertCanonicalQuarantineIdentity(ownedPath, entry.identity);
            if (!finalizePresent) {
                hooks.beforeMove?.(entry);
                renameSync(entry.quarantinePath, finalizePath);
                syncDirectory(dirname(entry.quarantinePath));
                ownedPath = finalizePath;
                hooks.afterMove?.(entry);
                try {
                    assertCanonicalQuarantineIdentity(ownedPath, entry.identity);
                }
                catch (error) {
                    preserveMovedCanonicalState(entry, ownedPath, error);
                }
            }
            hooks.beforeDelete?.(entry);
            assertCanonicalQuarantineIdentity(ownedPath, entry.identity);
            removeDurableFile(ownedPath);
        });
    }
}
function identityFromClaim(artifact) {
    const finalIdentity = identityFor(artifact.path);
    const claimIdentity = identityFor(artifact.claimPath);
    if (!sameFileId(finalIdentity, claimIdentity)) {
        throw new Error(`bootstrap artifact claim does not bind the published inode: ${artifact.path}`);
    }
    if (filesystemEntryPresent(artifact.rollbackPath)) {
        const receiptIdentity = identityFor(artifact.rollbackPath);
        if (!sameFileId(claimIdentity, receiptIdentity)) {
            throw new Error(`bootstrap artifact ownership receipt does not bind the published inode: ${artifact.path}`);
        }
    }
    if (artifact.claimOwnership?.phase === 'created'
        && (artifact.claimOwnership.device !== finalIdentity.device
            || artifact.claimOwnership.inode !== finalIdentity.inode)) {
        throw new Error(`bootstrap artifact claim ownership changed before publication: ${artifact.path}`);
    }
    if (!artifact.identity)
        throw new Error(`bootstrap artifact has no expected identity: ${artifact.path}`);
    assertExpectedArtifactIdentity(artifact.identity, finalIdentity, artifact.path);
    return finalIdentity;
}
export function recordPublishedBootstrapArtifact(journal, path, claimPath, persistClaimOwnership) {
    const canonical = resolve(path);
    let found = false;
    let claimedIdentity;
    const artifacts = journal.artifacts.map((artifact) => {
        if (artifact.path !== canonical)
            return artifact;
        found = true;
        if (artifact.claimPath !== resolve(claimPath)) {
            throw new Error(`bootstrap publisher used an unexpected claim path: ${path}`);
        }
        if (filesystemEntryPresent(artifact.path)) {
            const identity = identityFromClaim(artifact);
            const { claimOwnership: _claimOwnership, ...publishedArtifact } = artifact;
            return { ...publishedArtifact, identity };
        }
        if (journal.stage !== 'installing'
            || (artifact.claimOwnership?.phase !== 'armed'
                && artifact.claimOwnership?.phase !== 'created')) {
            throw new Error(`bootstrap publisher created a claim without a durable ownership plan: ${path}`);
        }
        if (!filesystemEntryPresent(artifact.claimPath)
            || !filesystemEntryPresent(artifact.rollbackPath)) {
            throw new Error(`bootstrap artifact ownership receipt is incomplete: ${path}`);
        }
        const claimIdentity = identityFor(artifact.claimPath);
        const receiptIdentity = identityFor(artifact.rollbackPath);
        if (!sameFileId(claimIdentity, receiptIdentity)) {
            throw new Error(`bootstrap artifact ownership receipt does not bind the opened claim: ${path}`);
        }
        if (artifact.claimOwnership.phase === 'armed') {
            if (!artifact.identity)
                throw new Error(`bootstrap artifact has no expected identity: ${path}`);
            if (claimIdentity.device === undefined || claimIdentity.inode === undefined) {
                throw new Error(`bootstrap artifact claim file identity is unavailable: ${path}`);
            }
            claimedIdentity = {
                expected: artifact.identity,
                actual: claimIdentity,
                path: artifact.claimPath,
            };
            return {
                ...artifact,
                claimOwnership: {
                    phase: 'created',
                    device: claimIdentity.device,
                    inode: claimIdentity.inode,
                },
            };
        }
        if (artifact.claimOwnership.device !== claimIdentity.device
            || artifact.claimOwnership.inode !== claimIdentity.inode) {
            throw new Error(`bootstrap artifact claim ownership changed before publication: ${path}`);
        }
        return artifact;
    });
    if (!found)
        throw new Error(`bootstrap publisher emitted an unplanned artifact: ${path}`);
    const recorded = { ...journal, artifacts };
    if (claimedIdentity) {
        // Persist exact-inode ownership before validating mutable apply bytes. A
        // plan/apply mismatch must remain recoverable without publishing canonical.
        persistClaimOwnership(recorded);
        assertExpectedArtifactIdentity(claimedIdentity.expected, claimedIdentity.actual, claimedIdentity.path);
    }
    return recorded;
}
export function captureBootstrapArtifactIdentities(journal, requirePresent = false) {
    return {
        ...journal,
        artifacts: journal.artifacts.map((artifact) => {
            if (!artifact.identity)
                throw new Error(`bootstrap artifact has no expected identity: ${artifact.path}`);
            if (!filesystemEntryPresent(artifact.path)) {
                if (filesystemEntryPresent(artifact.claimPath)) {
                    const claimIdentity = identityFor(artifact.claimPath);
                    assertExpectedArtifactIdentity(artifact.identity, claimIdentity, artifact.path);
                    return { ...artifact, identity: claimIdentity };
                }
                if (requirePresent)
                    throw new Error(`bootstrap artifact is missing after activation: ${artifact.path}`);
                return artifact;
            }
            const actual = identityFor(artifact.path);
            if (artifact.identity.device === undefined) {
                if (!filesystemEntryPresent(artifact.claimPath)) {
                    throw new Error(`bootstrap artifact lacks a durable publisher claim: ${artifact.path}`);
                }
                return { ...artifact, identity: identityFromClaim(artifact) };
            }
            assertExpectedArtifactIdentity(artifact.identity, actual, artifact.path);
            return { ...artifact, identity: actual };
        }),
    };
}
export function removeOwnedBootstrapArtifacts(journal, hooks = {}) {
    for (const artifact of [...journal.artifacts].reverse()) {
        if (!artifact.identity)
            throw new Error(`bootstrap artifact has no durable ownership identity: ${artifact.path}`);
        const expectedIdentity = artifact.identity;
        const claimIdentity = filesystemEntryPresent(artifact.claimPath) ? identityFor(artifact.claimPath) : undefined;
        const receiptIdentity = filesystemEntryPresent(artifact.rollbackPath)
            ? identityFor(artifact.rollbackPath)
            : undefined;
        const stagingCleanupPath = bootstrapArtifactStagingCleanupPath(artifact);
        const stagingCleanupIdentity = filesystemEntryPresent(stagingCleanupPath)
            ? identityFor(stagingCleanupPath)
            : undefined;
        const armedStagingOnly = artifact.claimOwnership?.phase === 'armed'
            && (stagingCleanupIdentity !== undefined
                || (receiptIdentity !== undefined
                    && (claimIdentity === undefined || !sameFileId(receiptIdentity, claimIdentity))));
        if (armedStagingOnly) {
            if (receiptIdentity !== undefined && stagingCleanupIdentity !== undefined) {
                throw new Error(`bootstrap artifact staging has two cleanup paths: ${artifact.path}`);
            }
            let ownedPath = stagingCleanupIdentity === undefined
                ? artifact.rollbackPath
                : stagingCleanupPath;
            let ownedIdentity = stagingCleanupIdentity ?? receiptIdentity;
            if (stagingCleanupIdentity === undefined) {
                hooks.beforeStagingQuarantine?.(artifact);
                renameSync(artifact.rollbackPath, stagingCleanupPath);
                syncDirectory(dirname(artifact.rollbackPath));
                ownedPath = stagingCleanupPath;
                hooks.afterStagingQuarantine?.(artifact);
                const movedIdentity = identityFor(stagingCleanupPath);
                if (!sameFileId(ownedIdentity, movedIdentity)) {
                    try {
                        linkSync(stagingCleanupPath, artifact.rollbackPath);
                        syncDirectory(dirname(artifact.rollbackPath));
                    }
                    catch (error) {
                        if (!isErrno(error, 'EEXIST'))
                            throw error;
                    }
                    if (filesystemEntryPresent(artifact.rollbackPath)) {
                        const restoredIdentity = identityFor(artifact.rollbackPath);
                        if (sameFileId(restoredIdentity, movedIdentity)) {
                            removeDurableFile(stagingCleanupPath);
                        }
                    }
                    throw new Error(`bootstrap rollback restored a staging inode replaced during cleanup: ${artifact.rollbackPath}`);
                }
                ownedIdentity = movedIdentity;
            }
            hooks.beforeStagingDelete?.(artifact);
            const beforeDelete = identityFor(ownedPath);
            if (!sameFileId(ownedIdentity, beforeDelete)) {
                throw new Error(`bootstrap artifact staging identity changed before cleanup: ${ownedPath}`);
            }
            removeDurableFile(ownedPath);
            continue;
        }
        let durableOwnership;
        if (artifact.claimOwnership?.phase === 'created') {
            // A persisted publisher receipt owns this exact inode independently of
            // content. Plan drift is a rollback trigger, not a reason to orphan it.
            durableOwnership = {
                size: expectedIdentity.size,
                sha256: expectedIdentity.sha256,
                device: artifact.claimOwnership.device,
                inode: artifact.claimOwnership.inode,
            };
            if (claimIdentity && !sameFileId(claimIdentity, durableOwnership)) {
                throw new Error(`bootstrap artifact claim file identity changed: ${artifact.claimPath}`);
            }
            if (receiptIdentity && !sameFileId(receiptIdentity, durableOwnership)) {
                throw new Error(`bootstrap artifact ownership receipt file identity changed: ${artifact.rollbackPath}`);
            }
            if (filesystemEntryPresent(artifact.path)) {
                const finalIdentity = identityFor(artifact.path);
                if (!sameFileId(finalIdentity, durableOwnership)) {
                    throw new Error(`bootstrap artifact file identity changed: ${artifact.path}`);
                }
            }
        }
        else if (artifact.claimOwnership?.phase === 'armed') {
            if (!claimIdentity) {
                if (receiptIdentity)
                    throw new Error(`bootstrap artifact staging cleanup was not completed: ${artifact.path}`);
            }
            else {
                if (!receiptIdentity) {
                    throw new Error(`bootstrap artifact claim has no durable ownership receipt: ${artifact.claimPath}`);
                }
                if (!sameFileId(claimIdentity, receiptIdentity)) {
                    throw new Error(`bootstrap artifact ownership receipt does not bind the opened claim: ${artifact.path}`);
                }
                assertExpectedArtifactIdentity(expectedIdentity, claimIdentity, artifact.claimPath);
                durableOwnership = claimIdentity;
            }
        }
        else if (claimIdentity) {
            assertExpectedArtifactIdentity(expectedIdentity, claimIdentity, artifact.claimPath);
            durableOwnership = claimIdentity;
        }
        else if (expectedIdentity.device !== undefined) {
            durableOwnership = expectedIdentity;
        }
        const assertOwned = (identity) => {
            if (durableOwnership) {
                if (artifact.claimOwnership === undefined && claimIdentity === undefined) {
                    assertExpectedArtifactIdentity(expectedIdentity, identity, artifact.path);
                    return;
                }
                if (!sameFileId(identity, durableOwnership)) {
                    throw new Error(`bootstrap rollback claim does not bind the owned artifact: ${artifact.path}`);
                }
                if (artifact.claimOwnership?.phase === 'armed') {
                    assertExpectedArtifactIdentity(expectedIdentity, identity, artifact.path);
                }
                return;
            }
            if (expectedIdentity.device === undefined) {
                throw new Error(`bootstrap artifact has no durable publisher claim: ${artifact.path}`);
            }
            assertExpectedArtifactIdentity(expectedIdentity, identity, artifact.path);
        };
        const restoreMovedForeign = (sourcePath, rollbackIdentity, cause) => {
            if (filesystemEntryPresent(sourcePath)) {
                const finalIdentity = identityFor(sourcePath);
                if (!sameFileId(finalIdentity, rollbackIdentity)) {
                    throw new Error(`bootstrap rollback preserved an unowned quarantine because the canonical path is occupied: ${sourcePath}`, { cause });
                }
            }
            else {
                try {
                    linkSync(artifact.rollbackPath, sourcePath);
                    syncDirectory(dirname(sourcePath));
                }
                catch (error) {
                    if (!isErrno(error, 'EEXIST'))
                        throw error;
                    throw new Error(`bootstrap rollback preserved an unowned quarantine because the canonical path could not be restored: ${sourcePath}`, { cause });
                }
                const restoredIdentity = identityFor(sourcePath);
                const currentRollbackIdentity = identityFor(artifact.rollbackPath);
                if (!sameFileId(restoredIdentity, currentRollbackIdentity)
                    || !sameFileId(currentRollbackIdentity, rollbackIdentity)) {
                    throw new Error(`bootstrap rollback preserved an unowned quarantine after an inconclusive restore: ${sourcePath}`, { cause });
                }
            }
            removeDurableFile(artifact.rollbackPath);
            throw new Error(`bootstrap rollback restored an unowned artifact moved during cleanup: ${sourcePath}`, { cause });
        };
        const removeOwnedClaim = () => {
            if (!filesystemEntryPresent(artifact.claimPath))
                return;
            if (filesystemEntryPresent(artifact.rollbackPath)) {
                throw new Error(`bootstrap rollback quarantine is occupied before claim cleanup: ${artifact.claimPath}`);
            }
            const beforeMove = identityFor(artifact.claimPath);
            assertOwned(beforeMove);
            hooks.beforeClaimQuarantine?.(artifact);
            renameSync(artifact.claimPath, artifact.rollbackPath);
            syncDirectory(dirname(artifact.claimPath));
            const movedIdentity = identityFor(artifact.rollbackPath);
            try {
                assertOwned(movedIdentity);
            }
            catch (error) {
                restoreMovedForeign(artifact.claimPath, movedIdentity, error);
            }
            if (filesystemEntryPresent(artifact.claimPath)) {
                throw new Error(`bootstrap rollback preserved its claim quarantine because the canonical path was recreated: ${artifact.claimPath}`);
            }
            hooks.beforeClaimQuarantineDelete?.(artifact);
            const beforeDelete = identityFor(artifact.rollbackPath);
            try {
                assertOwned(beforeDelete);
            }
            catch (error) {
                restoreMovedForeign(artifact.claimPath, beforeDelete, error);
            }
            removeDurableFile(artifact.rollbackPath);
        };
        if (filesystemEntryPresent(artifact.rollbackPath)) {
            const rollbackIdentity = identityFor(artifact.rollbackPath);
            try {
                assertOwned(rollbackIdentity);
            }
            catch (error) {
                restoreMovedForeign(artifact.path, rollbackIdentity, error);
            }
            if (filesystemEntryPresent(artifact.path)) {
                const finalIdentity = identityFor(artifact.path);
                if (!sameFileId(finalIdentity, rollbackIdentity)) {
                    throw new Error(`bootstrap rollback quarantine does not bind the owned artifact: ${artifact.path}`);
                }
                assertOwned(finalIdentity);
                removeDurableFile(artifact.rollbackPath);
            }
            else {
                hooks.beforeQuarantineDelete?.(artifact);
                const beforeDelete = identityFor(artifact.rollbackPath);
                try {
                    assertOwned(beforeDelete);
                }
                catch (error) {
                    restoreMovedForeign(artifact.path, beforeDelete, error);
                }
                removeDurableFile(artifact.rollbackPath);
            }
            if (!filesystemEntryPresent(artifact.path)) {
                removeOwnedClaim();
                continue;
            }
        }
        if (!filesystemEntryPresent(artifact.path)) {
            removeOwnedClaim();
            continue;
        }
        const finalIdentity = identityFor(artifact.path);
        assertOwned(finalIdentity);
        if (!filesystemEntryPresent(artifact.claimPath)) {
            linkSync(artifact.path, artifact.claimPath);
            syncDirectory(dirname(artifact.path));
        }
        const durableClaimIdentity = identityFor(artifact.claimPath);
        if (!sameFileId(finalIdentity, durableClaimIdentity)) {
            throw new Error(`bootstrap rollback claim does not bind the owned artifact: ${artifact.path}`);
        }
        hooks.beforeQuarantine?.(artifact);
        renameSync(artifact.path, artifact.rollbackPath);
        syncDirectory(dirname(artifact.path));
        hooks.afterQuarantine?.(artifact);
        const rollbackIdentity = identityFor(artifact.rollbackPath);
        try {
            assertOwned(rollbackIdentity);
        }
        catch (error) {
            restoreMovedForeign(artifact.path, rollbackIdentity, error);
        }
        if (filesystemEntryPresent(artifact.path)) {
            throw new Error(`bootstrap rollback preserved its quarantine because the canonical path was recreated: ${artifact.path}`);
        }
        hooks.beforeQuarantineDelete?.(artifact);
        const beforeDelete = identityFor(artifact.rollbackPath);
        try {
            assertOwned(beforeDelete);
        }
        catch (error) {
            restoreMovedForeign(artifact.path, beforeDelete, error);
        }
        removeDurableFile(artifact.rollbackPath);
        removeOwnedClaim();
    }
}