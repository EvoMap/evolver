import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHomePath, parseEnvFile } from '../bin/envFile.js';
import { resolvePrivateEnterpriseToken } from './adapterLoader.js';
const CONFIG_FILES = ['.mcp.json', join('.claude', 'settings.json'), join('.codex', 'config.toml')];
const POINTER_RE = /EVOLVER_ENV_FILE"?\s*[:=]\s*"([^"]+)"/;
export function resolvePrivateRuntimeSmokeOptions(sourceEnv = process.env, readEnvFileOrDeps) {
    const deps = normalizeDeps(readEnvFileOrDeps);
    const env = { ...sourceEnv };
    const envFilePath = resolveEnvFilePath(env, deps);
    if (envFilePath) {
        env['EVOLVER_ENV_FILE'] = envFilePath;
        try {
            const parsed = parseEnvFile(readEnvFile(envFilePath, deps));
            for (const [key, value] of Object.entries(parsed)) {
                if (key !== 'EVOLVER_ENV_FILE')
                    env[key] = value;
            }
            const insecureMode = insecureSecretFileMode(Object.keys(parsed), readStatMode(envFilePath, deps));
            if (env['EVOLVER_PRIVATE_SMOKE'] === '1' && insecureMode) {
                throw new Error(`EVOLVER_ENV_FILE mode ${insecureMode.modeText} exposes secret-like keys [${insecureMode.keys.join(', ')}]; run chmod 600 on the credential store`);
            }
        }
        catch (error) {
            if (env['EVOLVER_PRIVATE_SMOKE'] === '1') {
                throw new Error(`failed to load EVOLVER_ENV_FILE for private runtime smoke: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    const run = env['EVOLVER_PRIVATE_SMOKE'] === '1';
    const runSearch = env['EVOLVER_PRIVATE_SMOKE_SEARCH'] === '1';
    const runReuseResult = env['EVOLVER_PRIVATE_SMOKE_REUSE_RESULT'] === '1';
    const runPublish = env['EVOLVER_PRIVATE_SMOKE_PUBLISH'] === '1';
    const hubUrl = env['EVOMAP_HUB_URL']?.trim();
    const assetId = env['EVOLVER_PRIVATE_SMOKE_ASSET_ID']?.trim();
    if (run && env['EVOMAP_HUB_MODE']?.trim().toLowerCase() !== 'private') {
        throw new Error('EVOLVER_PRIVATE_SMOKE requires EVOMAP_HUB_MODE=private');
    }
    if (run && !hubUrl) {
        throw new Error('EVOLVER_PRIVATE_SMOKE requires EVOMAP_HUB_URL pointing at a controlled PHub test-env');
    }
    if (run && !resolvePrivateEnterpriseToken(env)) {
        throw new Error('EVOLVER_PRIVATE_SMOKE requires an enterprise token alias in EVOLVER_ENV_FILE or process env');
    }
    if (run && isProductionLikeHubUrl(hubUrl)) {
        throw new Error('EVOLVER_PRIVATE_SMOKE refuses production-like PHub URL; use a test/staging/dev/local PHub URL');
    }
    if (run && runReuseResult && !runSearch && !assetId) {
        throw new Error('EVOLVER_PRIVATE_SMOKE_REUSE_RESULT=1 requires EVOLVER_PRIVATE_SMOKE_ASSET_ID or EVOLVER_PRIVATE_SMOKE_SEARCH=1');
    }
    return {
        env,
        run,
        runSearch,
        runReuseResult,
        runPublish,
    };
}
function normalizeDeps(readEnvFileOrDeps) {
    if (typeof readEnvFileOrDeps === 'function')
        return { readEnvFile: readEnvFileOrDeps };
    return readEnvFileOrDeps ?? {};
}
function resolveEnvFilePath(env, deps) {
    const fromEnv = env['EVOLVER_ENV_FILE']?.trim();
    if (fromEnv)
        return fromEnv;
    const root = deps.configRoot ?? process.cwd();
    const exists = deps.exists ?? existsSync;
    const readConfig = deps.readConfigFile ?? ((path) => readFileSync(path, 'utf8'));
    for (const rel of CONFIG_FILES) {
        const path = join(root, rel);
        if (!exists(path))
            continue;
        try {
            const match = POINTER_RE.exec(readConfig(path));
            if (match?.[1])
                return match[1];
        }
        catch {
            // Ignore unreadable runtime config candidates; the env file itself remains the authoritative smoke input.
        }
    }
    return undefined;
}
function readEnvFile(path, deps) {
    if (deps.readEnvFile)
        return deps.readEnvFile(path);
    return readFileSync(expandHomePath(path), 'utf8');
}
function readStatMode(path, deps) {
    if (deps.statMode)
        return deps.statMode(path);
    if (deps.readEnvFile)
        return undefined;
    try {
        return statSync(expandHomePath(path)).mode;
    }
    catch {
        return undefined;
    }
}
function insecureSecretFileMode(keys, mode) {
    if (mode === undefined)
        return undefined;
    if ((mode & 0o077) === 0)
        return undefined;
    const secretKeys = keys.filter(isSecretKeyName);
    return secretKeys.length > 0 ? { modeText: (mode & 0o777).toString(8).padStart(3, '0'), keys: secretKeys } : undefined;
}
function isSecretKeyName(key) {
    return /(^|_)(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|NODE_SECRET|IPC_TOKEN)(_|$)/.test(key);
}
function isProductionLikeHubUrl(raw) {
    if (!raw)
        return false;
    try {
        const host = new URL(raw).hostname.toLowerCase();
        if (isLocalHubHost(host))
            return false;
        return !/(^|[-.])(test|staging|stage|dev|local)([-.]|$)/.test(host);
    }
    catch {
        return true;
    }
}
function isLocalHubHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(host);
}