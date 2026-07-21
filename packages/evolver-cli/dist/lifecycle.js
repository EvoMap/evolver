import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const requireFromHere = createRequire(import.meta.url);
const DEFAULT_DAEMON_NAME = 'evolver-proxy';
const DEFAULT_LABEL = 'com.evomap.evolver-proxy';
const DEFAULT_HEALTH_TIMEOUT_MS = 700;
const DEFAULT_WATCH_INTERVAL_MS = 120_000;
export function runLifecycleCommand(argv, deps = {}) {
    return runLifecycleCommandInner(argv, deps).catch((err) => {
        const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
        stderr(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    });
}
async function runLifecycleCommandInner(argv, deps) {
    const action = argv[0];
    const env = deps.env ?? process.env;
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    const flags = parseFlags(argv.slice(1));
    const paths = lifecyclePaths(env);
    switch (action) {
        case 'start': {
            const result = await startLifecycle(paths, env);
            stdout(`${JSON.stringify(result)}\n`);
            return 0;
        }
        case 'stop': {
            const result = stopLifecycle(paths);
            stdout(`${JSON.stringify(result)}\n`);
            return 0;
        }
        case 'restart': {
            stopLifecycle(paths);
            const result = await startLifecycle(paths, env);
            stdout(`${JSON.stringify({ ...result, status: result.status === 'started' ? 'restarted' : result.status })}\n`);
            return 0;
        }
        case 'status': {
            const status = await lifecycleStatus(paths, env);
            stdout(`${JSON.stringify(status, null, 2)}\n`);
            return status.running ? 0 : 1;
        }
        case 'check': {
            const status = await lifecycleStatus(paths, env);
            stdout(`${JSON.stringify(status, null, 2)}\n`);
            if (!status.healthy) {
                stderr(`[Lifecycle] unhealthy reason=${status.reason ?? 'unknown'}; restarting\n`);
                stopLifecycle(paths);
                const result = await startLifecycle(paths, env);
                stdout(`${JSON.stringify(result)}\n`);
                const next = await lifecycleStatus(paths, env);
                stdout(`${JSON.stringify({ after_restart: lifecycleStatusForOperator(next), log: 'inspect EVOLVER_LIFECYCLE_LOG_FILE or EVOLVER_LIFECYCLE_LOG_DIR' }, null, 2)}\n`);
                if (!next.healthy) {
                    stderr(`[Lifecycle] restart did not become healthy reason=${next.reason ?? 'unknown'}; inspect EVOLVER_LIFECYCLE_LOG_FILE or EVOLVER_LIFECYCLE_LOG_DIR\n`);
                    return 1;
                }
            }
            return 0;
        }
        case 'watch':
            return runWatch(paths, env, flags, stdout, stderr);
        case 'install-service': {
            const requestedEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : undefined;
            const envFileResult = requestedEnvFile
                ? loadEnvFile(requestedEnvFile, env)
                : loadEnvFileFromEnv(env);
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const target = serviceTarget(flags);
            const result = await installService(target, flags, env, deps.argv1 ?? process.argv[1]);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        default:
            stderr('用法: evolver lifecycle <start|stop|restart|status|check|watch|install-service --target=launchd|systemd|windows>\n');
            return action === undefined ? 0 : 1;
    }
}
function lifecycleStatusForOperator(status) {
    const { logFile: _logFile, ...safe } = status;
    return safe;
}
export async function maybeAutoRestartProxyForSessionStart(env = process.env, argv1 = process.argv[1], deps = {}) {
    if (!sessionAutoRestartEnabled(env))
        return;
    if (!proxyExpected(env))
        return;
    const paths = lifecyclePaths(env);
    const verbose = sessionStartHookVerboseEnabled(env);
    const stderr = verbose
        ? (deps.stderr ?? ((text) => { process.stderr.write(text); }))
        : undefined;
    const status = await lifecycleStatus(paths, env, { timeoutMs: 250, quietSettingsReadError: !verbose, stderr });
    if (status.healthy)
        return;
    if ((deps.platform ?? process.platform) === 'win32') {
        stderr?.(`[evolver-session-start] proxy daemon unhealthy (${status.reason ?? 'unknown'}); scheduled task/service manager should restart it on Windows.\n`);
        return;
    }
    const cliPath = argv1 && argv1.trim() ? argv1 : resolveCurrentCliPath();
    const spawnDetached = deps.spawnDetached ?? spawn;
    const child = spawnDetached(process.execPath, [cliPath, 'lifecycle', 'start'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...env },
        windowsHide: true,
    });
    child.once('error', (err) => {
        stderr?.(`[evolver-session-start] background restart spawn failed: ${err.message}\n`);
    });
    child.unref();
    stderr?.(`[evolver-session-start] proxy daemon unhealthy (${status.reason ?? 'unknown'}); attempted background restart (PID ${child.pid}).\n`);
}
export async function startLifecycle(paths, env = process.env) {
    loadEnvFileFromEnv(env);
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
    const current = await lifecycleStatus(paths, env);
    if (current.healthy && current.pid)
        return { status: 'already_running', pid: current.pid, logFile: paths.logFile };
    if (current.pid && current.running)
        stopLifecycle(paths);
    else
        rmSync(paths.pidFile, { force: true });
    const command = resolveDaemonCommand(env);
    const cwd = env['EVOLVER_LIFECYCLE_CWD'] || process.cwd();
    const out = openSync(paths.logFile, 'a');
    const err = openSync(paths.logFile, 'a');
    const child = spawn(command.command, command.args, {
        cwd,
        detached: true,
        stdio: ['ignore', out, err],
        env: oneShotChildEnv(env),
        windowsHide: true,
    });
    child.once('error', (err) => {
        process.stderr.write(`[Lifecycle] failed to spawn ${command.command}: ${err.message}\n`);
    });
    child.unref();
    if (!child.pid)
        throw new Error('failed to determine lifecycle daemon pid');
    writePidFile(paths.pidFile, {
        owner: 'evolver-lifecycle',
        pid: child.pid,
        parentPid: process.pid,
        command: command.command,
        args: command.args,
        cwd,
        createdAt: new Date().toISOString(),
    });
    return { status: 'started', pid: child.pid, logFile: paths.logFile };
}
function oneShotChildEnv(env) {
    const childEnv = { ...env };
    delete childEnv['EVOLVER_SELF_UPDATE_SUPERVISOR'];
    return childEnv;
}
export function stopLifecycle(paths, deps = {}) {
    const pidFile = readPidFile(paths.pidFile);
    const pid = pidFile.pid;
    if (!pid || !isPidRunning(pid)) {
        rmSync(paths.pidFile, { force: true });
        return { status: 'not_running' };
    }
    if (!pidFile.owned || !waitForPidFileRecordMatch(pidFile, 1_000, deps.processCommandLine ?? processCommandLine, deps.processIdentity ?? processIdentity)) {
        return { status: 'not_owned', pid, reason: 'pidfile_owner_unconfirmed' };
    }
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (err) {
        return { status: 'stop_failed', pid, reason: err instanceof Error ? err.message : String(err) };
    }
    const stopped = waitForExit(pid, 5_000);
    if (!stopped)
        forceKill(pid);
    rmSync(paths.pidFile, { force: true });
    return { status: 'stopped', pids: [pid] };
}
export async function lifecycleStatus(paths, env = process.env, options = {}) {
    const settings = readProxySettings(paths.settingsFile, {
        quietReadError: options.quietSettingsReadError === true,
        stderr: options.stderr,
    });
    const pidFile = readPidFile(paths.pidFile);
    const pid = pidFile.pid;
    if (!pid || !isPidRunning(pid)) {
        if (pid)
            rmSync(paths.pidFile, { force: true });
        const settingsStatus = await lifecycleStatusFromSettings(settings, paths, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
        if (settingsStatus)
            return settingsStatus;
        return { running: false, healthy: false, reason: 'not_running', logFile: paths.logFile };
    }
    if (!pidFile.owned || !pidFileRecordMatchesProcess(pidFile)) {
        const settingsStatus = await lifecycleStatusFromSettings(settings, paths, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
        if (settingsStatus)
            return settingsStatus;
        return { running: false, pid, healthy: false, reason: 'pidfile_owner_unconfirmed', logFile: paths.logFile };
    }
    if (env['EVOLVER_LIFECYCLE_REQUIRE_PROXY_STATUS'] === '0') {
        return { running: true, pid, healthy: true, logFile: paths.logFile };
    }
    if (!settings.url || !settings.token) {
        return { running: true, pid, healthy: false, reason: 'proxy_settings_missing', logFile: paths.logFile };
    }
    if (settings.pid && settings.pid !== pid && !isPidRunning(settings.pid)) {
        return { running: true, pid, healthy: false, reason: 'proxy_settings_stale_pid', logFile: paths.logFile };
    }
    const ok = await proxyStatusOk(settings, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    return {
        running: true,
        pid,
        healthy: ok,
        ...(ok ? {} : { reason: 'proxy_unreachable' }),
        logFile: paths.logFile,
    };
}
export function lifecyclePaths(env = process.env) {
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    const stateDir = env['EVOLVER_LIFECYCLE_STATE_DIR'] ?? join(home, 'lifecycle');
    const logDir = env['EVOLVER_LIFECYCLE_LOG_DIR'] ?? join(home, 'logs');
    const name = env['EVOLVER_LIFECYCLE_NAME'] ?? DEFAULT_DAEMON_NAME;
    const settingsHome = nonBlankEnv(env, 'EVOLVER_SETTINGS_DIR') ?? join(homedir(), '.evolver');
    return {
        home,
        stateDir,
        logDir,
        pidFile: env['EVOLVER_LIFECYCLE_PID_FILE'] ?? join(stateDir, `${name}.pid`),
        logFile: env['EVOLVER_LIFECYCLE_LOG_FILE'] ?? join(logDir, `${name}.log`),
        settingsFile: nonBlankEnv(env, 'EVOLVER_PROXY_SETTINGS_FILE') ?? join(settingsHome, 'settings.json'),
    };
}
function nonBlankEnv(env, key) {
    const value = env[key]?.trim();
    return value ? value : undefined;
}
export function renderSystemdUnit(opts = {}) {
    return [
        '# Linux systemd user unit -- ~/.config/systemd/user/evolver-proxy.service',
        '[Unit]',
        'Description=EvoMap Evolver Proxy Daemon',
        'After=network-online.target',
        'Wants=network-online.target',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=120s',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${opts.workingDirectory ?? '%h'}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        'Environment="EVOLVER_SELF_UPDATE_SUPERVISOR=systemd"',
        ...(opts.selfUpdateStateDir
            ? [`Environment="EVOLVER_SELF_UPDATE_STATE_DIR=${escapeSystemdEnvValue(opts.selfUpdateStateDir)}"`]
            : []),
        ...(opts.selfUpdateTarget
            ? [`Environment="EVOLVER_SELF_UPDATE_TARGET_PATH=${escapeSystemdEnvValue(opts.selfUpdateTarget)}"`]
            : []),
        `ExecStart=${opts.execStart ?? defaultServiceExecStart()}`,
        'Restart=on-failure',
        'RestartSec=5s',
        'RestartPreventExitStatus=0',
        'RestartForceExitStatus=78',
        'TimeoutStopSec=30s',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=evolver-proxy',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}
export function renderLaunchdPlist(opts = {}) {
    const workingDirectory = opts.workingDirectory ?? '/Users/YOU/your-project';
    const nodePath = opts.nodePath ?? '/usr/local/bin/node';
    const proxyBin = opts.proxyBin ?? '/Users/YOU/your-project/node_modules/@evomap/evolver-proxy/dist/bin/evolver-proxy.js';
    const programArguments = opts.programArguments ?? [nodePath, proxyBin];
    const logDir = opts.logDir ?? '/Users/YOU/Library/Logs';
    const envFileBlock = opts.envFile ? `        <key>EVOLVER_ENV_FILE</key>\n        <string>${escapeXml(opts.envFile)}</string>\n` : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${DEFAULT_LABEL}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`),
        '    </array>',
        '    <key>WorkingDirectory</key>',
        `    <string>${escapeXml(workingDirectory)}</string>`,
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        envFileBlock.trimEnd(),
        '        <key>EVOLVER_SELF_UPDATE_SUPERVISOR</key>',
        '        <string>launchd</string>',
        ...(opts.selfUpdateStateDir ? [
            '        <key>EVOLVER_SELF_UPDATE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.selfUpdateStateDir)}</string>`,
        ] : []),
        ...(opts.selfUpdateTarget ? [
            '        <key>EVOLVER_SELF_UPDATE_TARGET_PATH</key>',
            `        <string>${escapeXml(opts.selfUpdateTarget)}</string>`,
        ] : []),
        '        <key>PATH</key>',
        '        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
        '    </dict>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
        '    <key>ThrottleInterval</key>',
        '    <integer>5</integer>',
        '    <key>StandardOutPath</key>',
        `    <string>${escapeXml(join(logDir, 'evolver-proxy.log'))}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${escapeXml(join(logDir, 'evolver-proxy.err.log'))}</string>`,
        '    <key>ProcessType</key>',
        '    <string>Standard</string>',
        '    <key>LowPriorityIO</key>',
        '    <false/>',
        '    <key>LowPriorityBackgroundIO</key>',
        '    <false/>',
        '</dict>',
        '</plist>',
        '',
    ].filter((line) => line !== '').join('\n');
}
export function renderWindowsInstaller(defaults = {}) {
    const ps = (value) => `'${(value ?? '').replaceAll("'", "''")}'`;
    return String.raw `param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$TaskName = 'EvoMapEvolverProxyDaemon',
  [string]$EvolverBin = ${ps(defaults.evolverBin)},
  [string]$NodePath = ${ps(defaults.nodePath)},
  [string]$ProxyBin = ${ps(defaults.proxyBin)},
  [string]$EnvFile = ${ps(defaults.envFile)},
  [string]$SelfUpdateStateDir = ${ps(defaults.selfUpdateStateDir)}
)

$ErrorActionPreference = 'Stop'

if (-not ($Install -or $Uninstall)) {
  Write-Host 'Usage: install-evolver-proxy-windows.ps1 -Install [-EvolverBin ... | -NodePath ... -ProxyBin ...] [-EnvFile ...]'
  Write-Host '       install-evolver-proxy-windows.ps1 -Uninstall [-TaskName ...]'
  exit 1
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  $launcher = Join-Path $env:LOCALAPPDATA 'EvoMap\evolver-proxy-task-launcher.vbs'
  if (Test-Path $launcher) { Remove-Item $launcher -Force -ErrorAction SilentlyContinue }
  exit 0
}

if (-not $EvolverBin) {
  if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error 'Pass -EvolverBin, or install node.exe / pass -NodePath.'; exit 1 }
    $NodePath = $cmd.Source
  }
  if (-not $ProxyBin) { Write-Error 'Pass -EvolverBin, or -ProxyBin pointing at evolver-proxy.js.'; exit 1 }
  if (-not (Test-Path $ProxyBin)) { Write-Error "Proxy bin not found at $ProxyBin"; exit 1 }
} elseif (-not (Test-Path $EvolverBin)) {
  Write-Error "Evolver binary not found at $EvolverBin"; exit 1
}

if ($EvolverBin) {
  if (-not $SelfUpdateStateDir) { $SelfUpdateStateDir = $env:EVOLVER_SELF_UPDATE_STATE_DIR }
  if (-not $SelfUpdateStateDir) {
    $SelfUpdateStateDir = Join-Path (Split-Path -Parent $EvolverBin) '.evolver-update'
  }
}

foreach ($launcherValue in @($EvolverBin, $NodePath, $ProxyBin, $EnvFile, $SelfUpdateStateDir)) {
  if ($launcherValue -match "[\r\n]") {
    Write-Error 'Launcher paths must not contain line breaks.'
    exit 1
  }
}

if ($EvolverBin) {
  $EvolverBin = [System.IO.Path]::GetFullPath($EvolverBin)
  $SelfUpdateStateDir = [System.IO.Path]::GetFullPath($SelfUpdateStateDir)
  # Service installation is the explicit upgrade boundary for the stable controller.
  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } while ($existingTask -and $existingTask.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
    if ($existingTask -and $existingTask.State -eq 'Running') {
      Write-Error 'Existing Evolver Scheduled Task did not stop; refusing to replace its recovery controller.'
      exit 1
    }
  }
  $env:EVOLVER_SELF_UPDATE_STATE_DIR = $SelfUpdateStateDir
  $env:EVOLVER_SELF_UPDATE_TARGET_PATH = $EvolverBin
  & $EvolverBin 'proxy' '--evolver-windows-recovery-controller-provision'
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'Failed to provision the stable Windows recovery controller.'
    exit 1
  }
}

$launcherDir = Join-Path $env:LOCALAPPDATA 'EvoMap'
if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir | Out-Null }
$launcherPath = Join-Path $launcherDir 'evolver-proxy-task-launcher.vbs'

$nodeEsc = if ($NodePath) { $NodePath.Replace('"', '""') } else { '' }
$proxyEsc = if ($ProxyBin) { $ProxyBin.Replace('"', '""') } else { '' }
$evolverEsc = if ($EvolverBin) { $EvolverBin.Replace('"', '""') } else { '' }
$envEsc = if ($EnvFile) { $EnvFile.Replace('"', '""') } else { '' }
$stateDirEsc = if ($SelfUpdateStateDir) { $SelfUpdateStateDir.Replace('"', '""') } else { '' }

$launcherBody = @"
' AUTO-GENERATED by install-evolver-proxy-windows.ps1 -- do not edit.
' wscript.exe is a Windows-subsystem host. WshShell.Run(..., 0, True)
' launches node.exe hidden and waits so Task Scheduler sees the exit code.
Dim WshShell, env, fso, stateDir, pendingPath, updaterPath, controllerPath, controllerCmd, cmd, rc
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")
Set fso = CreateObject("Scripting.FileSystemObject")
If "$envEsc" <> "" Then env("EVOLVER_ENV_FILE") = "$envEsc"
env("EVOLVER_SELF_UPDATE_SUPERVISOR") = "windows-scheduled-task"
If "$evolverEsc" <> "" Then
  stateDir = "$stateDirEsc"
  env("EVOLVER_SELF_UPDATE_STATE_DIR") = stateDir
  env("EVOLVER_SELF_UPDATE_TARGET_PATH") = "$evolverEsc"
  pendingPath = stateDir & "\windows-updater\pending.json"
  updaterPath = stateDir & "\windows-updater\updater.exe"
  controllerPath = stateDir & "\windows-controller\evolver-recovery-controller.exe"
  cmd = """$evolverEsc"" proxy"
  If Not fso.FileExists(controllerPath) Then WScript.Quit 1
  If fso.FileExists(pendingPath) And Not fso.FileExists(updaterPath) Then WScript.Quit 1
  controllerCmd = """" & controllerPath & """ proxy --evolver-windows-recovery-controller"
  rc = WshShell.Run(controllerCmd, 0, True)
  WScript.Quit rc
Else
  cmd = """$nodeEsc"" ""$proxyEsc"""
End If
rc = WshShell.Run(cmd, 0, True)
WScript.Quit rc
"@
Set-Content -Path $launcherPath -Value $launcherBody -Encoding Unicode

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $launcherPath)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Days 0)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Host "Installed scheduled task '$TaskName' using hidden wscript launcher $launcherPath."
`;
}
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg?.startsWith('--'))
            continue;
        const raw = arg.slice(2);
        const eq = raw.indexOf('=');
        if (eq >= 0)
            out[raw.slice(0, eq)] = raw.slice(eq + 1);
        else if (argv[i + 1] && !argv[i + 1].startsWith('--'))
            out[raw] = argv[++i];
        else
            out[raw] = true;
    }
    return out;
}
function serviceTarget(flags) {
    const value = typeof flags['target'] === 'string' ? flags['target'] : '';
    if (value === 'launchd' || value === 'systemd' || value === 'windows')
        return value;
    throw new Error('missing or invalid --target (expected: launchd|systemd|windows)');
}
async function installService(target, flags, env, argv1) {
    const dryRun = flags['dry-run'] === true;
    const envFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : env['EVOLVER_ENV_FILE'];
    const supervised = configuredSelfUpdateTarget(env)
        ? resolveDaemonCommand(env, process.execPath, argv1)
        : resolveSelfUpdatingExecutable(process.execPath, argv1);
    const standaloneTarget = supervised?.args.length === 1 && supervised.args[0] === 'proxy'
        ? supervised.command
        : undefined;
    let unixController;
    let unixControllerStateDir;
    if (target !== 'windows' && standaloneTarget) {
        const { provisionStableUnixRecoveryController, stableUnixRecoveryControllerPathForTarget, UNIX_RECOVERY_CONTROLLER_ARG, } = await import('@evomap/evolver-proxy');
        const stateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim() || undefined;
        const controllerPath = dryRun
            ? stableUnixRecoveryControllerPathForTarget(standaloneTarget, stateDir)
            : await provisionStableUnixRecoveryController({
                env: { ...env, EVOLVER_SELF_UPDATE_TARGET_PATH: standaloneTarget },
                processExecPath: standaloneTarget,
            });
        unixController = {
            command: controllerPath,
            args: ['proxy', UNIX_RECOVERY_CONTROLLER_ARG],
            display: `${controllerPath} proxy ${UNIX_RECOVERY_CONTROLLER_ARG}`,
        };
        unixControllerStateDir = dirname(dirname(controllerPath));
    }
    const serviceCommand = unixController ?? supervised;
    if (target === 'systemd') {
        const path = expandHome('~/.config/systemd/user/evolver-proxy.service');
        const unit = renderSystemdUnit({
            envFile,
            workingDirectory: typeof flags['cwd'] === 'string' ? flags['cwd'] : undefined,
            ...(serviceCommand
                ? { execStart: [serviceCommand.command, ...serviceCommand.args].map(quoteSystemdArg).join(' ') }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
        });
        if (!dryRun)
            writeTextFile(path, unit, 0o644);
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(unixController ? [unixController.command] : [])],
            service: 'systemd-user',
        };
    }
    if (target === 'launchd') {
        const path = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        const plist = renderLaunchdPlist({
            envFile,
            workingDirectory: typeof flags['cwd'] === 'string' ? flags['cwd'] : process.cwd(),
            ...(serviceCommand
                ? { programArguments: [serviceCommand.command, ...serviceCommand.args] }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath() ?? (argv1?.startsWith('/') ? argv1 : undefined) ?? '/ABSOLUTE/PATH/TO/evolver-proxy.js',
            logDir: join(homedir(), 'Library', 'Logs'),
        });
        if (!dryRun)
            writeTextFile(path, plist, 0o644);
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(unixController ? [unixController.command] : [])],
            service: 'launchd',
        };
    }
    const path = expandHome('~/install-evolver-proxy-windows.ps1');
    const selfUpdateStateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim();
    const standalone = standaloneTarget;
    const script = renderWindowsInstaller({
        ...(standalone ? { evolverBin: standalone } : {
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath(),
        }),
        ...(envFile ? { envFile } : {}),
        ...(selfUpdateStateDir ? { selfUpdateStateDir } : {}),
    });
    if (!dryRun)
        writeTextFile(path, script, 0o644);
    return { status: dryRun ? 'rendered' : 'installed', files: [path], service: 'windows-scheduled-task' };
}
async function runWatch(paths, env, flags, stdout, stderr) {
    const once = flags['once'] === true;
    const intervalMs = positiveInt(env['EVOLVER_WATCH_INTERVAL_MS'], DEFAULT_WATCH_INTERVAL_MS);
    let prevWall = Date.now();
    let prevMono = process.hrtime.bigint();
    let skippedLastTick = false;
    const tick = async () => {
        const nowWall = Date.now();
        const nowMono = process.hrtime.bigint();
        const wallDelta = nowWall - prevWall;
        const monoDeltaMs = Number((nowMono - prevMono) / 1000000n);
        const status = await lifecycleStatus(paths, env);
        const clockJumped = (wallDelta - monoDeltaMs) > 60_000 && !skippedLastTick;
        if (status.healthy) {
            stdout(`[Watch] ${new Date().toISOString()} healthy pid=${status.pid ?? '-'}\n`);
            skippedLastTick = false;
        }
        else if (clockJumped && status.reason === 'stagnation') {
            stdout(`[Watch] wall-clock jump detected; skipping one stagnation restart\n`);
            skippedLastTick = true;
        }
        else {
            stdout(`[Watch] ${new Date().toISOString()} unhealthy reason=${status.reason ?? 'unknown'} restarting...\n`);
            stopLifecycle(paths);
            const result = await startLifecycle(paths, env);
            stdout(`[Watch] restart result: ${JSON.stringify(result)}\n`);
            skippedLastTick = false;
        }
        prevWall = nowWall;
        prevMono = nowMono;
    };
    await tick().catch((err) => { stderr(`[Watch] tick error: ${err instanceof Error ? err.message : String(err)}\n`); });
    if (once)
        return 0;
    setInterval(() => {
        void tick().catch((err) => { stderr(`[Watch] tick error: ${err instanceof Error ? err.message : String(err)}\n`); });
    }, intervalMs);
    stdout(`[Watch] Supervisor running every ${Math.round(intervalMs / 1000)}s. Ctrl-C to stop.\n`);
    return new Promise(() => { });
}
export function resolveDaemonCommand(env, execPath = process.execPath, argv1 = process.argv[1]) {
    const explicit = env['EVOLVER_LIFECYCLE_COMMAND']?.trim();
    const selfUpdateTarget = configuredSelfUpdateTarget(env);
    if (selfUpdateTarget) {
        const supervised = standaloneProxyCommand(selfUpdateTarget);
        if (explicit) {
            const parsed = repairUnquotedWindowsExePath(explicit, parseCommandLine(explicit));
            if (!matchesStandaloneProxyCommand(parsed, selfUpdateTarget)) {
                throw new Error('EVOLVER_LIFECYCLE_COMMAND must invoke EVOLVER_SELF_UPDATE_TARGET_PATH with only the "proxy" argument; refusing mismatched self-update supervision');
            }
        }
        return supervised;
    }
    if (explicit) {
        const parsed = repairUnquotedWindowsExePath(explicit, parseCommandLine(explicit));
        if (parsed.length === 0)
            throw new Error('EVOLVER_LIFECYCLE_COMMAND is empty');
        return { command: parsed[0], args: parsed.slice(1), display: explicit };
    }
    const selfExecutable = resolveSelfUpdatingExecutable(execPath, argv1);
    if (selfExecutable)
        return selfExecutable;
    const proxyBin = resolveProxyBinPath();
    if (proxyBin)
        return { command: execPath, args: [proxyBin], display: `${execPath} ${proxyBin}` };
    return { command: DEFAULT_DAEMON_NAME, args: [], display: DEFAULT_DAEMON_NAME };
}
function configuredSelfUpdateTarget(env) {
    const target = env['EVOLVER_SELF_UPDATE_TARGET_PATH']?.trim();
    return target || undefined;
}
function standaloneProxyCommand(targetPath) {
    return { command: targetPath, args: ['proxy'], display: `${targetPath} proxy` };
}
function matchesStandaloneProxyCommand(parsed, targetPath) {
    return parsed.length === 2
        && sameExecutablePath(parsed[0], targetPath)
        && parsed[1] === 'proxy';
}
function sameExecutablePath(left, right) {
    if (left === right)
        return true;
    if (process.platform !== 'win32')
        return false;
    const normalizeWindowsPath = (value) => value.replaceAll('/', '\\').toLowerCase();
    return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}
