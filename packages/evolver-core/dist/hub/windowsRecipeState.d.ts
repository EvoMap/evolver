export interface WindowsRecipeLocks {
    directory(path: string): void;
    publish(path: string): void;
    release(path: string): void;
}
export declare function secureWindowsRecipeDirectory(path: string, locks: WindowsRecipeLocks): string;
export declare function readWindowsRecipeJson(path: string, locks: WindowsRecipeLocks): unknown;
/** False means a validated exclusive target already exists. Never overwrite an unsafe existing entry. */
export declare function writeWindowsRecipeJson(path: string, value: unknown, exclusive: boolean, locks: WindowsRecipeLocks): boolean;