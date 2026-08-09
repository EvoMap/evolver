import { type EvolutionGraph } from '../schema/evolutionGraph.js';
/** The minimal root_event view this projector reads (structurally matches events' ReportEvent). */
export interface EvolutionGraphSourceEvent {
    type: string;
    seq: number;
    ts: string;
    payload?: Record<string, unknown> | undefined;
    human?: {
        title?: string | undefined;
    } | undefined;
}
export interface ProjectEvolutionGraphOptions {
    /** Stable identifier for the produced snapshot. */
    graphId?: string;
    /** Snapshot timestamp; defaults to the newest projected event so the projection stays deterministic. */
    generatedAt?: string;
    /** Bound on scanned events (newest window wins) so a long history cannot make the projection unbounded. */
    maxEvents?: number;
}
export declare function projectEvolutionGraph(events: readonly EvolutionGraphSourceEvent[], options?: ProjectEvolutionGraphOptions): EvolutionGraph;