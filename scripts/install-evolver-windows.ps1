param(
  [ValidateSet('metadata', 'full', 'off')]
  [string]$TraceMode = 'metadata',
  [string]$TraceFile = "$env:LOCALAPPDATA\EvoMap\proxy-traces.jsonl"
)

$launcherDir = Join-Path $env:LOCALAPPDATA 'EvoMap'
$launcherDir = Join-Path $launcherDir 'Evolver'
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
$launcherPath = Join-Path $launcherDir 'evolver-loop.vbs'

$traceModeEsc = $TraceMode.Replace('"', '""')
$traceFileEsc = $TraceFile.Replace('"', '""')
$node = (Get-Command node).Source.Replace('"', '""')
$index = "$PSScriptRoot\..\index.js".Replace('"', '""')

$launcherBody = @"
Set WshShell = CreateObject("WScript.Shell")
Set env = WshShell.Environment("PROCESS")
env("EVOMAP_PROXY") = "1"
env("EVOMAP_PROXY_TRACE") = "$traceModeEsc"
env("EVOMAP_PROXY_TRACE_FILE") = "$traceFileEsc"
cmd = """$node"" ""$index"" --loop"
result = WshShell.Run(cmd, 0, True)
"@
Set-Content -Path $launcherPath -Value $launcherBody -Encoding Unicode

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcherPath`""
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'EvoMap Evolver' -Action $action -Settings $settings -Force | Out-Null
Write-Host "Installed EvoMap Evolver scheduled task."
