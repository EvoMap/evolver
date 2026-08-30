// Passive SSE observer for provider streaming paths. The relay must stay byte-transparent (the client owns the
// SSE framing), so trace capture tees the stream: every chunk is forwarded untouched while a scanner accumulates
// just enough text to read provider-neutral metadata events. Parse failures are silently ignored: a trace without
// usage beats a broken relay.
import { ReadableStream } from 'node:stream/web';
import { bodyMaxChars, DEFAULT_TRACE_ENVELOPE_MAX_CHARS, positiveIntegerFromEnv, redactText, } from '../llm/bodyCapture.js';
/** Caps for OPT-IN streamed-content accumulation (see SseUsageScanner captureContent). Defaults align with the
 * trace body/envelope cap so normal Hub-sized streams are captured fully; env overrides can lower/raise them. */
const DEFAULT_STREAM_MAX_EVENTS = 100_000;
function sseCaptureLimits(env = process.env) {
    const bodyMax = bodyMaxChars(env);
    return {
        contentMaxChars: positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_STREAM_CONTENT_MAX_CHARS', 'EVOMAP_PROXY_TRACE_STREAM_CONTENT_MAX_CHARS'], bodyMax),
        contentMaxEvents: positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_STREAM_MAX_EVENTS', 'EVOMAP_PROXY_TRACE_STREAM_MAX_EVENTS'], DEFAULT_STREAM_MAX_EVENTS),
        semanticTailMaxEvents: positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_STREAM_SEMANTIC_TAIL_MAX_EVENTS', 'EVOMAP_PROXY_TRACE_STREAM_SEMANTIC_TAIL_MAX_EVENTS'], DEFAULT_STREAM_MAX_EVENTS),
        rawStreamMaxChars: positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_STREAM_RAW_MAX_CHARS', 'EVOMAP_PROXY_TRACE_STREAM_RAW_MAX_CHARS'], bodyMax),
    };
}
/** Append a streamed text delta to the running content buffer, bounded by the configured capture cap. */
function appendContent(into, piece, limits) {
    if (typeof piece !== 'string' || piece.length === 0)
        return;
    const cur = into.content_text ?? '';
    if (cur.length >= limits.contentMaxChars) {
        into.content_truncated = true;
        return;
    }
    const next = cur + piece;
    if (next.length > limits.contentMaxChars)
        into.content_truncated = true;
    into.content_text = next.slice(0, limits.contentMaxChars);
}
function appendEvent(into, evt, limits) {
    const events = into.content_events ?? [];
    if (events.length >= limits.contentMaxEvents) {
        into.dropped_event_count = (into.dropped_event_count ?? 0) + 1;
        appendSemanticTailEvent(into, evt, limits);
        return;
    }
    events.push(evt);
    into.content_events = events;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function hasUsage(value) {
    return isRecord(value) && Object.keys(value).length > 0;
}
function isSemanticToolType(value) {
    return value === 'function_call' || value === 'tool_use' || value === 'function_call_output' || value === 'tool_result';
}
function compactSemanticChoice(choice) {
    if (!isRecord(choice))
        return null;
    const out = {};
    if (choice['index'] !== undefined)
        out['index'] = choice['index'];
    if (choice['finish_reason'] !== undefined)
        out['finish_reason'] = choice['finish_reason'];
    const delta = isRecord(choice['delta']) ? choice['delta'] : undefined;
    if (delta) {
        const compactDelta = {};
        if (Array.isArray(delta['tool_calls']))
            compactDelta['tool_calls'] = delta['tool_calls'];
        if (isRecord(delta['function_call']))
            compactDelta['function_call'] = delta['function_call'];
        if (Object.keys(compactDelta).length > 0)
            out['delta'] = compactDelta;
    }
    const message = isRecord(choice['message']) ? choice['message'] : undefined;
    if (message) {
        const compactMessage = {};
        if (Array.isArray(message['tool_calls']))
            compactMessage['tool_calls'] = message['tool_calls'];
        if (isRecord(message['function_call']))
            compactMessage['function_call'] = message['function_call'];
        if (Object.keys(compactMessage).length > 0)
            out['message'] = compactMessage;
    }
    return Object.keys(out).length > 0 ? out : null;
}
function compactToolItems(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => isRecord(item) && isSemanticToolType(item['type']));
}
function compactStreamEvent(evt) {
    if (!isRecord(evt))
        return null;
    const out = {};
    for (const key of ['type', 'id', 'responseId', 'item_id', 'output_index', 'call_id']) {
        if (evt[key] !== undefined)
            out[key] = evt[key];
    }
    if (hasUsage(evt['usage']))
        out['usage'] = evt['usage'];
    if (hasUsage(evt['usageMetadata']))
        out['usageMetadata'] = evt['usageMetadata'];
    if (Array.isArray(evt['choices'])) {
        const choices = evt['choices'].map(compactSemanticChoice).filter((choice) => choice !== null);
        if (choices.length > 0)
            out['choices'] = choices;
    }
    const message = isRecord(evt['message']) ? evt['message'] : undefined;
    if (message) {
        const compactMessage = {};
        if (message['id'] !== undefined)
            compactMessage['id'] = message['id'];
        if (hasUsage(message['usage']))
            compactMessage['usage'] = message['usage'];
        if (Array.isArray(message['tool_calls']))
            compactMessage['tool_calls'] = message['tool_calls'];
        if (isRecord(message['function_call']))
            compactMessage['function_call'] = message['function_call'];
        if (Object.keys(compactMessage).length > 0)
            out['message'] = compactMessage;
    }
    const response = isRecord(evt['response']) ? evt['response'] : undefined;
    if (response) {
        const compactResponse = {};
        if (response['id'] !== undefined)
            compactResponse['id'] = response['id'];
        if (response['status'] !== undefined)
            compactResponse['status'] = response['status'];
        if (response['incomplete_details'] !== undefined)
            compactResponse['incomplete_details'] = response['incomplete_details'];
        if (hasUsage(response['usage']))
            compactResponse['usage'] = response['usage'];
        const output = compactToolItems(response['output']);
        if (output.length > 0)
            compactResponse['output'] = output;
        if (Object.keys(compactResponse).length > 0)
            out['response'] = compactResponse;
    }
    const item = isRecord(evt['item']) ? evt['item'] : undefined;
    if (item && isSemanticToolType(item['type']))
        out['item'] = item;
    const delta = isRecord(evt['delta']) ? evt['delta'] : undefined;
    if (delta) {
        const compactDelta = {};
        if (delta['type'] === 'input_json_delta')
            compactDelta['type'] = delta['type'];
        if (delta['partial_json'] !== undefined)
            compactDelta['partial_json'] = delta['partial_json'];
        if (Array.isArray(delta['tool_calls']))
            compactDelta['tool_calls'] = delta['tool_calls'];
        if (isRecord(delta['function_call']))
            compactDelta['function_call'] = delta['function_call'];
        if (Object.keys(compactDelta).length > 0)
            out['delta'] = compactDelta;
    }
    const contentBlock = isRecord(evt['content_block']) ? evt['content_block'] : undefined;
    if (contentBlock && isSemanticToolType(contentBlock['type']))
        out['content_block'] = contentBlock;
    return Object.keys(out).length > 0 ? out : null;
}
function streamEventHasSemanticValue(evt) {
    if (!isRecord(evt))
        return false;
    const type = typeof evt['type'] === 'string' ? evt['type'] : '';
    const message = isRecord(evt['message']) ? evt['message'] : undefined;
    const response = isRecord(evt['response']) ? evt['response'] : undefined;
    if (hasUsage(evt['usage']) || hasUsage(evt['usageMetadata']) || hasUsage(message?.['usage']) || hasUsage(response?.['usage']))
        return true;
    if (response?.['id'] || response?.['status'] || response?.['incomplete_details'] || message?.['id'] || evt['responseId'])
        return true;
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete')
        return true;
    if (type.includes('function_call') || type.includes('tool'))
        return true;
    const item = isRecord(evt['item']) ? evt['item'] : undefined;
    if (item && isSemanticToolType(item['type']))
        return true;
    const contentBlock = isRecord(evt['content_block']) ? evt['content_block'] : undefined;
    if (contentBlock && isSemanticToolType(contentBlock['type']))
        return true;
    const delta = isRecord(evt['delta']) ? evt['delta'] : undefined;
    if (delta && (delta['type'] === 'input_json_delta' || Array.isArray(delta['tool_calls']) || isRecord(delta['function_call'])))
        return true;
    const choices = Array.isArray(evt['choices']) ? evt['choices'] : [];
    return choices.some((choice) => {
        if (!isRecord(choice))
            return false;
        const choiceDelta = isRecord(choice['delta']) ? choice['delta'] : undefined;
        const choiceMessage = isRecord(choice['message']) ? choice['message'] : undefined;
        return choice['finish_reason'] !== undefined
            || Array.isArray(choiceDelta?.['tool_calls'])
            || isRecord(choiceDelta?.['function_call'])
            || Array.isArray(choiceMessage?.['tool_calls'])
            || isRecord(choiceMessage?.['function_call']);
    });
}
function appendSemanticTailEvent(into, evt, limits) {
    if (!streamEventHasSemanticValue(evt))
        return;
    const compact = compactStreamEvent(evt);
    if (!compact)
        return;
    const tail = into.semantic_tail_events ?? [];
    tail.push(compact);
    if (tail.length > limits.semanticTailMaxEvents)
        tail.splice(0, tail.length - limits.semanticTailMaxEvents);
    into.semantic_tail_events = tail;
}
/** Extract a streamed text delta across the three wire formats: Anthropic content_block_delta(text_delta),
 * OpenAI chat choices[].delta.content, OpenAI Responses response.output_text.delta. Best-effort; unknown shapes
 * are ignored. */
