import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { exec, verify } from '@evomap/evolver-core';
import { createLlmGit } from './llmGit.js';
/** Read the operator's acceptance plan once, before any material is claimed or model dispatched. */
export function readCycleValidationSpec(path) {
    if (!path)
        throw new Error('--validation-spec requires a file path');
    let fd;
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 65536n)
            throw new Error();
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd, { bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size
            || before.mtimeNs !== opened.mtimeNs || before.ctimeNs !== opened.ctimeNs)
            throw new Error();
        const buffer = Buffer.alloc(65_537);
        let count = 0;
        while (count < buffer.length) {
            const read = readSync(fd, buffer, count, buffer.length - count, count);
            if (read === 0)
                break;
            count += read;
        }
        const bytes = buffer.subarray(0, count);
        const after = fstatSync(fd, { bigint: true });
        if (bytes.length > 65_536 || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs)
            throw new Error();
        return verify.parseDeclarativeValidationSpec(JSON.parse(bytes.toString('utf8')));
    }
    catch {
        throw new Error('invalid --validation-spec; provide a regular file of at most 64 KiB containing version: 1 and nonempty files with path/sha256');
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
/** The LLM file executor is opt-in and never converts a script validation plan into a weaker check. */
export function prepareLlmCycle(options) {
    if (options.runner !== 'llm') {
        if (options.validationSpec !== undefined)
            throw new Error('--validation-spec requires explicit --runner llm');
        return options;
    }
    if (!options.validationSpec)
        throw new Error('--runner llm requires --validation-spec with independent expected file hashes');
    if (options.resume)
        throw new Error('llm executes a new file task; native session resume is unsupported');
    if (options.validationCmds?.length)
        throw new Error('--validation-spec cannot replace or combine with --validation-cmd; script validation still requires an OS sandbox');
    if (options.safety?.isolation === 'none' || options.safety?.scrubEnv === false)
        throw new Error('llm cycle requires a private worktree and scrubbed environment');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))
        throw new Error('llm cycle timeout must be a positive integer');
    const spec = verify.parseDeclarativeValidationSpec(options.validationSpec);
    const config = options.agent ? undefined : exec.readLlmRunnerConfig();
    verify.assertDeclarativeValidationAvailable(options.repo);
    const agent = options.agent ?? exec.makeLlmHeadlessRunner({}, { config, writePaths: spec.files.map((file) => file.path) });
    const priorValidate = options.validate;
    const safeGit = options.git ? undefined : createLlmGit(options.repo, spec.files.map((file) => file.path));
    const git = options.git ?? safeGit.git;
    const gitPatchWriter = options.gitPatchWriter ?? safeGit?.gitPatchWriter;
    return {
        ...options,
        validationSpec: spec,
        agent,
        git,
        ...(gitPatchWriter ? { gitPatchWriter } : {}),
        safety: { ...options.safety, isolation: 'worktree', scrubEnv: true, declarativeValidationOnly: true },
        validate: (task) => {
            const additional = priorValidate?.(task);
            return async (mutation, decision, cwd, signal) => {
                if (signal.aborted)
                    return { passed: false, score: 0.2 };
                // Include ignored untracked files too: an acceptance hash cannot authorize unrelated output.
                const tracked = await git(['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--'], cwd, signal);
                const untracked = await git(['ls-files', '--others', '-z', '--'], cwd, signal);
                const changed = [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
                const result = await verify.runDeclarativeValidation(spec, cwd, changed, signal);
                if (!result.passed || !additional)
                    return result;
                const other = await additional(mutation, decision, cwd, signal);
                return other.passed ? result : { ...result, passed: false, score: 0.2,
                    validator: { ...result.validator, passed: false, score: 0.2, reason: 'policy_denied' } };
            };
        },
    };
}