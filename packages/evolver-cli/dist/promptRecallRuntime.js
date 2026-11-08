import * as recall from '@evomap/evolver-core/prompt-recall';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deliverContextOutput, waitContextDelivery } from './contextDelivery.js';
import { writeProtectedAuditSessionNotice, protectedAuditNoticeStatePath } from './protectedAuditStatus.js';
import { MAX_PROMPT_RECALL_STDIN_BYTES, MAX_PROMPT_RECALL_LOCAL_FILE_BYTES, MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES, promptRecallMode, wrapGeneContext, writeHookStdout, writeContextReadDiagnostic } from './promptRecallShared.js';
const PROMPT_RECALL_STDIN_TIMEOUT_MS = 250;
const PROMPT_RECALL_SELECTION_TIMEOUT_MS = 750;
const PROMPT_RECALL_SCAN_LIMIT = 1000;
const PROMPT_RECALL_CONTEXT_MAX_CHARS = 800;
const PROMPT_RECALL_DEFAULT_MAX_GENES = 1;
const PROMPT_RECALL_MAX_GENES = 10;
const PROMPT_RECALL_MATCH_CHARS = 16 * 1024;
const PROMPT_RECALL_MATCH_TOKENS = 512;
const PROMPT_RECALL_SIGNAL_PATTERNS = 16;
const PROMPT_RECALL_SIGNAL_PATTERN_CHARS = 512;
const PROMPT_RECALL_SIGNAL_ALIASES = 4;
const PROMPT_RECALL_SIGNAL_ALIAS_CHARS = 192;
const PROMPT_RECALL_SIGNAL_ALIAS_TOKENS = 12;
const PROMPT_RECALL_TOKEN_CHARS = 96;
const PROMPT_RECALL_GENE_FIELD_CHARS = 512;
const PROMPT_RECALL_YIELD_EVERY_GENES = 8;
const NON_SPACE_SCRIPT = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Thai}]/u;
function promptRecallMaxGenes(env) {
    const parsed = Number.parseInt(String(env['EVOLVER_RECALL_MAX'] ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= PROMPT_RECALL_MAX_GENES
        ? parsed
        : PROMPT_RECALL_DEFAULT_MAX_GENES;
}
function readStdinBounded(timeoutMs = PROMPT_RECALL_STDIN_TIMEOUT_MS, maxBytes = MAX_PROMPT_RECALL_STDIN_BYTES) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        if (stdin.isTTY) {
            resolve(undefined);
            return;
        }
        let data = '';
        let bytes = 0;
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stdin.removeListener('data', onData);
            stdin.removeListener('end', onEnd);
            stdin.removeListener('error', onError);
            try {
                stdin.pause();
            }
            catch { /* already closed */ }
            resolve(value);
        };
        const onData = (chunk) => {
            const text = chunk.toString();
            bytes += Buffer.byteLength(text, 'utf8');
            if (bytes > maxBytes) {
                finish(undefined);
                return;
            }
            data += text;
        };
        const onEnd = () => finish(data);
        const onError = () => finish(undefined);
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        timer.unref?.();
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        stdin.on('end', onEnd);
        stdin.on('error', onError);
        try {
            stdin.resume();
        }
        catch {
            finish(undefined);
        }
    });
}
async function readHookPayload(readHookInput) {
    const raw = readHookInput
        ? await withSelectionBudget(PROMPT_RECALL_STDIN_TIMEOUT_MS, undefined, budget => Promise.resolve(readHookInput(budget.signal)))
        : await readStdinBounded();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROMPT_RECALL_STDIN_BYTES)
        return undefined;
    return raw;
}
function normalizedTokens(text, maxChars, maxTokens, cutStart = false) {
    let bounded = text.slice(0, maxChars).toLowerCase().normalize('NFKC');
    // Remove only a run actually cut by the window, before filtering tokens. A
    // delimiter at the boundary proves the adjacent token is complete.
    if (cutStart)
        bounded = bounded.replace(/^[\p{L}\p{N}]+/u, '');
    if (text.length > maxChars && /^[\p{L}\p{N}\p{M}]/u.test(text.slice(maxChars, maxChars + 2).normalize('NFKC'))) {
        bounded = bounded.replace(/[\p{L}\p{N}]+$/u, '');
    }
    const matches = bounded
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => (token.length >= 2 || /^\d+$/.test(token)) && token.length <= PROMPT_RECALL_TOKEN_CHARS)
        ?? [];
    return matches.slice(0, maxTokens);
}
function normalizedAliasTokens(text) {
    const runs = text
        .toLowerCase()
        .normalize('NFKC')
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    if (runs.some((token) => token.length > PROMPT_RECALL_TOKEN_CHARS))
        return [];
    const tokens = runs.filter((token) => token.length >= 2 || /^\d+$/.test(token));
    return tokens.length <= PROMPT_RECALL_SIGNAL_ALIAS_TOKENS ? tokens : [];
}
function promptTokenSegments(prompt) {
    if (prompt.length <= PROMPT_RECALL_MATCH_CHARS) {
        return [normalizedTokens(prompt, PROMPT_RECALL_MATCH_CHARS, PROMPT_RECALL_MATCH_TOKENS)];
    }
    const segmentChars = Math.floor(PROMPT_RECALL_MATCH_CHARS / 2);
    const segmentTokens = Math.floor(PROMPT_RECALL_MATCH_TOKENS / 2);
    const start = prompt.length - segmentChars;
    const cutStart = /[\p{L}\p{N}\p{M}]$/u.test(prompt.slice(Math.max(0, start - 2), start).normalize('NFKC'));
    const tailTokens = normalizedTokens(prompt.slice(start), segmentChars, segmentTokens, cutStart);
    return [
        normalizedTokens(prompt, segmentChars, segmentTokens),
        tailTokens,
    ];
}
function promptLiteralSegments(prompt) {
    const limit = PROMPT_RECALL_MATCH_CHARS;
    const segments = prompt.length <= limit
        ? [prompt]
        : [prompt.slice(0, limit / 2), prompt.slice(-limit / 2)];
    // Keep the windows separate: a signal must never span the omitted middle. Bound normalization expansion too.
    return segments.flatMap((segment, index) => {
        const normalized = segment.toLowerCase().normalize('NFKC');
        if (segments.length === 1 && normalized.length > limit) {
            return [
                { text: normalized.slice(0, limit / 2), cutStart: false, cutEnd: true },
                { text: normalized.slice(-limit / 2), cutStart: true, cutEnd: false },
            ];
        }
        const maxChars = limit / segments.length;
        const isTail = index > 0;
        return [{
                // Preserve the real prompt end when normalization expands the tail window.
                text: isTail ? normalized.slice(-maxChars) : normalized.slice(0, maxChars),
                cutStart: isTail,
                cutEnd: !isTail && (normalized.length > maxChars || segments.length > 1),
            }];
    }).filter((segment) => NON_SPACE_SCRIPT.test(segment.text));
}
function hasNonSpaceLetter(text) {
    return Array.from(text).some((character) => NON_SPACE_SCRIPT.test(character) && /\p{L}/u.test(character));
}
function containsNonSpaceLiteral(segments, alias) {
    const literal = alias.toLowerCase().normalize('NFKC');
    if (!NON_SPACE_SCRIPT.test(literal))
        return false;
    // Script_Extensions also includes shared punctuation and combining marks, which are not useful signals alone.
    if (!hasNonSpaceLetter(literal) || /^\p{M}/u.test(literal))
        return false;
    const characters = Array.from(literal);
    const runs = literal.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    if (runs.length > PROMPT_RECALL_SIGNAL_ALIAS_TOKENS
        || runs.some((run) => run.length > PROMPT_RECALL_TOKEN_CHARS))
        return false;
    const needsBoundary = (character) => /[\p{L}\p{N}\p{M}]/u.test(character)
        && !NON_SPACE_SCRIPT.test(character);
    const leftBoundary = needsBoundary(characters[0]);
    const rightBoundary = needsBoundary(characters.at(-1));
    for (const { text, cutStart, cutEnd } of segments) {
        for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1)) {
            if ((at === 0 && cutStart) || (at + literal.length === text.length && cutEnd))
                continue;
            const before = Array.from(text.slice(Math.max(0, at - 2), at)).at(-1) ?? '';
            const after = String.fromCodePoint(text.codePointAt(at + literal.length) ?? 0);
            // Mixed aliases retain Latin word boundaries; a Thai/Kana combining mark must not be cut off.
            if ((!leftBoundary || !needsBoundary(before))
                && (!rightBoundary || !needsBoundary(after)) && !/\p{M}/u.test(after))
                return true;
        }
    }
    return false;
}
function buildPromptSequenceIndex(segments) {
    const root = { children: new Map() };
    for (const tokens of segments) {
        for (let start = 0; start < tokens.length; start += 1) {
            let node = root;
            const end = Math.min(tokens.length, start + PROMPT_RECALL_SIGNAL_ALIAS_TOKENS);
            for (let offset = start; offset < end; offset += 1) {
                const token = tokens[offset];
                let child = node.children.get(token);
                if (!child) {
                    child = { children: new Map() };
                    node.children.set(token, child);
                }
                node = child;
            }
        }
    }
    return root;
}
function containsSequence(index, needle) {
    if (needle.length === 0)
        return false;
    let node = index;
    for (const token of needle) {
        const child = node.children.get(token);
        if (!child)
            return false;
        node = child;
    }
    return true;
}
function boundedSignalPatterns(gene) {
    const patterns = Array.isArray(gene['signals_match']) ? gene['signals_match'] : [];
    return patterns
        .slice(0, PROMPT_RECALL_SIGNAL_PATTERNS)
        .filter((pattern) => (typeof pattern === 'string' && pattern.length <= PROMPT_RECALL_SIGNAL_PATTERN_CHARS));
}
/**
 * V1 required a real local signals_match hit before prompt-time injection. Keep that conservative gate: aliases
 * separated by `|` are matched as normalized token sequences, with bounded literal matching for scripts that
 * do not require spaces between words. Regex-looking patterns are never evaluated
 * (a persisted pattern must not be able to run an expensive regular expression on a private prompt).
 */
