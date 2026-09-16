import { URL } from 'node:url';
import { type SourceAccessEvidence } from '../assetstore/sourceQualification.js';
export type ReferenceResource = {
    type: 'url' | 'file';
    value: string;
};
export interface ReferenceRule extends ReferenceResource {
    id: string;
    kind: SourceAccessEvidence['kind'];
}
export interface ReferencePolicy {
    schema: 'benchmark-reference-policy.v1';
    benchmarkId: string;
    allowedOrigins: readonly string[];
    allowedFileRoots: readonly string[];
    rules: readonly ReferenceRule[];
    maxBytes: number;
}
export interface ReferencePair {
    callId: string;
    eventDigest: string;
    resultDigest?: string;
    complete: boolean;
    startLine?: number;
    endLine?: number;
}
/** 来自可信宿主或独立复核文件，不消费model自报classification。 */
export interface ReferenceBinding {
    callId: string;
    trajectoryDigest: string;
    eventDigest: string;
    resultDigest: string;
    resource: ReferenceResource;
    outcome: 'read' | 'failed';
}
export interface ReferenceObservation extends SourceAccessEvidence {
    observedOutcome: 'read' | 'failed' | 'unknown';
    enforcement: 'observe-only';
    ruleId?: string;
}
export declare function referenceDigest(value: string | Uint8Array): string;
export declare function referenceId(value: unknown): value is string;
/** 只规范化标识，不读取文件；因此Linux冻结日志可在Windows离线检查。 */
export declare function referenceFilePath(value: string): string;
export declare function referenceUrl(value: string): URL;
export declare function referenceLocation(resource: ReferenceResource): string;
/** 摘要绑定查询参数，但公开locator和规则不包含查询值；fragment不发送到服务器。 */
export declare function referenceResourceDigest(resource: ReferenceResource): string;
export declare function referenceWithin(prefix: string, value: string): boolean;
export declare function parseReferencePolicy(value: unknown): ReferencePolicy;
export declare function referenceRule(policy: ReferencePolicy, resource: ReferenceResource): ReferenceRule | undefined;
export declare function forbiddenReference(kind: SourceAccessEvidence['kind']): boolean;
/** 未提供可信关联或返回不匹配时保持unknown；URL或isError都不能独自证明读取成功。 */
export declare function observeReferencePair(policy: ReferencePolicy, trajectoryDigest: string, pair: ReferencePair, binding?: ReferenceBinding): ReferenceObservation;