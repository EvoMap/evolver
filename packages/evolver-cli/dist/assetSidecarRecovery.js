import { assetstore, events, hub } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const GROUP = 'asset-health.repair';
const ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,79}$/;
export const ASSET_SIDECAR_RECOVERY_USAGE = [
    '  evolver asset-health repair-sidecar --sidecar <provenance|review|asset-sync> --replacement <file>',
    '    [--write --acknowledge-corrupt-history] [--json]',
].join('\n');
function writeJson(write, value) {
    write(`${JSON.stringify(value)}\n`);
}
function parseRepairArgs(argv) {
    let sidecar;
    let replacementPath;
    let write = false;
    let acknowledgeCorruptHistory = false;
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') {
            if (json)
                return 'duplicate_argument';
            json = true;
            continue;
        }
        if (arg === '--write') {
            if (write)
                return 'duplicate_argument';
            write = true;
            continue;
        }
        if (arg === '--acknowledge-corrupt-history') {
            if (acknowledgeCorruptHistory)
                return 'duplicate_argument';
            acknowledgeCorruptHistory = true;
            continue;
        }
        if (arg === '--sidecar') {
            if (sidecar !== undefined)
                return 'duplicate_argument';
            const value = argv[index + 1];
            if (value !== 'provenance' && value !== 'review' && value !== 'asset-sync')
                return 'invalid_sidecar';
            sidecar = value;
            index += 1;
            continue;
        }
        if (arg === '--replacement') {
            if (replacementPath !== undefined)
                return 'duplicate_argument';
            const value = argv[index + 1];
            if (!value || value.startsWith('--'))
                return 'replacement_required';
            replacementPath = value;
            index += 1;
            continue;
        }
        return 'unknown_argument';
    }
    if (!sidecar)
        return 'sidecar_required';
    if (!replacementPath)
        return 'replacement_required';
    if (acknowledgeCorruptHistory && !write)
        return 'acknowledgement_requires_write';
    if (write && !acknowledgeCorruptHistory)
        return 'acknowledgement_required';
    return { sidecar, replacementPath, write, acknowledgeCorruptHistory, json };
}
function safeActorId(env) {
    const raw = env['EVOLVER_ACTOR_ID'] ?? env['USER'] ?? env['LOGNAME'] ?? env['USERNAME'] ?? 'cli';
    const trimmed = raw.trim();
    return ACTOR_ID_RE.test(trimmed) && hub.redactString(trimmed) === trimmed ? trimmed : 'cli';
}
function failure(reason, json, stdout, stderr, exitCode) {
    if (json)
        writeJson(stdout, { ok: false, group: GROUP, reason });
    else
        stderr(`[asset-health] repair-sidecar ${reason}\n${exitCode === 2 ? ASSET_SIDECAR_RECOVERY_USAGE + '\n' : ''}`);
    return exitCode;
}
function recoveryReason(error) {
    if (error instanceof assetstore.AssetSidecarRecoveryError)
        return error.reason;
    if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'UNSAFE_ASSET_STORE_PATH')
            return 'unsafe_path';
        if (error.code === 'LOCK_RELEASE_FAILED')
            return 'lock_unavailable';
    }
    return 'recovery_failed';
}
async function recordRecoveryEvent(ingestor, result, actorId) {
    if (!result.changed || !result.backupId)
        return false;
    try {
        await ingestor.ingest({
            type: 'actor.human.sidecar.recover',
            payload: {
                sidecar: result.sidecar,
                backupId: result.backupId,
                currentDigest: result.current.digest,
                replacementDigest: result.replacement.digest,
                corruptRows: result.current.corruptRows,
                unterminated: result.current.unterminated,
            },
            human: { title: `recover ${result.sidecar} sidecar`, severity: 'warn' },
            actor: { kind: 'human', id: actorId },
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function runAssetSidecarRecoveryCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    const parsed = parseRepairArgs(argv);
    const json = argv.includes('--json');
    if (typeof parsed === 'string')
        return failure(parsed, json, stdout, stderr, 2);
    const env = deps.env ?? process.env;
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error)
        return failure('env_file_unavailable', parsed.json, stdout, stderr, 1);
    let result;
    try {
        result = (deps.recover ?? assetstore.recoverAssetSidecar)({
            baseDir: deps.assetsDir ?? (deps.resolveAssetsDir ?? events.assetsDir)(),
            sidecar: parsed.sidecar,
            replacementPath: parsed.replacementPath,
            write: parsed.write,
            acknowledgeCorruptHistory: parsed.acknowledgeCorruptHistory,
        });
    }
    catch (error) {
        return failure(recoveryReason(error), parsed.json, stdout, stderr, 1);
    }
    let auditEventRecorded = false;
    if (result.mode === 'write' && result.changed) {
        try {
            const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
            auditEventRecorded = await recordRecoveryEvent(ingestor, result, safeActorId(env));
        }
        catch {
            auditEventRecorded = false;
        }
    }
    if (result.mode === 'write' && result.changed && !auditEventRecorded) {
        stderr('[asset-health] sidecar recovered; root event unavailable\n');
    }
    if (result.lockReleaseWarning) {
        stderr(`[asset-health] sidecar recovered; lock release incomplete: ${result.lockReleaseWarning}\n`);
    }
    const output = { ok: true, group: GROUP, ...result, auditEventRecorded };
    if (parsed.json)
        writeJson(stdout, output);
    else {
        stdout([
            `sidecar recovery: mode=${result.mode}`,
            `sidecar=${result.sidecar}`,
            `changed=${result.changed}`,
            `would_write=${result.wouldWrite}`,
            `corrupt=${result.current.corruptRows}`,
            `unterminated=${result.current.unterminated}`,
            ...(result.backupId ? [`backup=${result.backupId}`] : []),
        ].join(' ') + '\n');
    }
    return 0;
}