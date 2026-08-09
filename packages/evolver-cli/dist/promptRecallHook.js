import { assetstore, events, hub, signals } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
/** The hook sees a raw user prompt, so reject oversized payloads instead of retaining a partial JSON document. */
export const MAX_PROMPT_RECALL_STDIN_BYTES = 64 * 1024;
export const MAX_PROMPT_RECALL_LOCAL_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES = 8 * 1024 * 1024;
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
const PROMPT_RECALL_LOCAL_FILES = [
    'genes.jsonl',
    'capsules.jsonl',
    'events.jsonl',
    'anti-genes.jsonl',
    'review.jsonl',
    'provenance.jsonl',
];
export function promptRecallMode(env = process.env) {
    const value = String(env['EVOLVER_RECALL_MODE'] ?? '').trim().toLowerCase();
    return value === 'shadow' || value === 'enforce' ? value : 'off';
}
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
    const raw = readHookInput ? await readHookInput() : await readStdinBounded();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROMPT_RECALL_STDIN_BYTES)
        return undefined;
    return raw;
}
function normalizedTokens(text, maxChars, maxTokens) {
    const bounded = text.slice(0, maxChars);
    const matches = bounded
        .toLowerCase()
        .normalize('NFKC')
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => (token.length >= 2 || /^\d+$/.test(token)) && token.length <= PROMPT_RECALL_TOKEN_CHARS)
        ?? [];
    // A character-boundary cut can leave a partial final token. Dropping it is conservative: it avoids a false
    // literal match while keeping prompt processing independent of the raw prompt's total size.
    if (text.length > maxChars && matches.length > 0)
        matches.pop();
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
    const tailTokens = normalizedTokens(prompt.slice(-segmentChars), segmentChars, segmentTokens);
    // The tail slice may begin in the middle of a token. Discard its first run rather than admit a prefix match.
    tailTokens.shift();
    return [
        normalizedTokens(prompt, segmentChars, segmentTokens),
        tailTokens,
    ];
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
 * separated by `|` are matched as normalized token sequences, while regex-looking patterns are never evaluated
 * (a persisted pattern must not be able to run an expensive regular expression on a private prompt).
 */
