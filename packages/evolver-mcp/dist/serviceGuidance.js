export const SERVICE_TARGETS = ['launchd', 'systemd', 'windows', 'compose', 'k8s'];
const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
const execParts = (exec) => [exec.command, ...(exec.args ?? [])];
const cmdLine = (exec) => execParts(exec).map(quotePosix).join(' ');
const envPathOf = (ctx) => ctx.envFile ?? ctx.exec.env?.[ENV_FILE_KEY] ?? '<path-to-evolver.env>';
/**
 * Render a service template for `target`. Print-only; the operator edits + installs it. Each template wires the
 * credential store via the EVOLVER_ENV_FILE pointer (never inlines a secret) and runs the given evolver command.
 */
export function renderServiceGuidance(target, ctx) {
    const cmd = cmdLine(ctx.exec);
    const ef = envPathOf(ctx);
    switch (target) {
        case 'systemd':
            return [
                '# Linux systemd user unit — ~/.config/systemd/user/evolver-proxy.service',
                '[Unit]',
                'Description=EvoMap Evolver Proxy Daemon',
                'After=network-online.target',
                'Wants=network-online.target',
                'StartLimitBurst=5',
                'StartLimitIntervalSec=120s',
                '',
                '[Service]',
                'Type=simple',
                `Environment="${ENV_FILE_KEY}=${escapeSystemdEnvValue(ef)}"`,
                `ExecStart=${execParts(ctx.exec).map(quoteSystemdArg).join(' ')}`,
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
                '# then: systemctl --user daemon-reload && systemctl --user enable --now evolver-proxy',
                `# ${ENV_FILE_KEY} is a pointer to the credential store; never inline secret values in this unit.`,
            ].join('\n');
        case 'launchd':
            return [
                '<!-- macOS launchd — ~/Library/LaunchAgents/com.evomap.evolver-proxy.plist -->',
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
                '<plist version="1.0">',
                '<dict>',
                '  <key>Label</key>',
                '  <string>com.evomap.evolver-proxy</string>',
                '  <key>EnvironmentVariables</key>',
                '  <dict>',
                `    <key>${ENV_FILE_KEY}</key>`,
                `    <string>${escapeXml(ef)}</string>`,
                '    <key>PATH</key>',
                '    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
                '  </dict>',
                '  <key>ProgramArguments</key>',
                '  <array>',
                ...execParts(ctx.exec).map((a) => `    <string>${escapeXml(a)}</string>`),
                '  </array>',
                '  <key>RunAtLoad</key>',
                '  <true/>',
                '  <key>KeepAlive</key>',
                '  <dict>',
                '    <key>SuccessfulExit</key>',
                '    <false/>',
                '  </dict>',
                '  <key>ThrottleInterval</key>',
                '  <integer>5</integer>',
                '  <key>ProcessType</key>',
                '  <string>Standard</string>',
                '</dict>',
                '</plist>',
                '',
                '# then: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evomap.evolver-proxy.plist',
                `# (the pointer ${ENV_FILE_KEY}=${ef} references the credential store; never inline secrets)`,
            ].join('\n');
        case 'windows':
            return [
                '# Windows Task Scheduler — hidden wscript.exe launcher; do not use a foreground command wrapper',
                '$launcher = "$env:LOCALAPPDATA\\EvoMap\\evolver-proxy-task-launcher.vbs"',
                '$dir = Split-Path -Parent $launcher',
                'if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }',
                '$body = @\'',
                "' AUTO-GENERATED; wscript.exe runs without a visible console window.",
                'Dim WshShell, env, cmd, rc',
                'Set WshShell = CreateObject("WScript.Shell")',
                'Set env = WshShell.Environment("PROCESS")',
                `env("${ENV_FILE_KEY}") = ${vbsString(ef)}`,
                `cmd = ${vbsString(windowsCommandLine(ctx.exec))}`,
                'rc = WshShell.Run(cmd, 0, True)',
                'WScript.Quit rc',
                "'@",
                'Set-Content -Path $launcher -Value $body -Encoding Unicode',
                'schtasks /Create /TN EvoMapEvolverProxyDaemon /TR "wscript.exe ""%LOCALAPPDATA%\\EvoMap\\evolver-proxy-task-launcher.vbs""" /SC ONLOGON /RL LIMITED /F',
                `# The VBS sets only the ${ENV_FILE_KEY} pointer; the credential store stays out of the task definition.`,
            ].join('\n');
        case 'compose':
            return [
                '# docker compose — mount the credential store as a file and point EVOLVER_ENV_FILE at it (do NOT bake secrets into the image/env)',
                'services:',
                '  evolver:',
                '    image: <your-evolver-image>',
                `    command: ${cmd}`,
                '    environment:',
                `      ${ENV_FILE_KEY}: /run/secrets/evolver_env   # pointer to the mounted store`,
                '    secrets:',
                '      - evolver_env',
                '    restart: on-failure',
                'secrets:',
                '  evolver_env:',
                `    file: ${ef}   # the real credential store, mounted at /run/secrets/evolver_env`,
            ].join('\n');
        case 'k8s':
            return [
                '# Kubernetes — keep creds in a Secret, mount it as a file, point EVOLVER_ENV_FILE at the mount (never inline in env)',
                'apiVersion: apps/v1',
                'kind: Deployment',
                'metadata: { name: evolver }',
                'spec:',
                '  replicas: 1',
                '  selector: { matchLabels: { app: evolver } }',
                '  template:',
                '    metadata: { labels: { app: evolver } }',
                '    spec:',
                '      containers:',
                '        - name: evolver',
                '          image: <your-evolver-image>',
                `          command: [${[ctx.exec.command, ...(ctx.exec.args ?? [])].map((a) => `"${a}"`).join(', ')}]`,
                `          env: [{ name: ${ENV_FILE_KEY}, value: /etc/evolver/evolver.env }]   # pointer to the mounted secret`,
                '          volumeMounts: [{ name: evolver-env, mountPath: /etc/evolver, readOnly: true }]',
                '      volumes:',
                `        - name: evolver-env`,
                `          secret: { secretName: evolver-env }   # create from your store: kubectl create secret generic evolver-env --from-file=evolver.env=${ef}`,
            ].join('\n');
        default: {
            const _exhaustive = target;
            throw new Error(`unknown service target: ${String(_exhaustive)}`);
        }
    }
}
function quotePosix(value) {
    return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
function quoteSystemdArg(value) {
    return /^[A-Za-z0-9_/:.@%+=,-]+$/.test(value)
        ? value
        : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}
function escapeSystemdEnvValue(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$');
}
function escapeXml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
function windowsCommandLine(exec) {
    return execParts(exec).map((part) => `"${part.replaceAll('"', '""')}"`).join(' ');
}
function vbsString(value) {
    return `"${value.replaceAll('"', '""')}"`;
}