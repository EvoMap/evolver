/** 在异步审计之前固定的文件identity；backend必须在读取正文前以同一handle核验。 */
export interface ReferenceNativeSnapshot {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}