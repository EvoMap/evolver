import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { assetstore, benchmark, events, hub } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { referenceToolPairs } from '@evomap/evolver-runtime-adapters';
const HASH = /^sha256:[a-f0-9]{64}$/;
const RAW_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const replayCallId = (value) => `call:${benchmark.referenceDigest(value).slice(7)}`;
const INPUT_FAILURES = new Set([
    'env_file_unavailable',
    'invalid_arguments', 'invalid_reference_input', 'reference_input_changed', 'invalid_reference_manifest', 'reference_manifest_mismatch',
    'invalid_trajectory_digest', 'invalid_reference_bindings', 'invalid_reference_binding', 'reference_binding_mismatch',
    'duplicate_reference_binding', 'reference_asset_not_found', 'invalid_reference_pair', 'invalid_reference_events',
    'reference_call_collision', 'reference_tool_mismatch', 'reference_event_order', 'invalid_reference_line', 'reference_event_limit',
    'invalid_reference_call', 'invalid_reference_tool', 'reference_line_collision',
]);
const USAGE = [
    'evolver asset-trust access replay --case <file> --manifest <file> --bindings <trusted-file> --policy <file> --run <id> [--events <journal>] [--asset-id <id>] [--json]',
    'evolver asset-trust access get --url <url> --policy <file> --run <id> --call <id> --events <journal> [--include-data] [--json]',
    'evolver asset-trust access read --path <file> --policy <file> --run <id> --call <id> --events <journal> [--include-data] [--json]',
    'replay默认只读并只输出摘要。bindings必须由宿主或operator独立复核，不能使用模型自报分类。',
    'get/read只控制本次操作，不隔离任意shell；--include-data显式返回base64原文，journal从不保存正文。',
    '',
].join('\n');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
/** 单descriptor有界读取，禁止symlink、变化中的文件及宽松UTF-8解码。 */
function readJson(path, limit) {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
        throw new Error('invalid_reference_input');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
            throw new Error('reference_input_changed');
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count)
                throw new Error('reference_input_changed');
            offset += count;
        }
        const after = fstatSync(fd);
        const named = lstatSync(path);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
            || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino)
            throw new Error('reference_input_changed');
        return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes, digest: benchmark.referenceDigest(bytes) };
    }
    finally {
        closeSync(fd);
    }
}
function argumentsFor(argv) {
    const action = argv[0];
    if (action !== 'replay' && action !== 'get' && action !== 'read')
        throw new Error('invalid_arguments');
    const allowed = action === 'replay' ? ['--case', '--manifest', '--bindings', '--policy', '--run', '--events', '--asset-id']
        : ['--policy', '--run', '--call', '--events', action === 'get' ? '--url' : '--path'];
    const flags = new Map();
    const seen = new Set();
    let includeData = false;
    for (let i = 1; i < argv.length; i++) {
        const key = argv[i];
        if (seen.has(key))
            throw new Error('invalid_arguments');
        seen.add(key);
        if (key === '--json')
            continue;
        if (key === '--include-data' && action !== 'replay') {
            includeData = true;
            continue;
        }
        if (!allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--'))
            throw new Error('invalid_arguments');
        flags.set(key, argv[++i]);
    }
    const required = action === 'replay' ? ['--case', '--manifest', '--bindings', '--policy', '--run'] : allowed;
    if (required.some((key) => !flags.has(key)) || !benchmark.referenceId(flags.get('--run'))
        || (action !== 'replay' && !benchmark.referenceId(flags.get('--call')))
        || (flags.has('--asset-id') && (!flags.has('--events') || !HASH.test(flags.get('--asset-id')))))
        throw new Error('invalid_arguments');
    return { action, flags, includeData };
}
function replayInput(flags) {
    const source = readJson(flags.get('--case'), 4 * 1024 * 1024);
    const manifest = object(readJson(flags.get('--manifest'), 256 * 1024).value);
    const rows = manifest?.['files'];
    if (!Array.isArray(rows) || rows.length > 512)
        throw new Error('invalid_reference_manifest');
    const name = basename(flags.get('--case'));
    const matches = rows.map(object).filter((row) => row?.['name'] === name || row?.['path'] === name);
    if (matches.length !== 1 || matches[0]?.['bytes'] !== source.bytes.length
        || `sha256:${String(matches[0]?.['sha256'])}` !== source.digest)
        throw new Error('reference_manifest_mismatch');
    const input = object(source.value);
    const hashes = object(input?.['source_hashes']);
    const trajectoryDigest = `sha256:${String(hashes?.['pi_sha256'])}`;
    if (!HASH.test(trajectoryDigest))
        throw new Error('invalid_trajectory_digest');
    const trusted = object(readJson(flags.get('--bindings'), 512 * 1024).value);
    if (trusted?.['schema'] !== 'benchmark-reference-bindings.v1' || trusted['caseDigest'] !== source.digest
        || trusted['trajectoryDigest'] !== trajectoryDigest || !benchmark.referenceId(trusted['reviewer'])
        || hub.redactString(trusted['reviewer']) !== trusted['reviewer']
        || !Array.isArray(trusted['bindings']) || trusted['bindings'].length > 256)
        throw new Error('invalid_reference_bindings');
    const pairs = referenceToolPairs(source.value);
    const byCall = new Map(pairs.map((pair) => [pair.callId, pair]));
    const seen = new Set();
    const bindings = trusted['bindings'].map((value) => {
        const row = object(value);
        const resource = object(row?.['resource']);
        if (!row || typeof row['callId'] !== 'string' || !RAW_CALL_ID.test(row['callId']) || row['trajectoryDigest'] !== trajectoryDigest
            || typeof row['eventDigest'] !== 'string' || !HASH.test(row['eventDigest'])
            || typeof row['resultDigest'] !== 'string' || !HASH.test(row['resultDigest'])
            || (row['outcome'] !== 'read' && row['outcome'] !== 'failed')
            || (resource?.['type'] !== 'url' && resource?.['type'] !== 'file') || typeof resource['value'] !== 'string')
            throw new Error('invalid_reference_binding');
        const binding = { callId: row['callId'], trajectoryDigest, eventDigest: row['eventDigest'], resultDigest: row['resultDigest'],
            resource: { type: resource['type'], value: resource['value'] }, outcome: row['outcome'] };
        const pair = byCall.get(binding.callId);
        if (!pair?.complete || pair.eventDigest !== binding.eventDigest || pair.resultDigest !== binding.resultDigest)
            throw new Error('reference_binding_mismatch');
        const key = `${binding.callId}:${benchmark.referenceResourceDigest(binding.resource)}`;
        if (seen.has(key))
            throw new Error('duplicate_reference_binding');
        seen.add(key);
        return binding;
    });
    // 原始toolCallId可能是高熵opaque标识。先在私有输入内精确配对，再散列公开身份；不放宽core的脱敏门禁。
    return { caseDigest: source.digest, trajectoryDigest,
        pairs: pairs.map((pair) => ({ ...pair, callId: replayCallId(pair.callId) })),
        bindings: bindings.map((binding) => ({ ...binding, callId: replayCallId(binding.callId) })) };
}
/** CLI composition只拼接runtime证据与core策略；不执行冻结轨迹中的命令。 */
export async function runReferenceAccessCommand(argv, deps) {
    const output = deps.stdout ?? ((text) => { process.stdout.write(text); });
    if (argv.includes('--help') || argv.includes('-h')) {
        output(USAGE);
        return 0;
    }
    let controller;
    let retryInitializationCleanup;
    let journalRequested = false;
    let journalMayContainEvents = false;
    let result;
    let code = 0;
    try {
        const { action, flags, includeData } = argumentsFor(argv);
        journalRequested = flags.has('--events');
        const env = deps.env ?? process.env;
        if (loadEnvFileFromEnv(env).error)
            throw new Error('env_file_unavailable');
        const policy = benchmark.parseReferencePolicy(readJson(flags.get('--policy'), 128 * 1024).value);
        const runId = flags.get('--run');
        if (action === 'replay') {
            const input = replayInput(flags);
            const observations = [];
            for (const pair of input.pairs) {
                const bindings = input.bindings.filter((binding) => binding.callId === pair.callId);
                if (!bindings.length)
                    observations.push(benchmark.observeReferencePair(policy, input.trajectoryDigest, pair));
                for (const binding of bindings)
                    observations.push(benchmark.observeReferencePair(policy, input.trajectoryDigest, pair, binding));
            }
            let qualification;
            if (journalRequested) {
                journalMayContainEvents = true;
                controller = new benchmark.ReferenceAccessController({ policy, runId, eventsPath: resolve(flags.get('--events')), mode: 'observe' });
                for (const binding of input.bindings) {
                    const pair = input.pairs.find((item) => item.callId === binding.callId);
                    await controller.observe(input.trajectoryDigest, pair, binding);
                }
                if (flags.has('--asset-id')) {
                    const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir(env));
                    const asset = await store.get(flags.get('--asset-id'));
                    if (!asset || asset.asset_id !== flags.get('--asset-id'))
                        throw new Error('reference_asset_not_found');
                    qualification = controller.qualification(asset, input.trajectoryDigest);
                }
            }
            result = { ok: true, schema: 'benchmark-reference-replay.v1', benchmarkId: policy.benchmarkId, runId,
                policyDigest: benchmark.referenceDigest(JSON.stringify(policy)), caseDigest: input.caseDigest, trajectoryDigest: input.trajectoryDigest,
                sourceArchiveVerified: false, originalReward: 'unchanged', bindingsTrust: 'operator-reviewed',
                callIdentitySchema: 'benchmark-reference-call-id.v1',
                capabilities: { mode: 'observe', httpGet: false, fileRead: false, arbitraryProcessContainment: false, observationCoverage: 'partial' },
                sourceStatus: observations.some((item) => item.outcome === 'read' && benchmark.forbiddenReference(item.kind)) ? 'ineligible' : 'unknown',
                pairedCalls: input.pairs.length, boundResources: input.bindings.length, pairs: input.pairs, observations,
                journalRequested, journaledResources: journalRequested ? input.bindings.length : 0,
                ...(qualification ? { qualification } : {}) };
        }
        else {
            journalMayContainEvents = true;
            controller = new benchmark.ReferenceAccessController({ policy, runId, eventsPath: resolve(flags.get('--events')), mode: 'enforce' });
            const accessed = action === 'get' ? await controller.get(flags.get('--call'), flags.get('--url'))
                : await controller.readFile(flags.get('--call'), resolve(flags.get('--path')));
            result = { ok: true, schema: 'benchmark-reference-read.v1', capabilities: controller.capabilities(),
                receipt: accessed.receipt, bytes: accessed.data.length, journalRequested,
                ...(includeData ? { encoding: 'base64', data: Buffer.from(accessed.data).toString('base64') } : {}) };
        }
    }
    catch (error) {
        code = 1;
        if (error instanceof benchmark.ReferenceAccessError)
            retryInitializationCleanup = error.retryCleanup;
        const reason = error instanceof benchmark.ReferenceAccessError ? error.code
            : error instanceof Error && INPUT_FAILURES.has(error.message) ? error.message : 'reference_access_failed';
        result = { ok: false, group: 'asset-trust', reason,
            journalRequested, journalMayContainEvents,
            ...(error instanceof benchmark.ReferenceAccessError && error.operationCode ? { operationReason: error.operationCode } : {}),
            ...(error instanceof benchmark.ReferenceAccessError && error.receipt ? { receipt: error.receipt } : {}) };
    }
    if (controller || retryInitializationCleanup) {
        try {
            if (controller)
                await controller.close();
            else
                await retryInitializationCleanup();
        }
        catch {
            code = 1;
            const { data: _data, encoding: _encoding, ...metadata } = result;
            result = { ...metadata, ok: false, group: 'asset-trust', journalMayContainEvents: true,
                reason: typeof metadata['reason'] === 'string' ? metadata['reason'] : 'reference_release_failed',
                cleanupReason: 'reference_release_failed', cleanupPending: true, operationOk: metadata['ok'] };
        }
    }
    output(`${JSON.stringify(result)}\n`);
    return code;
}