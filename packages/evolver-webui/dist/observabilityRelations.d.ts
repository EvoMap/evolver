import type { events as ev } from '@evomap/evolver-core';
export interface AssetRelation {
    id: string;
    assetId: string;
    type: string;
}
export interface TrajectoryRelation {
    traceId: string;
    sessionId: string;
}
export interface PullRequestRelation {
    number: number | null;
    url: string;
    repo: string;
}
export interface ObservabilityRelations {
    assets: AssetRelation[];
    trajectories: TrajectoryRelation[];
    pullRequests: PullRequestRelation[];
}
export declare function eventRelations(event: ev.ReportEvent): ObservabilityRelations;
export declare function eventListRelations(events: readonly ev.ReportEvent[]): ObservabilityRelations;