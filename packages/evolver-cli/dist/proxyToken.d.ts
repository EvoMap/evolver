import { lstatSync, readFileSync } from 'node:fs';
export interface ProxyTokenDeps {
    env?: Record<string, string | undefined>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    homeDir?: string;
    lstat?: typeof lstatSync;
    readFile?: typeof readFileSync;
}
export declare function runProxyToken(argv: readonly string[], deps?: ProxyTokenDeps): Promise<number>;