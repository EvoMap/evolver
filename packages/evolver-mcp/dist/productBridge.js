// Unique writer for the EvoX product-tools MCP server (`evox-product`).
// This is not the evolver gene/memory server. Desktop publishes a loopback
// grant at ~/.evox/product-bridge.json; this module only registers a stdio
// shim that fails closed until that file exists. Uninstall removes only a
// managed evox-product entry.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { util } from '@evomap/evolver-core';
import { commitSharedFile, SharedFileConflictError } from './sharedFileCommit.js';
export const PRODUCT_BRIDGE_SERVER_ID = 'evox-product';
export const PRODUCT_BRIDGE_MANAGED_KEY = '_evox_product_managed';
export const PRODUCT_BRIDGE_PREVIOUS_KEY = '_evox_product_previous';
export const PRODUCT_BRIDGE_GRANT_SCHEMA = 'evox.product_bridge.grant.v1';
const CONFIG_WRITE_RETRIES = 5;
const CONFIG_MODE = 0o600;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Resolve only a compiled JavaScript shim. Source TypeScript is never written into runtime config. */
export function productBridgeShimPath() {
    const modulePath = fileURLToPath(import.meta.url);
    const candidates = [
        fileURLToPath(new URL('./productBridgeShim.js', import.meta.url)),
        join(dirname(modulePath), '../dist/productBridgeShim.js'),
    ];
    const built = candidates.find((candidate) => existsSync(candidate));
    if (!built) {
        throw new Error('[setup-hooks] product-bridge shim is not built; run the evolver-mcp build before installing the bridge.');
    }
    return built;
}
const NO_PREVIOUS_ENTRY = Symbol('no previous product bridge entry');
/** The bridge shim runs under Node just like the evolver MCP entry. `nodePath` is the store-stable absolute
 *  Node executable resolved by the install chain (setup-hooks); when omitted — standalone callers without a
 *  resolved path — the entry keeps the current process executable. */
