import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
export function expandHomePath(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return join(homedir(), path.slice(2));
    return path;
}
export function parseEnvFile(raw) {
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
        const eq = body.indexOf('=');
        if (eq <= 0)
            continue;
        const key = body.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        out[key] = unquoteEnvValue(body.slice(eq + 1).trim());
    }
    return out;
}
export function loadEnvFile(path, env = process.env) {
    const resolved = isAbsolute(path) ? path : expandHomePath(path);
    try {
        const parsed = parseEnvFile(readFileSync(resolved, 'utf8'));
        const keys = Object.keys(parsed);
        for (const key of keys) {
            if (key === ENV_FILE_KEY)
                continue;
            env[key] = parsed[key];
        }
        return { loaded: true, path: resolved, keys };
    }
    catch (err) {
        return { loaded: false, path: resolved, keys: [], error: err instanceof Error ? err.message : String(err) };
    }
}
export function loadEnvFileFromEnv(env = process.env) {
    const path = env[ENV_FILE_KEY]?.trim();
    if (!path)
        return { loaded: false, keys: [] };
    return loadEnvFile(path, env);
}
function unquoteEnvValue(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = value.slice(1, -1);
            return first === '"' ? inner.replace(/\\(["\\nrt])/g, (_, ch) => {
                switch (ch) {
                    case 'n': return '\n';
                    case 'r': return '\r';
                    case 't': return '\t';
                    default: return ch;
                }
            }) : inner;
        }
    }
    return value;
}