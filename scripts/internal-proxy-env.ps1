param(
  [string]$Settings = "$HOME\.evolver\settings.json",
  [switch]$PrintSensitiveEnv
)

function Test-NonEmptyString($Value) {
  return ($Value -is [string]) -and (-not [string]::IsNullOrWhiteSpace($Value))
}

function Warn-ExistingAnthropicApiKey {
  if (Test-NonEmptyString $env:ANTHROPIC_API_KEY) {
    Write-Warning 'ANTHROPIC_API_KEY is already set in this PowerShell session; internal-proxy-env.ps1 does not overwrite it.'
  }
}

$settingsJson = Get-Content -Raw -Path $Settings | ConvertFrom-Json
$proxy = $settingsJson.proxy
if ((-not (Test-NonEmptyString $proxy.url)) -or (-not (Test-NonEmptyString $proxy.token))) {
  throw 'no active string proxy.url/proxy.token in settings'
}

Warn-ExistingAnthropicApiKey
$proxyUrl = $proxy.url.TrimEnd('/')
$proxyToken = $proxy.token
$env:ANTHROPIC_BASE_URL = "$proxyUrl/v1"
$env:ANTHROPIC_AUTH_TOKEN = $proxyToken

if ($PrintSensitiveEnv) {
  Write-Output "`$env:ANTHROPIC_BASE_URL = '$($env:ANTHROPIC_BASE_URL)'"
  Write-Output "`$env:ANTHROPIC_AUTH_TOKEN = '$proxyToken'"
} else {
  Write-Host "EvoMap Proxy environment applied for $proxyUrl"
}
