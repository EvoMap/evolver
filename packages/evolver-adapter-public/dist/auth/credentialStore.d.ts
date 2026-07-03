import type { hub } from '@evomap/evolver-core';
/** 凭证持久化(~/.evomap, 0600). token/keypair 私钥都经此, 文件权限收紧. */
export declare class CredentialStore {
    private readonly path;
    constructor(path: string);
    load(): hub.Credential | null;
    save(cred: hub.Credential): void;
}