export function resolveSelfUpdatingExecutable(execPath, argv1) {
    const executableName = basename(execPath).toLowerCase();
    if (/^evolver(?:\.exe|-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64\.exe))?$/.test(executableName)) {
        return { command: execPath, args: ['proxy'], display: `${execPath} proxy` };
    }
    if (argv1 && basename(argv1).toLowerCase() === 'cli.js') {
        return { command: execPath, args: [argv1, 'proxy'], display: `${execPath} ${argv1} proxy` };
    }
    return undefined;
}
export function resolveProxyBinPath() {
    try {
        const entry = requireFromHere.resolve('@evomap/evolver-proxy');
        const candidate = join(dirname(entry), 'bin', 'evolver-proxy.js');
        return existsSync(candidate) ? candidate : undefined;
    }
    catch {
        const local = fileURLToPath(new URL('../../evolver-proxy/dist/bin/evolver-proxy.js', import.meta.url));
        return existsSync(local) ? local : undefined;
    }
}
export function resolveStableNodePath() {
    const pathNode = resolvePathCommand('node');
    if (pathNode)
        return pathNode;
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
        if (existsSync(candidate))
            return candidate;
    }
    return process.execPath;
}
function defaultServiceExecStart() {
    const proxyBin = resolveProxyBinPath();
    if (!proxyBin)
        return `${quoteSystemdArg(resolveStableNodePath())} /ABSOLUTE/PATH/TO/evolver-proxy.js`;
    return `${quoteSystemdArg(resolveStableNodePath())} ${quoteSystemdArg(proxyBin)}`;
}
function resolvePathCommand(command) {
    try {
        const out = execFileSync('/bin/sh', ['-lc', `command -v ${command}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return out.startsWith('/') ? out : undefined;
    }
    catch {
        return undefined;
    }
}
function writePidFile(path, record) {
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}
function readPidFile(path) {
    try {
        const raw = readFileSync(path, 'utf8').trim();
        if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return { owned: false, legacy: false };
            const record = parsed;
            const rawPid = record['pid'];
            const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
            const args = record['args'];
            const command = record['command'];
            const cwd = record['cwd'];
            const owner = record['owner'];
            const createdAt = record['createdAt'];
            const parentPid = record['parentPid'];
            if (owner === 'evolver-lifecycle'
                && pid !== undefined
                && (parentPid === undefined || (typeof parentPid === 'number' && Number.isInteger(parentPid) && parentPid > 0))
                && typeof command === 'string'
                && Array.isArray(args)
                && args.every((arg) => typeof arg === 'string')
                && typeof cwd === 'string'
                && typeof createdAt === 'string') {
                return {
                    pid,
                    owned: true,
                    legacy: false,
                    record: { owner, pid, ...(parentPid ? { parentPid } : {}), command, args, cwd, createdAt },
                };
            }
            return { pid, owned: false, legacy: false };
        }
        const pid = Number(raw);
        return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, owned: false, legacy: true };
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return { owned: false, legacy: false };
        return { owned: false, legacy: false };
    }
}
function pidFileRecordMatchesProcess(pidFile, readCommandLine = processCommandLine, readIdentity = processIdentity) {
    if (!pidFile.owned || !pidFile.record)
        return false;
    const record = pidFile.record;
    const commandLine = readCommandLine(record.pid);
    if (commandLine && commandLine.includes(basename(record.command)))
        return record.args.every((arg) => commandLine.includes(arg));
    return processIdentityMatchesRecord(record, readIdentity(record.pid));
}
function waitForPidFileRecordMatch(pidFile, timeoutMs, readCommandLine = processCommandLine, readIdentity = processIdentity) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity))
            return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity);
}
function processCommandLine(pid) {
    if (process.platform === 'win32') {
        try {
            const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
            return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            }).trim() || undefined;
        }
        catch {
            return undefined;
        }
    }
    try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function processIdentity(pid) {
    if (process.platform === 'win32') {
        try {
            const script = [
                `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
                'if (-not $p) { exit 1 }',
                '$path=$p.ExecutablePath',
                '$start=if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { "" }',
                '$parent=if ($p.ParentProcessId) { $p.ParentProcessId } else { "" }',
                'Write-Output $path',
                'Write-Output $start',
                'Write-Output $parent',
            ].join('; ');
            const [executable, rawStartedAt, rawParentPid] = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            }).split(/\r?\n/).map((line) => line.trim());
            const startedAt = rawStartedAt ? Number(rawStartedAt) : undefined;
            const parentPid = rawParentPid ? Number(rawParentPid) : undefined;
            return {
                ...(executable ? { executable } : {}),
                ...(parentPid && Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
                ...(startedAt && Number.isFinite(startedAt) ? { startedAt } : {}),
            };
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function processIdentityMatchesRecord(record, identity) {
    if (!identity?.executable || !identity.parentPid || !identity.startedAt)
        return false;
    if (record.parentPid !== undefined && record.parentPid !== identity.parentPid)
        return false;
    if (normalizeFsIdentity(identity.executable) !== normalizeFsIdentity(record.command))
        return false;
    const recordStartedAt = Date.parse(record.createdAt);
    return Number.isFinite(recordStartedAt) && Math.abs(identity.startedAt - recordStartedAt) <= 30_000;
}
function normalizeFsIdentity(value) {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
function waitForExit(pid, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isPidRunning(pid))
            return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return !isPidRunning(pid);
}
function forceKill(pid) {
    if (process.platform === 'win32') {
        try {
            execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
            return;
        }
        catch (err) {
            process.stderr.write(`[Lifecycle] taskkill failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch (err) {
        process.stderr.write(`[Lifecycle] SIGKILL failed for PID ${pid}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
function readProxySettings(path, options = {}) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const proxy = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed['proxy'] : undefined;
        if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy))
            return {};
        const record = proxy;
        return {
            ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
            ...(typeof record['token'] === 'string' ? { token: record['token'] } : {}),
            ...(typeof record['pid'] === 'number' ? { pid: record['pid'] } : {}),
        };
    }
    catch (err) {
        if (!options.quietReadError && err.code !== 'ENOENT') {
            const stderr = options.stderr ?? ((text) => { process.stderr.write(text); });
            stderr(`[Lifecycle] failed to read proxy settings: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return {};
    }
}
async function proxyStatusOk(settings, timeoutMs) {
    if (!settings.url || !settings.token)
        return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = `${settings.url.replace(/\/+$/, '')}/proxy/status`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${settings.token}` }, signal: controller.signal });
        if (!res.ok)
            return false;
        const body = await res.json();
        return Boolean(body && typeof body === 'object' && !Array.isArray(body) && body['status'] === 'running');
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function lifecycleStatusFromSettings(settings, paths, timeoutMs) {
    if (!settings.pid || !settings.url || !settings.token || !isPidRunning(settings.pid))
        return undefined;
    const ok = await proxyStatusOk(settings, timeoutMs);
    if (!ok)
        return undefined;
    return { running: true, pid: settings.pid, healthy: true, logFile: paths.logFile };
}
function sessionAutoRestartEnabled(env) {
    const value = env['EVOLVER_SESSION_AUTO_RESTART']?.trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'off';
}
export function sessionStartHookVerboseEnabled(env = process.env) {
    const value = env['EVOLVER_HOOK_VERBOSE']?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
export function proxyExpected(env = process.env) {
    if (env['EVOLVER_PROXY_EXPECTED'] === '1')
        return true;
    if (env['EVOMAP_PROXY'] === '1')
        return true;
    if (env['A2A_TRANSPORT']?.toLowerCase() === 'mailbox')
        return true;
    if (isLoopbackUrl(env['EVOLVER_PROXY_URL']) || isLoopbackUrl(env['ANTHROPIC_BASE_URL']))
        return true;
    return existsSync(lifecyclePaths(env).settingsFile);
}
function isLoopbackUrl(value) {
    const raw = value?.trim();
    if (!raw)
        return false;
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
    }
    catch {
        return false;
    }
}
function repairUnquotedWindowsExePath(value, parsed) {
    if (process.platform !== 'win32' || parsed.length === 0)
        return parsed;
    const first = parsed[0];
    if (/\.exe$/i.test(first))
        return parsed;
    const exeEnd = value.toLowerCase().indexOf('.exe');
    if (exeEnd < 0)
        return parsed;
    const command = value.slice(0, exeEnd + 4).trim();
    if (!/^[A-Za-z]:\\/.test(command) && !command.startsWith('\\\\'))
        return parsed;
    if (!existsSync(command))
        return parsed;
    const rest = value.slice(exeEnd + 4).trim();
    return rest ? [command, ...parseCommandLine(rest)] : [command];
}
function parseCommandLine(value) {
    const out = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            const next = value[i + 1];
            if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
                escaped = true;
                continue;
            }
            current += ch;
            continue;
        }
        if ((ch === '"' || ch === "'") && quote === null) {
            quote = ch;
            continue;
        }
        if (ch === quote) {
            quote = null;
            continue;
        }
        if (/\s/.test(ch) && quote === null) {
            if (current) {
                out.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (quote !== null)
        throw new Error('unterminated quote in EVOLVER_LIFECYCLE_COMMAND');
    if (escaped)
        current += '\\';
    if (current)
        out.push(current);
    return out;
}
function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/'))
        return join(homedir(), path.slice(2));
    return path;
}
function writeTextFile(path, content, mode) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode });
}
function escapeXml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
function escapeSystemdEnvValue(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$');
}
function quoteSystemdArg(value) {
    return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(value)
        ? value
        : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}
function resolveCurrentCliPath() {
    return fileURLToPath(new URL('./cli.js', import.meta.url));
}