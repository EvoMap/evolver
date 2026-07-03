import { createHash } from 'node:crypto';
export const SIGNATURE_V = 1;
function sha1(...parts) {
    return createHash('sha1').update(parts.join('\x1f')).digest('hex');
}
/** 文本归一化: 小写+NFKC+去标点+折叠空白 → 同义不同措辞归并. */
export function normalizeText(s) {
    return s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
/** 栈帧归一化: 去绝对路径/行列号, 留 fn@basename. */
export function normalizeStackFrame(frame) {
    const f = frame.trim().replace(/^at\s+/, '');
    const pathMatch = f.match(/\(?([^()\s]+?):(\d+)(?::(\d+))?\)?$/);
    const fnMatch = f.match(/^([^(]+?)\s*\(/);
    const fileWithPath = pathMatch?.[1] ?? f;
    const base = fileWithPath.split(/[/\\]/).pop() ?? fileWithPath;
    const fn = fnMatch?.[1]?.trim() ?? '';
    return fn ? `${fn}@${base}` : base;
}
export function exitCodeClass(code) {
    if (code === undefined)
        return 'none';
    if (code === 0)
        return 'ok';
    if (code === 1)
        return 'general';
    if (code === 2)
        return 'misuse';
    if (code === 126 || code === 127)
        return 'notfound';
    if (code >= 128)
        return 'signal';
    return 'other';
}
export function eventSignature(input) {
    const top3 = (input.stack ?? []).slice(0, 3).map(normalizeStackFrame).join('|');
    return sha1('ev', normalizeText(input.errorClass), top3, input.syscall ?? '', exitCodeClass(input.exitCode));
}
export function problemSignature(input) {
    const tags = [...(input.domainTags ?? [])].map(normalizeText).sort().join(',');
    return sha1('pb', normalizeText(input.problemKind), tags, normalizeText(input.affectedSurface ?? ''), normalizeText(input.failureMode ?? ''));
}