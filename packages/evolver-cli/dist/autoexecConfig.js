import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from '@evomap/evolver-core';
// Default resident-loop cadence: 30s base, still multiplied by idle sleepMultiplier and single-flight gated.
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_VALIDATION_PROFILES = 32;
const MAX_VALIDATION_COMMANDS = 16;
const MAX_VALIDATION_COMMAND_LENGTH = 300;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_TEXT_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|gh[oprsu])_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i;
function parseRunner(value) {
    return value === 'codex' || value === 'cursor' || value === 'gemini' ? value : 'claude';
}
function isSafeValidationCommand(value) {
    if (typeof value !== 'string')
        return false;
    const command = value.trim();
    if (command.length === 0 || command.length > MAX_VALIDATION_COMMAND_LENGTH)
        return false;
    if (SECRET_TEXT_RE.test(command) || verify.SHELL_METACHARS.test(command))
        return false;
    return true;
}
function parseValidationProfiles(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const profiles = {};
    for (const [name, commands] of Object.entries(value).slice(0, MAX_VALIDATION_PROFILES)) {
        if (!PROFILE_NAME_RE.test(name) || !Array.isArray(commands) || commands.length === 0 || commands.length > MAX_VALIDATION_COMMANDS)
            continue;
        if (!commands.every(isSafeValidationCommand))
            continue;
        profiles[name] = commands.map((command) => command.trim());
    }
    return profiles;
}
/** Read <base>/config.json with deny-by-default workflow and autoexec safety settings. */
export function readAutoExecConfig(base) {
    const path = join(base, 'config.json');
    const defaults = {
        allowedRoots: [],
        pollMs: DEFAULT_POLL_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        runner: 'claude',
        workflowValidationProfiles: {},
    };
    if (!existsSync(path))
        return defaults;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return {
            allowedRoots: Array.isArray(parsed['allowedRoots'])
                ? parsed['allowedRoots'].filter((root) => typeof root === 'string' && root.trim().length > 0)
                : [],
            pollMs: typeof parsed['pollMs'] === 'number' && Number.isSafeInteger(parsed['pollMs']) && parsed['pollMs'] > 0
                ? parsed['pollMs']
                : DEFAULT_POLL_MS,
            timeoutMs: typeof parsed['timeoutMs'] === 'number' && Number.isSafeInteger(parsed['timeoutMs']) && parsed['timeoutMs'] > 0
                ? parsed['timeoutMs']
                : DEFAULT_TIMEOUT_MS,
            runner: parseRunner(parsed['runner']),
            workflowValidationProfiles: parseValidationProfiles(parsed['workflowValidationProfiles']),
        };
    }
    catch {
        return defaults;
    }
}