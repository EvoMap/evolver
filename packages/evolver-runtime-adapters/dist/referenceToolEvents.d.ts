export interface ReferenceToolPair {
    callId: string;
    eventDigest: string;
    resultDigest?: string;
    complete: boolean;
    startLine?: number;
    endLine?: number;
}
/** 解析冻结Pi事件对；忽略review文字，不执行args，不输出原始命令/结果。 */
export declare function referenceToolPairs(value: unknown): ReferenceToolPair[];