function literalSignalHits(promptIndex, patterns, literalSegments) {
    let hits = 0;
    for (const pattern of patterns) {
        const aliases = pattern.split('|', PROMPT_RECALL_SIGNAL_ALIASES + 1).slice(0, PROMPT_RECALL_SIGNAL_ALIASES);
        const matched = aliases.some((alias) => {
            const trimmed = alias.trim();
            if (!trimmed
                || trimmed.length > PROMPT_RECALL_SIGNAL_ALIAS_CHARS
                || (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0))
                return false;
            return containsSequence(promptIndex, normalizedAliasTokens(trimmed))
                || (literalSegments.length > 0 && containsNonSpaceLiteral(literalSegments, trimmed));
        });
        if (matched)
            hits += 1;
    }
    return hits;
}
function boundedGeneField(value) {
    return typeof value === 'string' ? value.slice(0, PROMPT_RECALL_GENE_FIELD_CHARS) : undefined;
}
function geneText(gene, signalsMatch) {
    return [boundedGeneField(gene['id']), boundedGeneField(gene['category']), boundedGeneField(gene['summary']), ...signalsMatch]
        .filter((value) => typeof value === 'string')
        .join(' ');
}
function selectionExpired(budget) {
    return budget.cancelled || performance.now() >= budget.deadlineMs;
}
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function selectPromptGenes(prompt, snapshot, maxGenes, budget, benchmark) {
    const tokenSegments = promptTokenSegments(prompt);
    const promptTokens = tokenSegments.flat();
    const literalSegments = promptLiteralSegments(prompt);
    if (promptTokens.length === 0 && literalSegments.length === 0)
        return [];
    const promptIndex = buildPromptSequenceIndex(tokenSegments);
    const boundedPrompt = promptTokens.join(' ');
    const receipts = new Map();
    const approved = recall.approvedGenesFromSnapshot(snapshot, PROMPT_RECALL_SCAN_LIMIT, {
        recent: true,
        signal: budget.signal, deadlineAt: budget.deadlineAt,
        ...(benchmark ? { benchmark } : {}),
        onQualification: (values) => { for (const receipt of values)
            receipts.set(receipt.assetId, receipt); },
    });
    if (selectionExpired(budget))
        return [];
    const ranked = [];
    for (let index = 0; index < approved.length; index += 1) {
        if (selectionExpired(budget))
            return [];
        const gene = approved[index];
        const signalsMatch = boundedSignalPatterns(gene);
        const literalHits = literalSignalHits(promptIndex, signalsMatch, literalSegments);
        if (literalHits > 0) {
            const semanticScore = recall.tagOverlapScore(promptTokens, {
                signalsMatch,
                geneId: boundedGeneField(gene['id']),
                category: boundedGeneField(gene['category']),
                summary: boundedGeneField(gene['summary']),
            }) + recall.bagCosine(boundedPrompt, geneText(gene, signalsMatch));
            ranked.push({
                gene,
                literalHits,
                semanticScore,
                assetKey: String(gene.asset_id).slice(0, 128),
                ...(receipts.has(gene.asset_id) ? { sourceQualification: receipts.get(gene.asset_id) } : {}),
            });
        }
        if ((index + 1) % PROMPT_RECALL_YIELD_EVERY_GENES === 0) {
            await yieldToEventLoop();
            if (selectionExpired(budget))
                return [];
        }
    }
    if (selectionExpired(budget))
        return [];
    ranked.sort((left, right) => (right.literalHits - left.literalHits
        || right.semanticScore - left.semanticScore
        || left.assetKey.localeCompare(right.assetKey)));
    return ranked.slice(0, benchmark ? Math.min(maxGenes, 8) : maxGenes);
}
function renderGeneLine(gene) {
    // Every metadata field belongs to this single bullet, including line breaks
    // carried by logical ids/categories. Redact the final normalized sequence.
    const singleLine = (value, limit) => value.slice(0, limit).replace(/\s+/g, ' ').trim();
    const id = singleLine(typeof gene['id'] === 'string' ? gene['id'] : String(gene.asset_id), 128);
    const category = typeof gene['category'] === 'string' ? singleLine(gene['category'], 96) : '';
    const summary = typeof gene['summary'] === 'string'
        ? singleLine(gene['summary'], PROMPT_RECALL_GENE_FIELD_CHARS)
        : '';
    return recall.redactString(`- ${id}${category ? ` [${category}]` : ''}${summary ? `: ${summary.slice(0, 240)}` : ''}`);
}
function renderPromptRecallContext(genes) {
    const header = '[Evolver memory - relevant prior capability]';
    const footer = 'Use only when directly relevant. Adapt and verify before applying; do not mention this memory block unless asked or materially relevant.';
    const lines = [header];
    const rendered = [];
    for (const ranked of genes) {
        const { gene } = ranked;
        const line = renderGeneLine(gene);
        if ([...lines, line, footer].join('\n').length > PROMPT_RECALL_CONTEXT_MAX_CHARS)
            break;
        lines.push(line);
        rendered.push(ranked);
    }
    if (lines.length === 1)
        return { text: '', genes: [] };
    lines.push(footer);
    return { text: lines.join('\n'), genes: rendered };
}
function boundedAuditString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 256) : undefined;
}
/** Optional correlation metadata must retain its original identity or be omitted.
 * Redacted/truncated values are not new session, source or chain identities.
 */
