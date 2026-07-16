export declare const AGENT_DIRECTORY_DEFAULT_LIMIT = 20;
export declare const AGENT_DIRECTORY_MAX_LIMIT = 50;
export declare const AGENT_DIRECTORY_DEFAULT_TIMEOUT_MS = 8000;
export declare const AGENT_DIRECTORY_MAX_TIMEOUT_MS = 30000;
export declare const AGENT_DIRECTORY_MAX_QUERY_LENGTH = 500;
export declare const AGENT_DIRECTORY_MAX_SIGNAL_COUNT = 20;
export declare const AGENT_DIRECTORY_MAX_SIGNAL_LENGTH = 64;
export declare const AGENT_DIRECTORY_MAX_CURSOR_LENGTH = 256;
export declare const AGENT_DIRECTORY_MAX_AGENT_ID_LENGTH = 128;
export type AgentAvailability = 'online' | 'busy' | 'offline' | 'unknown';
export type AgentDirectorySort = 'relevance' | 'reputation' | 'recent' | 'availability';
export type SortOrder = 'asc' | 'desc';
export interface AgentSearchRequest {
    query?: string;
    signals?: readonly string[];
    availability?: AgentAvailability;
    sort?: AgentDirectorySort;
    order?: SortOrder;
    cursor?: string;
    limit?: number;
    timeoutMs?: number;
}
export interface AgentTaskDiscoveryRequest {
    title: string;
    description?: string;
    signals?: readonly string[];
    availability?: AgentAvailability;
    sort?: AgentDirectorySort;
    order?: SortOrder;
    cursor?: string;
    limit?: number;
    timeoutMs?: number;
}
export interface AgentDirectoryEntry {
    agentId: string;
    displayName?: string;
    summary?: string;
    capabilities?: string[];
    domains?: string[];
    score?: number;
    reputation?: number;
    completedTaskCount?: number;
    availability?: AgentAvailability;
    lastSeenAt?: number;
}
export interface AgentProfile {
    agentId: string;
    displayName?: string;
    summary?: string;
    capabilities?: string[];
    domains?: string[];
    reputation?: number;
    completedTaskCount?: number;
    availability?: AgentAvailability;
    lastSeenAt?: number;
}
export interface AgentDirectoryPage {
    items: AgentDirectoryEntry[];
    nextCursor?: string;
    hasMore: boolean;
}
export type AgentDirectoryFailureCode = 'capability_unavailable' | 'permission_denied' | 'hub_unavailable' | 'timeout' | 'invalid_request' | 'invalid_response';
export interface AgentDirectoryFailure {
    code: AgentDirectoryFailureCode;
    retryable: boolean;
    message?: string;
}
export type AgentDirectoryResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: AgentDirectoryFailure;
};
export interface AgentDirectoryCapability {
    search(request: AgentSearchRequest): Promise<AgentDirectoryResult<AgentDirectoryPage>>;
    getProfile(agentId: string, options?: {
        timeoutMs?: number;
    }): Promise<AgentDirectoryResult<AgentProfile | null>>;
    discoverForTask(request: AgentTaskDiscoveryRequest): Promise<AgentDirectoryResult<AgentDirectoryPage>>;
}
export declare class AgentDirectoryInputError extends Error {
    readonly code = "invalid_request";
}
export declare function normalizeAgentSearchRequest(input: AgentSearchRequest): Required<Pick<AgentSearchRequest, 'limit' | 'timeoutMs' | 'sort' | 'order'>> & AgentSearchRequest;
export declare function normalizeAgentTaskDiscoveryRequest(input: AgentTaskDiscoveryRequest): AgentTaskDiscoveryRequest & Required<Pick<AgentTaskDiscoveryRequest, 'limit' | 'timeoutMs' | 'sort' | 'order'>>;
export declare function normalizeAgentId(value: string): string;
export declare function normalizeAgentDirectoryTimeout(value: number | undefined): number;
export declare function capabilityUnavailable(message?: string): AgentDirectoryResult<never>;
export declare function unsupportedAgentDirectoryCapability(message?: string): AgentDirectoryCapability;