export interface WindowsSecretProtector {
    protect(secret: string): string;
    unprotect(protectedValue: string): string;
    preflight?(): void;
}
export interface PrivateNodeCredentialStoreOptions {
    platform?: NodeJS.Platform;
    windowsProtector?: WindowsSecretProtector;
}
export declare class PrivateNodeCredentialReadError extends Error {
    constructor();
}
export declare class PrivateNodeCredentialStore {
    private readonly directory;
    private readonly path;
    private readonly platform;
    private readonly windowsProtector;
    constructor(proxyStorePath: string, options?: PrivateNodeCredentialStoreOptions);
    read(): string | undefined;
    write(nodeSecret: string): void;
    private prepareDirectory;
    private assertRegularFile;
}