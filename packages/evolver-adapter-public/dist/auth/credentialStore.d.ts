import { linkSync } from 'node:fs';
import type { hub } from '@evomap/evolver-core';
export interface CredentialStoreOptions {
    /**
     * Test seam for the Windows policy; defaults to the current platform.
     * Windows enforces entry types, identity checks, exclusive random temporary
     * files and atomic replacement. POSIX additionally enforces owner and mode.
     */
    platform?: NodeJS.Platform;
    /** Injectable so the Windows DACL policy can be verified on any platform. */
    windowsAclOps?: WindowsCredentialAclOps;
    /** Injectable so Darwin ancestor ACL caching can be tested without process mocks. */
    darwinAclReader?: (path: string) => string;
    /** Injectable so Windows parent ACL cache invalidation can be tested deterministically. */
    windowsParentStateReader?: (path: string) => readonly PathSecurityState[];
    /** Injectable filesystem primitive for deterministic no-clobber publication tests. */
    linkFile?: typeof linkSync;
}
export interface WindowsCredentialAclOps {
    assertTrustedParent(path: string, strictCreate: boolean): void;
    /** Fail-closed file DACL check before any Set-Acl and before trusting content. */
    assertTrustedFile(path: string): void;
    secureDirectory(path: string): void;
    secureFile(path: string): void;
}
export declare class CredentialStoreError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
interface FileIdentity {
    dev: bigint;
    ino: bigint;
}
interface FileSecurityState extends FileIdentity {
    ctimeNs: bigint;
}
interface PathSecurityState extends FileSecurityState {
    path: string;
}
/** Persists OAuth tokens and keypair private keys behind a local secret-file boundary. */
export declare class CredentialStore {
    private readonly path;
    private readonly platform;
    private readonly windowsAclOps;
    private readonly darwinAclReader;
    private readonly windowsParentStateReader;
    private readonly linkFile;
    private securedDirectoryState;
    private securedCredentialState;
    private readonly securedAncestorStates;
    private readonly trustedWindowsParentStates;
    constructor(path: string, options?: CredentialStoreOptions);
    load(): hub.Credential | null;
    /** Validate an existing credential path without changing its mode, DACL, ACL, or contents. */
    inspectTrustedExisting(): {
        dev: bigint;
        ino: bigint;
        birthtimeNs: bigint;
        ctimeNs: bigint;
        mtimeNs: bigint;
        size: bigint;
        mode: bigint;
        uid: bigint;
    } | null;
    /** Validate the existing parent chain for a future create without creating or hardening it. */
    inspectTrustedParentForCreate(): void;
    save(cred: hub.Credential): void;
    /** Persist a credential only when no filesystem entry already occupies its path. */
    saveIfAbsent(cred: hub.Credential): boolean;
    private saveCredential;
    private prepareDirectory;
    private missingDirectoryComponents;
    private createDirectoryComponent;
    private openCredentialFile;
    private secureCredentialFd;
    private assertCredentialFdTrustedReadOnly;
    private assertSafeDestination;
    private verifySavedFile;
    private directoryIdentity;
    private assertDirectoryIdentity;
    private exclusiveWriteFlags;
    private publishIfAbsent;
    private syncDirectory;
    private unlinkIfSameFile;
    private secureWindowsDirectory;
    private secureWindowsFile;
    private clearDarwinAcl;
    private assertSafeDarwinAncestor;
    private assertTrustedDarwinFile;
    private assertTrustedWindowsParent;
    private isPosix;
}
export {};