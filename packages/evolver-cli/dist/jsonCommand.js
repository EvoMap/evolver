import { authoring } from '@evomap/evolver-core';
export class JsonCommandError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'JsonCommandError';
    }
}
export const SMALL_REQUEST_BYTES = 64 * 1024;
export const LARGE_REQUEST_BYTES = 512 * 1024;
const MAX_ERROR_CHARS = 300;
function envLocale(io) {
    return authoring.authoringLocale(undefined, io.env ?? process.env);
}
export function requestLocale(request, io) {
    return authoring.authoringLocale(request['locale'], io.env ?? process.env);
}
export function inputError(locale, zh, en) {
    return new JsonCommandError('INPUT_INVALID', authoring.say(locale, zh, en));
}
/** One JSON object on stdin (an interactive terminal counts as `{}`), bounded before it is parsed. */
export async function readJsonRequest(limit, io) {
    const stdin = io.stdin ?? process.stdin;
    const locale = envLocale(io);
    if (stdin.isTTY)
        return {};
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limit)
            throw inputError(locale, `请求超过 ${limit / 1024} KiB 上限。`, `The request exceeds the ${limit / 1024} KiB limit.`);
        chunks.push(buffer);
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}');
    }
    catch {
        throw inputError(locale, '请求不是有效的 JSON。', 'The request is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw inputError(locale, '请求需要是一个 JSON 对象。', 'The request must be a JSON object.');
    return parsed;
}
function clipped(message) {
    return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
}
/** The versioned envelope every Desktop-facing command shares: one line of JSON, exit 0 when ok and 1 otherwise. */
export async function runJsonCommand(schema, operation, io, run) {
    const stdout = io.stdout ?? ((text) => { process.stdout.write(text); });
    const emit = (payload) => stdout(`${JSON.stringify({ schema, operation, ...payload })}\n`);
    try {
        emit({ ok: true, result: await run() });
        return 0;
    }
    catch (error) {
        const failure = error instanceof JsonCommandError ? error
            : new JsonCommandError('INTERNAL', authoring.say(envLocale(io), '命令执行失败，请检查本地 Evolver 安装与目录权限。', 'The command failed; check the local Evolver installation and directory permissions.'));
        emit({ ok: false, code: failure.code, error: clipped(failure.message) });
        return 1;
    }
}
export function optionalString(request, key, locale, maxChars = 100_000) {
    const value = request[key];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string' || value.length > maxChars || value.includes('\0'))
        throw inputError(locale, `${key} 需要是不超过 ${maxChars} 字的文本。`, `${key} must be text of at most ${maxChars} characters.`);
    return value;
}
export function requiredString(request, key, locale, maxChars = 100_000) {
    const value = optionalString(request, key, locale, maxChars);
    if (value === undefined)
        throw inputError(locale, `缺少 ${key}。`, `Missing ${key}.`);
    return value;
}
export function optionalStrings(request, key, locale, maxItems = 200, maxChars = 2000) {
    const value = request[key];
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length > maxChars || item.includes('\0'))) {
        throw inputError(locale, `${key} 需要是最多 ${maxItems} 条文本的列表。`, `${key} must be a list of at most ${maxItems} strings.`);
    }
    return value;
}
export function optionalEnum(request, key, values, locale) {
    const value = request[key];
    if (value === undefined || value === null)
        return undefined;
    if (!values.includes(value))
        throw inputError(locale, `${key} 只能是 ${values.join('、')}。`, `${key} must be one of ${values.join(', ')}.`);
    return value;
}
export function requiredEnum(request, key, values, locale) {
    const value = optionalEnum(request, key, values, locale);
    if (value === undefined)
        throw inputError(locale, `缺少 ${key}（${values.join('、')}）。`, `Missing ${key} (${values.join(', ')}).`);
    return value;
}
export function requiredObject(request, key, locale) {
    const value = request[key];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw inputError(locale, `缺少 ${key} 对象。`, `Missing the ${key} object.`);
    return value;
}
/** The operation word and that the remaining flags are only `--json`; anything else is an input error. */
export function operationOf(argv, operations, io) {
    const operation = argv[0] ?? '';
    const locale = envLocale(io);
    if (!operations.includes(operation)) {
        return { operation, error: inputError(locale, `不支持的操作，可用：${operations.join('、')}。`, `Unsupported operation; use one of ${operations.join(', ')}.`) };
    }
    const extra = argv.slice(1).find((arg) => arg !== '--json');
    return extra ? { operation, error: inputError(locale, `不支持的参数：${extra.slice(0, 40)}`, `Unsupported argument: ${extra.slice(0, 40)}`) } : { operation };
}