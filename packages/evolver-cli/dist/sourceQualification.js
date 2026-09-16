import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { assetstore, events, hub, wire } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const USAGE = 'evolver asset-trust qualify <asset_id> --evidence <file> --reason <text> [--exception <reason>] [--json]\n'
    + 'evolver asset-trust qualification <asset_id> --benchmark <id> [--evidence-digest <sha256>] [--json]\n';
/** 有界、单descriptor读取；不执行证据中的命令，不跟随symlink或读取增长中的文件。 */
function readEvidence(path) {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 128 * 1024)
        throw new Error('invalid_evidence_file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size)
            throw new Error('evidence_changed');
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
                throw new Error('evidence_changed');
            offset += count;
        }
        const after = fstatSync(fd);
        const named = lstatSync(path);
        if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
            || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino)
            throw new Error('evidence_changed');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    finally {
        closeSync(fd);
    }
}
export async function runSourceQualificationCommand(argv, deps, actorId) {
    const output = deps.stdout ?? ((text) => { process.stdout.write(text); });
    if (argv.includes('--help') || argv.includes('-h')) {
        output(USAGE);
        return 0;
    }
    const fail = (reason, persisted = false) => {
        output(`${JSON.stringify({ ok: false, group: 'asset-trust', reason, persisted })}\n`);
        return 1;
    };
    const action = argv[0];
    const assetId = argv[1];
    if ((action !== 'qualify' && action !== 'qualification') || !assetId || !/^sha256:[a-f0-9]{64}$/.test(assetId))
        return fail('invalid_arguments');
    const flags = new Map();
    for (let index = 2; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--json')
            continue;
        if (!['--evidence', '--reason', '--exception', '--benchmark', '--evidence-digest'].includes(flag) || flags.has(flag)
            || !argv[index + 1] || argv[index + 1].startsWith('--'))
            return fail('invalid_arguments');
        flags.set(flag, argv[++index]);
    }
    if (action === 'qualify' && (!flags.has('--evidence') || !flags.has('--reason') || flags.has('--benchmark') || flags.has('--evidence-digest')))
        return fail('invalid_arguments');
    if (action === 'qualification' && (!flags.has('--benchmark') || [...flags.keys()].some((key) => key !== '--benchmark' && key !== '--evidence-digest')))
        return fail('invalid_arguments');
    if (flags.has('--evidence-digest') && !/^sha256:[a-f0-9]{64}$/.test(flags.get('--evidence-digest')))
        return fail('invalid_arguments');
    let persisted = false;
    try {
        const env = deps.env ?? process.env;
        if (loadEnvFileFromEnv(env).error)
            return fail('env_file_unavailable');
        const store = deps.store ?? new assetstore.LocalJsonlProvider(deps.assetsDir ?? events.assetsDir());
        if (!(store instanceof assetstore.LocalJsonlProvider) && !deps.provenance)
            return fail('provenance_required');
        const provenance = deps.provenance ?? assetstore.provenanceStoreForStore(store);
        const asset = await store.get(assetId);
        if (!asset || asset.asset_id !== assetId)
            return fail('asset_not_found');
        if (action === 'qualification') {
            const context = assetstore.benchmarkContext(flags.get('--benchmark'));
            const record = provenance.get(assetId);
            output(`${JSON.stringify({ ok: true, assetId, benchmarkId: context.benchmarkId,
                decision: assetstore.assessSourceEligibility(asset, record, context),
                qualification: record?.sourceQualifications?.find((item) => item.benchmarkId === context.benchmarkId) ?? null,
                ...(flags.has('--evidence-digest') ? { historicalQualifications: provenance.qualificationHistory(assetId, context.benchmarkId, flags.get('--evidence-digest')) } : {}) })}\n`);
            return 0;
        }
        const request = assetstore.parseSourceQualificationRequest(readEvidence(flags.get('--evidence')));
        if (!request || request.assetId !== assetId || request.assetContentId !== wire.computeAssetId(asset))
            return fail('evidence_asset_mismatch');
        // The validated benchmark ID is public policy metadata, not a credential. Keep every other env check.
        const leakCheckEnv = { ...env, EVOLVER_BENCHMARK_ID: undefined };
        const reason = flags.get('--reason');
        const exceptionReason = flags.get('--exception');
        // 决策理由会进入sidecar、审计或输出；直接检查原字符串，避免JSON转义遮住环境秘密。
        // core仍负责metadata校验和资格判定，这里不改写理由，也不豁免其他环境键的同值。
        if (hub.fullLeakCheck(JSON.stringify(request), leakCheckEnv).found
            || [reason, exceptionReason].some((value) => value !== undefined && hub.fullLeakCheck(value, leakCheckEnv).found)) {
            return fail('unsafe_source_evidence');
        }
        const qualification = provenance.qualify(request, actorId(env), reason, exceptionReason);
        persisted = true;
        const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
        await ingestor.ingest({
            type: 'actor.human.source.qualify',
            actor: { kind: 'human', id: qualification.by },
            human: { title: '记录benchmark来源资格', why: qualification.reason },
            payload: { assetId, benchmarkId: qualification.benchmarkId, state: qualification.state,
                evidenceDigest: qualification.evidenceDigest, trajectoryDigest: qualification.trajectoryDigest,
                runId: qualification.runId, exception: qualification.exception !== undefined },
        });
        output(`${JSON.stringify({ ok: true, persisted, qualification })}\n`);
        return 0;
    }
    catch (error) {
        if (!persisted && error instanceof assetstore.SourceQualificationProvenanceRequiredError) {
            return fail('source_qualification_provenance_required');
        }
        // sidecar已经落盘而audit失败时不得谎称回滚；operator可用qualification命令读取权威结果。
        return fail(persisted ? 'qualification_saved_audit_failed' : 'source_qualification_failed', persisted);
    }
}