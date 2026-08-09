export declare const POWERSHELL_STDIN_SCRIPT_COMMAND = "& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
export declare function windowsAclFailureDetail(cause: unknown): string;
export declare function stripPowerShellClixml(text: string): string;