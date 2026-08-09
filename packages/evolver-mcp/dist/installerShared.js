import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
/** Default command used by runtimes that support a SessionStart hook. The flag enables session-id capture. */
export const DEFAULT_HOOK_COMMAND = 'evolver inject session-start --hook-stdin';
export const DEFAULT_PROMPT_RECALL_HOOK_COMMAND = 'evolver inject prompt-recall --hook-stdin';
export const EVOLVER_HOOK_STATUS = 'evolver-managed-hook';
const LEGACY_EVOLVER_HOOK_STATUS = 'Loading Evolver memory';
function isObj(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const LEGACY_NODE_COMMAND = /^"?node(?:\.exe)?"?\s+/i;
const LEGACY_EVOLVER_SCRIPT_BASENAME = /(?:^|[\\/'"\s])(?:evolver-session-start|evolver-session-end|evolver-signal-detect|evolver-task-recall|evolver-daemon-start)\.js(?=$|[\\/'"\s])/i;
const LEGACY_V2_CLI_HOOK_COMMAND = /^"?evolver(?:\.cmd|\.exe)?"?\s+inject\s+(?:session-start|prompt-recall)(?:\s|$)/i;
function isKnownEvolverHookCommand(command) {
    const trimmed = command.trim();
    return LEGACY_V2_CLI_HOOK_COMMAND.test(trimmed)
        || (LEGACY_NODE_COMMAND.test(trimmed) && LEGACY_EVOLVER_SCRIPT_BASENAME.test(trimmed));
}
/** Bind custom-command ownership to that exact command without adding undocumented hook-schema fields. */
export function evolverManagedHookStatus(command) {
    if (isKnownEvolverHookCommand(command))
        return EVOLVER_HOOK_STATUS;
    const commandTag = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 16);
    return `${EVOLVER_HOOK_STATUS} [evolver:${commandTag}]`;
}
function legacyEvolverManagedHookStatus(command) {
    const currentStatus = evolverManagedHookStatus(command);
    return `${LEGACY_EVOLVER_HOOK_STATUS}${currentStatus.slice(EVOLVER_HOOK_STATUS.length)}`;
}
const NO_MANAGED_HOOK_COMMANDS = new Set();
const isEvolverHandler = (handler, trustManagedStatus, managedCommands) => {
    if (!isObj(handler) || typeof handler['command'] !== 'string')
        return false;
    const command = handler['command'];
    return isKnownEvolverHookCommand(command)
        || (trustManagedStatus && (managedCommands.has(command)
            || handler['statusMessage'] === evolverManagedHookStatus(command)
            || handler['statusMessage'] === legacyEvolverManagedHookStatus(command)));
};
/** Remove only Evolver-owned handlers, retaining user handlers that share the same matcher group. */
export function stripEvolverHookEntries(entries, trustManagedStatus = false, managedCommands = NO_MANAGED_HOOK_COMMANDS) {
    let changed = false;
    const keptEntries = [];
    for (const entry of entries) {
        if (!isObj(entry)) {
            keptEntries.push(entry);
            continue;
        }
        const handlers = entry['hooks'];
        if (!Array.isArray(handlers)) {
            if (isEvolverHandler(entry, trustManagedStatus, managedCommands))
                changed = true;
            else
                keptEntries.push(entry);
            continue;
        }
        const keptHandlers = handlers.filter((handler) => !isEvolverHandler(handler, trustManagedStatus, managedCommands));
        if (keptHandlers.length === handlers.length) {
            keptEntries.push(entry);
            continue;
        }
        changed = true;
        if (keptHandlers.length > 0)
            keptEntries.push({ ...entry, hooks: keptHandlers });
    }
    return { changed, entries: keptEntries };
}
export class SymlinkRefusedError extends Error {
    constructor(label, path) {
        super(`[setup-hooks] refusing to operate: ${label} ${path} is a symbolic link — evolver will not follow symlinks for adapter-owned paths (a hostile workspace could redirect writes/unlinks outside the project). Replace it with a real directory/file and rerun.`);
        this.name = 'SymlinkRefusedError';
    }
}
export class UnparseableConfigError extends Error {
    constructor(label, path, owner = 'Claude Code') {
        super(`[setup-hooks] refusing to overwrite ${label} (${path}): the file exists and is non-empty but is not valid JSON. This is ${owner}'s own shared config; merging into it would replace the whole file and could wipe its contents. Fix or remove the corrupt file, then rerun.`);
        this.name = 'UnparseableConfigError';
    }
}
export class EmptySharedConfigError extends Error {
    constructor(label, path, owner = 'Claude Code') {
        super(`[setup-hooks] refusing to overwrite ${label} (${path}): the file exists but is empty or contains only whitespace. ${owner} may be in the middle of a truncating write, and treating it as fresh config could wipe shared config data. Fix the empty file or retry after ${owner} finishes writing it.`);
        this.name = 'EmptySharedConfigError';
    }
}
/** Refuse to read or write through a symlink at an adapter-owned path. */
export function assertNotSymlink(path, label) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (stat.isSymbolicLink())
        throw new SymlinkRefusedError(label, path);
}