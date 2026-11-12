interface PluginDraft {
    id: string;
    runtime: string;
    title: string;
    summary: string;
    score: number | null;
    createdAt: string;
    gene: Record<string, unknown> | null;
    capsule: Record<string, unknown> | null;
}
export interface PluginDrafts {
    drafts: PluginDraft[];
    /** Runtimes whose drafts file exists but could not be read: missing drafts there are unknown, not absent. */
    unreadable: string[];
}
export declare const RUNTIME_NAME: RegExp;
/** The agent plugin's unconfirmed distillation drafts (`~/.evolver/state/<runtime>-distill-drafts.json`), read in place. */
export declare function pluginDrafts(env: Readonly<Record<string, string | undefined>>, runtime?: string): PluginDrafts;
export {};