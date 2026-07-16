export interface AntiGeneOverblockSummary {
    antiGeneId: string;
    count: number;
    taskIds: string[];
}
interface AntiGeneImpactRunResult {
    overblocked: boolean;
    observedAntiWarnings: readonly string[];
}
interface AntiGeneImpactTaskResult {
    taskId: string;
    antiGene: AntiGeneImpactRunResult;
}
export declare function summarizeOverblockedAntiGenes(taskResults: readonly AntiGeneImpactTaskResult[]): AntiGeneOverblockSummary[];
export declare function parseOverblockedAntiGenes(value: unknown): AntiGeneOverblockSummary[] | null;
export {};