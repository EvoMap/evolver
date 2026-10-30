import { randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync, brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import * as assetstore from '@evomap/evolver-core/experience';
const LIMIT = 64 * 1024;
async function input() {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > LIMIT)
            throw new assetstore.ExperienceError('INPUT_TOO_LARGE', '内容太长，请缩短任务材料。');
        chunks.push(buffer);
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}');
    }
    catch {
        throw new assetstore.ExperienceError('INPUT_INVALID', '请求不是有效的 JSON。');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new assetstore.ExperienceError('INPUT_INVALID', '请求格式不正确。');
    return parsed;
}
const CONFIRMATION_PREFIX = 'evolver-experience-plan-v1.';
const BROTLI_CONFIRMATION_PREFIX = 'evolver-experience-plan-br-v1.';
function confirmationFor(plan) {
    const encoded = JSON.stringify({ plan });
    if (Buffer.byteLength(encoded) <= LIMIT)
        return undefined;
    const bytes = Buffer.from(JSON.stringify(plan));
    const deflated = `${CONFIRMATION_PREFIX}${deflateRawSync(bytes).toString('base64url')}`;
    if (Buffer.byteLength(JSON.stringify({ confirmation: deflated })) <= LIMIT)
        return deflated;
    // UTF-8 context coding also fits high-entropy multibyte material. Deflate's
    // byte histogram alone can expand a valid 64KiB request after base64 framing.
    const confirmation = `${BROTLI_CONFIRMATION_PREFIX}${brotliCompressSync(bytes, { params: {
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
        } }).toString('base64url')}`;
    if (Buffer.byteLength(JSON.stringify({ confirmation })) > LIMIT)
        throw new assetstore.ExperienceError('INPUT_TOO_LARGE', '完整确认内容仍超过输入预算，请缩短材料后重新查看。');
    return confirmation;
}
function confirmedPlan(request) {
    if (request.confirmation === undefined)
        return request.plan;
    if (request.plan !== undefined)
        throw new assetstore.ExperienceError('PLAN_INVALID', '请只传原确认计划或紧凑确认内容，不能同时指定。');
    try {
        if (typeof request.confirmation !== 'string')
            throw new Error();
        const brotli = request.confirmation.startsWith(BROTLI_CONFIRMATION_PREFIX);
        const prefix = brotli ? BROTLI_CONFIRMATION_PREFIX : CONFIRMATION_PREFIX;
        if (!request.confirmation.startsWith(prefix))
            throw new Error();
        const encoded = request.confirmation.slice(prefix.length);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded))
            throw new Error();
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded)
            throw new Error();
        // A transport envelope is not additional business capacity. Inflation is
        // bounded independently; the original plan/input limits still apply below.
        const decoded = (brotli ? brotliDecompressSync : inflateRawSync)(bytes, { maxOutputLength: 256 * 1024 });
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    }
    catch {
        throw new assetstore.ExperienceError('PLAN_INVALID', '紧凑确认内容不完整，请使用原样内容重新确认。');
    }
}
function flags(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json')
            continue;
        if (arg === '--no-stdin') {
            result['no-stdin'] = 'true';
            continue;
        }
        const match = /^--(action|query|limit|offset|id|code|runtime)(?:=(.*))?$/.exec(arg);
        if (!match)
            throw new assetstore.ExperienceError('INPUT_INVALID', '参数不正确。');
        const value = match[2] ?? argv[++i];
        if (value === undefined || match[2] === undefined && value.startsWith('--')) {
            throw new assetstore.ExperienceError('INPUT_INVALID', '参数没有填写；以 -- 开头的内容请使用 --参数=内容。');
        }
        result[match[1]] = value;
    }
    return result;
}
function diagnostic(error) {
    if (process.env['EVOLVER_EXPERIENCE_DIAGNOSTICS'] !== '1')
        return;
    try {
        const own = (name) => error && typeof error === 'object'
            ? Object.getOwnPropertyDescriptor(error, name)?.value : undefined;
        const code = own('code'), reason = own('reason');
        const codes = ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOENT', 'ENOTDIR', 'EEXIST', 'UNSAFE_ASSET_STORE_PATH'];
        const reasons = ['cancelled_or_expired', 'process_identity_unavailable', 'windows_path_blocked', 'windows_io_failed',
            'windows_io_incomplete', 'windows_io_invalid_count', 'path_changed', 'lock_changed', 'cleanup_capacity',
            'not_private_regular_file', 'not_regular_file', 'not_directory', 'symlink', 'safe_open_unavailable'];
        // Fixed categories only: never emit caller data, paths, messages or stacks.
        console.error(JSON.stringify({ diagnostic: 'experience-operation-failed',
            code: typeof code === 'string' && codes.includes(code) ? code : 'unclassified',
            reason: typeof reason === 'string' && reasons.includes(reason) ? reason : 'unclassified' }));
    }
    catch { /* Diagnostic failures must not replace the original response. */ }
}
/** Versioned local experience API for the desktop and remote operators. No shell, publication or model call. */
export async function runExperienceCommand(argv) {
    const operation = argv[0] ?? 'list';
    const emit = (payload) => { process.stdout.write(`${JSON.stringify({ schema: assetstore.EXPERIENCE_SCHEMA, operation, ...payload })}\n`); };
    try {
        const f = flags(argv.slice(1));
        if (f['no-stdin'] && !['check-start', 'search', 'check'].includes(operation)) {
            throw new assetstore.ExperienceError('INPUT_INVALID', '只用参数的模式只支持生成检查码、检查和查询。');
        }
        if (operation === 'capabilities') {
            emit({ ok: true, capabilities: { library: true, confirmedMutations: true, fullPlanBinding: true, durableRecovery: true, compactConfirmation: true, sourceRecovery: true, localOnly: true, originalMaterialsShared: false, activity: true, mcpStdio: true } });
            return 0;
        }
        const library = new assetstore.ExperienceLibrary(assetstore.assetsDir());
        const activity = new assetstore.ExperienceActivity(assetstore.assetsDir());
        if (operation === 'history') {
            emit({ ok: true, result: activity.history(Number(f['limit'] ?? 50)) });
            return 0;
        }
        if (operation === 'check-status') {
            emit({ ok: true, result: activity.checkStatus(f['id'] ?? '') });
            return 0;
        }
        if (['check-start', 'check', 'task-start', 'search', 'report'].includes(operation)) {
            const flagOnly = (process.stdin.isTTY || f['no-stdin'] === 'true') && (operation === 'check-start' && f['runtime'] !== undefined
                || operation === 'search' && f['query'] !== undefined);
            const codeOnly = operation === 'check' && f['code'] !== undefined && (process.stdin.isTTY || f['no-stdin'] === 'true');
            if (f['no-stdin'] && !flagOnly && !codeOnly) {
                throw new assetstore.ExperienceError('INPUT_INVALID', '只用参数时，请填写应用、查询关键词或检查码。');
            }
            const request = codeOnly ? { code: f['code'], runtime: f['runtime'] }
                : flagOnly ? {} : await input();
            if (f['runtime'] !== undefined && request.runtime !== undefined && f['runtime'] !== request.runtime) {
                throw new assetstore.ExperienceError('INPUT_INVALID', '命令行和请求中的应用不一致，请指定同一应用。');
            }
            if (operation === 'check' && f['code'] !== undefined) {
                if (request.code !== undefined && request.code !== f['code']) {
                    throw new assetstore.ExperienceError('INPUT_INVALID', '命令行和请求中的检查码不一致，请指定同一检查码。');
                }
                request.code = f['code'];
            }
            const runtime = f['runtime'] ?? request.runtime;
            if (operation === 'search' && f['query'] !== undefined) {
                if (request.query !== undefined && request.query !== f['query']) {
                    throw new assetstore.ExperienceError('INPUT_INVALID', '命令行和请求中的查询不一致，请指定同一查询。');
                }
                request.query = f['query'];
            }
            const source = { connectionId: request.taskId ? `cli-${request.taskId}` : `cli-${randomUUID()}`, transport: 'cli', clientName: 'evolver CLI', ...(runtime ? { runtime } : {}) };
            const result = operation === 'check-start' ? await activity.startCheck(runtime ?? '')
                : operation === 'check' ? await activity.check(request.code ?? '', source)
                    : operation === 'task-start' ? await activity.startTask(request.title ?? '', request.query ?? '', request.validationInput)
                        : operation === 'search' ? await activity.search(request.query ?? '', source, request.taskId)
                            : await activity.report(request.deliveryId ?? '', request.assetId ?? '', request.taskId ?? '', request.outcome ?? '', source, request.output);
            emit({ ok: true, result });
            return 0;
        }
        if (operation === 'list') {
            emit({ ok: true, result: await library.list(f['query'] ?? '', Number(f['limit'] ?? 50), Number(f['offset'] ?? 0)) });
            return 0;
        }
        if (operation === 'plan') {
            const request = await input();
            const plan = await library.plan(f['action'], request.assetId, request.input);
            const confirmation = confirmationFor(plan);
            emit({ ok: true, plan, ...(confirmation ? { confirmation } : {}) });
            return 0;
        }
        if (operation === 'legacy-audit-status') {
            emit({ ok: true, result: assetstore.Ingestor.experienceLegacyAuditStatus(assetstore.rootEventsPath(), Number(f['limit'] ?? 50)) });
            return 0;
        }
        if (operation === 'operation-status') {
            emit({ ok: true, result: library.operationStatus(Number(f['limit'] ?? 50), Number(f['offset'] ?? 0)) });
            return 0;
        }
        if (operation === 'recover') {
            const result = await library.recover(f['id'], Number(f['limit'] ?? 32));
            emit({ ok: result.remaining === 0, result, ...(result.remaining ? { code: 'AUDIT_COMPLETION_PENDING', error: '还有结果审计待恢复，请继续运行恢复；不要重新审批。' } : {}) });
            return result.remaining ? 1 : 0;
        }
        if (operation === 'source-recovery-plan') {
            const request = await input();
            emit({ ok: true, plan: await library.planSourceRecovery(request.assetId ?? '') });
            return 0;
        }
        if (operation === 'source-recovery-execute') {
            const request = await input();
            if (!request.sourceRecoveryPlan)
                throw new assetstore.ExperienceError('PLAN_INVALID', '请先查看并确认材料恢复。');
            emit({ ok: true, result: await library.executeSourceRecovery(request.sourceRecoveryPlan) });
            return 0;
        }
        if (operation === 'execute') {
            const request = await input(), plan = confirmedPlan(request);
            if (!plan)
                throw new assetstore.ExperienceError('PLAN_INVALID', '请先查看并确认要保存或修改的内容。');
            emit({ ok: true, result: await library.execute(plan) });
            return 0;
        }
        throw new assetstore.ExperienceError('INPUT_INVALID', '不支持这个经验库操作。');
    }
    catch (error) {
        if (error instanceof assetstore.ExperienceRecoveryRequiredError) {
            emit({ ok: false, code: error.code, error: '经验库的写入尚未结束；请先运行经验库恢复，再重新查看。' });
            return 1;
        }
        if (error instanceof assetstore.ExperienceJournalError) {
            emit({ ok: false, code: error.code, error: '经验操作的持久证据需要核对；请运行恢复状态检查，不要重复审批。' });
            return 1;
        }
        if (!(error instanceof assetstore.ExperienceError))
            diagnostic(error);
        emit({ ok: false, code: error instanceof assetstore.ExperienceError ? error.code : 'EXPERIENCE_FAILED',
            error: error instanceof assetstore.ExperienceError ? error.message : '未能确认经验库结果，请检查本地安装与目录权限；已有确认请先查看恢复状态。' });
        return 1;
    }
}