import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { editableSourcesInCopy } from './editableInstalls.js';
const PYTHON_TOOLS = new Set(['python', 'python3', 'pytest']);
const JAVASCRIPT_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'npx']);
// Credential stores that must stay hidden even when a tool happens to be installed beneath them.
const SECRET_HOME_SUBPATHS = ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.evomap', '.evolver', '.config', '.netrc', '.npmrc', 'Library/Keychains'];
// Package managers must never fetch: offline mode turns a would-be install into a fast, explicit failure.
const PACKAGE_MANAGER_ENV = {
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    NO_UPDATE_NOTIFIER: '1',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
};
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
const MAX_LINK_HOPS = 64;
/** Every symlink met while resolving `path` component by component, each spelled with a symlink-free parent. */
function symlinksAlong(path) {
    const links = [];
    let pending = path.split(sep).filter(Boolean);
    let current = sep;
    while (pending.length > 0) {
        const name = pending.shift();
        if (name === '.')
            continue;
        if (name === '..') {
            current = dirname(current);
            continue;
        }
        const next = join(current, name);
        if (!lstatSync(next).isSymbolicLink()) {
            current = next;
            continue;
        }
        links.push(next);
        if (links.length > MAX_LINK_HOPS)
            throw new Error('validation toolchain path has too many symlinks');
        const target = readlinkSync(next);
        if (isAbsolute(target))
            current = sep;
        pending = [...target.split(sep).filter(Boolean), ...pending];
    }
    return [...new Set(links)];
}
function executableIn(name, dirs) {
    for (const dir of dirs) {
        if (!isAbsolute(dir))
            continue;
        const candidate = join(dir, name);
        try {
            if (!statSync(candidate).isFile())
                continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch { /* try the next PATH entry */ }
    }
    return undefined;
}
function isJavaScriptEntry(path) {
    if (/\.(c|m)?js$/.test(path))
        return true;
    const buffer = Buffer.alloc(128);
    const fd = openSync(path, 'r');
    try {
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, length).toString('utf8').split('\n')[0] ?? '';
        return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
    }
    finally {
        closeSync(fd);
    }
}
function packageRoot(script) {
    let current = dirname(script);
    for (let depth = 0; depth < 4; depth += 1) {
        if (existsSync(join(current, 'package.json')))
            return current;
        current = dirname(current);
    }
    return dirname(script);
}
function installPrefix(real) {
    const dir = dirname(real);
    return basename(dir) === 'bin' ? dirname(dir) : dir;
}
function venvConfig(venv) {
    const buffer = Buffer.alloc(4096);
    const fd = openSync(join(venv, 'pyvenv.cfg'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size >= buffer.length)
            return {};
        const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
        const home = /^home\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
        const minorVersion = /^version(?:_info)?\s*=\s*(\d+\.\d+)/m.exec(text)?.[1];
        return { ...(home ? { home } : {}), ...(minorVersion ? { minorVersion } : {}) };
    }
    finally {
        closeSync(fd);
    }
}
/** The base interpreter on the daemon PATH that the venv was built from, or undefined when none qualifies. */
function venvBaseInterpreter(layout, real, hostDirs) {
    const { root, venv, home, minorVersion } = layout;
    const baseBin = realpathSync(home);
    // A venv built on a Python that is not the default one is found under its versioned name (`python3.11`).
    for (const name of ['python3', 'python', ...(minorVersion ? [`python${minorVersion}`] : [])]) {
        const candidate = executableIn(name, hostDirs);
        if (!candidate)
            continue;
        const interpreter = realpathSync(candidate);
        if (pathIsWithin(root, interpreter) || pathIsWithin(venv, interpreter))
            continue;
        if (baseBin !== dirname(interpreter) && baseBin !== realpathSync(dirname(candidate)))
            continue;
        if (real === interpreter || pathIsWithin(venv, real))
            return interpreter;
    }
    return undefined;
}
/** A checkout may select a host interpreter already on the daemon PATH, but cannot add a host read root. */
function projectVenvScope(shim, real, hostDirs, host) {
    const root = realpathSync(host.root);
    const expectedVenv = join(root, '.venv');
    const venv = realpathSync(expectedVenv);
    if (venv !== expectedVenv && venv !== host.mirroredVenvRoot)
        return null;
    if (!pathIsWithin(venv, realpathSync(dirname(shim))))
        return null;
    const { home, minorVersion } = venvConfig(venv);
    if (!home || !isAbsolute(home))
        return null;
    const interpreter = venvBaseInterpreter({ root, venv, home, ...(minorVersion ? { minorVersion } : {}) }, real, hostDirs);
    if (!interpreter)
        return null;
    return {
        readRoots: [installPrefix(interpreter)],
        readLinks: [join(venv, 'bin', 'python'), home].flatMap(symlinksAlong),
        pythonPath: venv === host.mirroredVenvRoot ? editableSourcesInCopy(venv, dirname(venv), root) : [],
    };
}
function corepackHome(host) {
    const configured = host.env['COREPACK_HOME'] ?? join(host.env['XDG_CACHE_HOME'] ?? join(host.home, '.cache'), 'node', 'corepack');
    try {
        return realpathSync(configured);
    }
    catch {
        return undefined;
    }
}
function rustupHome(host) {
    try {
        return realpathSync(host.env['RUSTUP_HOME'] ?? join(host.home, '.rustup'));
    }
    catch {
        return undefined;
    }
}
function protectedHomePaths(accountHome) {
    return SECRET_HOME_SUBPATHS.flatMap((subpath) => {
        const path = join(accountHome, subpath);
        try {
            return [path, realpathSync(path)];
        }
        catch {
            return [path];
        }
    });
}
/** Null when a link sits inside a credential store: even its metadata names what the store holds. */
function safeReadLinks(links, home) {
    const protectedPaths = protectedHomePaths(realpathSync(home));
    const unique = [...new Set(links)];
    return unique.some((link) => protectedPaths.some((path) => pathIsWithin(path, link))) ? null : unique;
}
export function safeValidationReadRoots(roots, home) {
    if (roots.length === 0)
        return [];
    if (!isAbsolute(home) || roots.some((root) => !isAbsolute(root)))
        return null;
    try {
        const accountHome = realpathSync(home);
        const protectedPaths = protectedHomePaths(accountHome);
        const unique = [...new Set(roots.map((root) => realpathSync(root)))];
        const unsafe = unique.some((root) => dirname(root) === root || pathIsWithin(root, accountHome)
            || protectedPaths.some((path) => pathIsWithin(path, root) || pathIsWithin(root, path)));
        if (unsafe)
            return null;
        return unique.filter((root) => !unique.some((other) => other !== root && pathIsWithin(other, root)));
    }
    catch {
        return null;
    }
}
// pnpm otherwise downloads the version pinned in package.json#packageManager; npm rejects the unknown key.
const PNPM_ENV = { npm_config_manage_package_manager_versions: 'false' };
function javascriptToolchain(name, shim, real, hostDirs, host) {
    const nodeShim = executableIn('node', hostDirs);
    if (!nodeShim)
        return null;
    const node = realpathSync(nodeShim);
    const roots = [packageRoot(real), installPrefix(node), dirname(shim)];
    const corepack = real.includes(`${sep}corepack${sep}`) ? corepackHome(host) : undefined;
    if (corepack)
        roots.push(corepack);
    const readRoots = safeValidationReadRoots(roots, host.home);
    const readLinks = safeReadLinks(symlinksAlong(shim), host.home);
    if (!readRoots || !readLinks)
        return null;
    return {
        bin: node,
        argsPrefix: [real],
        javascriptRuntime: true,
        readRoots,
        readLinks,
        pathDirs: [dirname(node), dirname(shim)],
        env: () => ({ ...PACKAGE_MANAGER_ENV, ...(name === 'pnpm' ? PNPM_ENV : {}), ...(corepack ? { COREPACK_HOME: corepack } : {}) }),
    };
}
function nativeEnv(name, real, host, pythonPath) {
    if (PYTHON_TOOLS.has(name)) {
        const path = pythonPath.length > 0 ? { PYTHONPATH: pythonPath.join(delimiter) } : {};
        return () => ({ PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTEST_ADDOPTS: '-p no:cacheprovider', ...path });
    }
    if (name === 'go') {
        return (tmp) => ({ GOPROXY: 'off', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', GOPATH: join(tmp, 'gopath'), GOCACHE: join(tmp, 'gocache') });
    }
    const rustup = basename(real) === 'rustup' ? rustupHome(host) : undefined;
    if (basename(real) === 'rustup' && !rustup)
        return null;
    return (tmp) => ({
        CARGO_NET_OFFLINE: 'true',
        CARGO_HOME: join(tmp, 'cargo-home'),
        CARGO_TARGET_DIR: join(tmp, 'cargo-target'),
        ...(rustup ? { RUSTUP_HOME: rustup, RUSTUP_AUTO_INSTALL: '0' } : {}),
    });
}
function nativeToolchain(name, shim, real, host, venv) {
    const env = nativeEnv(name, real, host, venv?.pythonPath ?? []);
    if (!env)
        return null;
    const roots = venv?.readRoots ?? [realpathSync(dirname(shim)), installPrefix(real)];
    if (basename(real) === 'rustup')
        roots.push(rustupHome(host));
    const readRoots = safeValidationReadRoots(roots, host.home);
    const readLinks = safeReadLinks([...symlinksAlong(shim), ...venv?.readLinks ?? []], host.home);
    if (!readRoots || !readLinks)
        return null;
    return { bin: shim, argsPrefix: [], javascriptRuntime: false, readRoots, readLinks, pathDirs: [dirname(shim)], env };
}
/**
 * Resolve a validation tool on the host PATH (a project `.venv` first for Python) and describe exactly what the
 * sandbox must expose for it to run offline. Null means the tool is absent or would need a hidden location.
 */
export function resolveValidationToolchain(executable, host) {
    const hostDirs = host.hostPath.split(':').filter(Boolean);
    const venvBin = join(host.root, '.venv', 'bin');
    const searchDirs = PYTHON_TOOLS.has(executable) ? [venvBin, ...hostDirs] : hostDirs;
    const shim = executableIn(executable, searchDirs) ?? (executable === 'python' ? executableIn('python3', searchDirs) : undefined);
    if (!shim)
        return null;
    try {
        const real = realpathSync(shim);
        if (JAVASCRIPT_TOOLS.has(executable)) {
            return isJavaScriptEntry(real) ? javascriptToolchain(executable, shim, real, hostDirs, host) : null;
        }
        if (PYTHON_TOOLS.has(executable) && dirname(shim) === venvBin) {
            const venv = projectVenvScope(shim, real, hostDirs, host);
            return venv && nativeToolchain(executable, shim, real, host, venv);
        }
        return nativeToolchain(executable, shim, real, host);
    }
    catch {
        return null;
    }
}