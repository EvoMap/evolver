import { createDecipheriv, createHash, privateDecrypt, constants } from 'node:crypto';
import { REDACTED, redactString } from '../hub/sanitize.js';
export const CODING_TRAJECTORY_SCHEMA = 'evomap.coding_trajectory.v1';
const RUNTIME_SESSION_REDACTION = 'evolver-redact-v2';
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function runtimeKeyParts(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.toLowerCase());
}
const RUNTIME_SENSITIVE_KEY_PARTS = new Set([
    'authentication',
    'authorization',
    'auth',
    'cookie',
    'cookies',
    'credentials',
    'dsn',
    'password',
    'secret',
    'token',
]);
const RUNTIME_SENSITIVE_KEY_COMPOUNDS = [
    'apikey',
    'clientsecret',
    'nodesecret',
    'privatekey',
];
const RUNTIME_STABLE_IDENTITY_KEY_RE = /(?:^|[_-])(?:user|session|device)[_-]?id(?:$|[_-])/i;
function isRuntimeSensitiveKey(key) {
    const parts = runtimeKeyParts(key);
    const normalized = parts.join('');
    if (parts.some((part) => RUNTIME_SENSITIVE_KEY_PARTS.has(part)))
        return true;
    return RUNTIME_SENSITIVE_KEY_COMPOUNDS.some((sensitive) => normalized.includes(sensitive));
}
function isRuntimeStableIdentityKey(key) {
    return RUNTIME_STABLE_IDENTITY_KEY_RE.test(key);
}
// Claude Code's metadata.user_id has the shape
// `user_<accountHash>_account__session_<sessionUuid>`. The session uuid changes
// every session, so hashing the whole value yields a different id per session,
// which breaks downstream cross-session de-duplication / anti-sybil. We strip
// the `__session_<uuid>` suffix and hash only the stable account portion so the
// same real account maps to the same redacted id across sessions. Non-Claude
// values (no `__session_` marker) fall back to hashing the whole value.
function stableIdentityHashSource(value) {
    let serialized;
    try {
        serialized = typeof value === 'string' ? value : JSON.stringify(value);
    }
    catch {
        serialized = String(value);
    }
    const sessionMarker = serialized.indexOf('__session_');
    if (sessionMarker > 0)
        return serialized.slice(0, sessionMarker);
    return serialized;
}
function stableIdentityPlaceholder(value) {
    const source = stableIdentityHashSource(value);
    const hash = createHash('sha256').update(`evomap-stable-identity-v1:${source}`, 'utf8').digest('hex').slice(0, 16);
    return `[REDACTED_ID_SHA256:${hash}]`;
}
function redactRuntimeStableIdentity(value) {
    if (value === undefined || value === null)
        return value;
    return stableIdentityPlaceholder(value);
}
// Deterministic, cross-session-stable hash of an account identity, used to emit
// an explicit `user_id_hash` sibling field so buyers get a stable de-dup key
// without ever seeing the plaintext account id. Reuses stableIdentityHashSource
// so it stays consistent with the in-place redacted user_id token.
export function stableUserIdHash(value) {
    const source = stableIdentityHashSource(value);
    return createHash('sha256').update(`evomap-stable-identity-v1:${source}`, 'utf8').digest('hex').slice(0, 16);
}
const USER_ID_KEY_RE = /(?:^|[_-])user[_-]?id(?:$|[_-])/i;
function redactRuntimeStructuredValue(value) {
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value))
        return value.map((entry) => redactRuntimeStructuredValue(entry));
    if (isRecord(value)) {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = isRuntimeSensitiveKey(key)
                ? REDACTED
                : (isRuntimeStableIdentityKey(key) ? redactRuntimeStableIdentity(entry) : redactRuntimeStructuredValue(entry));
            // Emit a stable, cross-session user_id_hash alongside a redacted user_id so
            // downstream de-dup/anti-sybil has a deterministic per-account key.
            if (USER_ID_KEY_RE.test(key) && (typeof entry === 'string' || typeof entry === 'number') && out['user_id_hash'] === undefined) {
                out['user_id_hash'] = stableUserIdHash(entry);
            }
        }
        return out;
    }
    return value;
}
function safeJsonParse(text, fallback) {
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
function newReadStats() {
    return {
        rowsScanned: 0,
        rowsRead: 0,
        invalidJson: 0,
        encryptedRows: 0,
        skippedMissingSecret: 0,
        decryptFailures: 0,
        nonTraceSkipped: 0,
    };
}
function parseNodeSecret(value) {
    const raw = String(value ?? '').trim();
    return /^[a-f0-9]{64}$/i.test(raw) ? raw : undefined;
}
function versionKey(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (typeof value === 'string')
        return value.trim();
    return '';
}
function nodeSecretKeyringMap(input) {
    const out = new Map();
    if (!input)
        return out;
    if (Array.isArray(input)) {
        for (const entry of input) {
            if (!isRecord(entry))
                continue;
            const version = versionKey(entry['version'] ?? entry['node_secret_version'] ?? entry['nodeSecretVersion']);
            const secret = parseNodeSecret(String(entry['node_secret'] ?? entry['nodeSecret'] ?? entry['secret'] ?? ''));
            if (version && secret)
                out.set(version, secret);
        }
        return out;
    }
    for (const [version, value] of Object.entries(input)) {
        const secret = parseNodeSecret(value);
        if (version && secret)
            out.set(version, secret);
    }
    return out;
}
function nodeSecretsForEnvelope(envelope, opts) {
    const secrets = [];
    const version = versionKey(envelope['secret_version'] ?? envelope['node_secret_version']);
    if (version) {
        const fromKeyring = nodeSecretKeyringMap(opts.nodeSecretKeyring).get(version);
        if (fromKeyring)
            secrets.push(fromKeyring);
    }
    const fallback = parseNodeSecret(opts.nodeSecret);
    if (fallback && !secrets.includes(fallback))
        secrets.push(fallback);
    return secrets;
}
function traceKeyFromNodeSecret(nodeSecret) {
    return createHash('sha256').update(`evomap-proxy-trace-v1:${nodeSecret}`, 'utf8').digest();
}
function decryptWithKey(envelope, key) {
    const iv = Buffer.from(String(envelope['iv'] ?? ''), 'base64');
    const tag = Buffer.from(String(envelope['tag'] ?? ''), 'base64');
    const ciphertext = Buffer.from(String(envelope['ciphertext'] ?? ''), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}
function decryptTraceEnvelope(envelope, opts) {
    let hubError;
    if (opts.hubPrivateKey && isRecord(envelope['hub_key_envelope'])) {
        try {
            const hub = envelope['hub_key_envelope'];
            const wrapped = Buffer.from(String(hub['wrapped_key'] ?? ''), 'base64');
            const key = privateDecrypt({
                key: opts.hubPrivateKey,
                padding: constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256',
            }, wrapped);
            return decryptWithKey(envelope, key);
        }
        catch (err) {
            hubError = err;
        }
    }
    const nodeSecrets = nodeSecretsForEnvelope(envelope, opts);
    if (nodeSecrets.length === 0)
        throw (hubError instanceof Error ? hubError : new Error('missing node secret'));
    let lastError = hubError;
    for (const nodeSecret of nodeSecrets) {
        try {
            return decryptWithKey(envelope, traceKeyFromNodeSecret(nodeSecret));
        }
        catch (err) {
            lastError = err;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('failed to decrypt encrypted trace row');
}
function hasDecryptKey(envelope, opts) {
    if (opts.hubPrivateKey && isRecord(envelope['hub_key_envelope']))
        return true;
    return nodeSecretsForEnvelope(envelope, opts).length > 0;
}
function isTraceTurn(row) {
    if (!isRecord(row))
        return false;
    if (row['event'] === 'llm_turn')
        return true;
    return row['prism_compatible'] === true;
}
export function readTraceRowsFromJsonl(text, opts = {}) {
    const rows = [];
    const stats = newReadStats();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        stats.rowsScanned += 1;
        let row = safeJsonParse(trimmed, null);
        if (!isRecord(row)) {
            stats.invalidJson += 1;
            continue;
        }
        if (row['encrypted'] === true || row['event'] === 'llm_trace_envelope') {
            stats.encryptedRows += 1;
            if (!hasDecryptKey(row, opts)) {
                stats.skippedMissingSecret += 1;
                if (!opts.allowPartial)
                    throw new Error('encrypted trace row cannot be exported without a matching key');
                continue;
            }
            try {
                row = decryptTraceEnvelope(row, opts);
            }
            catch {
                stats.decryptFailures += 1;
                if (!opts.allowPartial)
                    throw new Error('failed to decrypt encrypted trace row');
                continue;
            }
        }
        if (isTraceTurn(row)) {
            rows.push(row);
            stats.rowsRead += 1;
        }
        else {
            stats.nonTraceSkipped += 1;
        }
    }
    if (stats.encryptedRows > 0 && stats.rowsRead === 0 && stats.decryptFailures > 0 && !opts.allowPartial) {
        throw new Error('encrypted trace row cannot be exported without a matching key');
    }
    return { rows, stats };
}
function stringValue(value) {
    return typeof value === 'string' ? value : '';
}
function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function tokenCount(value) {
    const count = numberOrNull(value);
    return count !== null && count >= 0 ? count : 0;
}
function booleanValue(value) {
    return typeof value === 'boolean' ? value : false;
}
function normalizeBody(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    if (typeof raw === 'string')
        return safeJsonParse(raw, raw);
    return raw;
}
function rawBodyIsInvalidJson(raw) {
    if (typeof raw !== 'string')
        return false;
    const text = raw.trim();
    if (!text)
        return false;
    try {
        JSON.parse(text);
        return false;
    }
    catch {
        return true;
    }
}
function bodyIsEmpty(value) {
    if (value === undefined || value === null)
        return true;
    if (typeof value === 'string')
        return value.trim().length === 0;
    if (Array.isArray(value))
        return value.length === 0;
    if (isRecord(value))
        return Object.keys(value).length === 0;
    return false;
}
function usageTokens(row, key) {
    const direct = row[key];
    if (typeof direct === 'number' && Number.isFinite(direct))
        return direct;
    const usage = isRecord(row['usage']) ? row['usage'] : {};
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
const BEDROCK_PROVIDER_ALIASES = new Set([
    'bedrock',
    'aws-bedrock',
    'aws-bedrock-anthropic',
    'bedrock-anthropic',
]);
function normalizeBedrockProviderAlias(value) {
    return BEDROCK_PROVIDER_ALIASES.has(value.toLowerCase()) ? 'aws-bedrock-anthropic' : value;
}
function providerForRow(row) {
    const provider = stringValue(row['provider']);
    if (provider)
        return normalizeBedrockProviderAlias(provider);
    const upstream = stringValue(row['upstream']).toLowerCase();
    const normalizedUpstream = normalizeBedrockProviderAlias(upstream);
    if (normalizedUpstream === 'aws-bedrock-anthropic')
        return normalizedUpstream;
    if (upstream === 'vertex')
        return 'vertex-gemini';
    return upstream || 'anthropic';
}
function normalizeEndpoint(value) {
    return value.replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '').trim();
}
function endpointForRow(row) {
    const endpoint = stringValue(row['route']) || stringValue(row['path']);
    return endpoint ? normalizeEndpoint(endpoint) : '';
}
function timestampForRow(row) {
    return stringValue(row['ts']) || stringValue(row['createdAtIso']) || stringValue(row['timestamp']);
}
function modelForRow(row) {
    return stringValue(row['chosen_model']) || stringValue(row['chosenModel']) || stringValue(row['model']) || stringValue(row['original_model']);
}
function chosenModelForRow(row) {
    return stringValue(row['chosen_model']) || stringValue(row['chosenModel']);
}
function originalModelForRow(row) {
    return stringValue(row['original_model']) || stringValue(row['originalModel']);
}
function sessionIdForRow(row) {
    return stringValue(row['session_id']) || stringValue(row['sessionId']);
}
function responseIdForRow(row) {
    return stringValue(row['response_id']) || stringValue(row['responseId']);
}
function previousResponseIdForRow(row) {
    return stringValue(row['previous_response_id']) || stringValue(row['previousResponseId']);
}
function requestIdForRow(row) {
    return stringValue(row['request_id']) || stringValue(row['requestId']) || stringValue(row['id']);
}
function statusForRow(row) {
    return numberOrNull(row['status']);
}
function durationForRow(row) {
    return numberOrNull(row['latency_ms']) ?? numberOrNull(row['durationMs']);
}
function errorForRow(row) {
    return stringValue(row['error']) || stringValue(row['errorMessage']);
}
function streamErrorForRow(row) {
    return stringValue(row['stream_error']) || stringValue(row['streamError']);
}
function streamCancelledForRow(row) {
    return booleanValue(row['stream_cancelled']) || booleanValue(row['streamCancelled']);
}
function isStreamRow(row) {
    return booleanValue(row['stream']) || booleanValue(row['isStream']);
}
function finishReasonForRow(row) {
    return stringValue(row['stop_reason']) || stringValue(row['finish_reason']) || stringValue(row['finishReason']);
}
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map((part) => {
        if (!isRecord(part))
            return '';
        return stringValue(part['text']) || stringValue(part['content']);
    }).filter(Boolean).join('\n');
}
function extractTask(body) {
    if (!isRecord(body))
        return '';
    if (typeof body['instructions'] === 'string')
        return body['instructions'].slice(0, 1000);
    if (typeof body['input'] === 'string')
        return body['input'].slice(0, 1000);
    if (Array.isArray(body['input'])) {
        return body['input'].map((item) => isRecord(item) ? textFromContent(item['content']) : '')
            .filter(Boolean).join('\n').slice(0, 1000);
    }
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    const firstUser = messages.find((m) => isRecord(m) && m['role'] === 'user');
    return isRecord(firstUser) ? textFromContent(firstUser['content']).slice(0, 1000) : '';
}
function byteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    catch {
        return 0;
    }
}
function isToolCallType(value) {
    return value === 'tool_use' || value === 'function_call';
}
function isToolResultType(value) {
    return value === 'tool_result' || value === 'function_call_output';
}
function streamKeyPart(value) {
    if (typeof value === 'number' && Number.isInteger(value))
        return String(value);
    if (typeof value === 'string' && value)
        return value;
    return '';
}
function collectToolCalls(body) {
    const calls = [];
    const anthropicBlocks = new Map();
    const openAiToolCalls = new Map();
    const openAiLastToolKeyByChoice = new Map();
    const responsesFunctionCalls = new Map();
    const addCall = (call, opts = {}) => {
        if (!isRecord(call))
            return;
        const fn = isRecord(call['function']) ? call['function'] : undefined;
        const normalized = {
            id: stringValue(call['id']) || stringValue(call['tool_use_id']) || stringValue(call['call_id']) || stringValue(call['tool_call_id']),
            name: stringValue(call['name']) || (fn ? stringValue(fn['name']) : '') || stringValue(call['type']) || 'unknown',
            ...(call['input'] !== undefined ? { input: call['input'] } : {}),
            ...(call['arguments'] !== undefined ? { arguments: call['arguments'] } : {}),
            ...(fn !== undefined ? { function: fn } : {}),
            bytes: opts.bytes ?? byteLength(call),
            ...(opts.declared === true || call['declared'] === true ? { declared: true } : {}),
        };
        const existing = normalized.id && !normalized.declared
            ? calls.find((candidate) => candidate.id === normalized.id && !candidate.declared)
            : undefined;
        if (existing) {
            if ((!existing.name || existing.name === 'unknown') && normalized.name)
                existing.name = normalized.name;
            if (existing.input === undefined && normalized.input !== undefined)
                existing.input = normalized.input;
            if ((existing.arguments === undefined || existing.arguments === '') && normalized.arguments !== undefined && normalized.arguments !== '') {
                existing.arguments = normalized.arguments;
            }
            if (isRecord(existing.function) && isRecord(normalized.function)) {
                const mergedFunction = { ...existing.function };
                for (const [key, value] of Object.entries(normalized.function)) {
                    if ((mergedFunction[key] === undefined || mergedFunction[key] === '') && value !== undefined && value !== '') {
                        mergedFunction[key] = value;
                    }
                }
                existing.function = mergedFunction;
            }
            else if (existing.function === undefined && normalized.function !== undefined) {
                existing.function = normalized.function;
            }
            existing.bytes = Math.max(existing.bytes, normalized.bytes);
            return;
        }
        calls.push(normalized);
    };
    const addToolResult = (call) => {
        if (!isRecord(call))
            return;
        calls.push({
            id: stringValue(call['tool_use_id']) || stringValue(call['call_id']) || stringValue(call['tool_call_id']) || stringValue(call['id']),
            name: 'tool_result',
            ...(call['content'] !== undefined ? { input: call['content'] } : {}),
            ...(call['output'] !== undefined ? { arguments: call['output'] } : {}),
            bytes: byteLength(call),
        });
    };
    const anthropicKeys = (evt, block) => {
        const keys = [];
        const index = streamKeyPart(evt['index']);
        if (index)
            keys.push(`index:${index}`);
        const id = block ? stringValue(block['id']) : '';
        if (id)
            keys.push(`id:${id}`);
        return keys;
    };
    const getAnthropicBlock = (keys) => {
        for (const key of keys) {
            const existing = anthropicBlocks.get(key);
            if (existing) {
                for (const alias of keys)
                    anthropicBlocks.set(alias, existing);
                return existing;
            }
        }
        const fallbackKey = keys[0] ?? `anonymous:${anthropicBlocks.size}`;
        const created = { id: '', name: '', type: 'tool_use', partialJson: '', bytes: 0 };
        anthropicBlocks.set(fallbackKey, created);
        for (const alias of keys)
            anthropicBlocks.set(alias, created);
        return created;
    };
    const accumulateAnthropicStart = (evt, contentBlock) => {
        if (!isToolCallType(contentBlock['type']))
            return;
        const block = getAnthropicBlock(anthropicKeys(evt, contentBlock));
        block.id = block.id || stringValue(contentBlock['id']);
        block.name = block.name || stringValue(contentBlock['name']);
        block.type = stringValue(contentBlock['type']) || block.type;
        if (block.input === undefined && contentBlock['input'] !== undefined)
            block.input = contentBlock['input'];
        block.bytes += byteLength(contentBlock);
    };
    const accumulateAnthropicDelta = (evt, delta) => {
        if (delta['type'] !== 'input_json_delta')
            return;
        const partialJson = stringValue(delta['partial_json']);
        if (!partialJson)
            return;
        const block = getAnthropicBlock(anthropicKeys(evt));
        block.partialJson += partialJson;
        block.bytes += byteLength(delta);
    };
    const openAiChoiceKey = (choice) => {
        return streamKeyPart(choice['index']) || '0';
    };
    const openAiToolKey = (choice, toolCall) => {
        const choiceKey = openAiChoiceKey(choice);
        const toolIndex = streamKeyPart(toolCall['index']);
        if (toolIndex)
            return `choice:${choiceKey}:tool:${toolIndex}`;
        const id = stringValue(toolCall['id']);
        if (id)
            return `choice:${choiceKey}:id:${id}`;
        return openAiLastToolKeyByChoice.get(choiceKey) ?? `choice:${choiceKey}:anonymous:${openAiToolCalls.size}`;
    };
    const accumulateOpenAiToolCall = (choice, toolCall) => {
        if (!isRecord(toolCall))
            return;
        const key = openAiToolKey(choice, toolCall);
        const existing = openAiToolCalls.get(key) ?? { id: '', type: '', functionName: '', arguments: '', bytes: 0 };
        const fn = isRecord(toolCall['function']) ? toolCall['function'] : undefined;
        existing.id = existing.id || stringValue(toolCall['id']);
        existing.type = existing.type || stringValue(toolCall['type']);
        if (fn) {
            existing.functionName = existing.functionName || stringValue(fn['name']);
            existing.arguments += stringValue(fn['arguments']);
        }
        existing.bytes += byteLength(toolCall);
        openAiToolCalls.set(key, existing);
        openAiLastToolKeyByChoice.set(openAiChoiceKey(choice), key);
    };
    const responsesKeys = (evt, item) => {
        const keys = [];
        const itemId = stringValue(evt['item_id']) || (item ? stringValue(item['id']) : '');
        const outputIndex = streamKeyPart(evt['output_index']) || (item ? streamKeyPart(item['output_index']) : '');
        const callId = stringValue(evt['call_id']) || stringValue(evt['id']) || (item ? stringValue(item['call_id']) || stringValue(item['id']) : '');
        if (itemId)
            keys.push(`item:${itemId}`);
        if (outputIndex)
            keys.push(`output:${outputIndex}`);
        if (callId)
            keys.push(`call:${callId}`);
        return keys;
    };
    const getResponsesFunctionCall = (keys) => {
        for (const key of keys) {
            const existing = responsesFunctionCalls.get(key);
            if (existing) {
                for (const alias of keys)
                    responsesFunctionCalls.set(alias, existing);
                return existing;
            }
        }
        const fallbackKey = keys[0] ?? `anonymous:${responsesFunctionCalls.size}`;
        const created = { id: '', callId: '', name: '', arguments: '', bytes: 0 };
        responsesFunctionCalls.set(fallbackKey, created);
        for (const alias of keys)
            responsesFunctionCalls.set(alias, created);
        return created;
    };
    const accumulateResponsesOutputItem = (evt, item) => {
        if (item['type'] !== 'function_call')
            return;
        const call = getResponsesFunctionCall(responsesKeys(evt, item));
        call.id = call.id || stringValue(item['id']);
        call.callId = call.callId || stringValue(item['call_id']);
        call.name = call.name || stringValue(item['name']);
        const itemArguments = item['arguments'];
        if (typeof itemArguments === 'string' && itemArguments !== '')
            call.arguments = itemArguments;
        call.bytes += byteLength(item);
    };
    const accumulateResponsesArguments = (evt) => {
        if (evt['type'] !== 'response.function_call_arguments.delta' && evt['type'] !== 'response.function_call_arguments.done')
            return;
        const call = getResponsesFunctionCall(responsesKeys(evt));
        if (evt['type'] === 'response.function_call_arguments.done') {
            const doneArguments = evt['arguments'];
            if (typeof doneArguments === 'string' && doneArguments !== '')
                call.arguments = doneArguments;
        }
        else {
            call.arguments += stringValue(evt['delta']);
        }
        call.bytes += byteLength(evt);
    };
    // Gemini/Vertex parts are camelCase and carry no `type` field:
    //   { functionCall: { name, args } }       -> tool_use / tool_call
    //   { functionResponse: { name, response } } -> tool_result (paired by name/id)
    const addGeminiFunctionCall = (fc) => {
        if (!isRecord(fc))
            return;
        const name = stringValue(fc['name']);
        const call = { type: 'tool_use', name: name || 'unknown' };
        const id = stringValue(fc['id']);
        if (id)
            call['id'] = id;
        if (fc['args'] !== undefined)
            call['input'] = fc['args'];
        addCall(call);
    };
    const addGeminiFunctionResponse = (fr) => {
        if (!isRecord(fr))
            return;
        calls.push({
            id: stringValue(fr['id']) || stringValue(fr['name']),
            name: 'tool_result',
            ...(fr['response'] !== undefined ? { input: fr['response'] } : {}),
            bytes: byteLength(fr),
        });
    };
    const scanGeminiPart = (part) => {
        let matched = false;
        if (isRecord(part['functionCall'])) {
            addGeminiFunctionCall(part['functionCall']);
            matched = true;
        }
        if (isRecord(part['functionResponse'])) {
            addGeminiFunctionResponse(part['functionResponse']);
            matched = true;
        }
        return matched;
    };
    const scanGeminiCandidates = (candidates) => {
        if (!Array.isArray(candidates))
            return;
        for (const candidate of candidates) {
            if (!isRecord(candidate))
                continue;
            const content = candidate['content'];
            if (!isRecord(content))
                continue;
            const parts = Array.isArray(content['parts']) ? content['parts'] : [];
            for (const part of parts)
                if (isRecord(part))
                    scanGeminiPart(part);
        }
    };
    const scanContent = (content) => {
        const parts = Array.isArray(content) ? content : [];
        for (const part of parts) {
            if (!isRecord(part))
                continue;
            if (isToolCallType(part['type']))
                addCall(part);
            if (isToolResultType(part['type']))
                addToolResult(part);
            // Gemini message content (non-streaming request `contents[].parts[]`).
            scanGeminiPart(part);
        }
    };
    const scanMessage = (msg, opts = {}) => {
        if (!isRecord(msg))
            return;
        const shouldScanToolCalls = opts.scanToolCalls !== false;
        scanContent(msg['content']);
        if (shouldScanToolCalls && Array.isArray(msg['tool_calls']))
            for (const call of msg['tool_calls'])
                addCall(call);
        if (shouldScanToolCalls && isRecord(msg['function_call']))
            addCall(msg['function_call']);
        if (msg['role'] === 'tool' || msg['tool_call_id'])
            addToolResult(msg);
    };
    const scanEvent = (evt) => {
        if (!isRecord(evt))
            return;
        // Gemini/Vertex streaming chunks carry candidates[].content.parts[].
        if (Array.isArray(evt['candidates']))
            scanGeminiCandidates(evt['candidates']);
        scanMessage(evt);
        scanMessage(evt['message']);
        scanMessage(evt['delta'], { scanToolCalls: false });
        scanMessage(evt['item']);
        scanContent(evt['content']);
        const delta = isRecord(evt['delta']) ? evt['delta'] : {};
        scanContent(delta['content']);
        accumulateAnthropicDelta(evt, delta);
        accumulateResponsesArguments(evt);
        const contentBlock = isRecord(evt['content_block']) ? evt['content_block'] : undefined;
        if (contentBlock) {
            accumulateAnthropicStart(evt, contentBlock);
            scanContent(contentBlock['content']);
        }
        const item = isRecord(evt['item']) ? evt['item'] : undefined;
        if (item) {
            accumulateResponsesOutputItem(evt, item);
            if (isToolCallType(item['type']))
                addCall(item);
            if (isToolResultType(item['type']))
                addToolResult(item);
            scanContent(item['content']);
        }
        const response = isRecord(evt['response']) ? evt['response'] : undefined;
        if (response)
            for (const call of collectToolCalls(response))
                calls.push(call);
        const choices = Array.isArray(evt['choices']) ? evt['choices'] : [];
        for (const choice of choices) {
            if (!isRecord(choice))
                continue;
            scanMessage(choice['message']);
            scanMessage(choice['delta'], { scanToolCalls: false });
            const choiceDelta = isRecord(choice['delta']) ? choice['delta'] : {};
            const toolCalls = Array.isArray(choiceDelta['tool_calls']) ? choiceDelta['tool_calls'] : [];
            for (const toolCall of toolCalls)
                accumulateOpenAiToolCall(choice, toolCall);
        }
    };
    const flushAnthropicStreamBlocks = () => {
        for (const block of new Set(anthropicBlocks.values())) {
            if (!block.id && !block.name && !block.partialJson)
                continue;
            const call = { type: block.type || 'tool_use' };
            if (block.id)
                call['id'] = block.id;
            if (block.name)
                call['name'] = block.name;
            if (block.partialJson) {
                try {
                    call['input'] = JSON.parse(block.partialJson);
                }
                catch {
                    call['arguments'] = block.partialJson;
                }
            }
            else if (block.input !== undefined) {
                call['input'] = block.input;
            }
            addCall(call, { bytes: block.bytes });
        }
    };
    const flushOpenAiStreamToolCalls = () => {
        for (const toolCall of openAiToolCalls.values()) {
            if (!toolCall.id && !toolCall.functionName && !toolCall.arguments)
                continue;
            const fn = {};
            if (toolCall.functionName)
                fn['name'] = toolCall.functionName;
            if (toolCall.arguments)
                fn['arguments'] = toolCall.arguments;
            const call = {};
            if (toolCall.id)
                call['id'] = toolCall.id;
            if (toolCall.type)
                call['type'] = toolCall.type;
            if (Object.keys(fn).length > 0)
                call['function'] = fn;
            addCall(call, { bytes: toolCall.bytes });
        }
    };
    const flushResponsesFunctionCalls = () => {
        for (const functionCall of new Set(responsesFunctionCalls.values())) {
            if (!functionCall.id && !functionCall.callId && !functionCall.name && !functionCall.arguments)
                continue;
            const call = { type: 'function_call' };
            if (functionCall.id)
                call['id'] = functionCall.id;
            if (functionCall.callId)
                call['call_id'] = functionCall.callId;
            if (functionCall.name)
                call['name'] = functionCall.name;
            if (functionCall.arguments)
                call['arguments'] = functionCall.arguments;
            addCall(call, { bytes: functionCall.bytes });
        }
    };
    if (!isRecord(body))
        return calls;
    if (Array.isArray(body['messages']))
        for (const msg of body['messages'])
            scanMessage(msg);
    // Gemini/Vertex non-streaming response: { candidates: [{ content: { parts: [...] } }] }.
    if (Array.isArray(body['candidates']))
        scanGeminiCandidates(body['candidates']);
    // Gemini/Vertex request: { contents: [{ role, parts: [...] }] } (functionCall/functionResponse turns).
    if (Array.isArray(body['contents'])) {
        for (const turn of body['contents']) {
            if (isRecord(turn))
                scanContent(turn['parts']);
        }
    }
    if (Array.isArray(body['input'])) {
        for (const item of body['input']) {
            if (isRecord(item) && isToolCallType(item['type']))
                addCall(item);
            if (isRecord(item) && isToolResultType(item['type']))
                addToolResult(item);
            scanEvent(item);
        }
    }
    scanContent(body['content']);
    if (Array.isArray(body['output'])) {
        for (const item of body['output']) {
            if (isRecord(item) && isToolCallType(item['type']))
                addCall(item);
            if (isRecord(item) && isToolResultType(item['type']))
                addToolResult(item);
            scanEvent(item);
        }
    }
    if (Array.isArray(body['choices']))
        for (const choice of body['choices'])
            scanEvent(choice);
    if (Array.isArray(body['events']))
        for (const evt of body['events'])
            scanEvent(evt);
    if (Array.isArray(body['semantic_tail_events']))
        for (const evt of body['semantic_tail_events'])
            scanEvent(evt);
    if (Array.isArray(body['chunks']))
        for (const evt of body['chunks'])
            scanEvent(evt);
    flushAnthropicStreamBlocks();
    flushOpenAiStreamToolCalls();
    flushResponsesFunctionCalls();
    if (Array.isArray(body['tools']))
        for (const tool of body['tools'])
            addCall(tool, { declared: true });
    return calls;
}
function collectRowLevelToolCalls(row) {
    const raw = row['tool_calls'];
    if (!Array.isArray(raw))
        return [];
    const calls = [];
    for (const call of raw) {
        if (!isRecord(call))
            continue;
        const fn = isRecord(call['function']) ? call['function'] : undefined;
        calls.push({
            id: stringValue(call['id']) || stringValue(call['tool_use_id']) || stringValue(call['call_id']) || stringValue(call['tool_call_id']),
            name: stringValue(call['name']) || (fn ? stringValue(fn['name']) : '') || stringValue(call['type']) || 'unknown',
            ...(call['input'] !== undefined ? { input: call['input'] } : {}),
            ...(call['arguments'] !== undefined ? { arguments: call['arguments'] } : {}),
            ...(fn !== undefined ? { function: fn } : {}),
            bytes: numberOrNull(call['bytes']) ?? byteLength(call),
            ...(call['declared'] === true ? { declared: true } : {}),
        });
    }
    return calls;
}
function redactNormalizedToolCall(call) {
    const input = call.input !== undefined ? redactRuntimeStructuredValue(call.input) : undefined;
    const args = call.arguments !== undefined ? redactRuntimeStructuredValue(call.arguments) : undefined;
    const fn = call.function !== undefined ? redactRuntimeStructuredValue(call.function) : undefined;
    return {
        id: redactString(call.id),
        name: redactString(call.name),
        ...(input !== undefined ? { input } : {}),
        ...(args !== undefined ? { arguments: args } : {}),
        ...(fn !== undefined ? { function: fn } : {}),
        bytes: call.bytes,
        ...(call.declared === true ? { declared: true } : {}),
    };
}
function getToolArguments(call) {
    if (call.input !== undefined)
        return call.input;
    if (call.arguments !== undefined)
        return call.arguments;
    if (isRecord(call.function))
        return call.function['arguments'];
    return undefined;
}
function extractCommandText(call) {
    const args = getToolArguments(call);
    if (typeof args === 'string') {
        const parsed = safeJsonParse(args, null);
        return isRecord(parsed) ? extractCommandText({ id: '', name: '', input: parsed, bytes: 0 }) : args;
    }
    if (!isRecord(args))
        return '';
    for (const key of ['cmd', 'command', 'script', 'input']) {
        const value = args[key];
        if (typeof value === 'string')
            return value;
    }
    return '';
}
function isEditToolName(name) {
    const normalized = name.toLowerCase();
    if (!normalized)
        return false;
    if (/(^|[^a-z0-9])apply[_-]?patch([^a-z0-9]|$)/.test(normalized))
        return true;
    if (/(^|[^a-z0-9])multi[_-]?edit([^a-z0-9]|$)/.test(normalized))
        return true;
    if (/(^|[^a-z0-9])notebook[_-]?edit([^a-z0-9]|$)/.test(normalized))
        return true;
    if (/(^|[^a-z0-9])(edit|write|replace|patch)([^a-z0-9]|$)/.test(normalized))
        return true;
    return false;
}
function commandLooksLikeCodeEdit(command) {
    const cmd = command.toLowerCase();
    if (!cmd.trim())
        return false;
    if (/\bapply_patch\b/.test(cmd) || /\bgit\s+apply\b/.test(cmd))
        return true;
    if (/\bsed\b[^;\n]*\s-i(?:\b|['"])/.test(cmd))
        return true;
    if (/\bperl\b[^;\n]*(?:\s-pi\b|\s-i(?:\b|['"]))/.test(cmd))
        return true;
    if (/\b(?:python|python3|node)\b[^;\n]*(?:writefilesync|writefile|open\([^)]*,\s*['"]w|path\.write_text|pathlib|fs\.)/.test(cmd)) {
        return true;
    }
    return false;
}
function toolCallLooksLikeCodeEdit(call) {
    if (call.declared)
        return false;
    if (isEditToolName(call.name))
        return true;
    return commandLooksLikeCodeEdit(extractCommandText(call));
}
function commandLooksLikeTestExecution(command) {
    const cmd = command.toLowerCase();
    if (!cmd.trim())
        return false;
    return [
        /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:test|vitest|jest)(?:\b|:)/,
        /\b(?:vitest|jest|pytest)\b/,
        /\bgo\s+test\b/,
        /\bcargo\s+test\b/,
        /\bmvn(?:w)?\s+(?:[^;\n]*\s)?test\b/,
        /\bgradle(?:w)?\s+(?:[^;\n]*\s)?test\b/,
        /\bdotnet\s+test\b/,
        /\bswift\s+test\b/,
        /\bzig\s+test\b/,
        /\bnode\s+--test\b/,
    ].some((probe) => probe.test(cmd));
}
function toolCallTestCommand(call) {
    if (call.declared)
        return '';
    if (!/(bash|exec_command|shell_command|run_terminal_cmd|terminal|shell|command)/i.test(call.name))
        return '';
    const command = extractCommandText(call).trim();
    return commandLooksLikeTestExecution(command) ? command : '';
}
const FAILURE_OUTPUT_RE = /\b(?:assertionerror|traceback|test(?:s)? failed|failed tests?|exit(?:ed)? with code [1-9]\d*|exit code [1-9]\d*|non[- ]?zero|command failed|npm (?:test|run) failed|pytest\b[\s\S]{0,200}\bfailed|error: test failed)\b/i;
function textFromValue(value, depth = 0) {
    if (value == null || depth > 10)
        return '';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (Array.isArray(value))
        return value.map((item) => textFromValue(item, depth + 1)).filter(Boolean).join('\n');
    if (!isRecord(value))
        return '';
    return Object.entries(value)
        .filter(([key]) => !/^(?:id|call_id|tool_call_id|type|name)$/i.test(key))
        .map(([, child]) => textFromValue(child, depth + 1))
        .filter(Boolean)
        .join('\n');
}
function hasToolFailureSignal(body) {
    if (!isRecord(body))
        return false;
    for (const call of collectToolCalls(body)) {
        if (call.declared)
            continue;
        if (FAILURE_OUTPUT_RE.test(textFromValue(call)))
            return true;
    }
    return FAILURE_OUTPUT_RE.test(textFromValue(body));
}
function hasToolCallFailureSignal(body) {
    if (!isRecord(body))
        return false;
    for (const call of collectToolCalls(body)) {
        if (call.declared)
            continue;
        if (FAILURE_OUTPUT_RE.test(textFromValue(call)))
            return true;
    }
    return false;
}
function bodyIncompleteReasons(name, raw, body, row) {
    const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (missing) {
        if (name === 'response' && isStreamRow(row))
            return ['stream_response_body_missing'];
        return [`${name}_body_missing`];
    }
    if (rawBodyIsInvalidJson(raw))
        return [`${name}_body_invalid_json`];
    if (bodyIsEmpty(body))
        return [`${name}_body_empty`];
    return [];
}
function streamTransportIncompleteReasons(row) {
    if (!isStreamRow(row))
        return [];
    const error = errorForRow(row);
    const streamError = streamErrorForRow(row);
    const finish = finishReasonForRow(row);
    const cancelled = streamCancelledForRow(row)
        || booleanValue(row['cancelled'])
        || booleanValue(row['canceled'])
        || /\bcancel(?:led|ed|lation)?\b/i.test(`${finish} ${error} ${streamError}`);
    if (cancelled)
        return ['stream_cancelled'];
    if (error || streamError)
        return ['stream_error'];
    if (finish === 'stream_forwarded_unobserved')
        return ['stream_forwarded_unobserved'];
    if (row['finished'] === false)
        return ['stream_unfinished'];
    return [];
}
function turnIncompleteReasons(row, request, response) {
    const reasons = [
        ...bodyIncompleteReasons('request', requestBodyRawForRow(row), request, row),
        ...bodyIncompleteReasons('response', responseBodyRawForRow(row), response, row),
        ...streamTransportIncompleteReasons(row),
    ];
    if (row['body_truncated'] === true)
        reasons.push('body_truncated');
    if (responseEventsTruncated(response))
        reasons.push('response_body_truncated');
    return [...new Set(reasons)];
}
function collectLanguagesFromText(text) {
    const languages = new Set();
    const haystack = text.toLowerCase();
    const probes = [
        ['javascript', /\b(js|javascript|node|npm|pnpm|react|vue)\b/],
        ['typescript', /\b(ts|typescript|tsx)\b/],
        ['python', /\b(python|py|pytest|django|fastapi)\b/],
        ['go', /\b(golang|go test|go\.mod|go (?:code|file|files|parser|package|module))\b/],
        ['rust', /\b(rust|cargo|crates?)\b/],
        ['java', /\b(java|maven|gradle)\b/],
    ];
    for (const [name, re] of probes)
        if (re.test(haystack))
            languages.add(name);
    return [...languages];
}
function responseEventsTruncated(response) {
    return isRecord(response) && (response['events_truncated'] === true
        || response['content_truncated'] === true
        || response['provider_stream_truncated'] === true
        || response['raw_stream_truncated'] === true
        || response['truncated'] === true
        || typeof response['dropped_event_count'] === 'number');
}
function capturedRequestBodyTruncated(value) {
    return isRecord(value)
        && value['truncated'] === true
        && (value['capture_complete'] === false
            || value['body_omitted'] === true
            || typeof value['omitted_bytes'] === 'number'
            || typeof value['omitted_chars'] === 'number'
            || value['reason'] === 'body_exceeds_trace_body_max_bytes'
            || value['reason'] === 'body_exceeds_trace_body_max_chars');
}
function normalizeTraceAttempts(raw) {
    if (!Array.isArray(raw))
        return [];
    const attempts = [];
    raw.forEach((entry, fallbackIndex) => {
        if (!isRecord(entry))
            return;
        const hasRequestBody = rowHasField(entry, 'requestBody') || rowHasField(entry, 'request_body');
        const hasResponseBody = rowHasField(entry, 'responseBody') || rowHasField(entry, 'response_body');
        const requestBody = normalizeBody(rowHasField(entry, 'requestBody') ? entry['requestBody'] : entry['request_body']);
        const responseBody = normalizeBody(rowHasField(entry, 'responseBody') ? entry['responseBody'] : entry['response_body']);
        const redactedRequestBody = redactRuntimeStructuredValue(requestBody);
        const redactedResponseBody = redactRuntimeStructuredValue(responseBody);
        const upstreamMode = typeof entry['upstream_mode'] === 'string'
            ? entry['upstream_mode']
            : (typeof entry['upstreamMode'] === 'string' ? entry['upstreamMode'] : undefined);
        const error = typeof entry['error'] === 'string'
            ? entry['error']
            : (typeof entry['error_message'] === 'string'
                ? entry['error_message']
                : (typeof entry['errorMessage'] === 'string' ? entry['errorMessage'] : undefined));
        const attemptBodyTruncated = entry['body_truncated'] === true
            || capturedRequestBodyTruncated(requestBody)
            || responseEventsTruncated(responseBody);
        attempts.push({
            attempt_index: numberOrNull(entry['attempt_index']) ?? numberOrNull(entry['attemptIndex']) ?? fallbackIndex,
            ...(entry['model'] === null || typeof entry['model'] === 'string' ? { model: entry['model'] } : {}),
            ...(typeof entry['provider'] === 'string' ? { provider: entry['provider'] } : {}),
            ...(upstreamMode !== undefined ? { upstream_mode: upstreamMode } : {}),
            ...(rowHasField(entry, 'status') ? { status: numberOrNull(entry['status']) } : {}),
            ...(error !== undefined ? { error } : {}),
            ...(hasRequestBody ? { request_body: redactedRequestBody } : {}),
            ...(hasResponseBody ? { response_body: redactedResponseBody } : {}),
            ...(attemptBodyTruncated ? { body_truncated: true } : {}),
        });
    });
    return attempts;
}
function requestBodyRawForRow(row) {
    return rowHasField(row, 'requestBody') ? row['requestBody'] : row['request_body'];
}
function responseBodyRawForRow(row) {
    return rowHasField(row, 'responseBody') ? row['responseBody'] : row['response_body'];
}
function rowHasField(row, key) {
    return Object.prototype.hasOwnProperty.call(row, key);
}
function firstPresent(row, keys) {
    for (const key of keys)
        if (rowHasField(row, key))
            return row[key];
    return undefined;
}
function firstPresentFrom(records, keys) {
    for (const record of records) {
        const value = firstPresent(record, keys);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function parsedObject(value) {
    const parsed = normalizeBody(value);
    return isRecord(parsed) ? parsed : undefined;
}
function createRawRecordStore() {
    const objectIndexes = new WeakMap();
    const primitiveIndexes = new Map();
    const values = [];
    return {
        add(value) {
            if (value === undefined)
                return undefined;
            if (value && typeof value === 'object') {
                if (objectIndexes.has(value))
                    return objectIndexes.get(value);
                const index = values.length;
                objectIndexes.set(value, index);
                values.push(redactRuntimeStructuredValue(value));
                return index;
            }
            const key = `${typeof value}:${String(value)}`;
            if (primitiveIndexes.has(key))
                return primitiveIndexes.get(key);
            const index = values.length;
            primitiveIndexes.set(key, index);
            values.push(redactRuntimeStructuredValue(value));
            return index;
        },
        values() {
            return values;
        },
    };
}
function traceMetadataSources(row) {
    return [
        row,
        parsedObject(row['metadata']),
        parsedObject(row['meta']),
    ].filter((value) => isRecord(value));
}
function tracePassthroughFields(row) {
    const sources = traceMetadataSources(row);
    const metadata = rowHasField(row, 'metadata')
        ? normalizeBody(row['metadata'])
        : (rowHasField(row, 'meta') ? normalizeBody(row['meta']) : undefined);
    const usage = firstPresentFrom(sources, ['usage']);
    const risk = firstPresentFrom(sources, ['risk']);
    const fidelity = firstPresentFrom(sources, ['fidelity']);
    const confidentiality = firstPresentFrom(sources, ['confidentiality']);
    const requestHeaders = firstPresent(row, ['request_headers', 'requestHeaders']);
    const responseHeaders = firstPresent(row, ['response_headers', 'responseHeaders']);
    const transport = firstPresent(row, ['transport']);
    const transportMetadata = firstPresent(row, ['transport_metadata', 'transportMetadata']);
    const ttfb = numberOrNull(row['ttfb_ms']) ?? numberOrNull(row['ttfbMs']);
    return {
        ...(ttfb !== null ? { ttfb_ms: ttfb } : {}),
        ...(metadata !== undefined ? { metadata: redactRuntimeStructuredValue(metadata) } : {}),
        ...(usage !== undefined ? { usage: redactRuntimeStructuredValue(usage) } : {}),
        ...(risk !== undefined ? { risk: redactRuntimeStructuredValue(risk) } : {}),
        ...(fidelity !== undefined ? { fidelity: redactRuntimeStructuredValue(fidelity) } : {}),
        ...(confidentiality !== undefined ? { confidentiality: redactRuntimeStructuredValue(confidentiality) } : {}),
        ...(requestHeaders !== undefined ? { request_headers: redactRuntimeStructuredValue(normalizeBody(requestHeaders)) } : {}),
        ...(responseHeaders !== undefined ? { response_headers: redactRuntimeStructuredValue(normalizeBody(responseHeaders)) } : {}),
        ...(transport !== undefined ? { transport: redactRuntimeStructuredValue(normalizeBody(transport)) } : {}),
        ...(transportMetadata !== undefined ? { transport_metadata: redactRuntimeStructuredValue(normalizeBody(transportMetadata)) } : {}),
    };
}
function toolCallStatsKey(call) {
    if (call.declared)
        return '';
    const name = call.name || 'unknown';
    if (call.id)
        return `${name}:${call.id}`;
    return '';
}
function dedupeToolCalls(calls) {
    const seen = new Set();
    const out = [];
    for (const call of calls) {
        const key = toolCallStatsKey(call);
        if (key) {
            if (seen.has(key))
                continue;
            seen.add(key);
        }
        out.push(call);
    }
    return out;
}
function buildTrajectoryFromRows(sessionId, rows) {
    const sorted = [...rows].sort((a, b) => (Date.parse(timestampForRow(a)) || 0) - (Date.parse(timestampForRow(b)) || 0));
    const turns = [];
    const toolTypes = {};
    const testCommands = new Set();
    const languages = new Set();
    const providers = new Set();
    const endpoints = new Set();
    let inputTokens = 0;
    let outputTokens = 0;
    let hasToolCalls = false;
    let hasCodeEdit = false;
    let sawFailureSignal = false;
    let sawCorrectionAfterFailure = false;
    let hasTruncatedStream = false;
    let hasIncompleteTurns = false;
    let task = '';
    let trajectoryMetadata;
    let trajectoryUsage;
    let trajectoryRisk;
    let trajectoryFidelity;
    let trajectoryConfidentiality;
    const sourceRecordStore = createRawRecordStore();
    const rawRowStore = createRawRecordStore();
    const countedToolCalls = new Set();
    sorted.forEach((row, idx) => {
        const passthrough = tracePassthroughFields(row);
        const sourceRecordIndex = sourceRecordStore.add(row);
        const rawRowIndex = rawRowStore.add(row);
        if (trajectoryMetadata === undefined && passthrough['metadata'] !== undefined)
            trajectoryMetadata = passthrough['metadata'];
        if (trajectoryUsage === undefined && passthrough['usage'] !== undefined)
            trajectoryUsage = passthrough['usage'];
        if (trajectoryRisk === undefined && passthrough['risk'] !== undefined)
            trajectoryRisk = passthrough['risk'];
        if (trajectoryFidelity === undefined && passthrough['fidelity'] !== undefined)
            trajectoryFidelity = passthrough['fidelity'];
        if (trajectoryConfidentiality === undefined && passthrough['confidentiality'] !== undefined)
            trajectoryConfidentiality = passthrough['confidentiality'];
        const request = normalizeBody(requestBodyRawForRow(row));
        const response = normalizeBody(responseBodyRawForRow(row));
        const redactedRequest = redactRuntimeStructuredValue(request);
        const redactedResponse = redactRuntimeStructuredValue(response);
        const attempts = normalizeTraceAttempts(row['attempts']);
        const attemptsBodyTruncated = attempts.some((attempt) => attempt.body_truncated === true);
        const incompleteReasons = turnIncompleteReasons(row, request, response);
        if (attemptsBodyTruncated && !incompleteReasons.includes('body_truncated'))
            incompleteReasons.push('body_truncated');
        if (incompleteReasons.length > 0)
            hasIncompleteTurns = true;
        const requestToolCalls = collectToolCalls(request);
        const requestDeclaredTools = requestToolCalls.filter((call) => call.declared);
        const requestActualToolCalls = requestToolCalls.filter((call) => !call.declared);
        const rowLevelToolCalls = collectRowLevelToolCalls(row);
        const rowDeclaredTools = rowLevelToolCalls.filter((call) => call.declared);
        const rowActualToolCalls = rowLevelToolCalls.filter((call) => !call.declared);
        const responseActualToolCalls = collectToolCalls(response).filter((call) => !call.declared);
        const actualToolCalls = dedupeToolCalls(responseActualToolCalls.concat(rowActualToolCalls, requestActualToolCalls));
        const toolCalls = requestDeclaredTools.concat(rowDeclaredTools, actualToolCalls);
        const redactedToolCalls = toolCalls.map(redactNormalizedToolCall);
        const previousFailureSignal = sawFailureSignal;
        const requestFailureSignal = hasToolCallFailureSignal(request);
        const responseFailureSignal = hasToolFailureSignal(response);
        let correctionToolThisTurn = false;
        for (const call of toolCalls) {
            if (call.declared)
                continue;
            const statsKey = toolCallStatsKey(call);
            if (statsKey) {
                if (countedToolCalls.has(statsKey))
                    continue;
                countedToolCalls.add(statsKey);
            }
            hasToolCalls = true;
            toolTypes[call.name] = (toolTypes[call.name] ?? 0) + 1;
            const looksLikeCodeEdit = toolCallLooksLikeCodeEdit(call);
            if (looksLikeCodeEdit)
                hasCodeEdit = true;
            const testCommand = toolCallTestCommand(call);
            if (testCommand) {
                const redactedTestCommand = toolCallTestCommand(redactNormalizedToolCall(call));
                testCommands.add(redactedTestCommand || redactString(testCommand));
            }
            if (looksLikeCodeEdit || testCommand)
                correctionToolThisTurn = true;
        }
        const provider = providerForRow(row);
        const endpoint = endpointForRow(row);
        providers.add(provider);
        endpoints.add(endpoint);
        if (!task)
            task = redactString(extractTask(request));
        for (const lang of collectLanguagesFromText(`${JSON.stringify(request ?? {})}\n${JSON.stringify(response ?? {})}`))
            languages.add(lang);
        const input = usageTokens(row, 'input_tokens');
        const output = usageTokens(row, 'output_tokens');
        inputTokens += input;
        outputTokens += output;
        const status = statusForRow(row);
        const failureSignal = ((status !== null && status >= 400)
            || stringValue(row['error'])
            || stringValue(row['errorMessage'])
            || requestFailureSignal
            || responseFailureSignal);
        const responseText = textFromValue(response).trim();
        const correctionTextThisTurn = requestFailureSignal && !responseFailureSignal && responseText.length > 0;
        if ((previousFailureSignal && (correctionToolThisTurn || (!failureSignal && responseText.length > 0)))
            || (requestFailureSignal && (correctionToolThisTurn || correctionTextThisTurn))) {
            sawCorrectionAfterFailure = true;
        }
        if (failureSignal)
            sawFailureSignal = true;
        const truncatedStream = responseEventsTruncated(response) || row['body_truncated'] === true || attemptsBodyTruncated;
        if (truncatedStream)
            hasTruncatedStream = true;
        turns.push({
            turn_index: idx,
            request_id: requestIdForRow(row),
            timestamp: timestampForRow(row),
            provider,
            endpoint,
            model: modelForRow(row),
            ...(chosenModelForRow(row) ? { chosen_model: chosenModelForRow(row) } : {}),
            ...(originalModelForRow(row) ? { original_model: originalModelForRow(row) } : {}),
            status,
            duration_ms: durationForRow(row),
            is_stream: isStreamRow(row),
            finish_reason: finishReasonForRow(row),
            response_id: responseIdForRow(row),
            previous_response_id: previousResponseIdForRow(row),
            input_tokens: input,
            output_tokens: output,
            ...passthrough,
            ...(sourceRecordIndex !== undefined ? { source_record_index: sourceRecordIndex } : {}),
            ...(rawRowIndex !== undefined ? { raw_row_index: rawRowIndex } : {}),
            request_body: redactedRequest,
            response_body: redactedResponse,
            ...(rowHasField(row, 'reasoning') ? { reasoning: row['reasoning'] } : {}),
            ...(rowHasField(row, 'diff') ? { diff: row['diff'] } : {}),
            ...(rowHasField(row, 'validation') ? { validation: row['validation'] } : {}),
            tool_calls: redactedToolCalls,
            ...(typeof row['redaction'] === 'string' ? { redaction: row['redaction'] } : {}),
            ...(row['body_truncated'] === true || attemptsBodyTruncated ? { body_truncated: true } : {}),
            ...(attempts.length > 0 ? { attempts } : {}),
            ...(truncatedStream ? { response_events_truncated: true } : {}),
            ...(errorForRow(row) ? { error: redactString(errorForRow(row)) } : {}),
            ...(streamErrorForRow(row) ? { stream_error: redactString(streamErrorForRow(row)) } : {}),
            ...(streamCancelledForRow(row) ? { stream_cancelled: true } : {}),
            complete: incompleteReasons.length === 0,
            ...(incompleteReasons.length > 0 ? { incomplete_reasons: incompleteReasons } : {}),
        });
    });
    return {
        schema: CODING_TRAJECTORY_SCHEMA,
        session_id: sessionId || 'unknown',
        source_kind: 'proxy_trace',
        ...(trajectoryMetadata !== undefined ? { metadata: trajectoryMetadata } : {}),
        ...(trajectoryUsage !== undefined ? { usage: trajectoryUsage } : {}),
        ...(trajectoryRisk !== undefined ? { risk: trajectoryRisk } : {}),
        ...(trajectoryFidelity !== undefined ? { fidelity: trajectoryFidelity } : {}),
        ...(trajectoryConfidentiality !== undefined ? { confidentiality: trajectoryConfidentiality } : {}),
        ...(sourceRecordStore.values().length > 0 ? { source_record: sourceRecordStore.values()[0], source_records: sourceRecordStore.values() } : {}),
        ...(rawRowStore.values().length > 0 ? { raw_rows: rawRowStore.values() } : {}),
        task,
        providers: [...providers].filter(Boolean),
        endpoints: [...endpoints].filter(Boolean),
        languages: [...languages],
        stats: {
            turns: turns.length,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            tool_call_count: Object.values(toolTypes).reduce((sum, n) => sum + n, 0),
            tool_types: toolTypes,
            has_tool_calls: hasToolCalls,
            has_code_edit: hasCodeEdit,
            has_test_execution: testCommands.size > 0,
            test_commands: [...testCommands],
            has_failure_correction: sawFailureSignal && sawCorrectionAfterFailure,
            has_truncated_stream: hasTruncatedStream,
            has_incomplete_turns: hasIncompleteTurns,
        },
        turns,
    };
}
function runtimeBody(turn, sessionModel, sessionTools) {
    const body = {
        source: 'runtime_session',
        role: turn.role,
    };
    const model = stringValue(turn.model) || sessionModel;
    if (model)
        body['model'] = model;
    if ((turn.role === 'user' || turn.role === 'system') && sessionTools !== undefined) {
        body['tools_ref'] = 'session_tools';
    }
    if (turn.text)
        body['text'] = redactString(turn.text);
    if (turn.reasoning === true)
        body['reasoning'] = true;
    if (turn.reasoningSignature)
        body['reasoning_signature'] = turn.reasoningSignature;
    if (turn.encryptedSignature)
        body['encrypted_signature'] = turn.encryptedSignature;
    if (turn.encryptedContent !== undefined)
        body['encrypted_content'] = turn.encryptedContent;
    if (turn.metadata !== undefined)
        body['metadata'] = redactRuntimeStructuredValue(turn.metadata);
    if (turn.usage !== undefined)
        body['usage_raw'] = redactRuntimeStructuredValue(turn.usage);
    if (turn.risk !== undefined)
        body['risk'] = redactRuntimeStructuredValue(turn.risk);
    if (turn.fidelity !== undefined)
        body['fidelity'] = redactRuntimeStructuredValue(turn.fidelity);
    if (turn.confidentiality !== undefined)
        body['confidentiality'] = redactRuntimeStructuredValue(turn.confidentiality);
    if (turn.toolName)
        body['tool_name'] = turn.toolName;
    if (turn.toolUseId)
        body['tool_use_id'] = turn.toolUseId;
    if (turn.toolInput !== undefined)
        body['tool_input'] = redactRuntimeStructuredValue(turn.toolInput);
    if (turn.toolResult !== undefined)
        body['tool_result'] = redactRuntimeStructuredValue(turn.toolResult);
    if (turn.errorMessage)
        body['error'] = redactString(turn.errorMessage);
    const usage = {};
    if (turn.inputTokens !== undefined)
        usage['input_tokens'] = tokenCount(turn.inputTokens);
    if (turn.outputTokens !== undefined)
        usage['output_tokens'] = tokenCount(turn.outputTokens);
    if (Object.keys(usage).length > 0)
        body['usage'] = usage;
    return body;
}
function runtimeTurnPassthroughFields(turn, sourceRecordStore, rawRowStore) {
    const sourceRecordIndex = sourceRecordStore.add(turn.sourceRecord);
    const rawRowIndex = rawRowStore.add(turn.rawRow);
    return {
        ...(turn.metadata !== undefined ? { metadata: redactRuntimeStructuredValue(turn.metadata) } : {}),
        ...(turn.usage !== undefined ? { usage: redactRuntimeStructuredValue(turn.usage) } : {}),
        ...(turn.risk !== undefined ? { risk: redactRuntimeStructuredValue(turn.risk) } : {}),
        ...(turn.fidelity !== undefined ? { fidelity: redactRuntimeStructuredValue(turn.fidelity) } : {}),
        ...(turn.confidentiality !== undefined ? { confidentiality: redactRuntimeStructuredValue(turn.confidentiality) } : {}),
        ...(sourceRecordIndex !== undefined ? { source_record_index: sourceRecordIndex } : {}),
        ...(rawRowIndex !== undefined ? { raw_row_index: rawRowIndex } : {}),
    };
}
function runtimeSessionPassthroughFields(input, sourceRecordStore, rawRowStore) {
    return {
        ...(input.clientSource ? { client_source: input.clientSource } : {}),
        ...(input.systemPrompt ? { system_prompt: redactString(input.systemPrompt) } : {}),
        ...(input.metadata !== undefined ? { metadata: redactRuntimeStructuredValue(input.metadata) } : {}),
        ...(input.usage !== undefined ? { usage: redactRuntimeStructuredValue(input.usage) } : {}),
        ...(input.risk !== undefined ? { risk: redactRuntimeStructuredValue(input.risk) } : {}),
        ...(input.fidelity !== undefined ? { fidelity: redactRuntimeStructuredValue(input.fidelity) } : {}),
        ...(input.confidentiality !== undefined ? { confidentiality: redactRuntimeStructuredValue(input.confidentiality) } : {}),
        ...(sourceRecordStore.values().length > 0 ? { source_record: sourceRecordStore.values()[0], source_records: sourceRecordStore.values() } : {}),
        ...(rawRowStore.values().length > 0 ? { raw_rows: rawRowStore.values() } : {}),
    };
}
function runtimeTurnHasContent(turn) {
    return Boolean(turn.text
        || turn.toolName
        || turn.toolInput !== undefined
        || turn.toolResult !== undefined
        || turn.errorMessage
        || turn.reasoning === true
        || turn.model
        || turn.inputTokens !== undefined
        || turn.outputTokens !== undefined
        || turn.reasoningSignature
        || turn.encryptedSignature
        || turn.encryptedContent !== undefined
        || turn.metadata !== undefined
        || turn.usage !== undefined
        || turn.risk !== undefined
        || turn.fidelity !== undefined
        || turn.confidentiality !== undefined
        || turn.sourceRecord !== undefined
        || turn.rawRow !== undefined);
}
function runtimeToolCall(turn) {
    if (turn.role !== 'assistant' || !turn.toolName)
        return null;
    const input = turn.toolInput !== undefined ? redactRuntimeStructuredValue(turn.toolInput) : undefined;
    return {
        id: turn.toolUseId ?? '',
        name: turn.toolName,
        ...(input !== undefined ? { input } : {}),
        bytes: byteLength({ name: turn.toolName, input }),
    };
}
function runtimeTextForSignals(turn) {
    return [
        turn.text,
        typeof turn.toolInput === 'string' ? turn.toolInput : JSON.stringify(turn.toolInput ?? ''),
        typeof turn.toolResult === 'string' ? turn.toolResult : JSON.stringify(turn.toolResult ?? ''),
        turn.errorMessage,
    ].filter(Boolean).join('\n');
}
function runtimeSessionId(input) {
    const explicit = stringValue(input.sessionId);
    if (explicit)
        return explicit;
    const sourcePath = stringValue(input.sourcePath);
    const base = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? '';
    return base.replace(/\.jsonl?$/i, '') || 'unknown';
}
function nativeCallHasField(call, key) {
    return Object.prototype.hasOwnProperty.call(call, key);
}
function runtimeNativeCalls(input) {
    const calls = [];
    (input.nativeCalls ?? []).forEach((call) => {
        if (!isRecord(call))
            return;
        const hasRequestBody = nativeCallHasField(call, 'request_body')
            || nativeCallHasField(call, 'request');
        const hasResponseBody = nativeCallHasField(call, 'response_body')
            || nativeCallHasField(call, 'response');
        if (!hasRequestBody && !hasResponseBody)
            return;
        const requestBody = nativeCallHasField(call, 'request_body') ? call.request_body : call.request;
        const responseBody = nativeCallHasField(call, 'response_body') ? call.response_body : call.response;
        calls.push({
            call_index: calls.length,
            ...(stringValue(call.provider) ? { provider: stringValue(call.provider) } : {}),
            ...(stringValue(call.timestamp) ? { timestamp: stringValue(call.timestamp) } : {}),
            ...(stringValue(call.request_time) ? { request_time: stringValue(call.request_time) } : {}),
            ...(stringValue(call.response_time) ? { response_time: stringValue(call.response_time) } : {}),
            ...(numberOrNull(call.ttfb_ms) !== null ? { ttfb_ms: numberOrNull(call.ttfb_ms) } : {}),
            ...(call.request_headers !== undefined ? { request_headers: redactRuntimeStructuredValue(normalizeBody(call.request_headers)) } : {}),
            ...(call.response_headers !== undefined ? { response_headers: redactRuntimeStructuredValue(normalizeBody(call.response_headers)) } : {}),
            ...(call.transport !== undefined ? { transport: redactRuntimeStructuredValue(normalizeBody(call.transport)) } : {}),
            ...(call.transport_metadata !== undefined ? { transport_metadata: redactRuntimeStructuredValue(normalizeBody(call.transport_metadata)) } : {}),
            ...(hasRequestBody ? { request_body: redactRuntimeStructuredValue(normalizeBody(requestBody)) } : {}),
            ...(hasResponseBody ? { response_body: redactRuntimeStructuredValue(normalizeBody(responseBody)) } : {}),
            ...(call.metadata !== undefined ? { metadata: redactRuntimeStructuredValue(call.metadata) } : {}),
            ...(call.usage !== undefined ? { usage: redactRuntimeStructuredValue(call.usage) } : {}),
            ...(call.risk !== undefined ? { risk: redactRuntimeStructuredValue(call.risk) } : {}),
            ...(call.fidelity !== undefined ? { fidelity: redactRuntimeStructuredValue(call.fidelity) } : {}),
            ...(call.confidentiality !== undefined ? { confidentiality: redactRuntimeStructuredValue(call.confidentiality) } : {}),
            ...(call.sourceRecord !== undefined ? { source_record: redactRuntimeStructuredValue(call.sourceRecord) } : {}),
            ...(call.rawRow !== undefined ? { raw_row: redactRuntimeStructuredValue(call.rawRow) } : {}),
            redaction: RUNTIME_SESSION_REDACTION,
        });
    });
    return calls;
}
export function buildCodingTrajectoryFromSessionLog(input) {
    const sourceAgent = stringValue(input.sourceAgent) || 'unknown-runtime';
    const provider = stringValue(input.provider) || sourceAgent;
    const sessionModel = stringValue(input.model);
    const sessionTools = input.tools;
    const sourcePath = stringValue(input.sourcePath);
    const sessionId = runtimeSessionId(input);
    const sessionIncompleteReasons = [...new Set((input.incompleteReasons ?? [])
            .map((reason) => stringValue(reason).trim())
            .filter(Boolean))];
    const sessionDeclaredTools = sessionTools !== undefined
        ? collectToolCalls({ tools: redactRuntimeStructuredValue(sessionTools) }).filter((call) => call.declared)
        : [];
    const turns = [];
    const toolTypes = {};
    const testCommands = new Set();
    const languages = new Set();
    let task = '';
    let hasToolCalls = false;
    let hasCodeEdit = false;
    let hasFailureCorrection = false;
    let hasIncompleteTurns = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const nativeCalls = runtimeNativeCalls(input);
    const sourceRecordStore = createRawRecordStore();
    const rawRowStore = createRawRecordStore();
    sourceRecordStore.add(input.sourceRecord);
    for (const row of input.rawRows ?? [])
        rawRowStore.add(row);
    input.turns.forEach((turn, idx) => {
        const isSignalTurn = turn.isMeta !== true;
        if (isSignalTurn && !task && turn.role === 'user' && turn.text)
            task = redactString(turn.text).slice(0, 1000);
        if (isSignalTurn)
            for (const lang of collectLanguagesFromText(runtimeTextForSignals(turn)))
                languages.add(lang);
        const inputTokenCount = tokenCount(turn.inputTokens);
        const outputTokenCount = tokenCount(turn.outputTokens);
        inputTokens += inputTokenCount;
        outputTokens += outputTokenCount;
        const call = runtimeToolCall(turn);
        const isAssistantSide = turn.role === 'assistant' || turn.role === 'tool';
        const toolCalls = (!isAssistantSide ? sessionDeclaredTools : []).concat(call ? [call] : []);
        if (isSignalTurn && call) {
            hasToolCalls = true;
            toolTypes[call.name] = (toolTypes[call.name] ?? 0) + 1;
            if (toolCallLooksLikeCodeEdit(call))
                hasCodeEdit = true;
            const testCommand = toolCallTestCommand(call);
            if (testCommand)
                testCommands.add(testCommand);
        }
        if (isSignalTurn && (turn.errorMessage || FAILURE_OUTPUT_RE.test(runtimeTextForSignals(turn))))
            hasFailureCorrection = true;
        const incompleteReasons = [
            ...sessionIncompleteReasons,
            ...(runtimeTurnHasContent(turn) ? [] : ['runtime_turn_empty']),
        ];
        if (incompleteReasons.length > 0)
            hasIncompleteTurns = true;
        const body = runtimeBody(turn, sessionModel, sessionTools);
        const passthrough = runtimeTurnPassthroughFields(turn, sourceRecordStore, rawRowStore);
        const model = stringValue(turn.model) || sessionModel;
        const reasoningSignature = stringValue(turn.reasoningSignature);
        const encryptedSignature = stringValue(turn.encryptedSignature);
        turns.push({
            turn_index: idx,
            request_id: turn.toolUseId ? `${sessionId}:${turn.toolUseId}` : `${sessionId}:turn:${idx}`,
            timestamp: stringValue(turn.timestamp) || stringValue(input.startedAt),
            provider,
            endpoint: 'runtime_session',
            model,
            status: null,
            duration_ms: null,
            is_stream: false,
            finish_reason: turn.errorMessage ? 'error' : '',
            response_id: '',
            previous_response_id: '',
            input_tokens: inputTokenCount,
            output_tokens: outputTokenCount,
            ...passthrough,
            request_body: isAssistantSide ? null : body,
            response_body: isAssistantSide ? body : null,
            ...(turn.reasoning === true ? { reasoning: redactString(turn.text) } : {}),
            ...(turn.thinkingEmpty === true ? { thinking_empty: true } : {}),
            ...(reasoningSignature ? { reasoning_signature: reasoningSignature } : {}),
            ...(encryptedSignature ? { encrypted_signature: encryptedSignature } : {}),
            ...(turn.encryptedContent !== undefined ? { encrypted_content: turn.encryptedContent } : {}),
            tool_calls: toolCalls,
            redaction: RUNTIME_SESSION_REDACTION,
            ...(turn.errorMessage ? { error: redactString(turn.errorMessage) } : {}),
            complete: incompleteReasons.length === 0,
            ...(incompleteReasons.length > 0 ? { incomplete_reasons: incompleteReasons } : {}),
        });
    });
    if (turns.length === 0)
        return null;
    return {
        schema: CODING_TRAJECTORY_SCHEMA,
        session_id: sessionId,
        source_kind: 'runtime_session',
        source_agent: sourceAgent,
        source_path: sourcePath,
        ...(sessionModel ? { session_model: sessionModel } : {}),
        ...(provider !== sourceAgent ? { session_provider: provider } : {}),
        ...(sessionTools !== undefined ? { session_tools: redactRuntimeStructuredValue(sessionTools) } : {}),
        ...runtimeSessionPassthroughFields(input, sourceRecordStore, rawRowStore),
        task,
        providers: [provider],
        endpoints: ['runtime_session'],
        languages: [...languages],
        stats: {
            turns: turns.length,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            tool_call_count: Object.values(toolTypes).reduce((sum, n) => sum + n, 0),
            tool_types: toolTypes,
            has_tool_calls: hasToolCalls,
            has_code_edit: hasCodeEdit,
            has_test_execution: testCommands.size > 0,
            test_commands: [...testCommands],
            has_failure_correction: hasFailureCorrection,
            has_truncated_stream: false,
            has_incomplete_turns: hasIncompleteTurns,
        },
        ...(nativeCalls.length > 0 ? { native_calls: nativeCalls } : {}),
        turns,
    };
}
export function buildCodingTrajectories(rows) {
    const list = [...rows];
    const parent = list.map((_, idx) => idx);
    const rootSession = list.map((row) => sessionIdForRow(row));
    const find = (idx) => {
        let cur = idx;
        while (parent[cur] !== cur) {
            parent[cur] = parent[parent[cur]];
            cur = parent[cur];
        }
        return cur;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb)
            return;
        const leftSession = rootSession[ra] ?? '';
        const rightSession = rootSession[rb] ?? '';
        if (leftSession && rightSession && leftSession !== rightSession)
            return;
        parent[rb] = ra;
        rootSession[ra] = leftSession || rightSession;
    };
    const explicitOwner = new Map();
    const responseOwners = new Map();
    const rememberResponseOwner = (responseId, idx) => {
        if (!responseId)
            return;
        const owners = responseOwners.get(responseId) ?? [];
        owners.push(idx);
        responseOwners.set(responseId, owners);
    };
    const compatibleResponseOwnerRoots = (responseId, rowIdx) => {
        const owners = responseOwners.get(responseId) ?? [];
        const rowRoot = find(rowIdx);
        const rowSessionId = rootSession[rowRoot] ?? '';
        const roots = new Set();
        for (const ownerIdx of owners) {
            if (ownerIdx === rowIdx)
                continue;
            const ownerRoot = find(ownerIdx);
            const ownerSessionId = rootSession[ownerRoot] ?? '';
            if (ownerSessionId && rowSessionId && ownerSessionId !== rowSessionId)
                continue;
            roots.add(ownerRoot);
        }
        return [...roots];
    };
    list.forEach((row, idx) => {
        const explicit = sessionIdForRow(row);
        if (explicit) {
            const key = `session:${explicit}`;
            const owner = explicitOwner.get(key);
            if (owner !== undefined)
                union(owner, idx);
            else
                explicitOwner.set(key, idx);
        }
        const responseId = responseIdForRow(row);
        rememberResponseOwner(responseId, idx);
    });
    list.forEach((row, idx) => {
        const previous = previousResponseIdForRow(row);
        if (!previous)
            return;
        const roots = compatibleResponseOwnerRoots(previous, idx);
        if (roots.length !== 1)
            return;
        union(roots[0], idx);
    });
    const groups = new Map();
    list.forEach((row, idx) => {
        const root = find(idx);
        const owner = list[root] ?? row;
        const explicitSessionId = rootSession[root] || sessionIdForRow(owner);
        const fallbackId = requestIdForRow(owner) || responseIdForRow(owner) || 'unknown';
        const id = explicitSessionId || `${fallbackId}#${root}`;
        const bucket = groups.get(root) ?? { sessionId: id, rows: [] };
        bucket.rows.push(row);
        groups.set(root, bucket);
    });
    return [...groups.values()].map(({ sessionId, rows: groupRows }) => buildTrajectoryFromRows(sessionId, groupRows));
}