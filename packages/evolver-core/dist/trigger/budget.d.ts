/** 进化预算 (军杰§5.4): 日 cycle/token 上限 + per-pattern 上限. */
export interface BudgetConfig {
    maxCyclesPerDay: number;
    maxTokensPerDay: number;
    perPatternCap: number;
}
export declare class Budget {
    private readonly cfg;
    private cycles;
    private tokens;
    private readonly perPattern;
    constructor(cfg: BudgetConfig);
    available(patternId: string): boolean;
    consume(patternId: string, tokens?: number): void;
    reset(): void;
}