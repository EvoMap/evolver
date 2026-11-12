import { authoring } from '@evomap/evolver-core';
import { LARGE_REQUEST_BYTES, inputError, operationOf, optionalStrings, readJsonRequest, requestLocale, runJsonCommand, } from './jsonCommand.js';
const REDACT_SCHEMA = 'evolver.redact.v1';
const MAX_TEXTS = 500;
const MAX_TERMS = 200;
const MAX_TERM_CHARS = 200;
/** `evolver redact --json`: what would be removed from each text before it leaves this machine, with exact offsets. Read-only. */
export async function runRedactCommand(argv, io = {}) {
    const { error } = operationOf(['redact', ...argv], ['redact'], io);
    return runJsonCommand(REDACT_SCHEMA, 'redact', io, async () => {
        if (error)
            throw error;
        const request = await readJsonRequest(LARGE_REQUEST_BYTES, io);
        const locale = requestLocale(request, io);
        const texts = optionalStrings(request, 'texts', locale, MAX_TEXTS, LARGE_REQUEST_BYTES);
        if (!texts)
            throw inputError(locale, `缺少 texts（最多 ${MAX_TEXTS} 段文本）。`, `Missing texts (at most ${MAX_TEXTS}).`);
        const terms = optionalStrings(request, 'terms', locale, MAX_TERMS, MAX_TERM_CHARS);
        const identifiers = optionalStrings(request, 'identifiers', locale, MAX_TERMS, MAX_TERM_CHARS);
        const items = texts.map((text) => {
            const { text: redacted, findings } = authoring.redactWithFindings({ text, env: io.env ?? process.env, locale,
                ...(terms ? { terms } : {}), ...(identifiers ? { identifiers } : {}) });
            return { text: redacted, findings };
        });
        return { rulesVersion: authoring.REDACTION_RULES_VERSION, items };
    });
}