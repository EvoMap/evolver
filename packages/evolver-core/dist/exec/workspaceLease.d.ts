/** An in-process capability minted only for a freshly reserved private directory. */
export interface WorkspaceLease {
    readonly kind: 'private_workspace';
}
/**
 * Reserve before populating, then bind once. Never bless an existing user directory.
 * This is an exclusive-writer contract, not a sandbox against hostile same-user processes.
 * The owner must not give this directory to another writer until the run has settled.
 */
export declare function reservePrivateWorkspace(prefix?: string): {
    container: string;
    bind(root: string): WorkspaceLease;
};
export declare function acquireWorkspaceLease(root: string, lease: WorkspaceLease | undefined): {
    assert(): void;
    release(): void;
    container: string;
};
/** Detect a writer through its capability, even when a trusted wrapper omits the runner name. */
export declare function workspaceLeaseWasClaimed(lease: WorkspaceLease | undefined): boolean;