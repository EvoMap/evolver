import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** 凭证持久化(~/.evomap, 0600). token/keypair 私钥都经此, 文件权限收紧. */
export class CredentialStore {
    path;
    constructor(path) {
        this.path = path;
    }
    load() {
        if (!existsSync(this.path))
            return null;
        try {
            return JSON.parse(readFileSync(this.path, 'utf8'));
        }
        catch {
            return null;
        }
    }
    save(cred) {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(cred), { mode: 0o600 });
    }
}