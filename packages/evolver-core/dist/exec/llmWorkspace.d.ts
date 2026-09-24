import { type WorkspaceLease } from './workspaceLease.js';
import type { WorkspaceRecovery } from './workspaceRecovery.js';
export interface Workspace {
    list(dir: string): string;
    read(path: string): string;
    write(path: string, content: string): string;
    touched(): string[];
    /** Legacy injected workspaces may return void; callers must not claim that means restored. */
    undo(): WorkspaceRecovery | void;
    complete?(): void;
    close?(): void;
}
/** Writes are allowed only in an owner-reserved directory; shared paths remain read-only. */
export declare function workspaceAt(root: string, maxFileBytes?: number, lease?: WorkspaceLease): Workspace;