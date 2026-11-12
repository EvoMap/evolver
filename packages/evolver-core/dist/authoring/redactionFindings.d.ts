import { type AuthoringLocale } from './locale.js';
export declare const REDACTION_RULES_VERSION = "redact.v1";
export type RedactionKind = 'home_path' | 'secret' | 'email' | 'private_ip' | 'url_credential' | 'db_url' | 'high_entropy' | 'env_value' | 'term';
export interface RedactionFinding {
    kind: RedactionKind;
    start: number;
    end: number;
    original: string;
    replacement: string;
}
export interface RedactionResult {
    rulesVersion: typeof REDACTION_RULES_VERSION;
    text: string;
    findings: RedactionFinding[];
}
export interface RedactionRequest {
    text: string;
    terms?: readonly string[];
    identifiers?: readonly string[];
    env: Record<string, string | undefined>;
    locale: AuthoringLocale;
}
/**
 * redactString's rule families plus the publish-time leak scanners and the caller's terms, as located findings.
 * Offsets are UTF-16 indices into the input; applying every finding to the input yields `text` exactly.
 */
export declare function redactWithFindings(request: RedactionRequest): RedactionResult;