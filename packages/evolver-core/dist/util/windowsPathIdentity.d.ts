export declare function assertWindowsFixedDrive(path: string): void;
export interface WindowsPathIdentity {
    dev: bigint;
    ino: bigint;
    close(): void;
}
/** A no-follow native identity; the retained read handle denies deletion of the named object. */
export declare function pinWindowsPathIdentity(path: string, directory?: boolean, denyWrite?: boolean): WindowsPathIdentity;
/** Borrow the runtime's descriptor HANDLE without closing a capability owned by Node/Bun. */
export declare function readWindowsDescriptorIdentity(fd: number): Pick<WindowsPathIdentity, 'dev' | 'ino'>;
/** Named stat's dev=0 is not permission to ignore the volume of the opened file. */
export declare function sameWindowsOpenedPathIdentity(path: string, opened: {
    dev: bigint;
    ino: bigint;
}, fd?: number): boolean;