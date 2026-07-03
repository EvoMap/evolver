export type Direction = 'outbound' | 'inbound' | 'local';
export type Handler = 'core' | 'proxy' | 'agent';
export type TtlClass = 'control' | 'default';
export interface MessageSpec {
    direction: Direction;
    handler: Handler;
    feedsMaterial: boolean;
    ttlClass: TtlClass;
}
export declare class UnknownMessageTypeError extends Error {
    readonly type: string;
    constructor(type: string);
}
/** 三态消息目录单一来源 (mailbox 草案 §4). handler: core 确定性 / proxy non-agentic hub往返 / agent 需智能. */
export declare const MESSAGE_CATALOG: Readonly<Record<string, MessageSpec>>;
export declare function specForType(type: string): MessageSpec | undefined;
export declare function assertKnownType(type: string): MessageSpec;