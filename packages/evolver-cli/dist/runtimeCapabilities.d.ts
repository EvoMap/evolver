type RuntimeCapabilityStatus = 'supported' | 'experimental' | 'unsupported';
type RuntimeCapabilityId = 'claude-code' | 'codex' | 'cursor' | 'gemini' | 'antigravity' | 'kimi' | 'kiro' | 'opencode' | 'generic-chat';
interface RuntimeCapability {
    status: RuntimeCapabilityStatus;
    evidence: string;
}
interface RuntimeCapabilityEntry {
    runtime: RuntimeCapabilityId;
    ingest: RuntimeCapability;
    inject: RuntimeCapability;
    execute: RuntimeCapability;
    verify: RuntimeCapability;
    resume: RuntimeCapability;
}
/** Product-level runtime matrix. A transcript parser never implies execution, verification, or resumability. */
export declare const RUNTIME_CAPABILITY_MATRIX: Readonly<Record<RuntimeCapabilityId, RuntimeCapabilityEntry>>;
export declare function runtimeCapabilities(): RuntimeCapabilityEntry[];
export {};