function literalSignalHits(promptIndex, patterns) {
    let hits = 0;
    for (const pattern of patterns) {
        const aliases = pattern.split('|', PROMPT_RECALL_SIGNAL_ALIASES + 1).slice(0, PROMPT_RECALL_SIGNAL_ALIASES);
        const matched = aliases.some((alias) => {
            const trimmed = alias.trim();
            if (!trimmed
                || trimmed.length > PROMPT_RECALL_SIGNAL_ALIAS_CHARS
                || (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0))
                return false;
            return containsSequence(promptIndex, normalizedAliasTokens(trimmed));
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
function localRecallFilesWithinBudget(store) {
    if (!(store instanceof assetstore.LocalJsonlProvider))
        return true;
    try {
        lstatSync(join(store.baseDir, '.assetstore.lock'));
        return false;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            return false;
    }
    let totalBytes = 0;
    for (const file of PROMPT_RECALL_LOCAL_FILES) {
        try {
            const stat = lstatSync(join(store.baseDir, file));
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROMPT_RECALL_LOCAL_FILE_BYTES)
                return false;
            totalBytes += stat.size;
            if (totalBytes > MAX_PROMPT_RECALL_LOCAL_TOTAL_BYTES)
                return false;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return false;
        }
    }
    return true;
}
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function selectPromptGenes(prompt, store, review, provenance, maxGenes, budget) {
    const tokenSegments = promptTokenSegments(prompt);
    const promptTokens = tokenSegments.flat();
    if (promptTokens.length === 0)
        return [];
    const promptIndex = buildPromptSequenceIndex(tokenSegments);
    const boundedPrompt = promptTokens.join(' ');
    const approved = await assetstore.listApprovedGenes(store, review, PROMPT_RECALL_SCAN_LIMIT, provenance);
    if (selectionExpired(budget))
        return [];
    const ranked = [];
    for (let index = 0; index < approved.length; index += 1) {
        if (selectionExpired(budget))
            return [];
        const gene = approved[index];
        const signalsMatch = boundedSignalPatterns(gene);
        const literalHits = literalSignalHits(promptIndex, signalsMatch);
        if (literalHits > 0) {
            const semanticScore = signals.tagOverlapScore(promptTokens, {
                signalsMatch,
                geneId: boundedGeneField(gene['id']),
                category: boundedGeneField(gene['category']),
                summary: boundedGeneField(gene['summary']),
            }) + signals.bagCosine(boundedPrompt, geneText(gene, signalsMatch));
            ranked.push({
                gene,
                literalHits,
                semanticScore,
                assetKey: String(gene.asset_id).slice(0, 128),
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
    return ranked.slice(0, maxGenes);
}
function renderGeneLine(gene) {
    const id = (typeof gene['id'] === 'string' ? gene['id'] : String(gene.asset_id)).slice(0, 128);
    const category = typeof gene['category'] === 'string' ? gene['category'].slice(0, 96) : '';
    const summary = typeof gene['summary'] === 'string'
        ? gene['summary'].slice(0, PROMPT_RECALL_GENE_FIELD_CHARS).replace(/\s+/g, ' ').trim()
        : '';
    return `- ${id}${category ? ` [${category}]` : ''}${summary ? `: ${summary.slice(0, 240)}` : ''}`;
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
function logPromptRecallSelections(genes, mode, sessionId, env, injectedLog) {
    if (genes.length === 0)
        return;
    const callLog = injectedLog ?? new hub.AssetCallLog(events.assetCallLogPath(env));
    const runId = `recall:${boundedAuditString(sessionId) ?? 'unknown'}`;
    for (const ranked of genes) {
        const sourceNodeId = boundedAuditString(ranked.gene['source_node_id'] ?? ranked.gene['author_node_id']);
        const chainId = boundedAuditString(ranked.gene['chain_id']);
        try {
            callLog.append({
                run_id: runId,
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
                },
            });
        }
        catch { /* local attribution must never block prompt submission */ }
    }
}
async function withSelectionBudget(timeoutMs, fallback, run) {
    const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : PROMPT_RECALL_SELECTION_TIMEOUT_MS;
    const budget = {
        deadlineMs: performance.now() + boundedTimeoutMs,
        cancelled: false,
    };
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => run(budget)),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    budget.cancelled = true;
                    resolve(fallback);
                }, boundedTimeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * Shared Claude Code/Codex UserPromptSubmit entrypoint. It is intentionally local-only and fail-open: no Hub
 * query, no transcript read, no prompt persistence, and exactly one JSON object on stdout for every outcome.
 */
export async function runPromptRecallHook(argv, deps = {}) {
    const write = deps.stdout ?? ((text) => { process.stdout.write(text); });
    let output = {};
    const env = deps.env ?? process.env;
    const envFile = loadEnvFileFromEnv(env);
    if (env['EVOLVER_ENV_FILE']?.trim() && !envFile.loaded) {
        write('{}\n');
        return 0;
    }
    const mode = promptRecallMode(env);
    // Privacy invariant from V1: default-off does not even read the prompt-bearing stdin payload.
    if (mode === 'off' || !argv.includes('--hook-stdin')) {
        write('{}\n');
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
        const prompt = input.prompt;
        if (typeof prompt !== 'string' || prompt.trim().length < 8)
            throw new Error('prompt is not recallable');
        const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
        // These cold-loaded JSONL files are parsed synchronously inside the existing store/ledger APIs. Preflight
        // their footprint before entering those APIs so an append-only sidecar cannot defeat the hook deadline.
        if (!localRecallFilesWithinBudget(store))
            throw new Error('local recall files exceed the prompt-hook budget');
        const review = deps.review ?? assetstore.reviewLedgerForStore(store);
        const provenance = deps.provenance ?? assetstore.provenanceStoreForStore(store);
        const timeoutMs = deps.selectionTimeoutMs ?? PROMPT_RECALL_SELECTION_TIMEOUT_MS;
        const ranked = await withSelectionBudget(timeoutMs, [], (budget) => selectPromptGenes(prompt, store, review, provenance, promptRecallMaxGenes(env), budget));
        if (ranked.length > 0) {
            const rendered = renderPromptRecallContext(ranked);
            if (rendered.text) {
                logPromptRecallSelections(rendered.genes, mode, input.session_id, env, deps.callLog);
            }
            if (mode === 'enforce' && rendered.text) {
                output = {
                    hookSpecificOutput: {
                        hookEventName: 'UserPromptSubmit',
                        additionalContext: rendered.text,
                    },
                };
            }
        }
    }
    catch {
        output = {};
    }
    write(`${JSON.stringify(output)}\n`);
    return 0;
}