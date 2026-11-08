export interface WindowsSid {
    readonly value: string;
    readonly bytes: Buffer;
}
interface AccessRule {
    type: number;
    flags: number;
    rights: number;
    sid: WindowsSid;
}
export interface WindowsPrivateSecurity {
    owner: WindowsSid;
    protected: boolean;
    rules: readonly AccessRule[];
}
export declare function windowsSid(bytes: Buffer, offset?: number): WindowsSid;
/** Decode the kernel's self-relative owner/DACL, never a caller-selected principal name. */
export declare function windowsPrivateSecurity(bytes: Buffer): WindowsPrivateSecurity;
/** Same trusted SIDs and direct/inherit-only write policy as windowsPrivateAcl.ts. */
export declare function trustedWindowsSecurity(security: WindowsPrivateSecurity, user: WindowsSid, directory: boolean, strictCreate: boolean): boolean;
export declare function canonicalWindowsSecurity(security: WindowsPrivateSecurity, user: WindowsSid, directory: boolean): boolean;
/** Owner and protected one-ACE DACL are attached by NtCreateFile, before a name exists. */
export declare function canonicalWindowsDescriptor(user: WindowsSid, directory: boolean): Buffer;
export {};