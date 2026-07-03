import type { SourceAgent } from '../schema/common.js';
export interface RegisteredSource {
    agent: SourceAgent;
    kind: 'session_log' | 'tool_event';
    globs: string[];
}
export declare const DEFAULT_DISCOVERY_WHITELIST: readonly string[];
export interface SourceRegistryOptions {
    path?: string;
    autoDiscover?: boolean;
    whitelist?: readonly string[];
}
/** 源注册/发现 (批注#33): 默认只扫显式 register; 自动发现 opt-in + 白名单. */
export declare class SourceRegistry {
    private readonly sources;
    private readonly autoDiscover;
    private readonly whitelist;
    private readonly path;
    constructor(opts?: SourceRegistryOptions);
    register(s: RegisteredSource): void;
    list(): readonly RegisteredSource[];
    /** 自动发现根: 默认 off→空; opt-in→白名单(实际 glob 扫描在集成层). */
    discoveryRoots(): string[];
    private persist;
}