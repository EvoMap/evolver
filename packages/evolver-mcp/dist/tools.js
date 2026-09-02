import { assetstore, wire, mailbox as mb, hub, bootstrap, ops } from '@evomap/evolver-core';
import { buildEvolverPrimer } from './primer.js';
const str = (v) => (typeof v === 'string' ? v : String(v ?? ''));
const strArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
const REUSE_OUTCOMES = new Set(['success', 'failed', 'mismatched', 'stale', 'unsafe']);
const LOCAL_READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const REMOTE_READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
// Codex `auto` fail-closes when destructiveHint is true. MCP "destructive" as
// delete/overwrite is not that contract: any state-writing tool must prompt.
const LOCAL_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
const REMOTE_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function resultArray(value) {
    const r = record(value);
    if (Array.isArray(r['results']))
        return r['results'];
    if (Array.isArray(r['assets']))
        return r['assets'];
    const payload = record(r['payload']);
    if (Array.isArray(payload['results']))
        return payload['results'];
    if (Array.isArray(payload['assets']))
        return payload['assets'];
    return [];
}
function firstAsset(value) {
    const r = record(value);
    if (Array.isArray(r['assets']))
        return r['assets'][0] ?? null;
    if (Array.isArray(r['results']))
        return r['results'][0] ?? null;
    const payload = record(r['payload']);
    if (Array.isArray(payload['assets']))
        return payload['assets'][0] ?? null;
    if (Array.isArray(payload['results']))
        return payload['results'][0] ?? null;
    if (r['asset'])
        return r['asset'];
    if (payload['asset'])
        return payload['asset'];
    return null;
}
function requestedAsset(value, assetId) {
    const asset = firstAsset(value);
    const recordAsset = record(asset);
    return recordAsset['asset_id'] === assetId ? asset : null;
}
function proxyFallbackMetadata(value) {
    const response = record(value);
    if (response['degraded'] !== true)
        return undefined;
    return {
        degraded: true,
        local_fallback: response['local_fallback'] === true,
        auth_status: response['auth_status'],
        warning: response['warning'],
    };
}
function proxySearchResult(value) {
    const results = resultArray(value);
    const metadata = proxyFallbackMetadata(value);
    return metadata ? { results, assets: results, ...metadata } : results;
}
function proxyFetchResult(value, assetId) {
    const asset = requestedAsset(value, assetId);
    const metadata = proxyFallbackMetadata(value);
    return metadata ? { asset, ...metadata } : asset;
}
function optionalNonNegativeNumberArg(args, key, error) {
    if (!Object.prototype.hasOwnProperty.call(args, key))
        return undefined;
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error(error);
    return value;
}
function reuseOutcome(value) {
    if (typeof value === 'string' && REUSE_OUTCOMES.has(value)) {
        return value;
    }
    throw new Error('invalid reuse outcome');
}
function validateAssetBundleArgs(args) {
    if (Object.prototype.hasOwnProperty.call(args, 'assets')) {
        const assets = args['assets'];
        if (!Array.isArray(assets) || assets.length === 0 || assets.some((asset) => asset == null)) {
            throw new Error('evolver_asset_validate requires asset or non-empty assets');
        }
        return assets;
    }
    if (Object.prototype.hasOwnProperty.call(args, 'asset')) {
        const asset = args['asset'];
        if (asset == null)
            throw new Error('evolver_asset_validate requires asset or non-empty assets');
        return [asset];
    }
    throw new Error('evolver_asset_validate requires asset or non-empty assets');
}
/**
 * Evolver MCP 工具集(M5-2). asset.search/fetch/publish + gep.build + mailbox.*.
 * schema 单一来源走 gep-sdk(经 evolver-core 重导出), 不重复实现.
 */
