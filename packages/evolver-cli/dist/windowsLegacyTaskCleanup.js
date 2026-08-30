/**
 * Safe cleanup of legacy V1 Windows scheduled-task residue (#956).
 *
 * Issue #956 reports that some historical V1 builds may have registered
 * `EvoMapEvolverProxyDaemon` / `EvoMapEvolverAutoexecDaemon` as scheduled tasks whose action
 * invoked `powershell.exe` / `node.exe` DIRECTLY (the console window flashes at logon before
 * `-WindowStyle Hidden` takes effect, and once the pointed-at binary is gone the task fails
 * and retries `RestartCount` times). V2 registers the same
 * names through a hidden `wscript.exe` VBS launcher — currently via the ABSOLUTE trusted
 * path `<SystemRoot>\System32\wscript.exe` written by the bootstrap transaction, and in
 * older v2 generations via the bare `wscript.exe` name (handled by the existing legacy
 * adoption path, NOT by this module).
 *
 * This module is a destructive migration and obeys the lifecycle authority contract:
 *
 * - Fingerprint, not name match: a task can be removed only after an authoritative V1
 *   registration template and launcher/generation evidence have proved that it is residue.
 *   The repository currently carries no such evidence. Therefore a complete direct-action
 *   shape (`powershell.exe` or `node.exe`) is deliberately classified as `ambiguous` and
 *   refused; every missing, ambiguous, or otherwise unproven field fails closed
 *   (`inconclusive`). The current v2 absolute `wscript.exe` binding and older bare-`wscript`
 *   generations are kept. This module never deletes on a first-match, name-only, or
 *   shape-only basis.
 * - Revalidation: the fingerprint is re-verified immediately before unregister, and again
 *   after stop, inside the mutation script (mirroring the bootstrap rollback unregister
 *   pattern); a task replaced between probe and mutation is left untouched.
 * - Authority: mutation runs under the bootstrap owner lock (or an `assertOwner` seam held
 *   by the bootstrap transaction itself), so it cannot race a concurrent bootstrap.
 * - Durable preimage: the task XML (Export-ScheduledTask) is persisted owner-only/atomic in
 *   the lifecycle state dir BEFORE any stop/unregister, and `--restore=<preimage>` can
 *   re-register it.
 * - Trusted executable: every PowerShell invocation uses the absolute
 *   `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` path; never a PATH lookup.
 * - Honest status: `clean` / `legacy_detected` / `cleaned` / `inconclusive` / `failed` /
 *   `skipped` are never collapsed into each other. A failed or inconclusive run is never
 *   reported as `clean`; the automatic SessionStart sweep records it in a negative
 *   backoff marker (1h base, doubling per consecutive failure, capped at 24h) so a
 *   constrained host does not re-probe on every session, and a conclusive success
 *   overwrites it, resetting the counter. The manual command exits non-zero for it.
 *   Diagnostics carry task names and bounded reasons only — never raw
 *   PowerShell output, absolute paths, or exceptions.
 */
