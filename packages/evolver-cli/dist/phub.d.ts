import { type DoctorDeps } from './doctor.js';
type WriteTextFile = (path: string, data: string, options?: {
    encoding?: BufferEncoding;
    mode?: number;
    flag?: string;
}) => void;
type MakeDir = (path: string, opts: {
    recursive: true;
}) => void;
type RemoveFile = (path: string) => void;
export interface PhubDeps extends DoctorDeps {
    cwd?: string;
    writeFile?: WriteTextFile;
    mkdir?: MakeDir;
    removeFile?: RemoveFile;
}
export declare function runPhubCommand(argv: readonly string[], deps?: PhubDeps): Promise<number>;
export {};