const AUTOEXEC_TASK = 'EvoMapEvolverAutoexecDaemon';
const AUTOEXEC_SYSTEMD_UNIT = 'evolver-autoexec.service';
const WINDOWS_TASK_PROBE = `try { $tasks = @(Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq '${AUTOEXEC_TASK}' }) } catch { exit 9 }; if ($tasks.Count -eq 0) { exit 3 } else { exit 0 }`;
const WINDOWS_TASK_START = `Start-ScheduledTask -TaskPath '\\' -TaskName '${AUTOEXEC_TASK}' -ErrorAction Stop`;
export function autoexecCompanionActions(target, path, uid) {
    if (target === 'systemd')
        return ['systemctl --user daemon-reload', `systemctl --user enable --now ${AUTOEXEC_SYSTEMD_UNIT}`];
    if (target === 'launchd')
        return [`launchctl bootstrap gui/${uid ?? '<uid>'} ${path}`];
    return [
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${path} -Install`,
        `powershell.exe -NoProfile -NonInteractive -Command "${WINDOWS_TASK_START}"`,
    ];
}
class CompanionStepError extends Error {
}
function require0(result, operation) {
    if (result.error || result.status !== 0)
        throw new CompanionStepError(`${operation} failed`);
}
function windowsTaskRegistered(input) {
    const probe = input.run(input.powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TASK_PROBE]);
    if (!probe.error && probe.status === 0)
        return true;
    if (!probe.error && probe.status === 3)
        return false;
    throw new CompanionStepError('inspect Windows autoexec scheduled task failed');
}
function publishUnit(input) {
    try {
        input.writeUnit(input.plan.path, input.plan.content);
        return true;
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return false;
        throw error;
    }
}
function withdrawUnit(input, path) {
    if (!input.removeUnit(path, input.plan.content))
        return false;
    // systemd already loaded the unit; reloading drops it so the manager matches the disk until the next bootstrap.
    if (input.target === 'systemd')
        input.run(input.systemctl, ['--user', 'daemon-reload']);
    return true;
}
function failedOutcome(input, path, published, error) {
    const reason = error instanceof CompanionStepError ? error.message : 'write autoexec companion failed';
    if (published && withdrawUnit(input, path)) {
        return {
            status: 'failed',
            files: [],
            actions: [],
            detail: `${reason}; the proxy bootstrap is unaffected and the unactivated companion was removed, so rerunning evolver lifecycle bootstrap retries it`,
        };
    }
    return {
        status: 'failed',
        files: [path],
        actions: [],
        detail: `${reason}; the proxy bootstrap is unaffected. Run evolver lifecycle remove-autoexec-service --target=${input.target}, then rerun evolver lifecycle bootstrap`,
    };
}
/**
 * Bootstrap's proxy transaction owns only the proxy manager, so the companion is installed afterwards and
 * never rolled back with it. An existing companion is left exactly as the operator configured it; one this call
 * wrote but could not activate is removed again, since a later bootstrap would otherwise take it for configured.
 */
export function activateAutoexecCompanion(input) {
    const { target, plan, uid } = input;
    let path = plan.path;
    let published = false;
    const present = () => ({ status: 'present', files: [path], actions: [] });
    try {
        if (target === 'windows') {
            if (windowsTaskRegistered(input))
                return present();
            path = input.writeWindowsInstaller(plan.path, plan.content);
            const ps = input.powershell();
            require0(input.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, '-Install']), 'register Windows autoexec scheduled task');
            require0(input.run(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TASK_START]), 'start Windows autoexec scheduled task');
            return { status: 'installed', files: [path], actions: autoexecCompanionActions(target, path, uid) };
        }
        if (input.exists(path) || !publishUnit(input))
            return present();
        published = true;
        if (target === 'systemd') {
            require0(input.run(input.systemctl, ['--user', 'daemon-reload']), 'reload systemd user manager for autoexec');
            require0(input.run(input.systemctl, ['--user', 'enable', '--now', AUTOEXEC_SYSTEMD_UNIT]), 'enable systemd autoexec service');
        }
        else {
            if (uid === undefined)
                throw new CompanionStepError('cannot determine the current user id for launchd autoexec');
            require0(input.run(input.launchctl, ['bootstrap', `gui/${uid}`, path]), 'bootstrap launchd autoexec agent');
        }
        return { status: 'installed', files: [path], actions: autoexecCompanionActions(target, path, uid) };
    }
    catch (error) {
        return failedOutcome(input, path, published, error);
    }
}