import { randomUUID, verify as verifySignature } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { ops as coreOps } from '@evomap/evolver-core';
import { lifecyclePaths, trustedWindowsPowerShell } from './lifecycle.js';
import { acquireBootstrapOwnerLock, assertTrustedArtifactParent, removeDurableFile, readBootstrapArtifactFile, writeDurableText, } from './lifecycleBootstrapTransaction.js';
/** The only task names this module ever probes; nothing outside this set is ever touched. */
export const LEGACY_WINDOWS_TASK_NAMES = [
    'EvoMapEvolverProxyDaemon',
    'EvoMapEvolverAutoexecDaemon',
];
/** Direct-action leaves that require unavailable V1 provenance before any cleanup. */
const LEGACY_ACTION_EXECUTABLE_LEAVES = new Set(['powershell.exe', 'node.exe']);
/** `wscript.exe` leaf (any path form) identifies v2 generations — current or legacy v2. */
const V2_ACTION_EXECUTABLE_LEAF = 'wscript.exe';
const PROBE_TIMEOUT_MS = 20_000;
const EXPORT_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 40_000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const MAX_PREIMAGE_BYTES = 512 * 1024;
const MAX_COOLDOWN_MARKER_BYTES = 4096;
export const LEGACY_TASK_SKIP_ENV = 'EVOLVER_SKIP_LEGACY_TASK_PROBE';
export const LEGACY_TASK_COOLDOWN_FILE = 'legacy-task-cleanup.json';
export const LEGACY_TASK_PREIMAGE_DIR = 'legacy-task-preimages';
export const LEGACY_TASK_PROVENANCE_FILE = 'legacy-task-provenance.json';
export const LEGACY_TASK_PROVENANCE_PUBLIC_KEY_ENV = 'EVOLVER_LEGACY_TASK_PROVENANCE_PUBLIC_KEY';
export const LEGACY_TASK_PROVENANCE_SCHEMA = 'evolver/windows-legacy-task-provenance/v1';
export const LEGACY_TASK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Negative backoff for inconclusive/failed sweeps: 1h base, doubling, capped at 24h. */
const LEGACY_TASK_NEGATIVE_BACKOFF_BASE_MS = 60 * 60 * 1000;
const LEGACY_TASK_NEGATIVE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MARKER_SCHEMA = 'evolver/legacy-task-cleanup/v1';
function defaultLegacyTaskRun() {
    const powershell = trustedWindowsPowerShell();
    return (command, args, timeoutMs) => {
        if (command !== powershell) {
            return { status: null, error: new Error('legacy task probe refused a non-trusted executable') };
        }
        const result = spawnSync(command, [...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: timeoutMs,
            windowsHide: true,
        });
        return {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
            ...(typeof result.stderr === 'string' ? { stderr: result.stderr } : {}),
        };
    };
}
function powershellArgs(script) {
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}
function boundedDetail(value, max = 240) {
    const text = (value instanceof Error ? value.message : String(value))
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        // Diagnostic text can contain file:// or http(s):// URLs whose host, port, query,
        // and path are all potentially sensitive. Redact the complete token before the
        // platform-specific forms below so the slash after a URI scheme cannot leak a path.
        .replace(/\b(?:file|https?):\/\/[^"'<>|\r\n]+/gi, '[redacted-path]')
        // Paths may contain spaces; consume through the next quote/control delimiter rather than
        // stopping at the first whitespace and leaking the remainder of the path.
        .replace(/\b[A-Za-z]:[\\/][^"'<>|\r\n]+/g, '[redacted-path]')
        .replace(/(^|[\s("'=:])\\\\[^"'<>|\r\n]+/g, '$1[redacted-path]')
        .replace(/(^|[\s("'=:])\/[^"'<>|\r\n]+/g, '$1[redacted-path]')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** Normalize the scheduler's case-insensitive SHA-256 representation before embedding it. */
function normalizeDefinitionHash(value) {
    if (value === undefined)
        return undefined;
    const normalized = value.toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}
const LEGACY_TASK_PROVENANCE_KEYS = [
    'schema', 'taskName', 'taskPath', 'definitionHash', 'principalSid', 'issuedAt', 'expiresAt', 'signatureAlg', 'signature',
];
const LEGACY_TASK_PROVENANCE_BUNDLE_KEYS = ['schema', 'receipts'];
function hasOnlyKeys(value, allowed, required) {
    const keys = Object.keys(value);
    return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
export function canonicalLegacyTaskProvenanceBytes(payload) {
    const canonical = {
        schema: LEGACY_TASK_PROVENANCE_SCHEMA,
        taskName: payload.taskName,
        taskPath: '\\',
        definitionHash: payload.definitionHash.toLowerCase(),
        principalSid: payload.principalSid,
        issuedAt: payload.issuedAt,
        ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
        signatureAlg: 'ed25519',
    };
    return Buffer.from(JSON.stringify(canonical), 'utf8');
}
function parseLegacyTaskProvenanceReceipt(value, publicKey, now) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    if (!hasOnlyKeys(raw, LEGACY_TASK_PROVENANCE_KEYS, [
        'schema', 'taskName', 'taskPath', 'definitionHash', 'principalSid', 'issuedAt', 'signatureAlg', 'signature',
    ]))
        return undefined;
    if (raw.schema !== LEGACY_TASK_PROVENANCE_SCHEMA
        || typeof raw.taskName !== 'string'
        || !LEGACY_WINDOWS_TASK_NAMES.includes(raw.taskName)
        || raw.taskPath !== '\\'
        || typeof raw.definitionHash !== 'string'
        || normalizeDefinitionHash(raw.definitionHash) === undefined
        || typeof raw.principalSid !== 'string'
        || !/^S-\d-\d+(?:-\d+){1,15}$/.test(raw.principalSid)
        || typeof raw.issuedAt !== 'string'
        || !Number.isFinite(Date.parse(raw.issuedAt))
        || raw.signatureAlg !== 'ed25519'
        || typeof raw.signature !== 'string')
        return undefined;
    if (raw.expiresAt !== undefined
        && (typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= now)) {
        return undefined;
    }
    const signature = Buffer.from(raw.signature, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== raw.signature)
        return undefined;
    const payload = {
        schema: LEGACY_TASK_PROVENANCE_SCHEMA,
        taskName: raw.taskName,
        taskPath: '\\',
        definitionHash: normalizeDefinitionHash(raw.definitionHash),
        principalSid: raw.principalSid,
        issuedAt: raw.issuedAt,
        ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {}),
        signatureAlg: 'ed25519',
    };
    try {
        const key = coreOps.toPublicKey(publicKey);
        if (!verifySignature(null, canonicalLegacyTaskProvenanceBytes(payload), key, signature))
            return undefined;
    }
    catch {
        return undefined;
    }
    return { ...payload, signature: raw.signature };
}
function loadLegacyTaskProvenance(stateDir, env, now) {
    const path = join(stateDir, LEGACY_TASK_PROVENANCE_FILE);
    // 缺少 provenance 是正常的 fail-closed 状态。先探测叶节点，避免调用方只提供尚未创建的
    // state directory 时被错误报告为 receipt 不可读。
    try {
        lstatSync(path);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { receipts: new Map() };
        return { receipts: new Map(), detail: 'legacy task provenance receipt is unreadable' };
    }
    let bytes;
    try {
        assertLegacyStateArtifactPath(path);
        bytes = readBootstrapArtifactFile(path, MAX_COOLDOWN_MARKER_BYTES * 8, { role: 'owned' }).bytes;
    }
    catch {
        return { receipts: new Map(), detail: 'legacy task provenance receipt is unreadable' };
    }
    const publicKey = env[LEGACY_TASK_PROVENANCE_PUBLIC_KEY_ENV]?.trim();
    if (!publicKey)
        return { receipts: new Map(), detail: `${LEGACY_TASK_PROVENANCE_PUBLIC_KEY_ENV} is not configured` };
    let parsed;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        return { receipts: new Map(), detail: 'legacy task provenance receipt is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { receipts: new Map(), detail: 'legacy task provenance receipt has an invalid shape' };
    }
    const bundle = parsed;
    if (!hasOnlyKeys(bundle, LEGACY_TASK_PROVENANCE_BUNDLE_KEYS, ['schema', 'receipts'])
        || bundle.schema !== LEGACY_TASK_PROVENANCE_SCHEMA
        || !Array.isArray(bundle.receipts)
        || bundle.receipts.length > LEGACY_WINDOWS_TASK_NAMES.length) {
        return { receipts: new Map(), detail: 'legacy task provenance receipt has an invalid shape' };
    }
    const receipts = new Map();
    for (const candidate of bundle.receipts) {
        const receipt = parseLegacyTaskProvenanceReceipt(candidate, publicKey, now);
        if (!receipt || receipts.has(receipt.taskName)) {
            return { receipts: new Map(), detail: 'legacy task provenance receipt failed signature or identity validation' };
        }
        receipts.set(receipt.taskName, receipt);
    }
    return { receipts };
}
/** True when the automatic entry points must never cross the Task Scheduler boundary. */
export function legacyTaskProbeSkipped(env) {
    const value = env[LEGACY_TASK_SKIP_ENV]?.trim();
    return value !== undefined && value !== '' && value !== '0';
}
/**
 * The probe script emits one JSON record per known task name. It only READS the Task
 * Scheduler; names are compile-time constants, so no interpolation ever reaches it.
 *
 * Enumeration note: every script below enumerates with `-TaskPath '\*'` (a LIKE query)
 * rather than the exact key `'\'` — the exact-key query throws
 * CmdletizationQuery_NotFound_TaskPath when the root folder holds ZERO tasks (a clean
 * host), while the LIKE form returns an empty set. `-ErrorAction Stop` is kept on every
 * call so genuine scheduler faults still fail closed. Root-only semantics are preserved
 * by an explicit `$_.TaskPath -eq '\'` filter on every enumeration.
 */
const PROBE_SCRIPT = `$ErrorActionPreference = 'Stop'
$names = @(${LEGACY_WINDOWS_TASK_NAMES.map((name) => `'${name}'`).join(', ')})
$results = foreach ($name in $names) {
  $tasks = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq $name })
  if ($tasks.Count -eq 0) { [pscustomobject]@{ name = $name; present = $false; count = 0 } }
  elseif ($tasks.Count -ne 1) { [pscustomobject]@{ name = $name; present = $true; ambiguous = $true; count = $tasks.Count } }
  else {
    $task = $tasks[0]
    $actions = if ($null -eq $task.Actions) { $null } else { @($task.Actions) }
    $triggers = if ($null -eq $task.Triggers) { $null } else { @($task.Triggers) }
    $principalUser = if ($null -ne $task.Principal -and $null -ne $task.Principal.UserId) { [string]$task.Principal.UserId } else { $null }
    $principalSid = $null
    if ($principalUser -match '^S-\\d-') { $principalSid = $principalUser }
    elseif ($principalUser) {
      try { $principalSid = ([System.Security.Principal.NTAccount]$principalUser).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $principalSid = $null }
    }
    $definitionXml = [string](Export-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction Stop)
    $definitionSha = [System.Security.Cryptography.SHA256]::Create()
    $definitionHash = ([System.BitConverter]::ToString($definitionSha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($definitionXml)))).Replace('-', '').ToLowerInvariant()
    $definitionSha.Dispose()
    [pscustomobject]@{
      name = $name; present = $true; ambiguous = $false; count = 1
      taskPath = if ($null -ne $task.TaskPath) { [string]$task.TaskPath } else { $null }
      actionCount = if ($null -ne $actions) { $actions.Count } else { $null }
      execute = if ($null -ne $actions -and $actions.Count -ge 1 -and $null -ne $actions[0].Execute) { [string]$actions[0].Execute } else { $null }
      arguments = if ($null -ne $actions -and $actions.Count -ge 1 -and $null -ne $actions[0].Arguments) { [string]$actions[0].Arguments } else { $null }
      workingDirectory = if ($null -ne $actions -and $actions.Count -ge 1 -and $null -ne $actions[0].WorkingDirectory) { [string]$actions[0].WorkingDirectory } else { $null }
      triggerCount = if ($null -ne $triggers) { $triggers.Count } else { $null }
      userId = $principalUser
      principalSid = $principalSid
      logonType = if ($null -ne $task.Principal -and $null -ne $task.Principal.LogonType) { [string]$task.Principal.LogonType } else { $null }
      runLevel = if ($null -ne $task.Principal -and $null -ne $task.Principal.RunLevel) { [string]$task.Principal.RunLevel } else { $null }
      enabled = if ($null -ne $task.Settings -and $null -ne $task.Settings.Enabled) { [bool]$task.Settings.Enabled } else { $null }
      restartCount = if ($null -ne $task.Settings -and $null -ne $task.Settings.RestartCount) { [int]$task.Settings.RestartCount } else { $null }
      description = if ($null -ne $task.Description) { [string]$task.Description } else { $null }
      definitionHash = $definitionHash
    }
  }
}
ConvertTo-Json @($results) -Compress -Depth 3`;
/**
 * Fingerprint revalidation + export for one task. Exit codes: 0 preimage on stdout,
 * 3 count drift, 4 action drift, 5 execute/provenance refusal, 10 definition drift, 9
 * scheduler error.
 */
function renderDefinitionHashGuard(name, expectedHash) {
    if (expectedHash === undefined)
        return '';
    const normalizedHash = normalizeDefinitionHash(expectedHash);
    if (normalizedHash === undefined)
        return 'exit 10';
    const escapedHash = normalizedHash.replace(/'/g, "''");
    return `$definitionXml = [string](Export-ScheduledTask -TaskPath '\\' -TaskName '${name}' -ErrorAction Stop)
$definitionSha = [System.Security.Cryptography.SHA256]::Create()
$definitionHash = ([System.BitConverter]::ToString($definitionSha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($definitionXml)))).Replace('-', '').ToLowerInvariant()
$definitionSha.Dispose()
if ($definitionHash -ne '${escapedHash}') { exit 10 }`;
}
/**
 * Defense in depth for the dormant destructive path. The classifier refuses direct
 * powershell/node actions because this repository has no authoritative V1 provenance. Keep
 * the same refusal in every generated export/mutation script so a future caller cannot turn
 * a shape-only record into an unregister by bypassing the classifier.
 */
function renderV1ProvenanceGuard(receipt) {
    if (receipt === undefined) {
        return `# V1 provenance evidence is unavailable; direct-task cleanup is disabled
exit 5`;
    }
    if (normalizeDefinitionHash(receipt.definitionHash) === undefined)
        return 'exit 5';
    // Ed25519 receipt 在渲染脚本前由 Node authority 验证。PowerShell 侧仍绑定精确的任务身份和快照哈希，
    // 因此测试调用方或未来调用方都不能把缺失 receipt 变成仅凭形状注销。
    return `# V1 provenance receipt verified by the lifecycle owner; keep the exact task snapshot bound
if ($task.TaskPath -ne '\\') { exit 6 }`;
}
function renderExportScript(name, expectedHash, receipt) {
    const definitionHashGuard = renderDefinitionHashGuard(name, expectedHash);
    const provenanceGuard = renderV1ProvenanceGuard(receipt);
    const exportOutput = expectedHash !== undefined ? '$definitionXml' : `(Export-ScheduledTask -TaskPath '\\' -TaskName '${name}' -ErrorAction Stop)`;
    return `$ErrorActionPreference = 'Stop'
try {
  $tasks = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($tasks.Count -ne 1) { exit 3 }
  $task = $tasks[0]; $actions = @($task.Actions)
  if ($actions.Count -ne 1) { exit 4 }
  $leaf = Split-Path -Leaf ([string]$actions[0].Execute)
  if (($leaf -ine 'powershell.exe') -and ($leaf -ine 'node.exe')) { exit 5 }
  ${provenanceGuard}
  ${definitionHashGuard}
  Write-Output ${exportOutput}
  exit 0
} catch { exit 9 }`;
}
/**
 * Fingerprint revalidation → stop → revalidation → unregister → absence verification for
 * one task (the bootstrap rollback unregister pattern). Exit codes: 0 removed, 3 count
 * drift, 4 action drift, 5 execute/provenance refusal, 6 TaskPath drift, 7 stop timeout, 8
 * absence not confirmed, 9 scheduler error, 10 definition drift.
 */
function renderMutationScript(name, expectedHash, receipt) {
    const definitionHashGuard = renderDefinitionHashGuard(name, expectedHash);
    const provenanceGuard = renderV1ProvenanceGuard(receipt);
    const fingerprint = `$task = $tasks[0]; $actions = @($task.Actions)
  if ($actions.Count -ne 1) { exit 4 }
  $leaf = Split-Path -Leaf ([string]$actions[0].Execute)
  if (($leaf -ine 'powershell.exe') -and ($leaf -ine 'node.exe')) { exit 5 }
  ${provenanceGuard}
  if ($task.TaskPath -ne '\\') { exit 6 }
  ${definitionHashGuard}`;
    return `$ErrorActionPreference = 'Stop'
try {
  $tasks = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($tasks.Count -ne 1) { exit 3 }
  ${fingerprint}
  if ($task.State -eq 'Running') {
    # Stop the inspected CIM object as well, so a replacement cannot be stopped by name
    # before the post-stop fingerprint check has a chance to reject it.
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 100
      $wait = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
      if ($wait.Count -eq 0) { $task = $null; break }
      $task = $wait[0]
    } while ($null -ne $task -and $task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    if ($null -ne $task -and $task.State -eq 'Running') { exit 7 }
  }
  $tasks = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($tasks.Count -ne 1) { exit 3 }
  ${fingerprint}
  # Bind unregister to the CIM object returned by the final guarded enumeration. A name-only
  # lookup here could delete a replacement task that wins the race after the fingerprint check.
  Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop | Out-Null
  $left = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($left.Count -ne 0) { exit 8 }
  exit 0
} catch { exit 9 }`;
}
/**
 * Restore refuses to overwrite: it re-registers a persisted preimage only when the known
 * name is currently absent. Exit codes: 0 restored, 3 name already present, 4 registration
 * verification failed after a guarded rollback, 5 preimage changed while restoring, 9
 * scheduler error, 11 rollback could not prove that the just-registered generation was still
 * present (the task is deliberately left for operator inspection).
 */
function renderRestoreScript(name, preimageReadPath, expectedHash) {
    const escapedPath = preimageReadPath.replace(/'/g, "''");
    const normalizedHash = normalizeDefinitionHash(expectedHash);
    const escapedHash = normalizedHash
        ? normalizedHash.replace(/'/g, "''")
        : undefined;
    const hashGuard = expectedHash !== undefined && escapedHash === undefined
        ? 'exit 5'
        : escapedHash
            ? `$preimageBytes = [System.IO.File]::ReadAllBytes('${escapedPath}')
if ($preimageBytes.Length -eq 0 -or $preimageBytes.Length -gt ${MAX_PREIMAGE_BYTES}) { exit 5 }
$preimageSha = [System.Security.Cryptography.SHA256]::Create()
$preimageHash = ([System.BitConverter]::ToString($preimageSha.ComputeHash($preimageBytes))).Replace('-', '').ToLowerInvariant()
$preimageSha.Dispose()
if ($preimageHash -ne '${escapedHash}') { exit 5 }
$xml = [System.Text.Encoding]::UTF8.GetString($preimageBytes)`
            : `$xml = [System.IO.File]::ReadAllText('${escapedPath}')`;
    return `$ErrorActionPreference = 'Stop'
function Get-CanonicalTaskXml([string]$text) {
  $xmlSettings = New-Object System.Xml.XmlReaderSettings
  $xmlSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $xmlSettings.XmlResolver = $null
  $xmlReader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($text), $xmlSettings)
  try {
    $xmlDoc = New-Object System.Xml.XmlDocument
    $xmlDoc.PreserveWhitespace = $false
    $xmlDoc.XmlResolver = $null
    $xmlDoc.Load($xmlReader)
    if ($null -eq $xmlDoc.DocumentElement -or $xmlDoc.DocumentElement.LocalName -ne 'Task') { throw 'invalid scheduled-task XML root' }
    return [string]$xmlDoc.DocumentElement.OuterXml
  } finally {
    $xmlReader.Dispose()
  }
}
function Get-CanonicalTaskHash([string]$text) {
  $canonical = Get-CanonicalTaskXml $text
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}
function Try-RollbackRegisteredTask([string]$expectedCanonicalHash) {
  try {
    $current = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
    if ($current.Count -eq 0) { return $true }
    if ($current.Count -ne 1) { return $false }
    $currentXml = [string](Export-ScheduledTask -TaskPath '\\' -TaskName '${name}' -ErrorAction Stop)
    if ((Get-CanonicalTaskHash $currentXml) -ne $expectedCanonicalHash) { return $false }
    # Use the inspected CIM object, not a second name-only lookup, so a replacement is not
    # silently unregistered after the guarded identity check.
    Unregister-ScheduledTask -InputObject $current[0] -Confirm:$false -ErrorAction Stop | Out-Null
    $remaining = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
    return $remaining.Count -eq 0
  } catch {
    return $false
  }
}
$registered = $false
$registrationAttempted = $false
$expectedCanonicalHash = $null
try {
  $existing = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($existing.Count -ne 0) { exit 3 }
  ${hashGuard}
  $expectedCanonicalHash = Get-CanonicalTaskHash $xml
  $existingAfterRead = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($existingAfterRead.Count -ne 0) { exit 3 }
  # Mark the boundary before invoking the cmdlet. A provider can commit the task and then
  # surface a timeout/transport error; the catch path must still attempt guarded cleanup.
  $registrationAttempted = $true
  Register-ScheduledTask -TaskPath '\\' -TaskName '${name}' -Xml $xml -ErrorAction Stop | Out-Null
  $registered = $true
  $verify = @(Get-ScheduledTask -TaskPath '\\*' -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq '${name}' })
  if ($verify.Count -ne 1) {
    if (Try-RollbackRegisteredTask $expectedCanonicalHash) { exit 4 }
    exit 11
  }
  # Export the registered generation and compare a parsed/canonical representation. This
  # covers every action, argument, working directory, principal, trigger, setting,
  # description, and generation field, while tolerating scheduler whitespace/encoding
  # normalization. A command/argument-only check is insufficient because an extra action or
  # changed principal could otherwise survive a failed restore.
  $registeredXml = [string](Export-ScheduledTask -TaskPath '\\' -TaskName '${name}' -ErrorAction Stop)
  if ((Get-CanonicalTaskHash $registeredXml) -ne $expectedCanonicalHash) {
    if (Try-RollbackRegisteredTask $expectedCanonicalHash) { exit 4 }
    exit 11
  }
  exit 0
} catch {
  if (($registrationAttempted -or $registered) -and $null -ne $expectedCanonicalHash -and (Try-RollbackRegisteredTask $expectedCanonicalHash)) { exit 9 }
  if ($registrationAttempted -or $registered) { exit 11 }
  exit 9
}`;
}
function parseProbeRecords(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return undefined;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROBE_OUTPUT_BYTES)
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        if (list.length === 0)
            return undefined;
        return list;
    }
    catch {
        return undefined;
    }
}
function executeLeaf(execute) {
    if (typeof execute !== 'string')
        return undefined;
    const trimmed = execute.trim();
    if (!trimmed)
        return undefined;
    const leaf = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return leaf.toLowerCase();
}
function isFiniteInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
/**
 * A present record must carry every field needed to make the conservative shape decision. A
 * missing value is not equivalent to an empty/foreign task: it means the scheduler response
 * was incomplete, so callers must stop before mutation. Even a complete direct-action shape
 * remains ambiguous until a trusted V1 template is available; see `classifyProbedTask`.
 */
function hasCompleteProbeFingerprint(record) {
    return typeof record.taskPath === 'string'
        && isFiniteInteger(record.actionCount)
        && typeof record.execute === 'string'
        && typeof record.arguments === 'string'
        && typeof record.workingDirectory === 'string'
        && isFiniteInteger(record.triggerCount)
        && typeof record.userId === 'string'
        && typeof record.principalSid === 'string'
        && typeof record.logonType === 'string'
        && typeof record.runLevel === 'string'
        && typeof record.enabled === 'boolean'
        && isFiniteInteger(record.restartCount)
        && typeof record.description === 'string'
        && typeof record.definitionHash === 'string'
        && /^[a-f0-9]{64}$/i.test(record.definitionHash);
}
export function classifyProbedTask(record, provenance) {
    if (!record || record.present !== true)
        return { classification: 'absent' };
    if (typeof record.name !== 'string' || !LEGACY_WINDOWS_TASK_NAMES.includes(record.name)) {
        return { classification: 'foreign', reason: 'task name is outside the cleanup allowlist' };
    }
    // The probe protocol always emits a count and an explicit ambiguous flag for present
    // tasks; anything else is a protocol break and fails closed.
    if (record.ambiguous !== false || record.count !== 1) {
        return { classification: 'ambiguous', reason: 'multiple same-name tasks registered' };
    }
    if (!hasCompleteProbeFingerprint(record)) {
        return { classification: 'ambiguous', reason: 'task fingerprint is incomplete' };
    }
    if (record.taskPath !== '\\') {
        return { classification: 'foreign', reason: 'registered outside the root task path' };
    }
    if (record.actionCount !== 1) {
        return { classification: 'foreign', reason: 'action shape does not match the v1 template' };
    }
    const userId = typeof record.userId === 'string' ? record.userId : '';
    const principalSid = typeof record.principalSid === 'string' ? record.principalSid : '';
    const logonType = typeof record.logonType === 'string' ? record.logonType : '';
    const runLevel = typeof record.runLevel === 'string' ? record.runLevel : '';
    const actionArguments = typeof record.arguments === 'string' ? record.arguments : '';
    if (record.triggerCount !== 1
        || userId.trim() === ''
        || !/^S-\d-\d+(?:-\d+){1,15}$/.test(principalSid)
        || logonType.toLowerCase() !== 'interactive'
        || runLevel.toLowerCase() !== 'limited'
        || record.enabled !== true
        || record.restartCount !== 5
        || actionArguments.trim() === '') {
        return { classification: 'foreign', reason: 'principal, trigger, settings, or action arguments drifted' };
    }
    const leaf = executeLeaf(record.execute);
    if (leaf === undefined) {
        return { classification: 'ambiguous', reason: 'action executable could not be read' };
    }
    if (LEGACY_ACTION_EXECUTABLE_LEAVES.has(leaf)) {
        if (provenance === undefined) {
            return { classification: 'ambiguous', reason: 'V1 provenance evidence unavailable; refusing destructive cleanup' };
        }
        if (provenance.taskName !== record.name
            || provenance.taskPath !== record.taskPath
            || provenance.principalSid !== principalSid
            || provenance.definitionHash !== String(record.definitionHash).toLowerCase()) {
            return { classification: 'foreign', reason: 'signed V1 provenance does not match the observed task generation' };
        }
        return { classification: 'legacy', reason: 'signed V1 generation receipt matched' };
    }
    if (leaf === V2_ACTION_EXECUTABLE_LEAF) {
        return { classification: 'current', reason: 'v2 wscript launcher binding' };
    }
    return { classification: 'foreign', reason: 'action executable is not an evolver shape' };
}
function runProbe(run, powershell) {
    const result = run(powershell, powershellArgs(PROBE_SCRIPT), PROBE_TIMEOUT_MS);
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
        return { detail: result.error ? boundedDetail(result.error) : `probe exited with status ${result.status ?? 'timeout'}` };
    }
    const records = parseProbeRecords(result.stdout);
    if (!records)
        return { detail: 'probe output could not be parsed' };
    return { records };
}
/**
 * The PowerShell probe has a fixed, closed-world response contract. A missing,
 * duplicated, malformed, or unexpected record means enumeration was incomplete;
 * callers must not interpret it as an absent task.
 */
function probeCoverageIssue(records) {
    const knownNames = new Set(LEGACY_WINDOWS_TASK_NAMES);
    const names = records.map((record) => record && typeof record.name === 'string' ? record.name : undefined);
    if (names.some((name) => name === undefined))
        return 'probe returned a malformed task record';
    if (names.some((name) => !knownNames.has(name)))
        return 'probe returned an unexpected task record';
    for (const record of records) {
        if (!record || (record.present !== true && record.present !== false))
            return 'probe returned a malformed task record';
        if (record.present === false) {
            if (record.count !== 0 || (record.ambiguous !== undefined && record.ambiguous !== false)) {
                return 'probe returned an inconsistent absent-task record';
            }
            const absentFingerprintFields = [
                'taskPath', 'actionCount', 'execute', 'arguments', 'workingDirectory', 'triggerCount',
                'userId', 'principalSid', 'logonType', 'runLevel', 'enabled', 'restartCount',
                'description', 'definitionHash',
            ];
            if (absentFingerprintFields.some((field) => record[field] !== undefined)) {
                return 'probe returned an inconsistent absent-task record';
            }
        }
    }
    const missing = LEGACY_WINDOWS_TASK_NAMES.filter((name) => !names.includes(name));
    if (missing.length > 0)
        return 'probe omitted a known task name';
    const duplicate = LEGACY_WINDOWS_TASK_NAMES.find((name) => names.filter((candidate) => candidate === name).length !== 1);
    if (duplicate)
        return 'probe returned a duplicate known task record';
    return undefined;
}
function preimageDirFor(stateDir) {
    return join(stateDir, LEGACY_TASK_PREIMAGE_DIR);
}
function cooldownMarkerPath(stateDir) {
    return join(stateDir, LEGACY_TASK_COOLDOWN_FILE);
}
/** Keep lifecycle state artifacts on the trusted, non-reparse state directory chain. */
function assertLegacyStateArtifactPath(path) {
    assertTrustedArtifactParent(path, process.platform);
}
function writeLegacyStateText(path, content) {
    assertLegacyStateArtifactPath(path);
    writeDurableText(path, content, 0o600);
    // Re-check the parent chain after publication so a replaced/symlinked state directory is
    // never silently accepted as lifecycle-owned state.
    assertLegacyStateArtifactPath(path);
    // Validate the published leaf as well: owner-only mode, regular-file identity, no reparse
    // link, and a stable descriptor/hash. This closes the gap between the generic durable writer
    // and the lifecycle artifact contract used by reads.
    readBootstrapArtifactFile(path, MAX_PREIMAGE_BYTES, { role: 'owned' });
}
function readCooldownMarker(stateDir) {
    const path = cooldownMarkerPath(stateDir);
    try {
        assertLegacyStateArtifactPath(path);
        const receipt = readBootstrapArtifactFile(path, MAX_COOLDOWN_MARKER_BYTES, { role: 'owned' });
        const parsed = JSON.parse(receipt.bytes.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        const marker = parsed;
        if (marker.schema !== COOLDOWN_MARKER_SCHEMA)
            return undefined;
        if (typeof marker.lastConclusiveAt !== 'string' || Number.isNaN(Date.parse(marker.lastConclusiveAt)))
            return undefined;
        if (!Array.isArray(marker.removed) || marker.removed.some((entry) => typeof entry !== 'string'))
            return undefined;
        if (marker.status === 'clean' || marker.status === 'cleaned') {
            return {
                schema: COOLDOWN_MARKER_SCHEMA,
                lastConclusiveAt: marker.lastConclusiveAt,
                status: marker.status,
                removed: marker.removed,
            };
        }
        // Negative backoff markers (inconclusive/failed) are only valid with well-formed
        // attempts + nextRetryAt; anything else falls through to the no-marker fail-safe.
        if (marker.status === 'inconclusive' || marker.status === 'failed') {
            if (typeof marker.attempts !== 'number' || !Number.isInteger(marker.attempts) || marker.attempts < 1)
                return undefined;
            if (typeof marker.nextRetryAt !== 'string' || Number.isNaN(Date.parse(marker.nextRetryAt)))
                return undefined;
            return {
                schema: COOLDOWN_MARKER_SCHEMA,
                lastConclusiveAt: marker.lastConclusiveAt,
                status: marker.status,
                removed: marker.removed,
                attempts: marker.attempts,
                nextRetryAt: marker.nextRetryAt,
            };
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** Negative-backoff delay for inconclusive/failed sweeps: 1h base, doubling, capped at 24h. */
function legacyTaskNegativeBackoffMs(attempts) {
    const clamped = Math.max(1, Math.floor(attempts));
    const delay = LEGACY_TASK_NEGATIVE_BACKOFF_BASE_MS * 2 ** Math.min(clamped - 1, 30);
    return Math.min(delay, LEGACY_TASK_NEGATIVE_BACKOFF_MAX_MS);
}
function withLegacyOwnerLock(stateDir, lockOptions, operation) {
    const lock = _legacyTaskInternalsForTest.acquireBootstrapOwnerLock(stateDir, lockOptions ?? { maxTries: 300, waitMs: 100 });
    try {
        lock.assertOwned();
        return operation();
    }
    finally {
        lock.release();
    }
}
function writeCooldownMarker(stateDir, status, removed, now) {
    const marker = {
        schema: COOLDOWN_MARKER_SCHEMA,
        lastConclusiveAt: new Date(now()).toISOString(),
        status,
        removed,
    };
    writeLegacyStateText(cooldownMarkerPath(stateDir), `${JSON.stringify(marker)}\n`);
}
function writeNegativeCooldownMarker(stateDir, status, attempts, now) {
    const current = now();
    const marker = {
        schema: COOLDOWN_MARKER_SCHEMA,
        lastConclusiveAt: new Date(current).toISOString(),
        status,
        removed: [],
        attempts,
        nextRetryAt: new Date(current + legacyTaskNegativeBackoffMs(attempts)).toISOString(),
    };
    writeLegacyStateText(cooldownMarkerPath(stateDir), `${JSON.stringify(marker)}\n`);
}
function writeCooldownMarkerWithOwner(stateDir, status, removed, attempts, now, lockOptions) {
    withLegacyOwnerLock(stateDir, lockOptions, () => {
        if (status === 'clean' || status === 'cleaned')
            writeCooldownMarker(stateDir, status, removed, now);
        else
            writeNegativeCooldownMarker(stateDir, status, attempts ?? 1, now);
    });
}
function clearCooldownMarker(stateDir, assertOwner) {
    assertOwner?.();
    const path = cooldownMarkerPath(stateDir);
    assertLegacyStateArtifactPath(path);
    let identity;
    try {
        identity = readBootstrapArtifactFile(path, MAX_COOLDOWN_MARKER_BYTES, { role: 'owned' }).identity;
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return;
        throw error;
    }
    const quarantine = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.quarantine`);
    let moved = false;
    const sameIdentity = (left, right) => left.sha256 === right.sha256
        && left.size === right.size && left.device === right.device && left.inode === right.inode;
    const entryExists = (candidate) => {
        try {
            lstatSync(candidate);
            return true;
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return false;
            throw error;
        }
    };
    try {
        const settled = readBootstrapArtifactFile(path, MAX_COOLDOWN_MARKER_BYTES, { role: 'owned' }).identity;
        if (!sameIdentity(settled, identity))
            throw new Error('cooldown marker changed before removal');
        try {
            lstatSync(quarantine);
            throw new Error('cooldown marker quarantine is unexpectedly occupied');
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
        // Move the exact inspected inode out of the canonical name before deleting it. If a
        // concurrent writer publishes a replacement, the canonical path is observed as occupied
        // and the quarantined marker is preserved instead of deleting the replacement.
        assertLegacyStateArtifactPath(path);
        assertLegacyStateArtifactPath(quarantine);
        renameSync(path, quarantine);
        moved = true;
        // The rename is a filesystem boundary: re-check the trusted parent chain on both names
        // before reading or deleting the quarantined inode.
        assertLegacyStateArtifactPath(quarantine);
        assertLegacyStateArtifactPath(path);
        assertOwner?.();
        const movedIdentity = readBootstrapArtifactFile(quarantine, MAX_COOLDOWN_MARKER_BYTES, { role: 'owned' }).identity;
        if (!sameIdentity(movedIdentity, identity))
            throw new Error('cooldown marker changed during quarantine');
        if (entryExists(path))
            throw new Error('cooldown marker was replaced during quarantine');
        const beforeDelete = readBootstrapArtifactFile(quarantine, MAX_COOLDOWN_MARKER_BYTES, { role: 'owned' }).identity;
        if (!sameIdentity(beforeDelete, identity))
            throw new Error('cooldown marker changed before quarantine removal');
        removeDurableFile(quarantine);
        assertOwner?.();
    }
    catch (error) {
        if (moved) {
            // Restore the moved inode only while the canonical path is absent; otherwise leave both
            // generations for operator inspection rather than overwriting a newer marker.
            try {
                // The rename itself may have moved a newer or foreign generation if it won the race
                // with our settled read. Preserve whichever inode was moved; never silently drop it.
                if (!entryExists(path) && entryExists(quarantine))
                    renameSync(quarantine, path);
            }
            catch {
                // The quarantine remains durable and will not be mistaken for the canonical marker.
            }
        }
        throw error;
    }
}
function persistPreimage(stateDir, name, xml, now) {
    const stamp = new Date(now()).toISOString().replaceAll(':', '').replaceAll('-', '');
    // The clock is not an ownership primitive: two cleanup processes can observe the same
    // millisecond, and wall clocks can move backwards. Keep the operator-readable timestamp but
    // add a cryptographic nonce so a new preimage can never replace an older receipt by name.
    const nonce = randomUUID().replaceAll('-', '');
    const path = join(preimageDirFor(stateDir), `${name}.${stamp}.${nonce}.xml`);
    writeLegacyStateText(path, xml.endsWith('\n') ? xml : `${xml}\n`);
    return basename(path);
}
/**
 * The full safe cleanup. NEVER throws: every failure surface maps onto an honest
 * `inconclusive` / `failed` status. Non-Windows platforms are reported as `skipped` — an
 * unprobed host is never reported clean. The `EVOLVER_SKIP_LEGACY_TASK_PROBE` opt-out is
 * honored by the AUTOMATIC entry points (session-start sweep, bootstrap sweep, doctor
 * probe); this function implements the explicit operator/transaction path and always
 * probes, so an explicit `evolver lifecycle cleanup-legacy-tasks` can never be silently
 * disabled out from under the operator.
 */
function cleanupLegacyWindowsDaemonTasksInternal(options) {
    const platform = options.platform ?? process.platform;
    const dryRun = options.dryRun === true;
    if (platform !== 'win32') {
        return { status: 'skipped', dryRun, tasks: [], detail: 'not a Windows host' };
    }
    const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
    const run = options.run ?? defaultLegacyTaskRun();
    const now = options.now ?? Date.now;
    let trackedEntries = [];
    const removedNames = [];
    let powershell;
    try {
        powershell = trustedWindowsPowerShell();
    }
    catch (error) {
        return { status: 'inconclusive', dryRun, tasks: [], detail: boundedDetail(error) };
    }
    try {
        const provenance = loadLegacyTaskProvenance(stateDir, options.env, now());
        if (provenance.detail) {
            return { status: 'inconclusive', dryRun, tasks: [], detail: provenance.detail };
        }
        const probed = runProbe(run, powershell);
        if ('detail' in probed) {
            return { status: 'inconclusive', dryRun, tasks: [], detail: probed.detail };
        }
        const entries = LEGACY_WINDOWS_TASK_NAMES.map((name) => {
            const record = probed.records.find((candidate) => candidate && candidate.name === name);
            const { classification, reason } = classifyProbedTask(record, provenance.receipts.get(name));
            return { name, classification, ...(reason ? { reason } : {}) };
        });
        trackedEntries = entries;
        // A record for a known name that the probe never returned, or any other response-shape
        // drift, is a protocol break, not a negative result.
        const coverageIssue = probeCoverageIssue(probed.records);
        if (coverageIssue)
            return { status: 'inconclusive', dryRun, tasks: entries, detail: coverageIssue };
        if (entries.some((entry) => entry.classification === 'ambiguous')) {
            return { status: 'inconclusive', dryRun, tasks: entries, detail: 'ambiguous task shape; refusing to mutate' };
        }
        const expectedDefinitionHashes = new Map();
        for (const record of probed.records) {
            if (record && typeof record.name === 'string' && typeof record.definitionHash === 'string') {
                expectedDefinitionHashes.set(record.name, record.definitionHash);
            }
        }
        const expectedProvenanceReceipts = new Map();
        for (const entry of entries) {
            const receipt = provenance.receipts.get(entry.name);
            if (receipt)
                expectedProvenanceReceipts.set(entry.name, receipt);
        }
        const legacy = entries.filter((entry) => entry.classification === 'legacy');
        if (legacy.length === 0) {
            if (!dryRun) {
                try {
                    if (options.assertOwner) {
                        options.assertOwner();
                        writeCooldownMarker(stateDir, 'clean', [], now);
                    }
                    else {
                        writeCooldownMarkerWithOwner(stateDir, 'clean', [], undefined, now, options.lock);
                    }
                }
                catch {
                    // The cooldown marker is throttle state only; its loss merely retries sooner.
                }
            }
            return { status: 'clean', dryRun, tasks: entries };
        }
        if (dryRun) {
            return { status: 'legacy_detected', dryRun, tasks: entries };
        }
        return cleanupClassifiedLegacyTasks(options, powershell, entries, legacy, expectedDefinitionHashes, expectedProvenanceReceipts);
    }
    catch (error) {
        const detail = boundedDetail(error);
        const status = detail.startsWith('bootstrap owner lock unavailable')
            ? 'inconclusive'
            : 'failed';
        const partialPrefix = removedNames.length > 0
            ? `partial cleanup removed ${removedNames.join(', ')}; `
            : '';
        return { status, dryRun, tasks: trackedEntries, detail: `${partialPrefix}${detail}` };
    }
}
/**
 * Manual cleanup owns the lifecycle lock before it probes.  Without this outer lock a clean
 * probe could race a concurrent bootstrap that registers a legacy-named task and then publish
 * a positive cooldown marker, suppressing the next real sweep for 24 hours.  Automatic callers
 * already hold the same lock and pass `assertOwner`, while dry-run remains read-only.
 */
export function cleanupLegacyWindowsDaemonTasks(options) {
    const platform = options.platform ?? process.platform;
    const dryRun = options.dryRun === true;
    if (platform !== 'win32' || dryRun || options.assertOwner) {
        return cleanupLegacyWindowsDaemonTasksInternal(options);
    }
    const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
    let lock;
    try {
        try {
            lock = _legacyTaskInternalsForTest.acquireBootstrapOwnerLock(stateDir, options.lock ?? { maxTries: 300, waitMs: 100 });
        }
        catch (error) {
            // An owner lock that cannot be acquired is an authority failure, not evidence that
            // the task set is broken.  Report it as inconclusive so the manual path never turns
            // an unavailable or untrusted state directory into a misleading hard failure.
            return {
                status: 'inconclusive',
                dryRun,
                tasks: [],
                detail: `bootstrap owner lock unavailable: ${boundedDetail(error)}`,
            };
        }
        lock.assertOwned();
        const result = cleanupLegacyWindowsDaemonTasksInternal({
            ...options,
            assertOwner: lock.assertOwned,
        });
        try {
            lock.release();
        }
        catch (releaseError) {
            if (result.status === 'cleaned' || result.status === 'clean') {
                result.detail = `owner lock release failed: ${boundedDetail(releaseError)}`;
            }
        }
        lock = undefined;
        return result;
    }
    catch (error) {
        if (lock) {
            try {
                lock.release();
            }
            catch { /* preserve the primary bounded outcome */ }
        }
        const detail = boundedDetail(error);
        return {
            status: detail.startsWith('bootstrap owner lock unavailable') ? 'inconclusive' : 'failed',
            dryRun,
            tasks: [],
            detail,
        };
    }
}
/** Read-only probe for `evolver doctor` — never mutates, never throws. */
export function probeLegacyWindowsDaemonTasks(options) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
        return { conclusive: false, legacy: [], detail: 'not a Windows host' };
    }
    if (legacyTaskProbeSkipped(options.env)) {
        return { conclusive: false, legacy: [], detail: `${LEGACY_TASK_SKIP_ENV} is set` };
    }
    let powershell;
    try {
        powershell = trustedWindowsPowerShell();
    }
    catch (error) {
        return { conclusive: false, legacy: [], detail: boundedDetail(error) };
    }
    const run = options.run ?? defaultLegacyTaskRun();
    try {
        const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
        const provenance = loadLegacyTaskProvenance(stateDir, options.env, Date.now());
        if (provenance.detail)
            return { conclusive: false, legacy: [], detail: provenance.detail };
        const probed = runProbe(run, powershell);
        if ('detail' in probed) {
            return { conclusive: false, legacy: [], detail: probed.detail };
        }
        const coverageIssue = probeCoverageIssue(probed.records);
        if (coverageIssue)
            return { conclusive: false, legacy: [], detail: coverageIssue };
        const legacy = [];
        for (const name of LEGACY_WINDOWS_TASK_NAMES) {
            const record = probed.records.find((candidate) => candidate && candidate.name === name);
            const { classification } = classifyProbedTask(record, provenance.receipts.get(name));
            if (classification === 'ambiguous') {
                return { conclusive: false, legacy: [], detail: `ambiguous shape for ${name}` };
            }
            if (classification === 'legacy')
                legacy.push(name);
        }
        return { conclusive: true, legacy, detail: legacy.length > 0 ? `detected ${legacy.length} legacy v1 task(s)` : 'no legacy v1-style scheduled tasks registered' };
    }
    catch (error) {
        return { conclusive: false, legacy: [], detail: boundedDetail(error) };
    }
}
/**
 * Automatic entry point (SessionStart hook). Throttled by the cooldown marker: after a
 * conclusive success the sweep skips re-probing for the cooldown window; an
 * inconclusive/failed run writes a NEGATIVE backoff marker (1h base, doubling per
 * consecutive failure, capped at 24h) and the sweep skips until `nextRetryAt`, so a
 * constrained host does not spawn PowerShell on every session. A conclusive success
 * overwrites the marker, resetting the backoff counter. Never throws.
 */
export function maybeCleanupLegacyWindowsDaemonTasks(options) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32')
        return undefined;
    if (legacyTaskProbeSkipped(options.env))
        return undefined;
    const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
    const now = options.now ?? Date.now;
    const cooldownMs = options.cooldownMs ?? LEGACY_TASK_COOLDOWN_MS;
    let ownerLock;
    let result;
    try {
        // Keep the owner lock across marker read, probe/mutation, and marker publication. This
        // prevents a stale negative result from overwriting a newer conclusive marker produced by
        // a concurrent SessionStart/bootstrap process.
        ownerLock = _legacyTaskInternalsForTest.acquireBootstrapOwnerLock(stateDir, options.lock ?? { maxTries: 30, waitMs: 100 });
        ownerLock.assertOwned();
        const marker = readCooldownMarker(stateDir);
        if (marker) {
            if (marker.status === 'inconclusive' || marker.status === 'failed') {
                const retryAt = Date.parse(marker.nextRetryAt ?? '');
                if (Number.isFinite(retryAt) && now() < retryAt)
                    return undefined;
            }
            else {
                const age = now() - Date.parse(marker.lastConclusiveAt);
                if (Number.isFinite(age) && age >= 0 && age < cooldownMs)
                    return undefined;
            }
        }
        result = cleanupLegacyWindowsDaemonTasks({
            env: options.env,
            stateDir,
            platform,
            run: options.run,
            now,
            assertOwner: ownerLock.assertOwned,
        });
        ownerLock.assertOwned();
        if (result.status === 'inconclusive' || result.status === 'failed') {
            try {
                const previousAttempts = marker && (marker.status === 'inconclusive' || marker.status === 'failed')
                    ? marker.attempts ?? 0
                    : 0;
                writeNegativeCooldownMarker(stateDir, result.status, previousAttempts + 1, now);
            }
            catch {
                // The cooldown marker is throttle state only; its loss merely retries sooner.
            }
        }
        return result;
    }
    catch (error) {
        result = {
            status: 'inconclusive',
            dryRun: false,
            tasks: [],
            detail: boundedDetail(error),
        };
        return result;
    }
    finally {
        if (ownerLock) {
            try {
                ownerLock.release();
            }
            catch (releaseError) {
                if (result) {
                    result.detail = `${result.detail ? `${result.detail}; ` : ''}owner lock release failed: ${boundedDetail(releaseError)}`;
                }
            }
        }
    }
}
/**
 * Post-bootstrap sweep seam: runs under the already-held bootstrap owner lock and returns
 * report lines for the bootstrap `actions`. Never throws and never fails the bootstrap —
 * but a failed/inconclusive sweep is reported honestly instead of being dropped.
 */
export function sweepLegacyWindowsDaemonTasksAfterBootstrap(options) {
    try {
        if (legacyTaskProbeSkipped(options.env))
            return [];
        const result = cleanupLegacyWindowsDaemonTasks({
            env: options.env,
            stateDir: options.stateDir,
            assertOwner: options.assertOwner,
            ...(options.platform ? { platform: options.platform } : {}),
            ...(options.run ? { run: options.run } : {}),
        });
        if (result.status === 'cleaned') {
            const names = result.tasks.filter((task) => task.outcome === 'removed').map((task) => task.name);
            return [`removed legacy v1 scheduled-task residue: ${names.join(', ')} (durable preimage saved under the lifecycle state dir)`];
        }
        if (result.status === 'failed' || result.status === 'inconclusive') {
            return [`legacy v1 scheduled-task cleanup ${result.status}${result.detail ? `: ${result.detail}` : ''}; run evolver lifecycle cleanup-legacy-tasks manually`];
        }
        return [];
    }
    catch (error) {
        return [`legacy v1 scheduled-task cleanup inconclusive: ${boundedDetail(error)}; run evolver lifecycle cleanup-legacy-tasks manually`];
    }
}
/**
 * Manual restore of a persisted preimage. Only files named `<KnownTaskName>.<stamp>.xml`
 * are accepted, the target name must be currently ABSENT (restore never overwrites), and
 * the XML is validated before it reaches PowerShell. Never throws.
 */
export function restoreLegacyTaskPreimage(preimagePath, options) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32')
        return { status: 'failed', detail: 'not a Windows host' };
    let outcome;
    let ownerLock;
    try {
        const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
        const preimageRoot = resolvePath(preimageDirFor(stateDir));
        const requestedPath = isAbsolute(preimagePath)
            ? resolvePath(preimagePath)
            : resolvePath(preimageRoot, preimagePath);
        const requestedRelative = relative(preimageRoot, requestedPath);
        const sameDirectory = dirname(requestedPath).toLowerCase() === preimageRoot.toLowerCase();
        if (!requestedRelative || requestedRelative.startsWith('..') || isAbsolute(requestedRelative) || !sameDirectory) {
            return { status: 'failed', detail: 'preimage must be a direct file in the lifecycle preimage directory' };
        }
        assertLegacyStateArtifactPath(requestedPath);
        const base = basename(requestedPath);
        const name = LEGACY_WINDOWS_TASK_NAMES.find((candidate) => base.startsWith(`${candidate}.`) && base.endsWith('.xml'));
        if (!name) {
            return { status: 'failed', detail: 'preimage file name does not encode a known task name' };
        }
        const stampPattern = new RegExp(`^${name}\\.\\d{8}T\\d{6}(?:\\.\\d{3}|\\d{3})Z(?:\\.[a-f0-9]{32})?\\.xml$`);
        if (!stampPattern.test(base)) {
            return { status: 'failed', detail: 'preimage file name does not encode a valid lifecycle timestamp' };
        }
        ownerLock = _legacyTaskInternalsForTest.acquireBootstrapOwnerLock(stateDir, options.lock);
        ownerLock.assertOwned();
        const receipt = readBootstrapArtifactFile(requestedPath, MAX_PREIMAGE_BYTES, { role: 'owned' });
        if (receipt.bytes.length === 0) {
            return { status: 'failed', detail: 'preimage file is empty' };
        }
        const xml = receipt.bytes.toString('utf8');
        if (!/^\s*<\?xml/.test(xml) || !/<Task\b/.test(xml) || !/<Actions\b/.test(xml)
            || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
            return { status: 'failed', detail: 'preimage is not a scheduled-task XML definition' };
        }
        if (xml.split('\n').some((line) => line.startsWith("'@"))) {
            return { status: 'failed', detail: 'preimage content failed embedding validation' };
        }
        const powershell = trustedWindowsPowerShell();
        const run = options.run ?? defaultLegacyTaskRun();
        const result = run(powershell, powershellArgs(renderRestoreScript(name, requestedPath, receipt.identity.sha256)), MUTATION_TIMEOUT_MS);
        // The scheduler script performs the absent-check, registration, and verification while
        // the owner lock is held. Reassert after it returns so a lost lock cannot be reported as
        // a successful restore.
        ownerLock.assertOwned();
        if (result.status === 0 && !result.error) {
            try {
                const settled = readBootstrapArtifactFile(requestedPath, MAX_PREIMAGE_BYTES, { role: 'owned' });
                if (settled.identity.sha256 !== receipt.identity.sha256
                    || settled.identity.size !== receipt.identity.size
                    || settled.identity.device !== receipt.identity.device
                    || settled.identity.inode !== receipt.identity.inode) {
                    outcome = { status: 'failed', task: name, detail: 'preimage changed during restore; registration outcome is uncertain' };
                    return outcome;
                }
            }
            catch (error) {
                outcome = { status: 'failed', task: name, detail: `preimage changed during restore: ${boundedDetail(error)}` };
                return outcome;
            }
            try {
                clearCooldownMarker(stateDir, ownerLock.assertOwned);
            }
            catch (error) {
                outcome = {
                    status: 'restored',
                    task: name,
                    detail: `preimage re-registered and verified; cooldown marker cleanup failed: ${boundedDetail(error)}`,
                };
                return outcome;
            }
            outcome = { status: 'restored', task: name, detail: 'preimage re-registered and verified' };
            return outcome;
        }
        const detail = result.status === 3
            ? 'task name is already present; restore never overwrites (remove it first)'
            : result.status === 4
                ? 'registration could not be verified; guarded rollback completed'
                : result.status === 5
                    ? 'preimage changed while restoring; registration was refused'
                    : result.status === 11
                        ? 'registration verification was uncertain; task was left for operator inspection'
                        : result.error
                            ? boundedDetail(result.error)
                            : `restore exited with status ${result.status ?? 'timeout'}`;
        outcome = { status: 'failed', task: name, detail };
        return outcome;
    }
    catch (error) {
        outcome = { status: 'failed', detail: boundedDetail(error) };
        return outcome;
    }
    finally {
        if (ownerLock) {
            try {
                ownerLock.release();
            }
            catch (releaseError) {
                // A successful registration remains durable even when cleanup of the lock handle
                // reports an ownership change; preserve the success but surface the bounded warning.
                if (outcome?.status === 'restored')
                    outcome.detail = `owner lock release failed: ${boundedDetail(releaseError)}`;
            }
        }
    }
}
export const _legacyTaskInternalsForTest = {
    PROBE_SCRIPT,
    acquireBootstrapOwnerLock,
    defaultLegacyTaskRun,
    canonicalLegacyTaskProvenanceBytes,
    parseLegacyTaskProvenanceReceipt,
    loadLegacyTaskProvenance,
    renderExportScript,
    renderMutationScript,
    renderRestoreScript,
    parseProbeRecords,
    readCooldownMarker,
    writeCooldownMarker,
    writeNegativeCooldownMarker,
    negativeBackoffMs: legacyTaskNegativeBackoffMs,
    cooldownMarkerPath,
    preimageDirFor,
    cleanupClassifiedLegacyTasksForTest,
};
/**
 * Mutation mechanics for entries that have already passed the production classifier.
 *
 * 公开清理路径只有在可信 provenance classifier 至少返回一个 `legacy` 条目后才会进入这里。
 * 缺少有效签名 receipt 时，所有完整 direct-action shape 都会保持 `ambiguous`。下方测试专用
 * wrapper 仅接收预分类合成条目，以覆盖 preimage/revalidation 的失败机制；它不是
 * provenance/configuration 绕过，也不属于 package API。
 */
function cleanupClassifiedLegacyTasks(options, powershell, entries, legacy, expectedDefinitionHashes, expectedProvenanceReceipts = new Map()) {
    const dryRun = options.dryRun === true;
    const stateDir = options.stateDir ?? lifecyclePaths(options.env).stateDir;
    const run = options.run ?? defaultLegacyTaskRun();
    const now = options.now ?? Date.now;
    const removedNames = [];
    const trackedEntries = entries;
    if (legacy.some((entry) => entry.classification !== 'legacy')) {
        throw new Error('mutation helper requires preclassified legacy entries');
    }
    try {
        // Mutation phase: under lifecycle owner authority, preimage first, then unregister with
        // final revalidation. Lock contention means authority could not be proven; nothing is
        // mutated and the run reports inconclusive (never clean).
        const lock = options.assertOwner
            ? undefined
            : (() => {
                try {
                    return _legacyTaskInternalsForTest.acquireBootstrapOwnerLock(stateDir, options.lock ?? { maxTries: 300, waitMs: 100 });
                }
                catch (error) {
                    throw new Error(`bootstrap owner lock unavailable: ${boundedDetail(error)}`);
                }
            })();
        const assertOwner = options.assertOwner ?? lock.assertOwned;
        // The computed outcome is returned by reference, so the release below can annotate a
        // conclusive success without ever replacing it.
        let computed;
        try {
            assertOwner();
            const removed = removedNames;
            let drifted = false;
            let failed = false;
            let failDetail;
            for (const entry of legacy) {
                const name = entry.name;
                const expectedDefinitionHash = expectedDefinitionHashes.get(name);
                const provenanceReceipt = expectedProvenanceReceipts.get(name);
                if (provenanceReceipt !== undefined
                    && (expectedDefinitionHash === undefined
                        || normalizeDefinitionHash(expectedDefinitionHash) !== normalizeDefinitionHash(provenanceReceipt.definitionHash))) {
                    drifted = true;
                    entry.outcome = 'removal-aborted';
                    entry.reason = 'signed V1 provenance is not bound to the observed definition hash';
                    continue;
                }
                const exported = run(powershell, powershellArgs(renderExportScript(name, expectedDefinitionHash, provenanceReceipt)), EXPORT_TIMEOUT_MS);
                if (exported.error || exported.status !== 0 || typeof exported.stdout !== 'string' || !exported.stdout.trim()) {
                    if (exported.status === 3 || exported.status === 4 || exported.status === 5 || exported.status === 10) {
                        drifted = true;
                        entry.outcome = 'removal-aborted';
                        entry.reason = exported.status === 5
                            ? 'fingerprint/provenance guard refused preimage capture'
                            : 'fingerprint drifted before preimage capture';
                        continue;
                    }
                    failed = true;
                    entry.outcome = 'removal-failed';
                    failDetail ??= exported.error
                        ? boundedDetail(exported.error)
                        : `preimage capture exited with status ${exported.status ?? 'timeout'}`;
                    continue;
                }
                const xml = exported.stdout.trim();
                if (Buffer.byteLength(xml, 'utf8') > MAX_PREIMAGE_BYTES || xml.split('\n').some((line) => line.startsWith("'@"))) {
                    failed = true;
                    entry.outcome = 'removal-failed';
                    failDetail ??= 'preimage content failed durability validation';
                    continue;
                }
                let preimage;
                try {
                    preimage = persistPreimage(stateDir, name, xml, now);
                }
                catch (error) {
                    failed = true;
                    entry.outcome = 'removal-failed';
                    failDetail ??= `preimage persistence failed: ${boundedDetail(error)}`;
                    continue;
                }
                assertOwner();
                const mutation = run(powershell, powershellArgs(renderMutationScript(name, expectedDefinitionHash, provenanceReceipt)), MUTATION_TIMEOUT_MS);
                if (mutation.status === 0 && !mutation.error) {
                    entry.outcome = 'removed';
                    entry.preimage = preimage;
                    removed.push(name);
                    continue;
                }
                if (mutation.status === 3 || mutation.status === 4 || mutation.status === 5 || mutation.status === 6 || mutation.status === 10) {
                    drifted = true;
                    entry.outcome = 'removal-aborted';
                    entry.reason = mutation.status === 5
                        ? 'fingerprint/provenance guard refused unregister'
                        : 'fingerprint drifted before unregister';
                    continue;
                }
                failed = true;
                entry.outcome = 'removal-failed';
                failDetail ??= mutation.status === 7
                    ? 'task did not stop within the budget'
                    : mutation.status === 8
                        ? 'task still present after unregister'
                        : mutation.error
                            ? boundedDetail(mutation.error)
                            : `unregister exited with status ${mutation.status ?? 'timeout'}`;
            }
            assertOwner();
            const status = failed ? 'failed' : drifted ? 'inconclusive' : 'cleaned';
            const partialPrefix = removed.length > 0 ? `partial cleanup removed ${removed.join(', ')}; ` : '';
            const result = {
                status,
                dryRun,
                tasks: entries,
                ...(failDetail
                    ? { detail: `${partialPrefix}${failDetail}` }
                    : drifted
                        ? { detail: `${partialPrefix}task shape drifted during cleanup; residue left untouched` }
                        : {}),
            };
            if (status === 'cleaned') {
                try {
                    assertOwner();
                    writeCooldownMarker(stateDir, status, removed, now);
                }
                catch {
                    // The cooldown marker is throttle state only; its loss merely retries sooner.
                }
            }
            computed = result;
            return result;
        }
        finally {
            // A release failure must never overwrite the computed outcome: after a conclusive
            // success the tasks are removed and their preimages are durable (the release failure
            // is bounded into the detail only), and on the error path the original error keeps
            // propagating unchanged.
            if (lock) {
                try {
                    lock.release();
                }
                catch (releaseError) {
                    if (computed?.status === 'cleaned') {
                        computed.detail = `owner lock release failed: ${boundedDetail(releaseError)}`;
                    }
                }
            }
        }
    }
    catch (error) {
        const detail = boundedDetail(error);
        const status = detail.startsWith('bootstrap owner lock unavailable')
            ? 'inconclusive'
            : 'failed';
        const partialPrefix = removedNames.length > 0
            ? `partial cleanup removed ${removedNames.join(', ')}; `
            : '';
        return { status, dryRun, tasks: trackedEntries, detail: `${partialPrefix}${detail}` };
    }
}
/** Test-only wrapper for mutation mechanics; callers must supply preclassified legacy entries. */
function cleanupClassifiedLegacyTasksForTest(options, entries, expectedDefinitionHashes = new Map(), expectedProvenanceReceipts = new Map()) {
    if (entries.some((entry) => entry.classification !== 'legacy')) {
        throw new Error('test mutation helper requires preclassified legacy entries');
    }
    const powershell = trustedWindowsPowerShell();
    return cleanupClassifiedLegacyTasks(options, powershell, entries, entries, expectedDefinitionHashes, expectedProvenanceReceipts);
}