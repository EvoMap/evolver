import { verify } from '@evomap/evolver-core';
export function runRequiredSandboxedValidation(commands, cwd, options = {}, runner = verify.runSandboxedValidation) {
    return runner(commands, cwd, { ...options, requireIsolation: true });
}