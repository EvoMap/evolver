import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, posix, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHomePath, loadEnvFile, loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const requireFromHere = createRequire(import.meta.url);
const DEFAULT_DAEMON_NAME = 'evolver-proxy';
const DEFAULT_LABEL = 'com.evomap.evolver-proxy';
const AUTOEXEC_LABEL = 'com.evomap.evolver-autoexec';
const DEFAULT_HEALTH_TIMEOUT_MS = 700;
const DEFAULT_WATCH_INTERVAL_MS = 120_000;
const BOOTSTRAP_ENV_FILE_HANDOFF = 'EVOLVER_INTERNAL_BOOTSTRAP_ENV_FILE';
const LIFECYCLE_USAGE = 'Usage: evolver lifecycle <start|stop|restart|status|check|watch|install-service --target=launchd|systemd|windows [--with-autoexec] [--autoexec-home=<path>]|bootstrap [--target=launchd|systemd|windows] [--dry-run]|remove-autoexec-service --target=launchd|systemd|windows [--dry-run]>\n';
export function runLifecycleCommand(argv, deps = {}) {
    return runLifecycleCommandInner(argv, deps).catch((err) => {
        const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
        stderr(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    });
}
async function runLifecycleCommandInner(argv, deps) {
    const env = deps.env ?? process.env;
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    if (argv[0] === '--help' || argv[0] === '-h') {
        stdout(LIFECYCLE_USAGE);
        return 0;
    }
    const action = argv[0];
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
        case 'bootstrap': {
            const requestedEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : undefined;
            const envFileResult = requestedEnvFile
                ? loadEnvFile(requestedEnvFile, env)
                : loadEnvFileFromEnv(env);
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const result = await bootstrapService(flags, env, deps.argv1 ?? process.argv[1], deps.bootstrap ?? {}, deps.loadUnixRecoveryController);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        case 'install-service': {
            const requestedEnvFile = typeof flags['env-file'] === 'string' ? flags['env-file'] : undefined;
            const envFileResult = requestedEnvFile
                ? loadEnvFile(requestedEnvFile, env)
                : loadEnvFileFromEnv(env);
            if (envFileResult.error)
                throw new Error('failed to load lifecycle environment file');
            const target = serviceTarget(flags);
            const result = await installService(target, flags, env, deps.argv1 ?? process.argv[1], deps.loadUnixRecoveryController);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        case 'remove-autoexec-service': {
            if (flags['dry-run'] !== undefined && flags['dry-run'] !== true) {
                throw new Error('--dry-run is a boolean flag and does not accept a value');
            }
            const target = serviceTarget(flags);
            const result = (deps.removeAutoexecService ?? removeAutoexecService)(target, flags['dry-run'] === true);
            stdout(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        default:
            stderr(LIFECYCLE_USAGE);
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
    if (!pidFile.owned || !waitForPidFileRecordMatch(pidFile, 1_000, deps.processCommandLine ?? processCommandLine, deps.processIdentity ?? processIdentity, deps.platform ?? process.platform)) {
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
/** Fetch enriched connection status for the daily summary. Builds on lifecycleStatus, adding hub details. */
export async function dailyConnectionStatus(paths, env = process.env, options = {}) {
    const base = await lifecycleStatus(paths, env, { ...options, quietSettingsReadError: true });
    if (!base.running || !base.healthy)
        return base;
    // Proxy is healthy — fetch /proxy/status for hub details
    const settings = readProxySettings(paths.settingsFile, { quietReadError: true });
    if (!settings.url || !settings.token)
        return base;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    try {
        const url = `${settings.url.replace(/\/+$/, '')}/proxy/status`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${settings.token}` }, signal: controller.signal });
        if (!res.ok)
            return base;
        const body = await res.json();
        return {
            ...base,
            hubAuthStatus: typeof body['hub_auth_status'] === 'string' ? body['hub_auth_status'] : undefined,
            lastSyncAt: typeof body['last_sync_at'] === 'string' ? body['last_sync_at'] : undefined,
        };
    }
    catch {
        return base;
    }
    finally {
        clearTimeout(timeout);
    }
}
export function lifecyclePaths(env = process.env) {
    const home = env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
    const stateDir = resolvePath(nonBlankEnv(env, 'EVOLVER_LIFECYCLE_STATE_DIR') ?? join(home, 'lifecycle'));
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
    const execStart = assertSingleLine(opts.execStart ?? defaultServiceExecStart(), 'systemd ExecStart');
    const workingDirectory = opts.workingDirectory === undefined
        ? '%h'
        : quoteSystemdArg(isAbsolute(opts.workingDirectory) ? opts.workingDirectory : resolvePath(opts.workingDirectory));
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
        'Type=notify',
        '# The stable recovery controller may be MainPID; the proxy child invokes systemd-notify.',
        'NotifyAccess=all',
        'WatchdogSec=180s',
        `WorkingDirectory=${workingDirectory}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        'Environment="EVOLVER_SELF_UPDATE_SUPERVISOR=systemd"',
        ...(opts.lifecycleStateDir
            ? [`Environment="EVOLVER_LIFECYCLE_STATE_DIR=${escapeSystemdEnvValue(opts.lifecycleStateDir)}"`]
            : []),
        ...(opts.selfUpdateStateDir
            ? [`Environment="EVOLVER_SELF_UPDATE_STATE_DIR=${escapeSystemdEnvValue(opts.selfUpdateStateDir)}"`]
            : []),
        ...(opts.selfUpdateTarget
            ? [`Environment="EVOLVER_SELF_UPDATE_TARGET_PATH=${escapeSystemdEnvValue(opts.selfUpdateTarget)}"`]
            : []),
        `ExecStart=${execStart}`,
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
export function renderAutoexecSystemdUnit(opts) {
    const execStart = escapeSystemdPercent(assertSingleLine(opts.execStart, 'systemd ExecStart'));
    const workingDirectory = opts.workingDirectory === undefined
        ? '%h'
        : escapeSystemdPercent(quoteSystemdArg(isAbsolute(opts.workingDirectory) ? opts.workingDirectory : resolvePath(opts.workingDirectory)));
    return [
        '# Linux systemd user unit -- ~/.config/systemd/user/evolver-autoexec.service',
        '[Unit]',
        'Description=EvoMap Evolver Autoexec Daemon',
        'After=network-online.target evolver-proxy.service',
        'Wants=network-online.target evolver-proxy.service',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=120s',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${workingDirectory}`,
        ...(opts.envFile ? [`Environment="EVOLVER_ENV_FILE=${escapeSystemdEnvValue(opts.envFile)}"`] : []),
        `ExecStart=${execStart}`,
        'Restart=on-failure',
        'RestartSec=5s',
        'RestartPreventExitStatus=0',
        'TimeoutStopSec=30s',
        'StandardOutput=journal',
        'StandardError=journal',
        'SyslogIdentifier=evolver-autoexec',
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
    const label = opts.label ?? DEFAULT_LABEL;
    const logName = opts.logName ?? 'evolver-proxy';
    const selfUpdateSupervisor = opts.selfUpdateSupervisor ?? true;
    const envFileBlock = opts.envFile ? `        <key>EVOLVER_ENV_FILE</key>\n        <string>${escapeXml(opts.envFile)}</string>\n` : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${escapeXml(label)}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`),
        '    </array>',
        '    <key>WorkingDirectory</key>',
        `    <string>${escapeXml(workingDirectory)}</string>`,
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        envFileBlock.trimEnd(),
        ...(opts.lifecycleStateDir ? [
            '        <key>EVOLVER_LIFECYCLE_STATE_DIR</key>',
            `        <string>${escapeXml(opts.lifecycleStateDir)}</string>`,
        ] : []),
        ...(selfUpdateSupervisor ? [
            '        <key>EVOLVER_SELF_UPDATE_SUPERVISOR</key>',
            '        <string>launchd</string>',
        ] : []),
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
        `    <string>${escapeXml(posix.join(logDir, `${logName}.log`))}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${escapeXml(posix.join(logDir, `${logName}.err.log`))}</string>`,
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
export function renderAutoexecLaunchdPlist(opts) {
    return renderLaunchdPlist({
        ...opts,
        label: AUTOEXEC_LABEL,
        logName: 'evolver-autoexec',
        selfUpdateSupervisor: false,
    });
}
export function renderWindowsInstaller(defaults = {}) {
    const ps = (value) => `'${assertSingleLine(value ?? '', 'Windows installer value').replaceAll("'", "''")}'`;
    return String.raw `param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$TaskName = 'EvoMapEvolverProxyDaemon',
  [string]$EvolverBin = ${ps(defaults.evolverBin)},
  [string]$NodePath = ${ps(defaults.nodePath)},
  [string]$ProxyBin = ${ps(defaults.proxyBin)},
  [string]$EnvFile = ${ps(defaults.envFile)},
  [string]$LifecycleStateDir = ${ps(defaults.lifecycleStateDir)},
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
  if ($existing) {
    if ($existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $TaskName
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 100
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
      if ($existing -and $existing.State -eq 'Running') {
        Write-Error 'Existing Evolver Scheduled Task did not stop; refusing to uninstall.'
        exit 1
      }
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
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

foreach ($launcherValue in @($EvolverBin, $NodePath, $ProxyBin, $EnvFile, $LifecycleStateDir, $SelfUpdateStateDir)) {
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
$lifecycleStateDirEsc = if ($LifecycleStateDir) { $LifecycleStateDir.Replace('"', '""') } else { '' }
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
If "$lifecycleStateDirEsc" <> "" Then env("EVOLVER_LIFECYCLE_STATE_DIR") = "$lifecycleStateDirEsc"
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
# The proxy hands off right after bootstrap; start the task now so the current session is
# supervised immediately, while the -AtLogOn trigger keeps it durable across logins.
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed scheduled task '$TaskName' using hidden wscript launcher $launcherPath."
`;
}
export function renderWindowsAutoexecInstaller(defaults = {}) {
    const ps = (value) => `'${assertSingleLine(value ?? '', 'Windows installer value').replaceAll("'", "''")}'`;
    return String.raw `param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$TaskName = 'EvoMapEvolverAutoexecDaemon',
  [string]$EvolverBin = ${ps(defaults.evolverBin)},
  [string]$NodePath = ${ps(defaults.nodePath)},
  [string]$CliBin = ${ps(defaults.cliBin)},
  [string]$EnvFile = ${ps(defaults.envFile)},
  [string]$AutoexecHome = ${ps(defaults.autoexecHome)},
  [string]$WorkingDirectory = ${ps(defaults.workingDirectory)}
)

$ErrorActionPreference = 'Stop'

if (-not ($Install -or $Uninstall) -or ($Install -and $Uninstall)) {
  Write-Host 'Usage: install-evolver-autoexec-windows.ps1 -Install [-EvolverBin ... | -NodePath ... -CliBin ...] [-EnvFile ...] [-AutoexecHome ...]'
  Write-Host '       install-evolver-autoexec-windows.ps1 -Uninstall [-TaskName ...]'
  exit 1
}

$launcherDir = Join-Path $env:LOCALAPPDATA 'EvoMap'
$launcherPath = Join-Path $launcherDir 'evolver-autoexec-task-launcher.vbs'

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $TaskName
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 100
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
      if ($existing -and $existing.State -eq 'Running') {
        Write-Error 'Existing Evolver Autoexec Scheduled Task did not stop; refusing to uninstall.'
        exit 1
      }
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  if (Test-Path $launcherPath) { Remove-Item $launcherPath -Force -ErrorAction SilentlyContinue }
  exit 0
}

if (-not $EvolverBin) {
  if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Error 'Pass -EvolverBin, or install node.exe / pass -NodePath.'; exit 1 }
    $NodePath = $cmd.Source
  }
  if (-not $CliBin) { Write-Error 'Pass -EvolverBin, or -CliBin pointing at evolver CLI cli.js.'; exit 1 }
  if (-not (Test-Path $CliBin)) { Write-Error "Evolver CLI not found at $CliBin"; exit 1 }
} elseif (-not (Test-Path $EvolverBin)) {
  Write-Error "Evolver binary not found at $EvolverBin"
  exit 1
}

foreach ($launcherValue in @($EvolverBin, $NodePath, $CliBin, $EnvFile, $AutoexecHome, $WorkingDirectory)) {
  if ($launcherValue -match "[\r\n]") {
    Write-Error 'Launcher paths must not contain line breaks.'
    exit 1
  }
}

if (-not $WorkingDirectory) { $WorkingDirectory = $env:USERPROFILE }
if (-not (Test-Path $WorkingDirectory -PathType Container)) {
  Write-Error 'WorkingDirectory must be an existing directory.'
  exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 100
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  } while ($existing -and $existing.State -eq 'Running' -and [DateTime]::UtcNow -lt $stopDeadline)
  if ($existing -and $existing.State -eq 'Running') {
    Write-Error 'Existing Evolver Autoexec Scheduled Task did not stop; refusing to replace it.'
    exit 1
  }
}

if (-not (Test-Path $launcherDir)) { New-Item -ItemType Directory -Path $launcherDir | Out-Null }

$nodeEsc = if ($NodePath) { $NodePath.Replace('"', '""') } else { '' }
$cliEsc = if ($CliBin) { $CliBin.Replace('"', '""') } else { '' }
$evolverEsc = if ($EvolverBin) { $EvolverBin.Replace('"', '""') } else { '' }
$envEsc = if ($EnvFile) { $EnvFile.Replace('"', '""') } else { '' }
$homeEsc = if ($AutoexecHome) { $AutoexecHome.Replace('"', '""') } else { '' }

$launcherBody = @"
' AUTO-GENERATED by install-evolver-autoexec-windows.ps1 -- do not edit.
Dim WshShell, env, cmd, rc
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")
If "$envEsc" <> "" Then env("EVOLVER_ENV_FILE") = "$envEsc"
If "$evolverEsc" <> "" Then
  cmd = """$evolverEsc"" autoexec"
Else
  cmd = """$nodeEsc"" ""$cliEsc"" autoexec"
End If
If "$homeEsc" <> "" Then cmd = cmd & " ""$homeEsc"""
rc = WshShell.Run(cmd, 0, True)
WScript.Quit rc
"@
Set-Content -Path $launcherPath -Value $launcherBody -Encoding Unicode

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $launcherPath) -WorkingDirectory $WorkingDirectory
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Days 0) -MultipleInstances IgnoreNew
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
async function installService(target, flags, env, argv1, loadUnixRecoveryController = () => import('@evomap/evolver-proxy')) {
    const dryRun = flags['dry-run'] === true;
    const lifecycleStateDir = lifecyclePaths(env).stateDir;
    if (flags['with-autoexec'] !== undefined && flags['with-autoexec'] !== true) {
        throw new Error('--with-autoexec is a boolean flag and does not accept a value');
    }
    if (flags['autoexec-home'] === true) {
        throw new Error('--autoexec-home requires a path');
    }
    const withAutoexec = flags['with-autoexec'] === true;
    if (!withAutoexec && flags['autoexec-home'] !== undefined) {
        throw new Error('--autoexec-home requires --with-autoexec');
    }
    const configuredEnvFile = typeof flags['env-file'] === 'string'
        ? flags['env-file'].trim()
        : nonBlankEnv(env, 'EVOLVER_ENV_FILE');
    const envFile = configuredEnvFile
        ? resolvePath(expandHomePath(configuredEnvFile))
        : undefined;
    const supervised = configuredSelfUpdateTarget(env)
        ? resolveDaemonCommand(env, process.execPath, argv1)
        : resolveSelfUpdatingExecutable(process.execPath, argv1);
    const standaloneTarget = supervised?.args.length === 1 && supervised.args[0] === 'proxy'
        ? supervised.command
        : undefined;
    let unixController;
    let unixControllerStateDir;
    if (target !== 'windows' && standaloneTarget) {
        const { provisionStableUnixRecoveryController, stableUnixRecoveryControllerPathForTarget, UNIX_RECOVERY_CONTROLLER_ARG, } = await loadUnixRecoveryController();
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
    const autoexecHomeFlag = typeof flags['autoexec-home'] === 'string' ? flags['autoexec-home'].trim() : undefined;
    if (autoexecHomeFlag !== undefined && !autoexecHomeFlag) {
        throw new Error('--autoexec-home requires a non-empty path');
    }
    const companionWorkingDirectoryFlag = typeof flags['cwd'] === 'string'
        ? assertSingleLine(flags['cwd'].trim(), 'service working directory')
        : undefined;
    const companionWorkingDirectory = companionWorkingDirectoryFlag
        ? (isAbsolute(companionWorkingDirectoryFlag) ? companionWorkingDirectoryFlag : resolvePath(companionWorkingDirectoryFlag))
        : process.cwd();
    const autoexecHome = autoexecHomeFlag
        ? assertSingleLine(isAbsolute(autoexecHomeFlag) ? autoexecHomeFlag : resolvePath(companionWorkingDirectory, autoexecHomeFlag), 'autoexec home')
        : undefined;
    const autoexecCommand = withAutoexec
        ? resolveAutoexecDaemonCommand(env, process.execPath, argv1, autoexecHome)
        : undefined;
    if (withAutoexec && !autoexecCommand) {
        throw new Error('cannot resolve the current evolver CLI for --with-autoexec; pass a standalone Evolver binary or run through cli.js');
    }
    if (target === 'systemd') {
        const path = expandHome('~/.config/systemd/user/evolver-proxy.service');
        const autoexecPath = expandHome('~/.config/systemd/user/evolver-autoexec.service');
        const workingDirectory = typeof flags['cwd'] === 'string' ? flags['cwd'] : undefined;
        const unit = renderSystemdUnit({
            envFile,
            lifecycleStateDir,
            workingDirectory,
            ...(serviceCommand
                ? { execStart: [serviceCommand.command, ...serviceCommand.args].map(quoteSystemdArg).join(' ') }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
        });
        if (!dryRun)
            writeTextFile(path, unit, 0o644);
        if (autoexecCommand) {
            const autoexecUnit = renderAutoexecSystemdUnit({
                envFile,
                workingDirectory: companionWorkingDirectory,
                execStart: [autoexecCommand.command, ...autoexecCommand.args].map(quoteSystemdArg).join(' '),
            });
            if (!dryRun)
                writeTextFile(autoexecPath, autoexecUnit, 0o644);
        }
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            service: 'systemd-user',
            ...(autoexecHome ? { autoexecHome } : {}),
        };
    }
    if (target === 'launchd') {
        const path = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        const autoexecPath = expandHome('~/Library/LaunchAgents/com.evomap.evolver-autoexec.plist');
        const workingDirectory = companionWorkingDirectory;
        const logDir = join(homedir(), 'Library', 'Logs');
        const plist = renderLaunchdPlist({
            envFile,
            lifecycleStateDir,
            workingDirectory,
            ...(serviceCommand
                ? { programArguments: [serviceCommand.command, ...serviceCommand.args] }
                : {}),
            ...(standaloneTarget ? { selfUpdateTarget: standaloneTarget } : {}),
            ...(unixControllerStateDir ? { selfUpdateStateDir: unixControllerStateDir } : {}),
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath() ?? (argv1?.startsWith('/') ? argv1 : undefined) ?? '/ABSOLUTE/PATH/TO/evolver-proxy.js',
            logDir,
        });
        if (!dryRun)
            writeTextFile(path, plist, 0o644);
        if (autoexecCommand) {
            const autoexecPlist = renderAutoexecLaunchdPlist({
                envFile,
                workingDirectory,
                programArguments: [autoexecCommand.command, ...autoexecCommand.args],
                logDir,
            });
            if (!dryRun)
                writeTextFile(autoexecPath, autoexecPlist, 0o644);
        }
        return {
            status: dryRun ? 'rendered' : 'installed',
            files: [path, ...(autoexecCommand ? [autoexecPath] : []), ...(unixController ? [unixController.command] : [])],
            service: 'launchd',
            ...(autoexecHome ? { autoexecHome } : {}),
        };
    }
    let path = expandHome('~/install-evolver-proxy-windows.ps1');
    let autoexecPath = expandHome('~/install-evolver-autoexec-windows.ps1');
    const selfUpdateStateDir = env['EVOLVER_SELF_UPDATE_STATE_DIR']?.trim();
    const standalone = standaloneTarget;
    const script = renderWindowsInstaller({
        ...(standalone ? { evolverBin: standalone } : {
            nodePath: resolveStableNodePath(),
            proxyBin: resolveProxyBinPath(),
        }),
        ...(envFile ? { envFile } : {}),
        lifecycleStateDir,
        ...(selfUpdateStateDir ? { selfUpdateStateDir } : {}),
    });
    if (!dryRun)
        path = writeWindowsHelper(path, script);
    if (autoexecCommand) {
        const standaloneAutoexec = autoexecCommand.args[0] === 'autoexec';
        const autoexecScript = renderWindowsAutoexecInstaller({
            ...(standaloneAutoexec
                ? { evolverBin: autoexecCommand.command }
                : { nodePath: autoexecCommand.command, cliBin: autoexecCommand.args[0] }),
            ...(envFile ? { envFile } : {}),
            ...(autoexecHome ? { autoexecHome } : {}),
            workingDirectory: companionWorkingDirectory,
        });
        if (!dryRun)
            autoexecPath = writeWindowsHelper(autoexecPath, autoexecScript);
    }
    return {
        status: dryRun ? 'rendered' : 'installed',
        files: [path, ...(autoexecCommand ? [autoexecPath] : [])],
        service: 'windows-scheduled-task',
        ...(autoexecHome ? { autoexecHome } : {}),
    };
}
function defaultBootstrapTarget(platform) {
    if (platform === 'darwin')
        return 'launchd';
    if (platform === 'win32')
        return 'windows';
    return 'systemd';
}
/**
 * First-run supervision bootstrap: render + write the durable launcher for the current platform
 * (reusing install-service), then ACTIVATE it (user-level, no admin required) and persist a
 * success marker the proxy consults before attempting another bootstrap. The generated launcher
 * carries the EVOLVER_SELF_UPDATE_SUPERVISOR attestation, so self-update becomes eligible on the
 * next supervised startup. Activation failures throw (fail closed) after a best-effort rollback of
 * the launcher artifacts, so a half-activated unit/agent/task never survives a failed bootstrap.
 */
async function bootstrapService(flags, env, argv1, deps, loadUnixRecoveryController) {
    if (flags['dry-run'] !== undefined && flags['dry-run'] !== true) {
        throw new Error('--dry-run is a boolean flag and does not accept a value');
    }
    const platform = deps.platform ?? process.platform;
    const target = typeof flags['target'] === 'string' ? serviceTarget(flags) : defaultBootstrapTarget(platform);
    const dryRun = flags['dry-run'] === true;
    if (platform !== 'win32') {
        const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (uid === 0) {
            throw new Error('bootstrap must run as a regular (non-root) user: the systemd --user manager and the launchd gui domain do not exist for root; install as your normal user and, on headless hosts, run `loginctl enable-linger` for that user');
        }
    }
    const install = deps.install ?? installService;
    const handedOffEnvFile = nonBlankEnv(env, BOOTSTRAP_ENV_FILE_HANDOFF);
    const installFlags = handedOffEnvFile && typeof flags['env-file'] !== 'string'
        ? { ...flags, 'env-file': handedOffEnvFile }
        : flags;
    const installed = await install(target, installFlags, env, argv1, loadUnixRecoveryController);
    const files = installed.files ?? [];
    if (dryRun) {
        return { status: 'planned', files, service: installed.service, actions: bootstrapActivationPlan(target, files, deps.uid) };
    }
    const run = deps.run ?? ((command, args) => {
        const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: 60_000, windowsHide: true });
        return { status: result.status, ...(result.error ? { error: result.error } : {}) };
    });
    const preExisting = probePreExistingBootstrapService(target, run, deps.uid);
    const markerPath = join(lifecyclePaths(env).stateDir, 'bootstrap.json');
    let actions;
    try {
        actions = activateBootstrapTarget(target, files, run, deps.uid);
    }
    catch (error) {
        const rollbackErrors = rollbackBootstrapArtifacts(target, files, run, deps.uid, preExisting);
        // Activation failed, so supervision was never established and any success marker left over
        // from a previous run is no longer true. Drop it (force, best-effort) so the proxy's
        // shouldBootstrap no longer reports already_bootstrapped for a broken install; a failure here
        // must not mask the original activation error.
        try {
            rmSync(markerPath, { force: true });
        }
        catch {
            // best-effort: a stale marker is less harmful than swallowing the activation error
        }
        const rollbackSuffix = rollbackErrors.length > 0 ? ` (rollback also failed: ${rollbackErrors.join('; ')})` : '';
        throw new Error(`${error.message}; launcher artifacts were rolled back${rollbackSuffix}`);
    }
    writeTextFile(markerPath, `${JSON.stringify({
        bootstrappedAt: new Date().toISOString(),
        target,
        service: installed.service,
        files,
    })}\n`, 0o600);
    return { status: 'bootstrapped', files: [...files, markerPath], service: installed.service, actions };
}
function bootstrapActivationPlan(target, files, uid) {
    if (target === 'systemd') {
        return [
            'systemctl --user daemon-reload',
            'systemctl --user enable --now evolver-proxy.service',
        ];
    }
    if (target === 'launchd') {
        const plist = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        return [`launchctl bootstrap gui/${uid ?? '<uid>'} ${plist}`];
    }
    const installer = files[0] ?? expandHome('~/install-evolver-proxy-windows.ps1');
    return [`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${installer} -Install`];
}
function activateBootstrapTarget(target, files, run, uid) {
    if (target === 'systemd') {
        requireBootstrapActivation(run('systemctl', ['--user', 'daemon-reload']), [0], 'reload systemd user manager');
        requireBootstrapActivation(run('systemctl', ['--user', 'enable', '--now', 'evolver-proxy.service']), [0], 'enable systemd user service', 'if no user session bus exists, run `loginctl enable-linger` and retry');
        return bootstrapActivationPlan(target, files, uid);
    }
    if (target === 'launchd') {
        const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (userId === undefined)
            throw new Error('cannot determine the current user id for launchd bootstrap');
        const plist = expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        // 3/113: already bootstrapped/loaded; 5: "Bootstrap failed: service already loaded". All three
        // mean an identical agent is already registered, so a re-bootstrap stays idempotent instead of
        // failing and rolling back a working install.
        requireBootstrapActivation(run('launchctl', ['bootstrap', `gui/${userId}`, plist]), [0, 3, 5, 113], 'bootstrap launchd agent', 'launchctl bootstrap gui/<uid> requires an active GUI (Aqua) login session; log in at the console (or retry after your next GUI login)');
        return [`launchctl bootstrap gui/${userId} ${plist}`];
    }
    const installer = files[0];
    if (!installer)
        throw new Error('bootstrap could not locate the generated Windows installer script');
    requireBootstrapActivation(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Install']), [0], 'register Windows scheduled task');
    return [`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${installer} -Install`];
}
function requireBootstrapActivation(result, allowedStatuses, operation, hint) {
    if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
        throw new Error(`bootstrap activation failed during ${operation}${hint ? ` (hint: ${hint})` : ''}`);
    }
}
/**
 * Best-effort probe for a same-name service registration that existed before this bootstrap run.
 * Only an unambiguous "not registered" exit status reports false; any error, inconclusive, or
 * loaded-looking outcome reports true, so a later rollback conservatively leaves an existing
 * registration intact instead of tearing down a working install. The probe must never block the
 * bootstrap itself.
 */
function probePreExistingBootstrapService(target, run, uid) {
    let result;
    let absentStatuses;
    try {
        if (target === 'systemd') {
            // 1: not enabled, 4: no such unit. A working install is enabled (exit 0).
            result = run('systemctl', ['--user', 'is-enabled', '--quiet', 'evolver-proxy.service']);
            absentStatuses = [1, 4];
        }
        else if (target === 'launchd') {
            const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
            if (userId === undefined)
                return true;
            // 3: no such service, 113: the gui domain itself is absent (nothing can be loaded there).
            result = run('launchctl', ['print', `gui/${userId}`, 'com.evomap.evolver-proxy']);
            absentStatuses = [3, 113];
        }
        else {
            // 1: Get-ScheduledTask raised because the task does not exist; 0 means it is registered.
            result = run('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                'Get-ScheduledTask -TaskName EvoMapEvolverProxyDaemon',
            ]);
            absentStatuses = [1];
        }
    }
    catch {
        return true;
    }
    if (result.error !== undefined || result.status === null)
        return true;
    return !absentStatuses.includes(result.status);
}
/**
 * Best-effort rollback of the launcher artifacts written before a failed activation. Every step
 * ignores its own failure (reported back to the caller instead of thrown), so the original
 * activation error always surfaces. Uses the injected `run` so tests can observe the sequence.
 * When the probe detected a pre-existing same-name registration, this rollback is a strict no-op:
 * no teardown command, no file deletion, not even a systemd daemon-reload. installService already
 * overwrote the canonical unit/plist/installer before the probe could run, so the on-disk content
 * is inevitably the new rendering; deleting it would orphan a still-running service (no on-disk
 * definition, so it would stop auto-loading after a reboot), which is strictly worse than leaving
 * the updated content in place. The working install must survive a failed re-bootstrap untouched.
 */
function rollbackBootstrapArtifacts(target, files, run, uid, preExisting = false) {
    const errors = [];
    if (preExisting)
        return errors;
    const attempt = (label, action) => {
        try {
            action();
        }
        catch (error) {
            errors.push(`${label}: ${error.message}`);
        }
    };
    const removeFile = (file) => attempt(`remove ${file}`, () => { rmSync(file, { force: true }); });
    if (target === 'systemd') {
        attempt('disable systemd user service', () => { run('systemctl', ['--user', 'disable', '--now', 'evolver-proxy.service']); });
        const unit = files.find((file) => basename(file) === 'evolver-proxy.service');
        if (unit)
            removeFile(unit);
        attempt('reload systemd user manager', () => { run('systemctl', ['--user', 'daemon-reload']); });
        return errors;
    }
    if (target === 'launchd') {
        const plist = files.find((file) => file.endsWith('.plist')) ?? expandHome('~/Library/LaunchAgents/com.evomap.evolver-proxy.plist');
        const userId = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        if (userId !== undefined) {
            attempt(`bootout launchd agent gui/${userId}`, () => { run('launchctl', ['bootout', `gui/${userId}`, plist]); });
        }
        removeFile(plist);
        return errors;
    }
    const installer = files[0];
    if (installer) {
        attempt('unregister Windows scheduled task', () => {
            run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Uninstall']);
        });
    }
    for (const file of files)
        removeFile(file);
    return errors;
}
export function removeAutoexecService(target, dryRun, deps = {}) {
    const paths = {
        systemd: expandHome('~/.config/systemd/user/evolver-autoexec.service'),
        launchd: expandHome('~/Library/LaunchAgents/com.evomap.evolver-autoexec.plist'),
        windows: expandHome('~/install-evolver-autoexec-windows.ps1'),
    };
    const configuredPath = deps.paths?.[target] ?? paths[target];
    const path = target === 'windows' && !dryRun ? randomWindowsHelperPath(configuredPath) : configuredPath;
    const run = deps.run ?? ((command, args) => {
        const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
        return { status: result.status, ...(result.error ? { error: result.error } : {}) };
    });
    const exists = deps.exists ?? existsSync;
    const remove = deps.remove ?? ((file) => { rmSync(file, { force: true }); });
    const write = deps.write ?? ((file, content, mode) => {
        writeTextFile(file, content, mode, 'wx');
    });
    if (target === 'systemd') {
        const actions = [
            'systemctl --user disable --now evolver-autoexec.service',
            `remove ${path}`,
            'systemctl --user daemon-reload',
        ];
        if (dryRun)
            return { status: 'planned', files: [path], service: 'systemd-user', actions };
        const active = requireServiceControlStatus(run('systemctl', ['--user', 'is-active', '--quiet', 'evolver-autoexec.service']), [0, 3, 4], 'inspect systemd autoexec activity');
        const enabled = requireServiceControlStatus(run('systemctl', ['--user', 'is-enabled', '--quiet', 'evolver-autoexec.service']), [0, 1, 4], 'inspect systemd autoexec enablement');
        const hasUnit = exists(path);
        if (active !== 0 && enabled !== 0 && !hasUnit) {
            return { status: 'absent', files: [path], service: 'systemd-user', actions: [] };
        }
        requireServiceControlStatus(run('systemctl', ['--user', 'disable', '--now', 'evolver-autoexec.service']), [0], 'disable systemd autoexec service');
        if (hasUnit)
            remove(path);
        requireServiceControlStatus(run('systemctl', ['--user', 'daemon-reload']), [0], 'reload systemd user services');
        return { status: 'removed', files: [path], service: 'systemd-user', actions };
    }
    if (target === 'launchd') {
        const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
        const launchdTarget = `gui/${uid ?? '<uid>'}/${AUTOEXEC_LABEL}`;
        const actions = [`launchctl bootout ${launchdTarget}`, `remove ${path}`];
        if (dryRun)
            return { status: 'planned', files: [path], service: 'launchd', actions };
        if (uid === undefined)
            throw new Error('cannot determine the current user id for launchd autoexec removal');
        requireServiceControlStatus(run('launchctl', ['bootout', `gui/${uid}/${AUTOEXEC_LABEL}`]), [0, 3, 113], 'boot out launchd autoexec service');
        const hasPlist = exists(path);
        if (hasPlist)
            remove(path);
        return {
            status: hasPlist ? 'removed' : 'absent',
            files: [path],
            service: 'launchd',
            actions: hasPlist ? actions : actions.slice(0, 1),
        };
    }
    const actions = [
        `write ${path}`,
        `powershell.exe -File ${path} -Uninstall`,
        `remove ${path}`,
    ];
    if (dryRun)
        return { status: 'planned', files: [path], service: 'windows-scheduled-task', actions };
    write(path, renderWindowsAutoexecInstaller(), 0o644);
    requireServiceControlStatus(run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path,
        '-Uninstall',
    ]), [0], 'uninstall Windows autoexec scheduled task');
    remove(path);
    return { status: 'removed', files: [path], service: 'windows-scheduled-task', actions };
}
function requireServiceControlStatus(result, allowedStatuses, operation) {
    if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
        throw new Error(`${operation} failed; companion artifact was retained`);
    }
    return result.status;
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
export function resolveAutoexecDaemonCommand(env, execPath = process.execPath, argv1 = process.argv[1], autoexecHome) {
    const target = configuredSelfUpdateTarget(env);
    const proxyCommand = target
        ? standaloneProxyCommand(target)
        : resolveSelfUpdatingExecutable(execPath, argv1);
    if (!proxyCommand || proxyCommand.args.at(-1) !== 'proxy')
        return undefined;
    const args = [...proxyCommand.args.slice(0, -1), 'autoexec'];
    const home = autoexecHome?.trim();
    if (home)
        args.push(home);
    return {
        command: proxyCommand.command,
        args,
        display: [proxyCommand.command, ...args].join(' '),
    };
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
function pidFileRecordMatchesProcess(pidFile, readCommandLine = processCommandLine, readIdentity = processIdentity, platform = process.platform) {
    if (!pidFile.owned || !pidFile.record)
        return false;
    const record = pidFile.record;
    const commandLine = readCommandLine(record.pid);
    const commandMatches = Boolean(commandLine
        && commandLine.includes(basename(record.command))
        && record.args.every((arg) => commandLine.includes(arg)));
    const identity = readIdentity(record.pid);
    if (commandLine?.includes(basename(record.command))) {
        if (!commandMatches)
            return false;
        if (identity !== undefined)
            return processIdentityMatchesRecord(record, identity);
        return platform !== 'win32';
    }
    return processIdentityMatchesRecord(record, identity);
}
function waitForPidFileRecordMatch(pidFile, timeoutMs, readCommandLine = processCommandLine, readIdentity = processIdentity, platform = process.platform) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity, platform))
            return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return pidFileRecordMatchesProcess(pidFile, readCommandLine, readIdentity, platform);
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
function randomWindowsHelperPath(preferredPath) {
    const extension = extname(preferredPath) || '.ps1';
    const stem = basename(preferredPath, extension);
    return join(dirname(preferredPath), `${stem}-${randomUUID()}${extension}`);
}
function writeWindowsHelper(preferredPath, content) {
    try {
        writeTextFile(preferredPath, content, 0o600, 'wx');
        return preferredPath;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const fallbackPath = randomWindowsHelperPath(preferredPath);
    writeTextFile(fallbackPath, content, 0o600, 'wx');
    return fallbackPath;
}
export const _writeWindowsHelperForTest = writeWindowsHelper;
function writeTextFile(path, content, mode = 0o600, flag = 'w') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode, flag });
}
function assertSingleLine(value, label) {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f)
            throw new Error(`${label} must not contain control characters`);
    }
    return value;
}
function escapeSystemdPercent(value) {
    return value.replaceAll('%', '%%');
}
function escapeXml(value) {
    return assertSingleLine(value, 'launchd value')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
function escapeSystemdEnvValue(value) {
    return assertSingleLine(value, 'systemd environment value')
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('$', '\\$')
        .replaceAll('%', '%%');
}
function quoteSystemdArg(value) {
    const safe = assertSingleLine(value, 'systemd argument');
    return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(safe)
        ? safe
        : `"${safe.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}
function resolveCurrentCliPath() {
    return fileURLToPath(new URL('./cli.js', import.meta.url));
}