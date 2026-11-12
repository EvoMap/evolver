export type ProbeState = 'active' | 'pending' | 'paused';
export interface ProbeCandidate {
    gene: Record<string, unknown>;
    state: ProbeState;
}
export interface ProbedTask {
    text: string;
    matched: boolean;
    matchedSignals: string[];
    score: number;
}
export interface SimilarGene {
    assetId: string;
    id: string;
    title: string;
    similarity: number;
    state: ProbeState;
}
export interface GeneProbeResult {
    tasks: ProbedTask[];
    similar: SimilarGene[];
}
/**
 * Would a task trigger this Gene, and which local Genes already say the same thing. Similarity is the IDF-weighted
 * token cosine content recall uses, over summary + strategy + signals, with the local store as the corpus: the probed
 * tasks weigh the task scores only, so the similar list does not change with them.
 */
export declare function probeGene(gene: Record<string, unknown>, tasks: readonly string[], local: readonly ProbeCandidate[]): GeneProbeResult;