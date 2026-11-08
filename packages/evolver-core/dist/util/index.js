export { acquireLock, attachLockGuardianToProcess, clearLockGuardianForProcess, deferLockRelease, inspectFileLockOwnerProcess, LockReleaseError, LockTimeoutError, MAX_LOCK_OWNER_BYTES, releaseLock, retainLockGuardianForProcess, readFileLockProcessStartIdentity, readFileLockOwner, sameFileLockProcessStartIdentity, serializeFileLockOwnerRecord, parseFileLockProcessStartIdentity, syncSleep, statRegularFileIdentity, transferLockOwnershipToProcess, UnsafeLockPathError, } from './fileLock.js';
export * from './fetchPort.js';
export * from './version.js';
export { canonicalEventPath } from './canonicalEventPath.js';
export { loadReferenceFfi as loadNativeFfi } from '../benchmark/referenceNativeRuntime.js';
export { pinWindowsPathIdentity, readWindowsDescriptorIdentity, sameWindowsOpenedPathIdentity } from './windowsPathIdentity.js';