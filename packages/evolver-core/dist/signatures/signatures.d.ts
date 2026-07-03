export declare const SIGNATURE_V = 1;
/** 文本归一化: 小写+NFKC+去标点+折叠空白 → 同义不同措辞归并. */
export declare function normalizeText(s: string): string;
/** 栈帧归一化: 去绝对路径/行列号, 留 fn@basename. */
export declare function normalizeStackFrame(frame: string): string;
export declare function exitCodeClass(code?: number): string;
/** 工程层指纹 (军杰 §4.2): 纯工程特征, 不含领域语义. */
export interface EventSignatureInput {
    errorClass: string;
    stack?: readonly string[];
    syscall?: string;
    exitCode?: number;
}
export declare function eventSignature(input: EventSignatureInput): string;
/** 领域层指纹 (军杰 §4.3): 不含 gene_id/capsule_id. */
export interface ProblemSignatureInput {
    problemKind: string;
    domainTags?: readonly string[];
    affectedSurface?: string;
    failureMode?: string;
}
export declare function problemSignature(input: ProblemSignatureInput): string;