function productBridgeServerEntry(nodePath, previous = NO_PREVIOUS_ENTRY) {
    return {
        command: nodePath ?? process.execPath,
        args: [productBridgeShimPath()],
        [PRODUCT_BRIDGE_MANAGED_KEY]: true,
        ...(previous === NO_PREVIOUS_ENTRY ? {} : { [PRODUCT_BRIDGE_PREVIOUS_KEY]: previous }),
    };
}
function previousEntryForForce(existing, hasExisting) {
    if (!hasExisting)
        return NO_PREVIOUS_ENTRY;
    if (!isOwnedProductBridge(existing))
        return existing;
    return isObj(existing) && Object.prototype.hasOwnProperty.call(existing, PRODUCT_BRIDGE_PREVIOUS_KEY)
        ? existing[PRODUCT_BRIDGE_PREVIOUS_KEY]
        : NO_PREVIOUS_ENTRY;
}
/** Ownership is explicit. A matching filename alone is never enough to delete a user's server. */
export function isOwnedProductBridge(entry) {
    return isObj(entry) && entry[PRODUCT_BRIDGE_MANAGED_KEY] === true;
}
/** Restore a user entry previously preserved by an explicit force takeover. */
export function restoreProductBridgeEntry(entry) {
    if (!isOwnedProductBridge(entry) || !isObj(entry) || !Object.prototype.hasOwnProperty.call(entry, PRODUCT_BRIDGE_PREVIOUS_KEY)) {
        return { restored: false };
    }
    return { restored: true, entry: entry[PRODUCT_BRIDGE_PREVIOUS_KEY] };
}
/** Merge a managed evox-product server into a parsed MCP JSON object (project .mcp.json or ~/.claude.json). */
export function withClaudeProductBridge(data, force = false, nodePath) {
    if (Object.prototype.hasOwnProperty.call(data, 'mcpServers') && !isObj(data['mcpServers'])) {
        throw new Error('[setup-hooks] refusing to overwrite MCP configuration: mcpServers must be an object.');
    }
    const servers = isObj(data['mcpServers']) ? { ...data['mcpServers'] } : {};
    const hasExisting = Object.prototype.hasOwnProperty.call(servers, PRODUCT_BRIDGE_SERVER_ID);
    const existing = servers[PRODUCT_BRIDGE_SERVER_ID];
    if (hasExisting && !isOwnedProductBridge(existing) && !force) {
        return { changed: false, skipped: true, data };
    }
    const previous = previousEntryForForce(existing, hasExisting);
    const next = productBridgeServerEntry(nodePath, previous);
    if (JSON.stringify(existing) === JSON.stringify(next))
        return { changed: false, data };
    return { changed: true, data: { ...data, mcpServers: { ...servers, [PRODUCT_BRIDGE_SERVER_ID]: next } } };
}
/** Merge a managed evox-product table into parsed Codex TOML. */
export function withCodexProductBridge(data, force = false, nodePath) {
    if (Object.prototype.hasOwnProperty.call(data, 'mcp_servers') && !isObj(data['mcp_servers'])) {
        throw new Error('[setup-hooks] refusing to overwrite MCP configuration: mcp_servers must be an object.');
    }
    const servers = isObj(data['mcp_servers']) ? { ...data['mcp_servers'] } : {};
    const hasExisting = Object.prototype.hasOwnProperty.call(servers, PRODUCT_BRIDGE_SERVER_ID);
    const existing = servers[PRODUCT_BRIDGE_SERVER_ID];
    if (hasExisting && !isOwnedProductBridge(existing) && !force) {
        return { changed: false, skipped: true, data };
    }
    const previous = previousEntryForForce(existing, hasExisting);
    const next = productBridgeServerEntry(nodePath, previous);
    if (JSON.stringify(existing) === JSON.stringify(next))
        return { changed: false, data };
    return { changed: true, data: { ...data, mcp_servers: { ...servers, [PRODUCT_BRIDGE_SERVER_ID]: next } } };
}
function assertNotSymlink(path, label) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (st.isSymbolicLink()) {
        throw new Error(`[setup-hooks] refusing to operate: ${label} ${path} is a symbolic link.`);
    }
}
function assertConfigPathSafe(path, label) {
    assertNotSymlink(path, label);
    assertNotSymlink(`${path}.evolver.lock`, `${label} lock`);
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink())
        throw new Error(`[setup-hooks] refusing to operate: ${label} parent directory is a symbolic link.`);
    if (!parent.isDirectory())
        throw new Error(`[setup-hooks] refusing to operate: ${label} parent is not a directory.`);
}
function readConfigSnapshot(path, label, parse) {
    assertConfigPathSafe(path, label);
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { data: {}, raw: undefined, mode: CONFIG_MODE };
        throw error;
    }
    if (!raw.trim())
        throw new Error(`[setup-hooks] refusing to overwrite ${label} (${path}): the existing file is empty.`);
    let data;
    try {
        data = parse(raw.trim());
    }
    catch (error) {
        throw new Error(`[setup-hooks] refusing to overwrite ${label} (${path}): the existing document is malformed.`, { cause: error });
    }
    if (!isObj(data))
        throw new Error(`[setup-hooks] refusing to overwrite ${label} (${path}): the existing document must be an object.`);
    const mode = statSync(path).mode & 0o777;
    return { data, raw, mode: mode === 0 ? CONFIG_MODE : mode & 0o700 };
}
function readRawIfExists(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function releaseConfigLock(lockPath) {
    const released = util.releaseLock(lockPath);
    if (!released.released)
        throw new util.LockReleaseError(released.reason);
}
/** Lock, compare, and commit a product bridge update without clobbering concurrent runtime writes. */
function updateConfigFile(path, label, parse, serialize, update) {
    const lockPath = `${path}.evolver.lock`;
    assertConfigPathSafe(path, label);
    util.acquireLock(lockPath);
    try {
        for (let attempt = 1; attempt <= CONFIG_WRITE_RETRIES; attempt += 1) {
            const snapshot = readConfigSnapshot(path, label, parse);
            const next = update(snapshot.data);
            if (!next.changed)
                return { changed: false, ...(next.skipped ? { skipped: true } : {}) };
            assertConfigPathSafe(path, label);
            if (readRawIfExists(path) !== snapshot.raw)
                continue;
            try {
                commitSharedFile({
                    path,
                    expectedRaw: snapshot.raw,
                    nextRaw: serialize(next.data),
                    mode: snapshot.mode,
                });
                return { changed: true };
            }
            catch (error) {
                if (error instanceof SharedFileConflictError)
                    continue;
                throw error;
            }
        }
        throw new Error(`[setup-hooks] refusing to overwrite ${label} (${path}): the file changed repeatedly while the product bridge was being installed.`);
    }
    finally {
        releaseConfigLock(lockPath);
    }
}
export function installClaudeProductBridge(configRoot, force = false, nodePath) {
    const path = join(configRoot, '.mcp.json');
    const result = updateConfigFile(path, '.mcp.json', (raw) => JSON.parse(raw), (data) => `${JSON.stringify(data, null, 2)}\n`, (data) => withClaudeProductBridge(data, force, nodePath));
    return { ...result, path };
}
export function uninstallClaudeProductBridge(configRoot) {
    const path = join(configRoot, '.mcp.json');
    if (!existsSync(path))
        return false;
    const result = updateConfigFile(path, '.mcp.json', (raw) => JSON.parse(raw), (data) => `${JSON.stringify(data, null, 2)}\n`, (data) => {
        const servers = data['mcpServers'];
        if (!isObj(servers) || !isOwnedProductBridge(servers[PRODUCT_BRIDGE_SERVER_ID]))
            return { changed: false, data };
        const next = { ...servers };
        const restored = restoreProductBridgeEntry(next[PRODUCT_BRIDGE_SERVER_ID]);
        if (restored.restored)
            next[PRODUCT_BRIDGE_SERVER_ID] = restored.entry;
        else
            delete next[PRODUCT_BRIDGE_SERVER_ID];
        const out = { ...data };
        if (Object.keys(next).length > 0)
            out['mcpServers'] = next;
        else
            delete out['mcpServers'];
        return { changed: true, data: out };
    });
    return result.changed;
}
export function installCodexProductBridge(configRoot, force = false, nodePath) {
    const path = join(configRoot, '.codex', 'config.toml');
    assertNotSymlink(join(configRoot, '.codex'), '.codex');
    mkdirSync(dirname(path), { recursive: true });
    const result = updateConfigFile(path, '.codex/config.toml', (raw) => parseToml(raw), (data) => `${stringifyToml(data)}\n`, (data) => withCodexProductBridge(data, force, nodePath));
    return { ...result, path };
}
export function uninstallCodexProductBridge(configRoot) {
    const path = join(configRoot, '.codex', 'config.toml');
    if (!existsSync(path))
        return false;
    const result = updateConfigFile(path, '.codex/config.toml', (raw) => parseToml(raw), (data) => `${stringifyToml(data)}\n`, (data) => {
        const servers = data['mcp_servers'];
        if (!isObj(servers) || !isOwnedProductBridge(servers[PRODUCT_BRIDGE_SERVER_ID]))
            return { changed: false, data };
        const next = { ...servers };
        const restored = restoreProductBridgeEntry(next[PRODUCT_BRIDGE_SERVER_ID]);
        if (restored.restored)
            next[PRODUCT_BRIDGE_SERVER_ID] = restored.entry;
        else
            delete next[PRODUCT_BRIDGE_SERVER_ID];
        const out = { ...data };
        if (Object.keys(next).length > 0)
            out['mcp_servers'] = next;
        else
            delete out['mcp_servers'];
        return { changed: true, data: out };
    });
    return result.changed;
}