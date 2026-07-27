export interface ExplicitNodeCredentials {
    senderId?: string;
    nodeSecret?: string;
    nodeSecretVersion?: string;
}
/** Select explicit node credentials without combining conflicting alias namespaces. */
export declare function resolveExplicitNodeCredentials(env?: NodeJS.ProcessEnv): ExplicitNodeCredentials;
/** Resolve the public Hub identity root without coupling credentials to Evolver state. */
export declare function resolveIdentityHome(env?: NodeJS.ProcessEnv, homeDir?: string): string;