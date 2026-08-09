/**
 * Operator maintenance CLI for local MemoryGraph (Refs #674).
 */
import { events } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { join } from 'node:path';
import { LocalMemoryGraph, formatMemoryGraphOperatorStatus, loadMemoryGraphOperatorStatus, resolveLocalMemoryUserIdentity, } from './localMemoryGraph.js';
const USAGE = [
    'Usage:',
    '  evolver memory-graph status [--json]',
    '  evolver memory-graph maintain [--json]   # recovery or threshold rotation + compaction',
    '  evolver memory-graph prune [--json]      # enforce rotated-archive retention',
    '  evolver memory-graph recover [--json]    # rebuild compact from retained current-epoch state',
    '  evolver memory-graph reset --yes [--json]  # copy a backup, then advance the local epoch',
    '',
    'Graph dir: $EVOLVER_HOME/evolution, then $EVOMAP_HOME/evolution, then ~/.evomap/evolution.',
    'Destructive reset requires --yes. Predictive cross-epoch weighting remains deferred (#670).',
    '',
].join('\n');
function writeJson(write, value) {
    write(`${JSON.stringify(value)}\n`);
}
function graphFor(env, deps) {
    const home = events.evomapHome(env);
    if (!home.trim())
        throw new Error('memory_graph_home_rejected');
    const dir = join(home, 'evolution');
    if (deps.createGraph)
        return deps.createGraph(dir);
    return new LocalMemoryGraph({ dir, ...resolveLocalMemoryUserIdentity(dir) });
}
function renderMaintain(report, stdout) {
    stdout([
        `rotated=${report.rotated ? 1 : 0}`,
        `compacted=${report.compactedRecords}`,
        `corrupt=${report.corruptLines}`,
        `oversized_lines=${report.oversizedLines}`,
        `archives=${report.archives}`,
        `recovery=${report.recovery}`,
    ].join(' ') + '\n');
}
function renderReset(report, stdout) {
    renderMaintain(report, stdout);
    stdout(`backup_id=${report.backupId ?? 'none'} backup_files=${report.backupFiles} epoch_id=${report.epochId ?? 'unchanged'}\n`);
}
function writeFailure(command, reason, json, stdout, stderr, usage = false) {
    if (json)
        writeJson(stdout, { ok: false, command, reason });
    else
        stderr(`[memory-graph] ${reason}\n${usage ? USAGE : ''}`);
    return reason === 'unknown_argument' || reason === 'confirmation_required' ? 2 : 1;
}
function writeMaintenance(command, report, json, stdout) {
    const ok = report.recovery !== 'degraded';
    if (json)
        writeJson(stdout, { ok, command, report });
    else
        renderMaintain(report, stdout);
    return ok ? 0 : 1;
}
function operationFailureReason(error) {
    const message = error instanceof Error ? error.message : '';
    return new Set([
        'memory_graph_busy',
        'memory_graph_dir_rejected',
        'memory_graph_epoch_rejected',
        'memory_graph_home_rejected',
        'memory_graph_append_rollback_failed',
        'memory_graph_path_rejected',
        'memory_graph_rotation_backup_failed',
        'memory_graph_rotation_journal_rejected',
        'memory_graph_rotation_recovery_failed',
        'memory_graph_reset_backup_failed',
        'memory_graph_reset_failed',
        'memory_graph_write_failed',
    ]).has(message) ? message : 'memory_graph_operation_failed';
}
export async function runMemoryGraphCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        stdout(USAGE);
        return argv.length === 0 ? 1 : 0;
    }
    const sub = argv[0] ?? '';
    const rest = argv.slice(1);
    const json = rest.includes('--json') || argv.includes('--json');
    const known = new Set(['status', 'maintain', 'prune', 'recover', 'reset']);
    if (!known.has(sub)) {
        if (json)
            writeJson(stdout, { ok: false, command: sub, reason: 'unknown_subcommand' });
        else
            stderr(`unknown memory-graph subcommand: ${sub}\n${USAGE}`);
        return 1;
    }
    const allowed = new Set(sub === 'reset' ? ['--json', '--yes'] : ['--json']);
    if (rest.some((arg) => !allowed.has(arg))) {
        return writeFailure(sub, 'unknown_argument', json, stdout, stderr, true);
    }
    if (sub === 'reset' && !rest.includes('--yes')) {
        return writeFailure(sub, 'confirmation_required', json, stdout, stderr, true);
    }
    const env = { ...(deps.env ?? process.env) };
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error)
        return writeFailure(sub, 'env_file_unavailable', json, stdout, stderr);
    if (!events.evomapHome(env).trim()) {
        return writeFailure(sub, 'memory_graph_home_rejected', json, stdout, stderr);
    }
    if (sub === 'status') {
        const status = loadMemoryGraphOperatorStatus(env);
        const ok = status.recovery !== 'degraded' && status.busy !== true;
        if (json)
            writeJson(stdout, { ok, command: 'status', status });
        else
            stdout(`${formatMemoryGraphOperatorStatus(status)}\n`);
        return ok ? 0 : 1;
    }
    try {
        const graph = graphFor(env, deps);
        if (sub === 'maintain')
            return writeMaintenance(sub, graph.maintain(), json, stdout);
        if (sub === 'prune')
            return writeMaintenance(sub, graph.prune(), json, stdout);
        if (sub === 'recover')
            return writeMaintenance(sub, graph.recoverFromArchives(), json, stdout);
        const report = graph.resetGraph();
        if (report.lockReleaseWarning) {
            stderr(`[memory-graph] reset completed; lock release incomplete: ${report.lockReleaseWarning}\n`);
        }
        if (json)
            writeJson(stdout, { ok: true, command: 'reset', report });
        else
            renderReset(report, stdout);
        return 0;
    }
    catch (error) {
        return writeFailure(sub, operationFailureReason(error), json, stdout, stderr);
    }
}