export function buildEvolverTools(deps) {
    const now = deps.now ?? (() => Date.now());
    const searchableKinds = ['Gene', 'Capsule', 'EvolutionEvent', 'AntiGene'];
    // Per-connection idempotency for reuse-feedback emissions (#268): a retried reuse_result must not double-record.
    // Keyed by (eventType, connId, assetId, taskId); deduped ONLY when the agent supplies a taskId (the explicit
    // dedup handle) — without it we cannot tell a retry from a genuine new reuse, so we must not drop it (Bugbot
    // #269). Bounded by one stdio process' lifetime.
    const emitted = new Set();
    // Best-effort + never throws: reuse-feedback is an optimization, so an ingest failure can never break the tool
    // the agent is calling (mirrors the autoexec reuse seam contract). Returns whether the event was recorded
    // (emitted now OR already recorded via idempotency; false = no ingestor, or the ingest threw).
    const emitReuse = async (type, assetId, taskId, extra, title) => {
        if (!deps.ingestor)
            return false;
        const cycleId = `${deps.cycleId ?? 'mcp'}${taskId ? `:${taskId}` : ''}`;
        const key = taskId ? `${type}|${deps.cycleId ?? 'mcp'}|${assetId}|${taskId}` : null;
        if (key && emitted.has(key))
            return true; // already recorded this (type,assetId,taskId) on a prior call
        if (key)
            emitted.add(key);
        try {
            // The root_event schema caps human.title at 80 chars (humanNarrative). A content-addressed assetId is a
            // 71-char `sha256:…`, so a naive `<prefix>: <assetId>` title overflows and the ingest THROWS — which this
            // best-effort path would SILENTLY swallow, leaving the local ledger un-credited for every MCP reuse of a
            // real asset (#268 regression). Clamp defensively so a long title can never drop the event; the full
            // assetId is always in the payload regardless.
            await deps.ingestor.ingest({ type, human: { title: title.slice(0, 80), detail: `cycle ${cycleId}` }, payload: { assetId, cycleId, ...extra } });
            return true;
        }
        catch {
            if (key)
                emitted.delete(key);
            return false; /* keep retryable; report not recorded */
        }
    };
    // SUCCESS → value.reuse_hit (observed reuse; no measured baseline means zero/unknown savings, never a
    // fabricated ROI number). NON-success → value.reuse_outcome (the keep/prune verdict half of the cross-runtime
    // signal, #268 slice C; summarizeReuseOutcomes reads it). Both best-effort + idempotent.
    // Titles use a SHORT asset id (the full sha256:… lives in the payload) so they stay well under the 80-char
    // title cap; emitReuse also clamps defensively.
    const emitReuseHit = (assetId, taskId) => emitReuse(ops.VALUE_REUSE_HIT_EVENT, assetId, taskId, { fetchTokens: 0 }, `mcp reuse hit: ${assetId.slice(0, 19)}…`);
    const emitReuseOutcome = (assetId, taskId, outcome) => emitReuse(ops.VALUE_REUSE_OUTCOME_EVENT, assetId, taskId, { outcome }, `mcp reuse ${outcome}: ${assetId.slice(0, 19)}…`);
    // evolver_recall priming → a `value.inject` root_event recording which approved genes were primed (#mcp-recall),
    // the SAME attribution rail the SessionStart hook feeds (ops.VALUE_INJECT_EVENT). This is what lets #274
    // auto-recall later observe — from the MCP agent's own transcript (the generic-chat adapter) — which injected
    // genes were actually used, closing the self-learning loop for any MCP agent, not just the hook-based runtimes.
    // Best-effort + never throws (priming is the agent's path); deduped per connection on the (session, gene set) so
    // repeated recall calls do not inflate the inject rail.
    //
    // sessionId is what ties the inject to a transcript: #274 auto-recall only emits value.recall when the inject
    // payload's sessionId EQUALS the transcript basename (minus .jsonl) — sessionIdFromTranscript. The MCP server
    // cannot know the agent's transcript filename, so the agent must pass its session key for the loop to close;
    // without it the value.inject is attribution-only (recorded, but auto-recall cannot correlate it to a session).
    const injectedSig = new Set();
    const emitInject = async (geneIds, sessionId) => {
        if (!deps.ingestor || geneIds.length === 0)
            return false;
        const cycleId = deps.cycleId ?? 'mcp';
        const sig = `${sessionId ?? ''}|${[...geneIds].join(',')}`;
        if (injectedSig.has(sig))
            return true; // already recorded this (session, gene set) on this connection
        injectedSig.add(sig);
        try {
            await deps.ingestor.ingest({
                type: ops.VALUE_INJECT_EVENT,
                human: { title: `mcp injected ${geneIds.length} gene(s)`, detail: `cycle ${cycleId}` },
                payload: { geneIds: [...geneIds], cycleId, ...(sessionId ? { sessionId } : {}) },
            });
            return true;
        }
        catch {
            injectedSig.delete(sig);
            return false; /* keep retryable */
        }
    };
    const tools = [
        {
            // Self-onboarding (#mcp-onboarding): any MCP agent can learn the quiet reuse loop when it needs guidance.
            // Mirrors the initialize.instructions primer; always present, but no longer asks the agent to narrate routine work.
            name: 'evolver_guide',
            description: '按需说明 evolver 的静默复用机制(Recipe search→express, Gene/Capsule 为 fallback；search→reuse→capture 循环)与各工具何时调用；不要向用户叙述例行预检、状态或空搜索。',
            inputSchema: { type: 'object', properties: {} },
            annotations: LOCAL_READ_ONLY,
            handler: async () => ({ guide: buildEvolverPrimer({ proxy: !!deps.proxy }) }),
        },
        {
            // Priming for ANY MCP agent (#mcp-recall): when prior local memory is likely to help, return trusted +
            // review-approved genes (the same gate the SessionStart hook uses) AND record a value.inject so auto-recall can
            // later observe, from this agent's transcript, which primed genes were used. NOT a hub search (that is
            // evolver_asset_search): this is the curated, already-approved local memory, ready to reuse quietly.
            name: 'evolver_recall',
            description: 'Fallback：当本机已审核通过的可复用经验 gene 可能有帮助时调用（不是 Hub Recipe 搜索）。联网默认先 evolver_recipe_search / evolver_recipe_express。返回信任+审核双闸后的本地 gene，并记录一条 value.inject。若传入 sessionId(= 本会话 transcript 文件名去掉 .jsonl 后缀),后续 auto-recall 能从该 transcript 观测哪些注入 gene 真正被用,为经 MCP 接入的 AI 闭合自学习环;不传则仅记录归因、无法关联到会话。命中后静默复用，并在结果明确后用 evolver_asset_reuse_result 回报。',
            inputSchema: { type: 'object', properties: { limit: { type: 'number' }, sessionId: { type: 'string' } } },
            annotations: LOCAL_WRITE,
            handler: async (a) => {
                const limit = optionalNonNegativeNumberArg(a, 'limit', 'evolver_recall limit must be a non-negative number') ?? 5;
                const sessionId = typeof a['sessionId'] === 'string' && a['sessionId'].trim() ? a['sessionId'].trim() : undefined;
                const review = assetstore.reviewLedgerForStore(deps.store);
                const provenance = assetstore.provenanceStoreForStore(deps.store);
                const genes = await assetstore.listApprovedGenes(deps.store, review, limit, provenance);
                const primed = genes.map((g) => {
                    const r = g;
                    const id = typeof r['id'] === 'string' ? r['id'] : String(r['asset_id']);
                    return {
                        id,
                        asset_id: String(r['asset_id']),
                        ...(typeof r['summary'] === 'string' ? { summary: r['summary'] } : {}),
                        ...(Array.isArray(r['signals_match']) ? { signals_match: r['signals_match'] } : {}),
                        ...(Array.isArray(r['strategy']) ? { strategy: r['strategy'] } : {}),
                    };
                });
                const injected = await emitInject(primed.map((p) => p.id), sessionId);
                return {
                    genes: primed,
                    count: primed.length,
                    injected,
                    correlated: injected && sessionId !== undefined, // auto-recall can tie this inject to the session only with a sessionId
                    note: primed.length === 0
                        ? 'no approved genes yet — distill/approve some first (evolver_distill_conversation), then they appear here'
                        : sessionId === undefined
                            ? 'reuse a matching gene, then report via evolver_asset_reuse_result. Pass sessionId (your transcript filename without .jsonl) so evolver can observe which primed genes you used.'
                            : 'reuse a matching gene, then report the outcome via evolver_asset_reuse_result',
                };
            },
        },
        ...(deps.proxy ? [{
                name: 'evolver_recipe_search',
                description: '默认第一步：通过本机 evolver-proxy 搜索 Hub 已发布 Recipe（有序 Gene/Capsule DNA）。命中后调用 evolver_recipe_express。无匹配时再 fallback 到 evolver_asset_search。旧客户端默认收到 Recipe 数组；设置 includePagination=true 可读取 nextCursor/hasMore。',
                annotations: REMOTE_READ_ONLY,
                inputSchema: {
                    type: 'object',
                    properties: {
                        q: { type: 'string' },
                        query: { type: 'string' },
                        text: { type: 'string' },
                        limit: { type: 'number' },
                        cursor: { type: 'string' },
                        sort: { type: 'string' },
                        includePagination: {
                            type: 'boolean',
                            description: 'Set true to return the recipe page envelope with nextCursor/hasMore. The default array shape remains backwards compatible.',
                        },
                    },
                },
                handler: async (a) => {
                    const q = [a['q'], a['query'], a['text']].find((value) => typeof value === 'string' && value.trim().length > 0);
                    const includePagination = a['includePagination'] === true;
                    const receipt = record(await deps.proxy.searchRecipes({
                        ...(q ? { q } : {}),
                        ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
                        ...(typeof a['cursor'] === 'string' ? { cursor: a['cursor'] } : {}),
                        ...(typeof a['sort'] === 'string' ? { sort: a['sort'] } : {}),
                    }));
                    if (includePagination && (Array.isArray(receipt['recipes'])
                        || Array.isArray(receipt['results'])
                        || Array.isArray(receipt['items'])))
                        return receipt;
                    if (Array.isArray(receipt['recipes']))
                        return receipt['recipes'];
                    if (Array.isArray(receipt['results']))
                        return receipt['results'];
                    if (Array.isArray(receipt['items']))
                        return receipt['items'];
                    return receipt;
                },
            }, {
                name: 'evolver_recipe_express',
                description: '表达/执行一条 Recipe：只转发 Hub POST /a2a/recipe/{id}/express。Hub 按步骤展开 Gene 再 Capsule，从而产生全网 gene/capsule 调用。不要在本地解析 recipe JSON。',
                annotations: REMOTE_WRITE,
                inputSchema: {
                    type: 'object',
                    required: ['recipeId'],
                    properties: {
                        recipeId: { type: 'string' },
                        inputPayload: { type: 'object' },
                    },
                },
                handler: async (a) => {
                    const recipeId = str(a['recipeId']).trim();
                    if (!recipeId)
                        throw new Error('evolver_recipe_express requires recipeId');
                    const inputPayload = a['inputPayload'];
                    return deps.proxy.expressRecipe({
                        recipeId,
                        ...(inputPayload && typeof inputPayload === 'object' && !Array.isArray(inputPayload)
                            ? { inputPayload: inputPayload }
                            : {}),
                    });
                },
            }, {
                name: 'evolver_proxy_status',
                description: '检查本机 evolver-proxy 与 PHub 的连接状态. 需要 EVOLVER_PROXY_URL/EVOLVER_IPC_TOKEN.',
                inputSchema: { type: 'object', properties: {} },
                annotations: REMOTE_READ_ONLY,
                handler: async () => deps.proxy.status(),
            }] : []),
        {
            name: 'evolver_asset_search',
            description: deps.proxy
                ? 'Fallback：当 evolver_recipe_search 无匹配 Recipe 时，通过本机 evolver-proxy 直搜 PHub 经验资产(Gene/Capsule/EvolutionEvent)。AntiGene 是本地负经验资产, 会直接查本地库供人工 review. 真正复用应优先 evolver_recipe_express。'
                : '搜索本地经验资产库(Gene/Capsule/EvolutionEvent/AntiGene). 支持 kind/信号/类目/gene 反查/文本. 联网 Recipe 搜索需要 evolver-proxy。',
            inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: searchableKinds }, signalsAny: { type: 'array', items: { type: 'string' } }, category: { type: 'string' }, gene: { type: 'string' }, text: { type: 'string' }, limit: { type: 'number' } } },
            annotations: deps.proxy ? REMOTE_READ_ONLY : LOCAL_READ_ONLY,
            handler: async (a) => {
                if (deps.proxy && a['kind'] === 'AntiGene') {
                    return deps.store.search({
                        kind: 'AntiGene',
                        signalsAny: a['signalsAny'],
                        category: a['category'],
                        gene: a['gene'],
                        text: a['text'],
                        limit: a['limit'],
                    });
                }
                if (deps.proxy) {
                    return proxySearchResult(await deps.proxy.search({
                        signalsAny: strArray(a['signalsAny']),
                        ...(typeof a['kind'] === 'string' ? { kind: a['kind'] } : {}),
                        ...(typeof a['category'] === 'string' ? { category: a['category'] } : {}),
                        ...(typeof a['gene'] === 'string' ? { gene: a['gene'] } : {}),
                        ...(typeof a['text'] === 'string' ? { text: a['text'] } : {}),
                        ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
                    }));
                }
                return deps.store.search({
                    kind: a['kind'],
                    signalsAny: a['signalsAny'],
                    category: a['category'],
                    gene: a['gene'],
                    text: a['text'],
                    limit: a['limit'],
                });
            },
        },
        {
            name: 'evolver_asset_fetch',
            description: deps.proxy ? '通过本机 evolver-proxy 按 asset_id 从 PHub 拉 full asset, 供当前 Agent 直接复用.' : '按 asset_id 取单个资产.',
            inputSchema: { type: 'object', required: ['assetId'], properties: { assetId: { type: 'string' } } },
            annotations: deps.proxy ? REMOTE_READ_ONLY : LOCAL_READ_ONLY,
            handler: async (a) => {
                const assetId = str(a['assetId']);
                if (deps.proxy) {
                    const local = await deps.store.get(assetId);
                    if (local?.type === 'AntiGene')
                        return local;
                    return proxyFetchResult(await deps.proxy.fetchAsset({ assetId }), assetId);
                }
                return deps.store.get(assetId);
            },
        },
        {
            name: 'evolver_gep_build',
            description: '由字段构造资产并计算 asset_id(content-addressed). 不落库; 返回带 asset_id 的资产 + 校验结果. 用于发布前确认.',
            inputSchema: { type: 'object', required: ['asset'], properties: { asset: { type: 'object' } } },
            annotations: LOCAL_READ_ONLY,
            handler: async (a) => {
                const asset = a['asset'];
                const assetId = wire.computeAssetId(asset);
                const validation = wire.validateWire(asset);
                return { asset: { ...asset, asset_id: assetId }, asset_id: assetId, wire_valid: validation.ok, wire_errors: validation.errors };
            },
        },
        {
            name: 'evolver_asset_publish',
            description: deps.proxy ? '把资产提交给本机 evolver-proxy, 由 proxy 异步发布到 PHub. Capsule.gene 须非空或 ad-hoc.' : '仅把资产写入本地库(content-addressed 去重 + 强绑定校验)，不会发布到 PHub；返回 local_only 明示该语义. Capsule.gene 须非空或 ad-hoc.',
            inputSchema: { type: 'object', required: ['asset'], properties: { asset: { type: 'object' } } },
            annotations: deps.proxy ? REMOTE_WRITE : LOCAL_WRITE,
            handler: async (a) => {
                if (deps.proxy)
                    return deps.proxy.submitAsset(a['asset']);
                const stored = await deps.store.put(a['asset']);
                return {
                    ...record(stored),
                    local_only: true,
                    publish_status: 'local_only',
                    warning: 'Asset was stored locally and was not published to Hub.',
                };
            },
        },
        {
            name: 'evolver_distill_conversation',
            description: '从当前对话蒸馏可复用能力. persist=true 只在结果可发布(经宿主验证)或为失败/无轨迹草稿时才落 Gene/Capsule; 携带调用方自报 success 轨迹而未经宿主验证时仅返回草稿不落库. 需要具体 summary、strategy/evidence、artifacts、validation; 质量闸门会将弱信号保留为草稿而不会发布. provider 若不具备 putBundle 能力，成对持久化会 fail-closed 并返回 bundle_persistence_unsupported. Hub 默认优先发布成 Recipe, 不再优先上 Skill Store. publish=true 时默认 compose_recipe, 可用 publish_recipe=false 关掉.',
            annotations: deps.proxy ? REMOTE_WRITE : LOCAL_WRITE,
            inputSchema: {
                type: 'object',
                required: ['summary'],
                properties: {
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    platform: { type: 'string' },
                    thread_id: { type: 'string' },
                    user_prompt: { type: 'string' },
                    assistant_summary: { type: 'string' },
                    transcript: { type: 'string' },
                    signals: { type: 'array', items: { type: 'string' } },
                    strategy: { type: 'array', items: { type: 'string' } },
                    artifacts: { type: 'array', items: { type: 'string' } },
                    validation: { type: 'array', items: { type: 'string' } },
                    persist: { type: 'boolean' },
                    publish: { type: 'boolean' },
                    publish_recipe: { type: 'boolean', description: 'When publish=true, also compose and publish a Recipe. Defaults to true.' },
                    min_score: { type: 'integer', minimum: 5, maximum: 10 },
                },
            },
            handler: async (a) => {
                const input = { ...a, platform: a['platform'] || 'mcp', model: bootstrap.detectModelName() };
                if (deps.proxy)
                    return deps.proxy.distillConversation(input);
                return hub.distillConversation(input, { persist: a['persist'] === true, store: deps.store });
            },
        },
    ];
    // Reuse-result is the MCP-native recall signal (#268): the agent self-reports whether a reused asset worked.
    // Registered in ALL modes (was proxy-only) so MCP-only agents — no SessionStart hook, no daemon — can close the
    // loop. A SUCCESS credits the LOCAL ledger via emitLocalReuse; proxy mode ALSO forwards to PHub for cross-node
    // aggregation (prior behavior + return shape preserved).
    tools.push({
        name: 'evolver_asset_reuse_result',
        description: '上报某复用资产的实际结果(success/failed/mismatched/stale/unsafe). 任何模式下 success 会在本地 value-ledger 记一笔 reuse(让经 MCP 接入的任何 AI 都能反哺本地经验环, #268);proxy 模式还会转发到 PHub.',
        annotations: deps.proxy ? REMOTE_WRITE : LOCAL_WRITE,
        inputSchema: {
            type: 'object',
            required: ['assetId', 'outcome'],
            properties: {
                assetId: { type: 'string' },
                outcome: { type: 'string', enum: ['success', 'failed', 'mismatched', 'stale', 'unsafe'] },
                taskId: { type: 'string' },
                traceId: { type: 'string' },
                tokensSaved: { type: 'number', minimum: 0, description: 'Deprecated compatibility field. Ignored unless future measurement metadata proves a measured baseline.' },
                timeSavedSeconds: { type: 'number', minimum: 0 },
                reason: { type: 'string' },
            },
        },
        handler: async (a) => {
            // Validate numeric args FIRST so a bad request rejects before any local emit or hub forward.
            // Keep validating the deprecated field for caller compatibility, but never forward it as ROI by itself.
            optionalNonNegativeNumberArg(a, 'tokensSaved', 'invalid_tokens_saved');
            const timeSavedSeconds = optionalNonNegativeNumberArg(a, 'timeSavedSeconds', 'invalid_time_saved_seconds');
            const assetId = str(a['assetId']);
            const outcome = reuseOutcome(a['outcome']);
            const taskId = typeof a['taskId'] === 'string' ? a['taskId'] : undefined;
            // Local-first: feed the local experience loop even with no proxy/hub (the MCP-only path). SUCCESS credits the
            // $ rail (reuse_hit); a non-success records the keep/prune verdict (reuse_outcome) — the cross-runtime signal.
            let creditedLocally = false;
            if (outcome === 'success')
                creditedLocally = await emitReuseHit(assetId, taskId);
            else
                await emitReuseOutcome(assetId, taskId, outcome);
            if (deps.proxy) {
                return deps.proxy.recordReuseResult({
                    assetId, outcome,
                    ...(taskId !== undefined ? { taskId } : {}),
                    ...(typeof a['traceId'] === 'string' ? { traceId: a['traceId'] } : {}),
                    ...(timeSavedSeconds !== undefined ? { timeSavedSeconds } : {}),
                    ...(typeof a['reason'] === 'string' ? { reason: a['reason'] } : {}),
                });
            }
            return { recorded: true, local: creditedLocally, outcome };
        },
    });
    if (deps.mailbox) {
        const box = deps.mailbox;
        tools.push({
            name: 'evolver_mailbox_send',
            description: '投递一条 mailbox 消息(类型须在目录内). 副作用类型应传 idempotencyKey.',
            inputSchema: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, payload: { type: 'object' }, idempotencyKey: { type: 'string' }, runtimeNamespace: { type: 'string' } } },
            annotations: LOCAL_WRITE,
            handler: async (a) => {
                const env = mb.createEnvelope({
                    type: str(a['type']), payload: a['payload'],
                    ...(a['idempotencyKey'] ? { idempotencyKey: str(a['idempotencyKey']) } : {}),
                    ...(a['runtimeNamespace'] ? { runtimeNamespace: str(a['runtimeNamespace']) } : {}),
                    now: now(),
                });
                const r = box.send(env);
                return { id: env.id, receiptId: r.receiptId, stored: r.stored, correlationId: env.correlationId };
            },
        }, {
            name: 'evolver_mailbox_status',
            description: '查 mailbox 消息状态(status/attempts/dlq).',
            inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
            annotations: LOCAL_READ_ONLY,
            handler: async (a) => box.getStatus(str(a['id'])) ?? { error: 'not found' },
        });
    }
    if (deps.proxy) {
        tools.push({
            name: 'evolver_agent_search',
            description: '按自然语言 query 或 capability signals 搜索可协作 agent；结果来自 Hub，不代表实时可用，availability=unknown 时不得推断在线。',
            inputSchema: agentDirectorySearchSchema(),
            annotations: REMOTE_READ_ONLY,
            handler: async (a) => deps.proxy.searchAgents(agentSearchArgs(a)),
        }, {
            name: 'evolver_agent_profile',
            description: '读取 Hub 授权返回的最小安全 agent profile；不返回凭证、node secret、workspace path 或设备指纹。',
            annotations: REMOTE_READ_ONLY,
            inputSchema: {
                type: 'object',
                required: ['agentId'],
                properties: {
                    agentId: { type: 'string', minLength: 1, maxLength: hub.AGENT_DIRECTORY_MAX_AGENT_ID_LENGTH },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: hub.AGENT_DIRECTORY_MAX_TIMEOUT_MS },
                },
            },
            handler: async (a) => deps.proxy.getAgentProfile(str(a['agentId']), typeof a['timeoutMs'] === 'number' ? a['timeoutMs'] : undefined),
        }, {
            name: 'evolver_agent_discover',
            description: '按任务标题、描述和 capability signals 发现候选 agent；分页和排序由 Hub 执行。',
            annotations: REMOTE_READ_ONLY,
            inputSchema: {
                ...agentDirectorySearchSchema(),
                required: ['title'],
                properties: {
                    ...agentDirectorySearchSchema()['properties'],
                    title: { type: 'string', minLength: 1, maxLength: hub.AGENT_DIRECTORY_MAX_QUERY_LENGTH },
                    description: { type: 'string', maxLength: hub.AGENT_DIRECTORY_MAX_QUERY_LENGTH },
                },
            },
            handler: async (a) => deps.proxy.discoverAgentsForTask({
                title: str(a['title']),
                ...(typeof a['description'] === 'string' ? { description: a['description'] } : {}),
                ...agentSearchArgs(a),
            }),
        }, {
            name: 'evolver_asset_validate',
            description: '通过本机 evolver-proxy 对 PHub 做发布前 dry-run 校验: 先执行与发布相同的本地脱敏/泄漏拦截, 再跑 hub 端质量门禁 + 内容安全扫描, 不落库、不计费. 返回 {valid, reason?}. 建议在 evolver_asset_publish 前调用. Capsule.gene 须非空或 ad-hoc.',
            annotations: REMOTE_READ_ONLY,
            inputSchema: {
                type: 'object',
                anyOf: [{ required: ['assets'] }, { required: ['asset'] }],
                properties: {
                    assets: { type: 'array', minItems: 1, items: { type: 'object' } },
                    asset: { type: 'object' },
                },
            },
            handler: async (a) => deps.proxy.validateAssetBundle({ assets: validateAssetBundleArgs(a) }),
        }, {
            name: 'evolver_mailbox_poll',
            description: '通过本机 evolver-proxy 轮询 PHub mailbox 的待处理消息.',
            inputSchema: { type: 'object', properties: { type: { type: 'string' }, direction: { type: 'string' }, limit: { type: 'number' } } },
            annotations: REMOTE_READ_ONLY,
            handler: async (a) => deps.proxy.call('POST', '/mailbox/poll', {
                ...(typeof a['type'] === 'string' ? { type: a['type'] } : {}),
                ...(typeof a['direction'] === 'string' ? { direction: a['direction'] } : {}),
                ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
            }),
        });
    }
    return tools;
}
function agentDirectorySearchSchema() {
    return {
        type: 'object',
        properties: {
            query: { type: 'string', minLength: 1, maxLength: hub.AGENT_DIRECTORY_MAX_QUERY_LENGTH },
            signals: { type: 'array', maxItems: hub.AGENT_DIRECTORY_MAX_SIGNAL_COUNT, items: { type: 'string', minLength: 1, maxLength: hub.AGENT_DIRECTORY_MAX_SIGNAL_LENGTH } },
            availability: { type: 'string', enum: ['online', 'busy', 'offline', 'unknown'] },
            sort: { type: 'string', enum: ['relevance', 'reputation', 'recent', 'availability'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            cursor: { type: 'string', maxLength: hub.AGENT_DIRECTORY_MAX_CURSOR_LENGTH },
            limit: { type: 'integer', minimum: 1, maximum: hub.AGENT_DIRECTORY_MAX_LIMIT },
            timeoutMs: { type: 'integer', minimum: 100, maximum: hub.AGENT_DIRECTORY_MAX_TIMEOUT_MS },
        },
    };
}
function agentSearchArgs(args) {
    return {
        ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
        ...(Array.isArray(args['signals']) ? { signals: strArray(args['signals']) ?? [] } : {}),
        ...(typeof args['availability'] === 'string' ? { availability: args['availability'] } : {}),
        ...(typeof args['sort'] === 'string' ? { sort: args['sort'] } : {}),
        ...(typeof args['order'] === 'string' ? { order: args['order'] } : {}),
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['timeoutMs'] === 'number' ? { timeoutMs: args['timeoutMs'] } : {}),
    };
}