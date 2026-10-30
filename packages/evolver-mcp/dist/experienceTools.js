import { assetstore } from '@evomap/evolver-core';
/** Explicit onboarding tools. Their receipts never impersonate an authenticated vendor or causal savings proof. */
export function buildExperienceTools(baseDir, getClient) {
    const activity = new assetstore.ExperienceActivity(baseDir);
    const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    return [
        {
            name: 'evolver_experience_check',
            description: '用户要求检查 Evolver 接入并提供检查码时调用。将 code 原样传入，写入本地真实工具调用记录；不要只回复确认。返回不代表应用身份已认证。',
            inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 100 }, runtime: { type: 'string', description: '检查码指定的应用；宿主没有绑定 runtime 时必须填写。', enum: ['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'kiro', 'workbuddy', 'deepseek-harness', 'openclaw', 'gemini-cli'] } } }, annotations,
            handler: async (args) => {
                const source = getClient();
                const runtime = typeof args['runtime'] === 'string' ? args['runtime'] : source.runtime;
                if (source.runtime && runtime !== source.runtime)
                    throw new assetstore.ExperienceError('RUNTIME_MISMATCH', '检查应用与宿主配置不一致。');
                return activity.check(String(args['code'] ?? ''), { ...source, ...(runtime ? { runtime } : {}) });
            },
        },
        {
            name: 'evolver_experience_search',
            description: '查询本地已审核、已启用的经验。query 用 1–3 个关键词；taskId 使用用户提供的本次任务编号。不填 taskId 仅用于浏览，不能回报任务结果；需要回报时，先创建任务，再带该 taskId 重新查询。返回方法、条件及 deliveryId，不读取或上传原始任务材料。保存、查询和实际使用是不同状态。',
            inputSchema: { type: 'object', required: ['query'], properties: {
                    query: { type: 'string', minLength: 1, maxLength: 300 }, taskId: { type: 'string', minLength: 1, maxLength: 100, description: '本次任务编号；省略时仅浏览，返回的 deliveryId 不能用于任务结果回报。' },
                } }, annotations,
            handler: async (args) => activity.search(String(args['query'] ?? ''), getClient(), typeof args['taskId'] === 'string' ? args['taskId'] : undefined),
        },
        {
            name: 'evolver_experience_result',
            description: '完成任务后，回报本会话实际使用的经验与结果。只能引用带本次 taskId 查询返回的 deliveryId 和 assetId，以及用户给出的同一 taskId。不带 taskId 的浏览查询不能回报；请先创建任务并带任务编号重新查询。没有采用时回报 unused；查询没有结果时省略 assetId，不编造编号。日期示例按用户要求返回 output 日期数组；检查仅验证结果，不证明因果收益。',
            inputSchema: { type: 'object', required: ['deliveryId', 'taskId', 'outcome'], properties: {
                    deliveryId: { type: 'string', maxLength: 100 }, assetId: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, taskId: { type: 'string', maxLength: 100 },
                    outcome: { type: 'string', enum: ['success', 'failed', 'unused'] }, output: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 32 } },
                } }, annotations,
            handler: async (args) => activity.report(String(args['deliveryId'] ?? ''), String(args['assetId'] ?? ''), String(args['taskId'] ?? ''), String(args['outcome'] ?? ''), getClient(), Array.isArray(args['output']) ? args['output'].map(String) : undefined),
        },
    ];
}