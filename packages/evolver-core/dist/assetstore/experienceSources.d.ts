export interface ExperienceSource {
    task: string;
    material: string;
}
/** Original task material stays outside the Gene and never enters MCP asset responses. */
export declare class ExperienceSources {
    private readonly baseDir;
    private readonly path;
    constructor(baseDir: string);
    read(): Map<string, ExperienceSource>;
    save(assetId: string, source: ExperienceSource): void;
}