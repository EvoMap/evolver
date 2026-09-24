export declare class PowerShellWindowsAclOps {
    private readonly options;
    private readonly executable;
    private readonly systemRoot;
    constructor(options?: {
        redactDiagnostics?: boolean;
    });
    assertPrivateFile(path: string): void;
    assertPrivateDirectory(path: string): void;
    secureDirectory(path: string): void;
    secureFile(path: string): void;
    assertTrustedParent(path: string, strictCreate: boolean): void;
    assertTrustedFile(path: string): void;
    private run;
}