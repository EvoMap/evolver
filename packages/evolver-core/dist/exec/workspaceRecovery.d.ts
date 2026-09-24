/** Host-side recovery evidence; never an asset, success proof, or automatic retry authorization. */
export interface WorkspaceRecovery {
    status: 'restored' | 'conflict' | 'failed';
    restored: string[];
    /** Confirmed writes preserved after commit when journal cleanup failed. Never count as restored. */
    committed?: string[];
    conflicts: Array<{
        path: string;
        reason: string;
    }>;
    failed: Array<{
        path: string;
        reason: string;
    }>;
    /** Retained execution directory. Revalidate ownership before any manual recovery. */
    workspace?: string;
    /** Retained private journal containing original bytes and write receipts. Operator-only, not for publishing. */
    journal?: string;
}