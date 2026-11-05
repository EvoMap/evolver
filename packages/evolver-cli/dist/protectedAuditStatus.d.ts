import { type ProtectedAuditReadiness } from '@evomap/evolver-core/prompt-recall';
export type { ProtectedAuditReadiness };
export type ProtectedAuditInstallState = 'ready' | 'not_required' | 'not_provisioned' | 'unavailable';
export declare const PROTECTED_AUDIT_INSTALL_GUIDE: string;
export interface ProtectedAuditInstallReport {
    protected_audit: ProtectedAuditInstallState;
    protected_audit_next_step?: string;
}
export declare function protectedAuditInstallReport(readiness: ProtectedAuditReadiness): ProtectedAuditInstallReport;
export interface ProtectedAuditSessionNoticeOptions {
    readiness?: () => ProtectedAuditReadiness;
    statePath?: string;
}
export declare function protectedAuditNoticeStatePath(evomapHome: string): string;
interface NoticeWriter {
    /** A trusted writer resolves only after its output is complete. */
    stdout?: (text: string) => void | Promise<void>;
    stdoutWithSettlement?: (text: string, onSettled: (written: boolean) => void) => Promise<void>;
    onOutputWritten?: () => void;
}
/** Reserve before attempting one write; only the actual transport acknowledgement confirms it. */
export declare function writeProtectedAuditSessionNotice(sessionId: string | undefined, readiness: ProtectedAuditReadiness, path: string, writer: NoticeWriter, emptyOutput?: string): Promise<void>;