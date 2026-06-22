'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('proxy trace platform install templates', () => {
  it('enables proxy trace in the Linux systemd user unit template', () => {
    const service = readRepoFile('scripts/evolver.service');
    assert.match(service, /Environment=EVOMAP_PROXY=1/);
    assert.match(service, /Environment=EVOMAP_PROXY_TRACE=metadata/);
    assert.match(service, /Environment=EVOMAP_PROXY_TRACE_FILE=%h\/\.local\/state\/evomap\/proxy-traces\.jsonl/);
    assert.match(service, /proxy_trace_failed_once/);
    assert.match(service, /StandardOutput=journal/);
    assert.match(service, /StandardError=journal/);
    assert.doesNotMatch(service, /controlling terminal/);
  });

  it('arms systemd notify/watchdog even in EVOMAP_PROXY mode', () => {
    const index = readRepoFile('index.js');
    const a2a = require('../src/gep/a2aProtocol');
    const lifecycle = readRepoFile('src/proxy/lifecycle/manager.js');
    assert.match(index, /startProxy\(\{[\s\S]*?registerMailboxTransport\(\)[\s\S]*?startSystemdNotifyWatchdog/);
    assert.equal(typeof a2a.startSystemdNotifyWatchdog, 'function');
    assert.equal(typeof a2a._sdNotify, 'function');
    assert.match(lifecycle, /getHeartbeatStats\(\)[\s\S]*?intervalMs:[\s\S]*?lastTickAt:/);
  });

  it('does not mask stopped hub-backed lifecycle stats behind the systemd watchdog fallback', () => {
    const index = readRepoFile('index.js');
    assert.match(index, /const proxy = proxyInfo && proxyInfo\.proxy;[\s\S]*?const lifecycle = proxy && proxy\.lifecycle;/);
    assert.match(index, /if \(stats && \(stats\.running \|\| proxy\.hubUrl\)\) return stats;/);
    assert.doesNotMatch(index, /if \(stats && stats\.running\) return stats;/);
  });

  it('bakes process-local proxy trace env into the Windows launcher', () => {
    const installer = readRepoFile('scripts/install-evolver-windows.ps1');
    assert.match(installer, /\[ValidateSet\('metadata', 'full', 'off'\)\]/);
    assert.match(installer, /env\("EVOMAP_PROXY"\) = "1"/);
    assert.match(installer, /env\("EVOMAP_PROXY_TRACE"\) = "\$traceModeEsc"/);
    assert.match(installer, /env\("EVOMAP_PROXY_TRACE_FILE"\) = "\$traceFileEsc"/);
    assert.match(installer, /Join-Path \$launcherDir 'Evolver'/);
    assert.match(installer, /RestartCount 5/);
  });

  it('registers the Windows daemon through a hidden wscript launcher', () => {
    const installer = readRepoFile('scripts/install-evolver-windows.ps1');
    const taskStart = installer.indexOf('$action = New-ScheduledTaskAction');
    const taskEnd = installer.indexOf('$settings = New-ScheduledTaskSettingsSet');
    assert.notEqual(taskStart, -1);
    assert.notEqual(taskEnd, -1);
    const taskAction = installer.slice(taskStart, taskEnd);
    assert.match(taskAction, /-Execute 'wscript\.exe'/);
    assert.match(installer, /WshShell\.Run\(cmd, 0, True\)/);
    assert.doesNotMatch(taskAction, /powershell\.exe/i);
    assert.doesNotMatch(taskAction, /cmd\.exe/i);
  });

  it('keeps the macOS LaunchAgent detached from Terminal apps', () => {
    const plist = readRepoFile('scripts/com.evomap.evolver.plist');
    assert.match(plist, /<key>ProgramArguments<\/key>[\s\S]*?<string>\/usr\/local\/bin\/node<\/string>[\s\S]*?<string>--loop<\/string>/);
    assert.match(plist, /<key>StandardOutPath<\/key>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>/);
    assert.doesNotMatch(plist, /Terminal|iTerm|osascript|open -a/);
  });

  it('writes the Windows VBS launcher with a Unicode-safe encoding', () => {
    const installer = readRepoFile('scripts/install-evolver-windows.ps1');
    assert.match(installer, /Set-Content -Path \$launcherPath -Value \$launcherBody -Encoding Unicode/);
    assert.doesNotMatch(installer, /Set-Content -Path \$launcherPath -Value \$launcherBody -Encoding ASCII/);
  });

  it('provides a Windows client helper that does not print the token by default', () => {
    const helper = readRepoFile('scripts/internal-proxy-env.ps1');
    assert.match(helper, /\$env:ANTHROPIC_AUTH_TOKEN = \$proxyToken/);
    assert.match(helper, /\[switch\]\$PrintSensitiveEnv/);
    assert.doesNotMatch(helper, /\[Alias\('Print'\)\]/);
    assert.doesNotMatch(helper, /-Print \| Invoke-Expression/);
    assert.match(helper, /if \(\$PrintSensitiveEnv\)/);
    assert.match(helper, /Write-Host "EvoMap Proxy environment applied/);
    assert.doesNotMatch(helper, /Write-Host .*proxyToken/);
  });

  it('requires proxy.url and proxy.token to be non-empty strings in the Windows helper', () => {
    const helper = readRepoFile('scripts/internal-proxy-env.ps1');
    assert.match(helper, /function Test-NonEmptyString/);
    assert.match(helper, /\$Value -is \[string\]/);
    assert.match(helper, /\[string\]::IsNullOrWhiteSpace\(\$Value\)/);
    assert.match(helper, /Test-NonEmptyString \$proxy\.url/);
    assert.match(helper, /Test-NonEmptyString \$proxy\.token/);
    assert.match(helper, /no active string proxy\.url\/proxy\.token/);
  });

  it('warns when ANTHROPIC_API_KEY already exists in the current PowerShell session', () => {
    const helper = readRepoFile('scripts/internal-proxy-env.ps1');
    assert.match(helper, /function Warn-ExistingAnthropicApiKey/);
    assert.match(helper, /Test-NonEmptyString \$env:ANTHROPIC_API_KEY/);
    assert.match(helper, /Write-Warning 'ANTHROPIC_API_KEY is already set in this PowerShell session/);
    assert.match(helper, /does not overwrite it/);
  });
});
