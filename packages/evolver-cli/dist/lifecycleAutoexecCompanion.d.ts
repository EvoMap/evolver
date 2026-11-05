export type CompanionTarget = 'systemd' | 'launchd' | 'windows';
export interface AutoexecCompanionPlan {
    path: string;
    content: string;
    autoexecHome?: string;
}
export interface AutoexecCompanionOutcome {
    status: 'planned' | 'installed' | 'present' | 'failed';
    files: string[];
    actions: string[];
    detail?: string;
}
interface ControlResult {
    status: number | null;
    error?: unknown;
}
export interface AutoexecCompanionActivation {
    target: CompanionTarget;
    plan: AutoexecCompanionPlan;
    uid: number | undefined;
    systemctl: string;
    launchctl: string;
    powershell: () => string;
    run: (command: string, args: readonly string[]) => ControlResult;
    exists: (path: string) => boolean;
    /** Create-only; throws EEXIST when another writer published the companion first. */
    writeUnit: (path: string, content: string) => void;
    /** Removes the unit only while it still holds `content`; true when it is gone. */
    removeUnit: (path: string, content: string) => boolean;
    /** Returns the path actually written, which may differ when the preferred helper name is taken. */
    writeWindowsInstaller: (path: string, content: string) => string;
}
export declare function autoexecCompanionActions(target: CompanionTarget, path: string, uid: number | undefined): string[];
/**
 * Bootstrap's proxy transaction owns only the proxy manager, so the companion is installed afterwards and
 * never rolled back with it. An existing companion is left exactly as the operator configured it; one this call
 * wrote but could not activate is removed again, since a later bootstrap would otherwise take it for configured.
 */
export declare function activateAutoexecCompanion(input: AutoexecCompanionActivation): AutoexecCompanionOutcome;
export {};