function extractContentDelta(into, o, limits) {
    const type = typeof o['type'] === 'string' ? o['type'] : '';
    // Anthropic: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
    if (type === 'content_block_delta') {
        const delta = o['delta'];
        if (delta && typeof delta === 'object')
            appendContent(into, delta['text'], limits);
        return;
    }
    // OpenAI Responses: { type: 'response.output_text.delta', delta: '...' }
    if (type === 'response.output_text.delta') {
        appendContent(into, o['delta'], limits);
        return;
    }
    // OpenAI Chat Completions: { choices: [{ delta: { content: '...' } }] }
    const choices = o['choices'];
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
        const delta = choices[0]['delta'];
        if (delta && typeof delta === 'object')
            appendContent(into, delta['content'], limits);
    }
}
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
/** Partial-line buffer cap: a pathological stream with no newlines must not grow memory unbounded. OpenAI
 * Responses `response.completed` can put the full response onto one data line, so keep this generous. */
export const MAX_PARTIAL_LINE_BYTES = DEFAULT_TRACE_ENVELOPE_MAX_CHARS;
const LARGE_LINE_SCAN_TAIL_BYTES = 128 * 1024;
function clipError(value) {
    return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function mergeUsage(into, raw) {
    if (!raw || typeof raw !== 'object')
        return;
    const u = raw;
    const usage = into.usage ?? {};
    for (const k of USAGE_KEYS)
        if (typeof u[k] === 'number')
            usage[k] = u[k];
    if (typeof u['prompt_tokens'] === 'number')
        usage.input_tokens = u['prompt_tokens'];
    if (typeof u['completion_tokens'] === 'number')
        usage.output_tokens = u['completion_tokens'];
    const tokenDetails = u['input_tokens_details'] ?? u['prompt_tokens_details'];
    if (tokenDetails && typeof tokenDetails === 'object') {
        const cached = tokenDetails['cached_tokens'];
        if (typeof cached === 'number')
            usage.cache_read_input_tokens = cached;
    }
    if (Object.keys(usage).length > 0)
        into.usage = usage;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return null;
}
function nestedErrorMessage(value) {
    if (!value || typeof value !== 'object')
        return null;
    const o = value;
    return firstString(o['message'], o['type'], o['code']);
}
function responseIdFromEvent(o) {
    const message = o['message'];
    const response = o['response'];
    return firstString(message && typeof message === 'object' ? message['id'] : undefined, response && typeof response === 'object' ? response['id'] : undefined, typeof o['id'] === 'string' && /^(?:resp_|chatcmpl-|msg_)/.test(o['id']) ? o['id'] : undefined);
}
function applyEvent(into, evt, captureContent = false, limits = sseCaptureLimits()) {
    if (!evt || typeof evt !== 'object')
        return;
    const o = evt;
    if (captureContent) {
        appendEvent(into, evt, limits);
        extractContentDelta(into, o, limits);
    }
    const message = o['message'];
    const response = o['response'];
    mergeUsage(into, o['usage']);
    if (message && typeof message === 'object')
        mergeUsage(into, message['usage']);
    if (response && typeof response === 'object')
        mergeUsage(into, response['usage']);
    const delta = o['delta'];
    if (delta && typeof delta === 'object') {
        const sr = delta['stop_reason'];
        if (typeof sr === 'string' || sr === null)
            into.stop_reason = sr;
    }
    if (response && typeof response === 'object') {
        const r = response;
        const incomplete = r['incomplete_details'];
        const reason = incomplete && typeof incomplete === 'object'
            ? incomplete['reason']
            : undefined;
        if (typeof reason === 'string')
            into.stop_reason = reason;
        else if (typeof r['status'] === 'string')
            into.stop_reason = r['status'];
        if (r['status'] === 'failed' || r['status'] === 'cancelled') {
            into.error = clipError(nestedErrorMessage(r['error']) ?? `provider stream ${r['status']}`);
        }
    }
    const choices = o['choices'];
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
        const finish = choices[0]['finish_reason'];
        if (typeof finish === 'string' || finish === null)
            into.stop_reason = finish;
    }
    const rid = responseIdFromEvent(o);
    if (rid)
        into.response_id = rid;
    const type = typeof o['type'] === 'string' ? o['type'] : '';
    const topError = nestedErrorMessage(o['error']);
    if (type === 'error' || topError)
        into.error = clipError(topError ?? 'provider stream error');
}
function setNumberUsage(into, key, match) {
    if (!match?.[1])
        return;
    const n = Number(match[1]);
    if (!Number.isFinite(n))
        return;
    const usage = into.usage ?? {};
    usage[key] = n;
    into.usage = usage;
}
function scanTextMetadata(into, text) {
    const id = /"id"\s*:\s*"((?:resp_|chatcmpl-|msg_)[^"]+)"/.exec(text);
    if (id?.[1])
        into.response_id = id[1];
    const status = /"status"\s*:\s*"(completed|failed|incomplete|cancelled)"/.exec(text);
    if (status?.[1])
        into.stop_reason = status[1];
    setNumberUsage(into, 'input_tokens', /"input_tokens"\s*:\s*(\d+)/.exec(text));
    setNumberUsage(into, 'output_tokens', /"output_tokens"\s*:\s*(\d+)/.exec(text));
    setNumberUsage(into, 'input_tokens', /"prompt_tokens"\s*:\s*(\d+)/.exec(text));
    setNumberUsage(into, 'output_tokens', /"completion_tokens"\s*:\s*(\d+)/.exec(text));
    setNumberUsage(into, 'cache_read_input_tokens', /"cached_tokens"\s*:\s*(\d+)/.exec(text));
    const looksLikeFailure = /"type"\s*:\s*"response\.failed"/.test(text)
        || /"status"\s*:\s*"(failed|cancelled)"/.test(text);
    if (!looksLikeFailure)
        return;
    const error = /"error"\s*:\s*\{[^{}]{0,2000}?"message"\s*:\s*"([^"]+)"/.exec(text)
        ?? /"type"\s*:\s*"response\.failed"[^{}]{0,2000}?"message"\s*:\s*"([^"]+)"/.exec(text);
    if (error?.[1])
        into.error = clipError(error[1]);
}
export class SseUsageScanner {
    result = {};
    buf = '';
    overCapLine = false;
    largeLineTail = '';
    rawStreamChars = 0;
    decoder = new TextDecoder();
    /** OPT-IN: when true, accumulate streamed completion text into result.content_text (bounded). Default false
     * keeps the scanner metadata-only. Driven by the body-capture flag (see bodyCapture.ts). */
    captureContent;
    limits;
    maxPartialLineBytes;
    constructor(opts = {}) {
        this.captureContent = opts.captureContent === true;
        const env = opts.env ?? process.env;
        this.limits = sseCaptureLimits(env);
        this.maxPartialLineBytes = positiveIntegerFromEnv(env, ['EVOLVER_LLM_TRACE_STREAM_LINE_MAX_BYTES', 'EVOMAP_PROXY_TRACE_STREAM_LINE_MAX_BYTES'], MAX_PARTIAL_LINE_BYTES);
    }
    push(chunk) {
        let text;
        if (typeof chunk === 'string')
            text = chunk;
        else if (chunk instanceof Uint8Array)
            text = this.decoder.decode(chunk, { stream: true });
        else
            return;
        if (this.captureContent)
            this.captureRawStream(text);
        this.pushText(text, false);
    }
    finish() {
        const finalText = this.decoder.decode();
        if (finalText) {
            if (this.captureContent)
                this.captureRawStream(finalText);
            this.pushText(finalText, false);
        }
        this.pushText('', true);
    }
    captureRawStream(text) {
        if (!text)
            return;
        const redacted = redactText(text);
        const current = this.result.raw_stream_body ?? '';
        const available = Math.max(0, this.limits.rawStreamMaxChars - this.rawStreamChars);
        if (available > 0) {
            const piece = redacted.slice(0, available);
            this.result.raw_stream_body = current + piece;
            this.rawStreamChars += piece.length;
        }
        if (redacted.length > available)
            this.result.raw_stream_truncated = true;
    }
    pushText(text, flush) {
        if (this.overCapLine && text) {
            this.scanLargeLineText(text);
        }
        this.buf += text;
        for (;;) {
            const nl = this.buf.indexOf('\n');
            if (nl < 0)
                break;
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (this.overCapLine) {
                this.scanLargeLineText(line);
                this.overCapLine = false;
                this.largeLineTail = '';
                continue;
            }
            this.scanLine(line);
        }
        if (flush && this.buf.length > 0) {
            const line = this.buf.trim();
            this.buf = '';
            if (this.overCapLine) {
                this.scanLargeLineText(line);
                this.overCapLine = false;
                this.largeLineTail = '';
                const dataAt = line.indexOf('data:');
                if (dataAt >= 0)
                    this.scanLine(line.slice(dataAt));
            }
            else {
                this.scanLine(line);
            }
        }
        if (this.buf.length > this.maxPartialLineBytes) {
            this.markDroppedDataLine(this.buf);
            this.scanLargeLineText(this.buf);
            this.buf = '';
            this.overCapLine = true;
        }
    }
    scanLargeLineText(text) {
        this.largeLineTail = (this.largeLineTail + text).slice(-LARGE_LINE_SCAN_TAIL_BYTES);
        scanTextMetadata(this.result, text);
        scanTextMetadata(this.result, this.largeLineTail);
    }
    markDroppedDataLine(line) {
        if (!this.captureContent || !line.trimStart().startsWith('data:'))
            return;
        this.result.content_truncated = true;
        this.result.dropped_event_count = (this.result.dropped_event_count ?? 0) + 1;
    }
    scanLine(line) {
        if (!line.startsWith('data:'))
            return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]')
            return;
        let evt;
        try {
            evt = JSON.parse(payload);
        }
        catch {
            return;
        }
        applyEvent(this.result, evt, this.captureContent, this.limits);
    }
}
/**
 * Wrap a stream so every chunk passes to `push` before reaching the consumer, with `onEnd` fired exactly once
 * on completion, error, or client cancel. Handles the two shapes _streamResponse relays (Web ReadableStream
 * and async iterables); anything opaque is returned untouched with an immediate onEnd (trace without usage).
 */
export function teeStreamForScan(stream, push, onEnd) {
    let ended = false;
    const finish = (info) => {
        if (ended)
            return;
        ended = true;
        try {
            onEnd(info);
        }
        catch { /* trace emission must never break the relay */ }
    };
    if (stream && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        return new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await reader.read();
                    if (done) {
                        finish();
                        controller.close();
                        return;
                    }
                    push(value);
                    controller.enqueue(value);
                }
                catch (err) {
                    finish({ error: errMsg(err) });
                    controller.error(err);
                }
            },
            cancel(reason) {
                finish({ cancelled: true, ...(reason !== undefined ? { error: `stream cancelled: ${errMsg(reason)}` } : {}) });
                return reader.cancel(reason).catch(() => undefined);
            },
        });
    }
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        const src = stream;
        return (async function* tee() {
            let info;
            try {
                for await (const chunk of src) {
                    push(chunk);
                    yield chunk;
                }
            }
            catch (err) {
                info = { error: errMsg(err) };
                throw err;
            }
            finally {
                finish(info);
            }
        })();
    }
    finish();
    return stream;
}