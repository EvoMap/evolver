import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { evomapHome } from '../events/paths.js';
import { fetchSkillFiles } from './gitSkillSource.js';
import { checkSkillTree, digestOfSkillFiles, requiredSkillsOf } from './requiredSkills.js';
/** Where evolver keeps the skills Genes pin: `<EVOLVER_HOME>/skills/`, never inside a user's project. */
export function managedSkillsRoot(env = process.env) {
    return join(evomapHome(env), 'skills');
}
/**
 * Where each required skill of a Gene stands. Local only, no network: an installed skill is re-checked against its
 * pin, and a pin that cannot be read is reported as invalid instead of disappearing. A skill that follows a branch
 * is never reported installed: only a fetch can tell whether a copy on disk is still the branch's latest.
 */
export function requiredSkillStatus(gene, root) {
    const refs = requiredSkillsOf(gene);
    if (!refs.ok)
        return [{ name: 'skill:git+', state: 'invalid', message: refs.message }];
    return refs.value.map((ref) => {
        if ('branch' in ref)
            return { name: ref.name, state: 'follows_branch', branch: ref.branch };
        const dir = skillDir(ref.name, ref.sha256, root);
        if (!existsSync(dir))
            return { name: ref.name, state: 'not_installed' };
        return holds(dir, ref.sha256) ? { name: ref.name, state: 'installed', skillMd: join(dir, 'SKILL.md') } : { name: ref.name, state: 'invalid', message: notPinned(dir) };
    });
}
function skillDir(name, sha256, root) {
    return join(root, `${name}-${sha256.slice(0, 16)}`);
}
/** Install every skill a Gene requires, or say which one could not be installed. A Gene that requires none yields []. */
export async function installRequiredSkills(gene, root, fetchFiles = fetchSkillFiles) {
    const refs = requiredSkillsOf(gene);
    if (!refs.ok)
        return refs;
    const installed = [];
    for (const ref of refs.value) {
        const skill = await installSkill(ref, root, fetchFiles);
        if (!skill.ok)
            return { ok: false, message: `required skill ${ref.name} cannot be installed: ${skill.message}` };
        installed.push(skill.value);
    }
    return { ok: true, value: installed };
}
/**
 * Install one required skill into a directory named after its content digest. The directory is staged beside its
 * final place and renamed in, so it either holds the whole verified skill or does not exist; a directory that is
 * already there is reused after its content is checked against the digest again. A pinned skill found on disk is
 * reused without touching the network; a skill that follows a branch is fetched every time, and lands in the same
 * directory as long as the branch's content has not changed.
 */
async function installSkill(ref, root, fetchFiles) {
    if ('sha256' in ref && existsSync(skillDir(ref.name, ref.sha256, root)))
        return installedAt(ref, root);
    const fetched = await fetchFiles(ref);
    if (!fetched.ok)
        return fetched;
    const { commit, files } = fetched.value;
    const tree = checkSkillTree(files.map((file) => ({ mode: '100644', type: 'blob', size: file.content.length, path: file.path })));
    if (!tree.ok)
        return tree;
    const sha256 = digestOfSkillFiles(files);
    if ('sha256' in ref && sha256 !== ref.sha256)
        return { ok: false, message: 'its content does not match the sha256 the Gene pins' };
    const resolved = 'branch' in ref ? { ...ref, commit, sha256 } : ref;
    const dir = skillDir(ref.name, sha256, root);
    if (!existsSync(dir)) {
        mkdirSync(root, { recursive: true });
        const staging = mkdtempSync(join(root, '.staging-'));
        try {
            for (const file of files) {
                const target = join(staging, ...file.path.split('/'));
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, file.content, { mode: 0o644, flag: 'wx' });
            }
            renameSync(staging, dir);
        }
        catch (error) {
            if (!existsSync(dir))
                throw error; // lost a race to another install of the same content: verify theirs below
        }
        finally {
            rmSync(staging, { recursive: true, force: true });
        }
    }
    return installedAt(resolved, root);
}
function installedAt(skill, root) {
    const dir = skillDir(skill.name, skill.sha256, root);
    const present = readInstalled(dir);
    if (!present || digestOfSkillFiles(present) !== skill.sha256)
        return { ok: false, message: notPinned(dir) };
    return { ok: true, value: { ...skill, dir, skillMd: join(dir, 'SKILL.md'), files: present.length } };
}
function holds(dir, sha256) {
    const present = readInstalled(dir);
    return present !== null && digestOfSkillFiles(present) === sha256;
}
/** The files of an installed skill, or null when it is not a plain directory, holds anything else, or cannot be read. */
function readInstalled(dir) {
    try {
        return lstatSync(dir).isDirectory() ? filesIn(dir, '') : null;
    }
    catch {
        return null;
    }
}
function notPinned(dir) {
    return `${dir} does not hold the pinned content; remove it and retry`;
}
function filesIn(dir, prefix) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const stat = lstatSync(path);
        const nested = stat.isDirectory() ? filesIn(path, `${prefix}${entry}/`) : null;
        if (stat.isFile())
            files.push({ path: `${prefix}${entry}`, content: readFileSync(path) });
        else if (nested)
            files.push(...nested);
        else
            return null;
    }
    return files;
}