function safeAuditIdentity(value) {
    const bounded = boundedAuditString(value);
    if (!bounded || typeof value !== 'string' || bounded !== value.trim()
        || recall.redactString(bounded) !== bounded)
        return undefined;
    if (Array.from(bounded).some(character => {
        const point = character.codePointAt(0);
        return point < 32 || (point >= 127 && point <= 159)
            || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
    }))
        return undefined;
    return bounded;
}
async function logPromptRecallSelections(genes, mode, sessionId, env, deadlineAt, injectedLog) {
    if (genes.length === 0)
        return;
    const callLog = injectedLog ?? new recall.AssetCallLog(recall.assetCallLogPath(env));
    const safeSessionId = safeAuditIdentity(sessionId);
    const runId = safeSessionId ? `recall:${safeSessionId}` : boundedAuditString(sessionId) ? undefined : 'recall:unknown';
    for (const ranked of genes) {
        const sourceNodeId = safeAuditIdentity(ranked.gene['source_node_id'] ?? ranked.gene['author_node_id']);
        const chainId = safeAuditIdentity(ranked.gene['chain_id']);
        try {
            if (Date.now() >= deadlineAt)
                return;
            const entry = {
                ...(runId ? { run_id: runId } : {}),
                action: mode === 'enforce' ? 'asset_inject' : 'asset_inject_shadow',
                asset_id: ranked.assetKey,
                asset_type: 'Gene',
                ...(sourceNodeId ? { source_node_id: sourceNodeId } : {}),
                ...(chainId ? { chain_id: chainId } : {}),
                score: ranked.semanticScore,
                reason: 'local_gene_pattern_hit',
                extra: {
                    via: 'prompt_recall',
                    attribution: 'correlational_local',
                    origin: 'local',
                    literal_hits: ranked.literalHits,
                    ...(ranked.sourceQualification ? recall.compactQualificationReceipts([ranked.sourceQualification]) : {}),
                },
            };
            if (callLog.appendBounded)
                await callLog.appendBounded(entry, { deadlineAt });
            else
                callLog.append(entry); // explicit legacy injection only; production never takes this synchronous path
        }
        catch { /* local attribution must never block prompt submission */ }
    }
}
async function withSelectionBudget(timeoutMs, fallback, run) {
    const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : PROMPT_RECALL_SELECTION_TIMEOUT_MS;
    const controller = new AbortController();
    const budget = {
        deadlineMs: performance.now() + boundedTimeoutMs,
        deadlineAt: Date.now() + boundedTimeoutMs,
        signal: controller.signal,
        cancelled: false,
        reads: new Set(),
    };
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => {
                if (selectionExpired(budget) || Date.now() >= budget.deadlineAt) {
                    budget.cancelled = true;
                    controller.abort();
                    return fallback;
                }
                return run(budget);
            }),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    budget.cancelled = true;
                    controller.abort();
                    resolve(fallback);
                }, boundedTimeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        controller.abort();
        // A timed-out injected provider must become terminal before the hook
        // returns. A signal merely requests cancellation; it is not proof.
        if (budget.cancelled && budget.reads.size > 0) {
            await Promise.all([...budget.reads].map(read => read.cancelAndSettle()));
        }
    }
}
async function ownPromptRead(budget, store, begin) {
    // Own admission before invoking an injected adapter. A thrown begin() may
    // already have dispatched work, so without an operation receipt its slot
    // cannot be released safely.
    const release = recall.acquireContextRead(store);
    let begun = false;
    let terminal = false;
    let operation;
    let owner;
    try {
        begun = true;
        operation = begin();
        if (operation?.version !== 1 || !operation.result || typeof operation.result.then !== 'function'
            || typeof operation.cancelAndSettle !== 'function')
            throw new Error('invalid_context_read_operation_v1');
        let settlement;
        owner = { cancelAndSettle: () => settlement ??= Promise.resolve().then(() => operation.cancelAndSettle()) };
        budget.reads.add(owner);
        try {
            const value = await operation.result;
            await owner.cancelAndSettle();
            terminal = true;
            return value;
        }
        catch (error) {
            try {
                await owner.cancelAndSettle();
                terminal = true;
            }
            catch { /* retain owner */ }
            throw error;
        }
        finally {
            if (terminal)
                budget.reads.delete(owner);
        }
    }
    finally {
        if (!begun || terminal)
            release();
    }
}
function promptRecallContentMode(env = process.env) {
    const mode = env['EVOLVER_RECALL_CONTENT'];
    return mode === 'summary' || mode === 'strategy' ? mode : 'context';
}
const digestText = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
async function assemblePromptContext(ranked, store, snapshot, env, deadlineAt, taskText) {
    const contentMode = promptRecallContentMode(env);
    if (contentMode === 'summary') {
        const rendered = renderPromptRecallContext(ranked);
        let cursor = 0;
        const sections = rendered.genes.map(({ gene }) => {
            const line = renderGeneLine(gene);
            const start = rendered.text.indexOf(line, cursor);
            cursor = start + line.length;
            return { geneAssetId: gene.asset_id, kind: 'summary', start, end: cursor, digest: digestText(line) };
        });
        return { text: rendered.text, digest: digestText(rendered.text), contentMode, privacyMode: 'enforce',
            geneAssetIds: rendered.genes.map(({ gene }) => gene.asset_id), capsuleAssetIds: [], sections, omissions: [],
            projections: [], qualifications: [], coverage: [], counts: { selected: ranked.length, eligible: ranked.length, rendered: rendered.genes.length, examples: 0 } };
    }
    const prefix = '[Evolver memory - relevant prior capability]\n';
    const suffix = '\nUse only when directly relevant. Adapt and verify before applying; historical examples are not current task success.';
    const context = await recall.assembleGeneContext({ selectedGenes: ranked.map(({ gene }) => gene), store,
        assertPromptAdapter: () => {
            if (!recall.isBuiltInPromptProvider(store))
                throw new Error('unsupported_prompt_context_provider_v1');
        },
        eligibility: { provenance: snapshot.provenance, review: snapshot.review, benchmark: recall.benchmarkContext(env['EVOLVER_BENCHMARK_ID']), referenceScope: snapshot.referenceScope },
        contentMode, privacyMode: 'enforce', deadlineAt, taskText,
        budget: { maxChars: Math.max(0, 2400 - prefix.length - suffix.length), maxExampleChars: 600, maxExampleCharsPerGene: 600,
            maxExamplesPerGene: env['EVOLVER_RECALL_EXAMPLES'] === 'off' ? 0 : 1 },
    });
    return wrapGeneContext(context, prefix, suffix);
}
/**
 * Shared Claude Code/Codex UserPromptSubmit entrypoint. It is intentionally local-only and fail-open: no Hub
 * query, no transcript read, no prompt persistence, and exactly one JSON object on stdout for every outcome.
 */
