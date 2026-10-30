import { type BigIntStats } from 'node:fs';
export declare function selfUpdateFileMetadata(path: string, access?: number): Promise<BigIntStats>;