import { assetstore, events } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { ASSET_SIDECAR_RECOVERY_USAGE, runAssetSidecarRecoveryCommand, } from './assetSidecarRecovery.js';
const GROUP = 'asset-health';
const USAGE = [
    'Usage:',
    '  evolver asset-health [--json]',
    ASSET_SIDECAR_RECOVERY_USAGE,
    '',
].join('\n');
function writeJson(write, value) {
    write(`${JSON.stringify(value)}\n`);
}
function renderText(report, stdout) {
    stdout([
        `asset health: status=${report.status}`,
        `unique=${report.totals.uniqueAssets}`,
        `corrupt=${report.totals.corruptRows}`,
        `duplicate=${report.totals.duplicateRows}`,
        `hash_mismatch=${report.totals.hashMismatchRows}`,
        `schema_invalid=${report.totals.schemaInvalidRows}`,
        `unsafe=${report.totals.unsafeFiles}`,
        `unavailable=${report.totals.unavailableFiles}`,
    ].join(' ') + '\n');
    for (const file of report.files) {
        stdout([
            file.kind,
            file.file,
            `status=${file.status}`,
            `rows=${file.rows}`,
            `unique=${file.uniqueAssets}`,
            `corrupt=${file.corruptRows}`,
            `duplicate=${file.duplicateRows}`,
            `hash_mismatch=${file.hashMismatchRows}`,
            `schema_invalid=${file.schemaInvalidRows}`,
            ...(file.unterminated ? ['unterminated=true'] : []),
            ...(file.reason ? [`reason=${file.reason}`] : []),
        ].join(' ') + '\n');
    }
    stdout([
        'sidecar health:',
        `corrupt=${report.sidecarTotals.corruptRows}`,
        `unterminated=${report.sidecarTotals.unterminatedFiles}`,
        `unsafe=${report.sidecarTotals.unsafeFiles}`,
        `unavailable=${report.sidecarTotals.unavailableFiles}`,
    ].join(' ') + '\n');
    for (const sidecar of report.sidecars) {
        stdout([
            sidecar.kind,
            sidecar.file,
            `status=${sidecar.status}`,
            `rows=${sidecar.rows}`,
            `valid=${sidecar.validRows}`,
            `corrupt=${sidecar.corruptRows}`,
            ...(sidecar.unterminated ? ['unterminated=true'] : []),
            ...(sidecar.reason ? [`reason=${sidecar.reason}`] : []),
        ].join(' ') + '\n');
    }
}
export async function runAssetHealthCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    const json = argv.includes('--json');
    if (argv.includes('--help') || argv.includes('-h')) {
        stdout(USAGE);
        return 0;
    }
    const repairIndex = argv.indexOf('repair-sidecar');
    if (repairIndex >= 0) {
        const repairArgs = ['repair-sidecar', ...argv.slice(0, repairIndex), ...argv.slice(repairIndex + 1)];
        return runAssetSidecarRecoveryCommand(repairArgs, deps);
    }
    if (argv.some((arg) => arg !== '--json')) {
        if (json)
            writeJson(stdout, { ok: false, group: GROUP, reason: 'unknown_argument' });
        else
            stderr(`[asset-health] unknown_argument\n${USAGE}`);
        return 2;
    }
    const env = deps.env ?? process.env;
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error) {
        if (json)
            writeJson(stdout, { ok: false, group: GROUP, reason: 'env_file_unavailable' });
        else
            stderr('[asset-health] env_file_unavailable\n');
        return 1;
    }
    const inspect = deps.inspect ?? assetstore.inspectLocalAssetStore;
    const report = inspect(deps.assetsDir ?? (deps.resolveAssetsDir ?? events.assetsDir)());
    const result = {
        ok: report.ok,
        group: GROUP,
        status: report.status,
        totals: report.totals,
        files: report.files,
        sidecarTotals: report.sidecarTotals,
        sidecars: report.sidecars,
    };
    if (json)
        writeJson(stdout, result);
    else
        renderText(report, stdout);
    return report.ok ? 0 : 1;
}