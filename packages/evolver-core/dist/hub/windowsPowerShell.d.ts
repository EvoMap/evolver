export declare const POWERSHELL_ENV_SCRIPT_COMMAND = "& ([scriptblock]::Create($env:EVOMAP_CREDENTIAL_ACL_SCRIPT))";
export declare function windowsAclFailureDetail(cause: unknown): string;
export declare function stripPowerShellClixml(text: string): string;