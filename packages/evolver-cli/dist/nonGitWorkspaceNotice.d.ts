type GitWorkspaceStatus = 'git' | 'non_git' | 'unknown';
export declare const NON_GIT_WORKSPACE_NOTICE_THROTTLE_MS: number;
export interface NonGitWorkspaceNoticeOptions {
    cwd?: string;
    statePath?: string;
    now?: () => number;
    throttleMs?: number;
    detect?: (cwd: string) => GitWorkspaceStatus;
    write?: (line: string) => void;
}
interface NonGitWorkspaceNoticeResult {
    status: GitWorkspaceStatus;
    emitted: boolean;
    workspaceHash?: string;
}
type GitProbe = (file: string, args: readonly string[], options: {
    encoding: 'utf8';
    stdio: readonly ['ignore', 'pipe', 'pipe'];
    timeout: number;
    windowsHide: true;
}) => string;
export declare function detectGitWorkspace(cwd?: string, gitProbe?: GitProbe): GitWorkspaceStatus;
export declare function maybeEmitNonGitWorkspaceNotice(options?: NonGitWorkspaceNoticeOptions): NonGitWorkspaceNoticeResult;
export {};