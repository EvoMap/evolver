export declare const WORKSPACE_KEYCHAIN_SERVICE = "evomap.evolver.workspace-id";
export type WorkspaceKeychainMode = 'auto' | 'force' | 'off';
export interface WorkspaceKeychainEntry {
    getPassword(): string | null | undefined;
    setPassword(password: string): void;
}
export interface WorkspaceKeychainAddon {
    Entry: new (service: string, account: string) => WorkspaceKeychainEntry;
}
export interface WorkspaceKeychainReadResult {
    available: boolean;
    id: string | null;
}
export interface WorkspaceKeychainOps {
    loadAddon(): WorkspaceKeychainAddon | null;
    readFromKeychain(account: string): WorkspaceKeychainReadResult;
    writeToKeychain(account: string, id: string): boolean;
    getMode(env?: Record<string, string | undefined>): WorkspaceKeychainMode;
}
export interface WorkspaceIdentityOptions {
    env?: Record<string, string | undefined>;
    cwd?: string;
    workspaceRoot?: string;
    keychain?: WorkspaceKeychainOps;
}
export declare function resetWorkspaceKeychainAddonCacheForTests(): void;
export declare function getWorkspaceKeychainMode(env?: Record<string, string | undefined>): WorkspaceKeychainMode;
export declare function loadWorkspaceKeychainAddon(): WorkspaceKeychainAddon | null;
export declare function isWorkspaceKeychainNoEntryError(err: unknown): boolean;
export declare function readFromWorkspaceKeychain(account: string, addon?: WorkspaceKeychainAddon | null): WorkspaceKeychainReadResult;
export declare function writeToWorkspaceKeychain(account: string, id: string, addon?: WorkspaceKeychainAddon | null): boolean;
export declare const defaultWorkspaceKeychain: WorkspaceKeychainOps;
export declare function workspaceIdPath(workspaceRoot: string): string;
export declare function resolveWorkspaceRootForIdentity(opts?: Pick<WorkspaceIdentityOptions, 'env' | 'cwd'>): string;
export declare function resolveWorkspaceId(opts?: WorkspaceIdentityOptions): string | null;
export declare function readWorkspaceIdFromFs(file: string): string | null;
export declare function writeWorkspaceIdToFs(file: string, id?: string): string | null;