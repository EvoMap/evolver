type PrivateTreeHookPhase = 'before-validation' | 'after-security-read';
declare let privateTreeHookForTest: ((root: string) => void) | undefined;
export declare function _setWindowsPrivateTreeHookForTest(hook?: typeof privateTreeHookForTest, phase?: PrivateTreeHookPhase): void;
export declare class PowerShellWindowsAclOps {
    private readonly options;
    private readonly executable;
    private readonly systemRoot;
    constructor(options?: {
        redactDiagnostics?: boolean;
    });
    assertPrivateFile(path: string): void;
    assertPrivateDirectory(path: string): void;
    /** Validate inherited private ACLs for journal generations and content without one process per file. */
    assertPrivateTree(path: string): void;
    /** Secure a new private directory and verify its full parent trust chain in one native operation. */
    securePrivateDirectory(path: string): void;
    secureDirectory(path: string): void;
    secureFile(path: string): void;
    assertTrustedParent(path: string, strictCreate: boolean): void;
    assertTrustedFile(path: string): void;
    private run;
}
export {};