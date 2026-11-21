import { type FetchedSkill } from './gitSkillSource.js';
import { type RequiredSkillRef, type ResolvedSkill, type Result } from './requiredSkills.js';
/** A required skill present in evolver's own skill directory, byte-identical to the content it resolved to. */
export interface InstalledSkill extends ResolvedSkill {
    dir: string;
    skillMd: string;
    files: number;
}
type FetchSkillFiles = (ref: RequiredSkillRef) => Result<FetchedSkill> | Promise<Result<FetchedSkill>>;
/** Where evolver keeps the skills Genes pin: `<EVOLVER_HOME>/skills/`, never inside a user's project. */
export declare function managedSkillsRoot(env?: Readonly<Record<string, string | undefined>>): string;
export type RequiredSkillState = {
    name: string;
    state: 'installed';
    skillMd: string;
} | {
    name: string;
    state: 'not_installed';
} | {
    name: string;
    state: 'follows_branch';
    branch: string;
} | {
    name: string;
    state: 'invalid';
    message: string;
};
/**
 * Where each required skill of a Gene stands. Local only, no network: an installed skill is re-checked against its
 * pin, and a pin that cannot be read is reported as invalid instead of disappearing. A skill that follows a branch
 * is never reported installed: only a fetch can tell whether a copy on disk is still the branch's latest.
 */
export declare function requiredSkillStatus(gene: Record<string, unknown>, root: string): RequiredSkillState[];
/** Install every skill a Gene requires, or say which one could not be installed. A Gene that requires none yields []. */
export declare function installRequiredSkills(gene: Record<string, unknown>, root: string, fetchFiles?: FetchSkillFiles): Promise<Result<InstalledSkill[]>>;
export {};