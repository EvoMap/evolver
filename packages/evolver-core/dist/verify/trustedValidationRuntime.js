import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
function windowsBunConfig() {
    const cwd = mkdtempSync(join(tmpdir(), 'evolver-validation-worker-'));
    const directory = lstatSync(cwd, { bigint: true });
    const path = join(cwd, 'worker.toml');
    let config;
    let removed = false;
    const cleanup = () => {
        if (removed)
            return;
        const currentDirectory = lstatSync(cwd, { bigint: true });
        if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()
            || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) {
            throw new Error('trusted_validation_runtime_cleanup_failed');
        }
        if (config) {
            const currentConfig = lstatSync(path, { bigint: true });
            if (!currentConfig.isFile() || currentConfig.isSymbolicLink()
                || currentConfig.dev !== config.dev || currentConfig.ino !== config.ino) {
                throw new Error('trusted_validation_runtime_cleanup_failed');
            }
            // No recursive deletion: unexpected files or a replaced artifact remain a failure.
            unlinkSync(path);
        }
        rmdirSync(cwd);
        removed = true;
    };
    let descriptor;
    try {
        // Bun 1.3.14 on Windows crashes when --config targets NUL. Record ownership
        // before writing, so even a partial write can be cleaned up safely.
        descriptor = openSync(path, 'wx', 0o600);
        config = fstatSync(descriptor, { bigint: true });
        writeFileSync(descriptor, '# trusted validation worker\n');
        const owned = descriptor;
        descriptor = undefined;
        closeSync(owned);
    }
    catch (error) {
        const errors = [error];
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            }
            catch (closeError) {
                errors.push(closeError);
            }
        }
        try {
            cleanup();
        }
        catch (cleanupError) {
            errors.push(cleanupError);
        }
        if (errors.length > 1)
            throw new AggregateError(errors, 'trusted_validation_runtime_setup_cleanup_failed');
        throw error;
    }
    return { path, cwd, cleanup };
}
/** Only fixed, trusted JavaScript belongs here. Positional data is never interpolated into its source. */
export function trustedValidationRuntime(source, positional = [], options = {}) {
    const runtime = options.runtime ?? {
        execPath: process.execPath,
        platform: process.platform,
        bunVersion: process.versions['bun'],
    };
    const cwd = runtime.platform === 'win32' ? parse(runtime.execPath).root : '/';
    if (typeof runtime.bunVersion !== 'string') {
        return {
            cmd: runtime.execPath,
            // Node -e has no script-name slot: the first positional is process.argv[1].
            args: [...options.nodeArgs ?? [], '-e', source, '--', ...positional],
            env: {},
            cwd,
            cleanup() { },
        };
    }
    const config = runtime.platform === 'win32' ? windowsBunConfig() : undefined;
    return {
        cmd: runtime.execPath,
        args: ['--no-env-file', `--config=${config?.path ?? '/dev/null'}`, '--no-install', '-e', source, '--', ...positional],
        // Official standalone mode bypasses the bundled CLI entrypoint. This value
        // is fixed here rather than inherited from user-controlled configuration.
        env: { BUN_BE_BUN: '1' },
        cwd: config?.cwd ?? cwd,
        cleanup: config?.cleanup ?? (() => { }),
    };
}