export function runPromptRecallHook(argv, deps = {}) {
    const run = () => recall.withSnapshotReadInvocation(() => runPromptRecallHookOwned(argv, deps));
    if ((deps.env ?? process.env)['EVOLVER_CONTEXT_STAGE_DIAGNOSTICS'] !== '1')
        return run();
    return recall.withContextReadDiagnostics(true, run, writeContextReadDiagnostic);
}
async function runPromptRecallHookOwned(argv, deps) {
    const write = deps.stdout ?? writeHookStdout;
    let output = {};
    let pending;
    const env = deps.env ?? process.env;
    const mode = promptRecallMode(env);
    // Privacy invariant from V1: default-off does not even read the prompt-bearing stdin payload.
    if (mode === 'off' || !argv.includes('--hook-stdin')) {
        try {
            await write('{}\n');
        }
        catch { /* one write attempt, never retry EPIPE */ }
        return 0;
    }
    try {
        const raw = await readHookPayload(deps.readHookInput);
        if (!raw?.trim())
            throw new Error('empty hook payload');
        const input = JSON.parse(raw);
        if (typeof input.hook_event_name === 'string' && input.hook_event_name !== 'UserPromptSubmit') {
            throw new Error('unexpected hook event');
        }
        const auditReadiness = (deps.protectedAuditNotice?.readiness ?? recall.protectedAuditReadiness)();
        if (auditReadiness.state === 'unavailable') {
            await writeProtectedAuditSessionNotice(typeof input.session_id === 'string' ? input.session_id : undefined, auditReadiness, deps.protectedAuditNotice?.statePath ?? protectedAuditNoticeStatePath(recall.evomapHome(env)), deps, '{}\n');
            return 0;
        }
        const prompt = input.prompt;
        if (typeof prompt !== 'string')
            throw new Error('prompt is not recallable');
        const trimmedPrompt = prompt.trim();
        if (trimmedPrompt.length < 8) {
            const normalizedPrompt = trimmedPrompt.toLowerCase().normalize('NFKC');
            if (!hasNonSpaceLetter(normalizedPrompt)
                || (normalizedPrompt.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 2) {
                throw new Error('prompt is not recallable');
            }
        }
        // The default prompt path constructs no writable store/ledger: all authority,
        // reference and trust reads happen asynchronously inside the one selection budget.
        const store = deps.store ?? new recall.ForeignJsonlSource(recall.assetsDir(env));
        if (!recall.isBuiltInPromptProvider(store))
            throw new Error('unsupported_prompt_context_provider_v1');
        const timeoutMs = deps.selectionTimeoutMs ?? PROMPT_RECALL_SELECTION_TIMEOUT_MS;
        const outerDeadline = performance.now() + Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : PROMPT_RECALL_SELECTION_TIMEOUT_MS);
        let snapshot;
        const ranked = await recall.measureContextReadStage('prompt_selection', () => withSelectionBudget(timeoutMs, [], async (budget) => {
            {
                snapshot = await ownPromptRead(budget, store, () => {
                    if (!recall.isBuiltInPromptProvider(store))
                        throw new Error('unsupported_prompt_context_provider_v1');
                    return store.beginPromptGeneSnapshotV1({
                        recent: true,
                        deadlineAt: budget.deadlineAt, signal: budget.signal,
                        maxFileBytes: MAX_PROMPT_RECALL_LOCAL_FILE_BYTES, maxTotalBytes: MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES
                    });
                });
                if (selectionExpired(budget))
                    return [];
                // Explicit dependencies remain authoritative for embedders/tests. Production
                // never constructs these synchronous ledger APIs on the prompt path.
                if (deps.review)
                    snapshot = { ...snapshot, review: deps.review.snapshot() };
                if (deps.provenance)
                    snapshot = { ...snapshot, provenance: deps.provenance.snapshot() };
            }
            return selectPromptGenes(prompt, snapshot, promptRecallMaxGenes(env), budget, recall.benchmarkContext(env['EVOLVER_BENCHMARK_ID']));
        }));
        try {
            if (ranked.length > 0 && snapshot) {
                // Convert the remaining monotonic budget to core's epoch deadline; never mix the two clocks.
                const context = await recall.measureContextReadStage('prompt_assembly', () => assemblePromptContext(ranked, store, snapshot, env, Date.now() + Math.max(0, outerDeadline - performance.now()), prompt));
                if (context.text)
                    pending = { context, genes: ranked.filter(({ gene }) => context.geneAssetIds.includes(gene.asset_id)), sessionId: input.session_id, referenceScope: snapshot.referenceScope };
                if (mode === 'enforce' && context.text) {
                    output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.text } };
                }
            }
        }
        finally {
            if (snapshot) {
                // Recovery owns a separate audit budget. Drain before new admission, even
                // without context, without spending the selection/Capsule assembly deadline.
                const scope = snapshot.referenceScope;
                const recover = Promise.resolve().then(() => deps.ingestor
                    ? deps.ingestor.recoverContextDeliveries?.({ deadlineAt: Date.now() + 100 })
                    : recall.Ingestor.recoverContextDeliveries({ path: recall.rootEventsPath(env), referenceScope: scope, deadlineAt: Date.now() + 100 }));
                await waitContextDelivery(recover.catch(() => undefined), 120);
            }
        }
    }
    catch {
        output = {};
        pending = undefined;
    }
    if (pending && mode === 'enforce') {
        const selected = pending;
        const sessionId = safeAuditIdentity(selected.sessionId);
        const event = { type: recall.GENE_CONTEXT_DELIVERY_EVENT, human: { title: 'Gene context stdout written' },
            payload: { receipt: recall.geneContextDeliveryReceipt(selected.context), entrypoint: 'prompt_recall',
                transport: 'stdout_written', hostReceived: 'unknown', ...(sessionId ? { sessionId } : {}) } };
        const prepare = deps.ingestor ? ((options) => {
            if (typeof deps.ingestor?.prepareContextDeliveryAsync === 'function')
                return deps.ingestor.prepareContextDeliveryAsync(event, options);
            if (!deps.ingestor?.prepareContextDelivery)
                throw new Error('unsupported_context_delivery_sink_v1');
            return deps.ingestor.prepareContextDelivery(event, options);
        })
            : (options) => recall.Ingestor.prepareContextDeliveryAsync(event, { ...options, path: recall.rootEventsPath(env), referenceScope: selected.referenceScope });
        const result = await deliverContextOutput({ text: `${JSON.stringify(output)}\n`,
            prepare, ...(deps.stdout ? { stdout: deps.stdout } : {}),
            ...(deps.stdoutWithSettlement ? { stdoutWithSettlement: deps.stdoutWithSettlement } : {}),
            ...(deps.onOutputWritten ? { onOutputWritten: deps.onOutputWritten } : {}) });
        if (result === 'prepare_failed') {
            try {
                await write('{}\n');
            }
            catch { /* One fallback; no context was dispatched. */ }
            return 0;
        }
        if (result === 'written')
            await logPromptRecallSelections(selected.genes, mode, selected.sessionId, env, Date.now() + 150, deps.callLog);
        return 0;
    }
    try {
        await write(`${JSON.stringify(output)}\n`);
    }
    catch {
        return 0;
    }
    try {
        deps.onOutputWritten?.();
    }
    catch { /* An observer cannot invalidate confirmed stdout. */ }
    if (pending) {
        // Shadow is an advisory would-render event, never a prepared stdout-written receipt.
        await logPromptRecallSelections(pending.genes, mode, pending.sessionId, env, Date.now() + 150, deps.callLog);
        try {
            const sessionId = safeAuditIdentity(pending.sessionId);
            const event = { type: recall.GENE_CONTEXT_DELIVERY_EVENT,
                human: { title: mode === 'shadow' ? 'Gene context would render' : 'Gene context stdout written' },
                payload: { receipt: recall.geneContextDeliveryReceipt(pending.context), entrypoint: 'prompt_recall',
                    transport: mode === 'shadow' ? 'would_render' : 'stdout_written', hostReceived: 'unknown',
                    ...(sessionId ? { sessionId } : {}) } };
            if (recall.fitsRootEventLine(event)) {
                // Only the known local Ingestor has the bounded audit writer. A caller-supplied
                // Promise-only sink has no terminal ownership proof and is never dispatched.
                if (!deps.ingestor)
                    await recall.Ingestor.ingestBoundedReceipt(event, { path: recall.rootEventsPath(env),
                        referenceScope: pending.referenceScope, deadlineAt: Date.now() + 200 });
                else if (deps.ingestor instanceof recall.Ingestor
                    && Object.getPrototypeOf(deps.ingestor) === recall.Ingestor.prototype
                    && deps.ingestor.ingestBoundedReceipt === recall.Ingestor.prototype.ingestBoundedReceipt) {
                    await deps.ingestor.ingestBoundedReceipt(event, { deadlineAt: Date.now() + 200 });
                }
            }
        }
        catch { /* audit failure cannot block user submission */ }
    }
    return 0;
}