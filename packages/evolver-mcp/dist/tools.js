import { assetstore, wire, mailbox as mb, hub, bootstrap, ops } from '@evomap/evolver-core';
import { buildEvolverPrimer } from './primer.js';
const str = (v) => (typeof v === 'string' ? v : String(v ?? ''));
const strArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
const REUSE_OUTCOMES = new Set(['success', 'failed', 'mismatched', 'stale', 'unsafe']);
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
            description: '按需说明 evolver 的静默复用机制(search→reuse→capture 循环)与各工具何时调用；不要向用户叙述例行预检、状态或空搜索。',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => ({ guide: buildEvolverPrimer({ proxy: !!deps.proxy }) }),
        },
        {
            // Priming for ANY MCP agent (#mcp-recall): when prior local memory is likely to help, return trusted +
            // review-approved genes (the same gate the SessionStart hook uses) AND record a value.inject so auto-recall can
            // later observe, from this agent's transcript, which primed genes were used. NOT a hub search (that is
            // evolver_asset_search): this is the curated, already-approved local memory, ready to reuse quietly.
            name: 'evolver_recall',
            description: '当本机已审核通过的可复用经验 gene 可能有帮助时调用；返回信任+审核双闸后的本地 gene，并记录一条 value.inject。若传入 sessionId(= 本会话 transcript 文件名去掉 .jsonl 后缀),后续 auto-recall 能从该 transcript 观测哪些注入 gene 真正被用,为经 MCP 接入的 AI 闭合自学习环;不传则仅记录归因、无法关联到会话。命中后静默复用，并在结果明确后用 evolver_asset_reuse_result 回报。',
            inputSchema: { type: 'object', properties: { limit: { type: 'number' }, sessionId: { type: 'string' } } },
            handler: async (a) => {
                const limit = optionalNonNegativeNumberArg(a, 'limit', 'evolver_recall limit must be a non-negative number') ?? 5;
                const sessionId = typeof a['sessionId'] === 'string' && a['sessionId'].trim() ? a['sessionId'].trim() : undefined;
                const review = assetstore.reviewLedgerForStore(deps.store);
                const genes = await assetstore.listApprovedGenes(deps.store, review, limit);
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
                name: 'evolver_proxy_status',
                description: '检查本机 evolver-proxy 与 PHub 的连接状态. 需要 EVOLVER_PROXY_URL/EVOLVER_IPC_TOKEN.',
                inputSchema: { type: 'object', properties: {} },
                handler: async () => deps.proxy.status(),
            }] : []),
        {
            name: 'evolver_asset_search',
            description: deps.proxy
                ? '通过本机 evolver-proxy 搜索 PHub 经验资产(Gene/Capsule/EvolutionEvent); AntiGene 是本地负经验资产, 会直接查本地库供人工 review.'
                : '搜索本地经验资产库(Gene/Capsule/EvolutionEvent/AntiGene). 支持 kind/信号/类目/gene 反查/文本.',
            inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: searchableKinds }, signalsAny: { type: 'array', items: { type: 'string' } }, category: { type: 'string' }, gene: { type: 'string' }, text: { type: 'string' }, limit: { type: 'number' } } },
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
                    return resultArray(await deps.proxy.search({
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
            handler: async (a) => {
                const assetId = str(a['assetId']);
                if (deps.proxy) {
                    const local = await deps.store.get(assetId);
                    if (local?.type === 'AntiGene')
                        return local;
                    return requestedAsset(await deps.proxy.fetchAsset({ assetId }), assetId);
                }
                return deps.store.get(assetId);
            },
        },
        {
            name: 'evolver_gep_build',
            description: '由字段构造资产并计算 asset_id(content-addressed). 不落库; 返回带 asset_id 的资产 + 校验结果. 用于发布前确认.',
            inputSchema: { type: 'object', required: ['asset'], properties: { asset: { type: 'object' } } },
            handler: async (a) => {
                const asset = a['asset'];
                const assetId = wire.computeAssetId(asset);
                const validation = wire.validateWire(asset);
                return { asset: { ...asset, asset_id: assetId }, asset_id: assetId, wire_valid: validation.ok, wire_errors: validation.errors };
            },
        },
        {
            name: 'evolver_asset_publish',
            description: deps.proxy ? '把资产提交给本机 evolver-proxy, 由 proxy 异步发布到 PHub. Capsule.gene 须非空或 ad-hoc.' : '把资产发布到本地库(content-addressed 去重 + 强绑定校验). Capsule.gene 须非空或 ad-hoc.',
            inputSchema: { type: 'object', required: ['asset'], properties: { asset: { type: 'object' } } },
            handler: async (a) => deps.proxy ? deps.proxy.submitAsset(a['asset']) : deps.store.put(a['asset']),
        },
        {
            name: 'evolver_distill_conversation',
            description: '从当前 agent 对话中蒸馏可复用 Gene/Capsule. 需要具体 summary、strategy/evidence、artifacts、validation; core quality gate 会拒绝弱信号.',
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
                    min_score: { type: 'integer', minimum: 1, maximum: 10 },
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
            handler: async (a) => box.getStatus(str(a['id'])) ?? { error: 'not found' },
        });
    }
    if (deps.proxy) {
        tools.push({
            name: 'evolver_asset_validate',
            description: '通过本机 evolver-proxy 对 PHub 做发布前 dry-run 校验: 先执行与发布相同的本地脱敏/泄漏拦截, 再跑 hub 端质量门禁 + 内容安全扫描, 不落库、不计费. 返回 {valid, reason?}. 建议在 evolver_asset_publish 前调用. Capsule.gene 须非空或 ad-hoc.',
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
            handler: async (a) => deps.proxy.call('POST', '/mailbox/poll', {
                ...(typeof a['type'] === 'string' ? { type: a['type'] } : {}),
                ...(typeof a['direction'] === 'string' ? { direction: a['direction'] } : {}),
                ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
            }),
        });
    }
    return tools;
}