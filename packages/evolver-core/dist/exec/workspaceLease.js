import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
const leases = new WeakMap();
function identity(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('private workspace directory identity changed');
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid };
}
function sameDirectory(path, expected) {
    const actual = identity(path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode || actual.uid !== expected.uid)
        throw new Error('private workspace directory identity changed');
}
/**
 * Reserve before populating, then bind once. Never bless an existing user directory.
 * This is an exclusive-writer contract, not a sandbox against hostile same-user processes.
 * The owner must not give this directory to another writer until the run has settled.
 */
export function reservePrivateWorkspace(prefix = 'evolver-llm-') {
    if (!/^[a-z0-9-]+$/u.test(prefix))
        throw new Error('invalid private workspace prefix');
    const container = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const containerIdentity = identity(container);
    let bound = false;
    return {
        container,
        bind(root) {
            if (bound)
                throw new Error('private workspace reservation already bound');
            root = resolve(root);
            const rel = relative(container, root);
            if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
                throw new Error('workspace is outside its private reservation');
            const parents = [container];
            for (const part of rel.split(sep).filter(Boolean))
                parents.push(join(parents[parents.length - 1], part));
            const identities = parents.map((path) => ({ path, identity: identity(path) }));
            const assert = () => {
                sameDirectory(container, containerIdentity);
                for (const entry of identities)
                    sameDirectory(entry.path, entry.identity);
                if (realpathSync(root) !== root)
                    throw new Error('private workspace path changed');
            };
            assert();
            const lease = Object.freeze({ kind: 'private_workspace' });
            leases.set(lease, { root, container, assert, active: false, claimed: false });
            bound = true;
            return lease;
        },
    };
}
export function acquireWorkspaceLease(root, lease) {
    const state = lease && leases.get(lease);
    if (!state || state.root !== resolve(root))
        throw new Error('llm writes require a private workspace lease; use worktree isolation');
    state.assert();
    if (state.active)
        throw new Error('private workspace already has an active writer');
    state.active = true;
    state.claimed = true;
    let released = false;
    return {
        container: state.container,
        assert() {
            if (released)
                throw new Error('private workspace writer has finished');
            state.assert();
        },
        release() { if (!released) {
            released = true;
            state.active = false;
        } },
    };
}
/** Detect a writer through its capability, even when a trusted wrapper omits the runner name. */
export function workspaceLeaseWasClaimed(lease) {
    return lease !== undefined && leases.get(lease)?.claimed === true;
}