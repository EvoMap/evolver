export class Budget {
    cfg;
    cycles = 0;
    tokens = 0;
    perPattern = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    available(patternId) {
        return this.cycles < this.cfg.maxCyclesPerDay
            && this.tokens < this.cfg.maxTokensPerDay
            && (this.perPattern.get(patternId) ?? 0) < this.cfg.perPatternCap;
    }
    consume(patternId, tokens = 0) {
        this.cycles += 1;
        this.tokens += tokens;
        this.perPattern.set(patternId, (this.perPattern.get(patternId) ?? 0) + 1);
    }
    reset() { this.cycles = 0; this.tokens = 0; this.perPattern.clear(); }
}