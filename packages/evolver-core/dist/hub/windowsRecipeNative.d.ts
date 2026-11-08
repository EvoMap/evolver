import { createWindowsReferenceApi } from '../benchmark/referenceNativeWindows.js';
import { windowsPrivateSecurity, type WindowsSid } from './windowsRecipeAcl.js';
export type WindowsRecipeHandle = bigint;
export type WindowsRecipeFileInfo = ReturnType<ReturnType<typeof createWindowsReferenceApi>['info']>;
export interface WindowsRecipeTokenIdentity {
    user: WindowsSid;
    generation: string;
}
export interface WindowsRecipeNativeApi {
    token(): WindowsRecipeHandle;
    identity(handle: WindowsRecipeHandle): WindowsRecipeTokenIdentity;
    root(drive: string): WindowsRecipeHandle;
    child(parent: WindowsRecipeHandle, name: string, directory: boolean, descriptor?: Buffer): WindowsRecipeHandle;
    security(handle: WindowsRecipeHandle): ReturnType<typeof windowsPrivateSecurity>;
    info(handle: WindowsRecipeHandle): WindowsRecipeFileInfo;
    finalPath(handle: WindowsRecipeHandle): string;
    fileType(handle: WindowsRecipeHandle): number;
    read(handle: WindowsRecipeHandle, output: Buffer, position: number): number;
    write(handle: WindowsRecipeHandle, input: Buffer, position: number): number;
    flush(handle: WindowsRecipeHandle): void;
    publish(handle: WindowsRecipeHandle, parent: WindowsRecipeHandle, name: string, replace: boolean): void;
    remove(handle: WindowsRecipeHandle): void;
    close(handle: WindowsRecipeHandle): void;
}
type CleanupFailure = () => never;
export declare class WindowsRecipeIoError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function unsafeWindowsRecipeState(directory: boolean): never;
export declare function windowsRecipePathKey(path: string): string;
export declare function windowsRecipeComponent(name: string): void;
/** Fixed OS bindings only. Callers retain these wrappers, never authorization observations. */
export declare function createWindowsRecipeNativeApi(cleanupFailure: CleanupFailure): WindowsRecipeNativeApi;
export {};