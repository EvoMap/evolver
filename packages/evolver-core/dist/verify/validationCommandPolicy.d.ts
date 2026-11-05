export type ValidationCommandRejection = 'empty' | 'credential' | 'command_substitution' | 'shell_metacharacters' | 'unparseable' | 'disallowed_env' | 'blocked_node_flag' | 'invalid_node_invocation' | 'unsupported_executable' | 'disallowed_subcommand' | 'disallowed_option';
export declare const VALIDATION_TEST_TOOLS: ReadonlySet<string>;
/** Bare executable names the sandbox resolves itself; a path would bypass that resolution. */
export declare const VALIDATION_EXECUTABLES: ReadonlySet<string>;
/** The single policy for Gene validation commands: null when allowed, otherwise the first reason it is not. */
export declare function validationCommandRejection(cmd: string): ValidationCommandRejection | null;
export declare function isValidationCommandAllowed(cmd: string): boolean;