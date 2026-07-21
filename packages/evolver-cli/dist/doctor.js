// `evolver doctor` (#217 slice 3, read-only) — verify a runtime onboarding is SAFE without ever printing a secret.
// Read-only: it reads env + the runtime config files and reports pass/warn/fail; it never mutates config, never
// loads the env file into the process, and redacts any value before output. The smoke/reachability checks
// (heartbeat, proxy path) touch the proxy and are a SEPARATE, gated step — not here.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { expandHomePath, parseEnvFile } from '@evomap/evolver-mcp';
import { formatMemoryGraphOperatorStatus, loadMemoryGraphOperatorStatus } from './localMemoryGraph.js';
// Secrets that must live ONLY behind the EVOLVER_ENV_FILE pointer — never inlined into a runtime config (#217).
const SECRET_KEYS = [
    'A2A_NODE_SECRET',
    'EVOMAP_ENTERPRISE_TOKEN',
    'EVOMAP_PRIVATE_HUB_TOKEN',
    'EVOMAP_NODE_SECRET',
    'EVOLVER_IPC_TOKEN',
    'EVOLVER_LLM_TOKEN',
    'PHUB_ENTERPRISE_TOKEN',
    'PRIVATE_HUB_ENTERPRISE_TOKEN',
];
const PRIVATE_TOKEN_KEYS = ['EVOMAP_ENTERPRISE_TOKEN', 'EVOMAP_PRIVATE_HUB_TOKEN', 'PHUB_ENTERPRISE_TOKEN', 'PRIVATE_HUB_ENTERPRISE_TOKEN'];
const PRIVATE_LIVE_SMOKE_FLAGS = ['EVOLVER_PRIVATE_SMOKE_SEARCH', 'EVOLVER_PRIVATE_SMOKE_REUSE_RESULT', 'EVOLVER_PRIVATE_SMOKE_PUBLISH'];
// Runtime config files setup-hooks may write (claude-code / codex). cursor's .mdc carries gene text, not creds.
const CONFIG_FILES = ['.mcp.json', join('.claude', 'settings.json'), join('.codex', 'config.toml')];
const ENV_CATALOG_DEFINITIONS = [
    {
        name: 'EVOLVER_ENV_FILE',
        group: 'credential-store',
        purpose: 'Pointer to the local env file that stores private credentials outside runtime config.',
        requiredFor: 'PHub/private proxy, setup-hooks pointer-only credential flow',
        defaultValue: 'unset',
    },
    {
        name: 'A2A_NODE_SECRET',
        group: 'credential-store',
        purpose: 'Public hub node secret used by A2A hub authentication.',
        requiredFor: 'public hub sync/publish when not using an enterprise token',
        secret: true,
    },
    {
        name: 'EVOMAP_NODE_SECRET',
        group: 'credential-store',
        purpose: 'Legacy/public hub node secret alias used by hub clients.',
        requiredFor: 'public hub sync/publish compatibility',
        secret: true,
    },
    {
        name: 'EVOMAP_ENTERPRISE_TOKEN',
        aliases: PRIVATE_TOKEN_KEYS.filter((key) => key !== 'EVOMAP_ENTERPRISE_TOKEN'),
        group: 'credential-store',
        purpose: 'Enterprise token used by private PHub runtime. Keep exactly one token alias set.',
        requiredFor: 'EVOMAP_HUB_MODE=private',
        secret: true,
    },
    {
        name: 'EVOMAP_ENTERPRISE_SUBJECT',
        aliases: ['EVOMAP_PRIVATE_SUBJECT', 'PHUB_ENTERPRISE_SUBJECT', 'USER'],
        group: 'credential-store',
        purpose: 'Operator or SSO subject sent to the private adapter.',
        requiredFor: 'PHub inventory/audit identity',
    },
    {
        name: 'EVOLVER_IPC_TOKEN',
        group: 'credential-store',
        purpose: 'Bearer token for loopback evolver-proxy IPC endpoints.',
        requiredFor: 'local proxy status/search/fetch/reuse-result clients',
        secret: true,
    },
    {
        name: 'EVOLVER_LLM_TOKEN',
        group: 'credential-store',
        purpose: 'Bearer token for the local LLM proxy surface.',
        requiredFor: 'local LLM proxy clients',
        secret: true,
    },
    {
        name: 'EVOMAP_HUB_MODE',
        group: 'hub-runtime',
        purpose: 'Selects public or private hub adapter mode.',
        requiredFor: 'PHub runtime requires private',
        defaultValue: 'public',
    },
    {
        name: 'EVOMAP_HUB_URL',
        aliases: ['A2A_HUB_URL'],
        group: 'hub-runtime',
        purpose: 'Hub base URL for public/private adapter connections.',
        requiredFor: 'hub sync, PHub runtime, live smoke',
    },
    {
        name: 'EVOLVER_DEFAULT_HUB_URL',
        group: 'hub-runtime',
        purpose: 'Deployment-time default Hub URL override used when A2A_HUB_URL and EVOMAP_HUB_URL are unset.',
        requiredFor: 'release/deployment default Hub selection',
        defaultValue: 'https://evomap.ai',
    },
    {
        name: 'EVOMAP_PRIVATE_ADAPTER_MODULE',
        group: 'hub-runtime',
        purpose: 'Optional private adapter module override.',
        requiredFor: 'local/private adapter development',
        defaultValue: '@evomap/evolver-adapter-private',
    },
    {
        name: 'EVOMAP_HUB_ALLOW_INSECURE',
        group: 'hub-runtime',
        purpose: 'Allows insecure hub transport when explicitly set by the operator.',
        requiredFor: 'local/dev hub testing only',
        defaultValue: 'unset',
    },
    {
        name: 'EVOLVER_HEARTBEAT_MS',
        group: 'hub-runtime',
        purpose: 'Proxy heartbeat interval.',
        requiredFor: 'proxy daemon heartbeat tuning',
    },
    {
        name: 'EVOLVER_PROXY_URL',
        group: 'proxy-loopback',
        purpose: 'Loopback evolver-proxy URL used by CLI/MCP clients.',
        requiredFor: 'proxy status/search/fetch/reuse-result',
        defaultValue: '~/.evolver/settings.json when available',
    },
    {
        name: 'EVOLVER_PROXY_SETTINGS_FILE',
        group: 'proxy-loopback',
        purpose: 'Override path for the proxy-published local settings file.',
        requiredFor: 'custom proxy settings location',
    },
    {
        name: 'EVOLVER_IPC_PORT',
        aliases: ['EVOMAP_PROXY_PORT'],
        group: 'proxy-loopback',
        purpose: 'Loopback IPC port for evolver-proxy.',
        requiredFor: 'proxy daemon startup',
    },
    {
        name: 'NO_PROXY',
        aliases: ['no_proxy'],
        group: 'proxy-loopback',
        purpose: 'Bypasses corporate/system proxy for local loopback traffic.',
        requiredFor: 'safe local IPC when HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is set',
    },
    {
        name: 'HTTP_PROXY',
        aliases: ['HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'],
        group: 'proxy-loopback',
        purpose: 'System proxy variables that can affect outbound and loopback traffic.',
        requiredFor: 'operator network environments',
    },
    {
        name: 'EVOLVER_REUSE_BEFORE_SOLVE',
        group: 'autoexec-reuse',
        purpose: 'Enables autoexec reuse-before-solve through local/proxy candidates.',
        requiredFor: 'live reuse loop',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_REUSE_SIGNAL',
        group: 'autoexec-reuse',
        purpose: 'Emergency switch for reuse soft-rerank.',
        requiredFor: 'reuse ranking tuning',
        defaultValue: 'enabled unless set to 0',
    },
    {
        name: 'EVOLVER_REUSE_MODE',
        group: 'autoexec-reuse',
        purpose: 'Controls reuse mode behavior for candidate selection.',
        requiredFor: 'reuse experiments',
    },
    {
        name: 'EVOLVER_MIN_REUSE_SCORE',
        group: 'autoexec-reuse',
        purpose: 'Minimum score threshold for selected reuse candidates.',
        requiredFor: 'reuse quality tuning',
    },
    {
        name: 'EVOLVER_GENE_PROBATION',
        group: 'autoexec-reuse',
        purpose: 'Enables probation promotion/demotion loop.',
        requiredFor: 'probation rollout',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_AUTO_DISTILL_LLM',
        aliases: ['EVOLVER_AUTO_DISTILL'],
        group: 'distill',
        purpose: 'Enables LLM distillation from successful capsules.',
        requiredFor: 'online gene distill',
        defaultValue: 'off',
    },
    {
        name: 'EVOLVER_AUTO_DISTILL_TRANSCRIPT',
        group: 'distill',
        purpose: 'Enables watched transcript distillation.',
        requiredFor: 'passive transcript distill',
        defaultValue: 'off',
    },
    {
        name: 'EVOLVER_AUTO_DISTILL_ANTI_GENE',
        group: 'distill',
        purpose: 'Enables anti-gene distill from repeated failures.',
        requiredFor: 'anti-gene rollout',
        defaultValue: 'off',
    },
    {
        name: 'EVOLVER_REFLECTION',
        group: 'distill',
        purpose: 'Enables reflection observer/event path.',
        requiredFor: 'reflection observability',
        defaultValue: 'enabled unless set to 0',
    },
    {
        name: 'EVOLVER_VALUE_DIGEST',
        group: 'observability',
        purpose: 'Enables value digest observer.',
        requiredFor: 'operator value summaries',
        defaultValue: 'enabled unless set to 0',
    },
    {
        name: 'EVOLVER_VALUE_DIGEST_MOTD',
        group: 'observability',
        purpose: 'Prints value digest as MOTD-style output when enabled.',
        requiredFor: 'operator dashboard summaries',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_LLM_TRACE_CAPTURE_BODIES',
        aliases: ['EVOMAP_PROXY_TRACE_CAPTURE_BODIES', 'EVOMAP_PROXY_TRACE'],
        group: 'llm-trace',
        purpose: 'Controls native LLM trace body capture.',
        requiredFor: 'offline trajectory/raw data capture',
        defaultValue: 'capture enabled unless explicitly disabled',
    },
    {
        name: 'EVOLVER_LLM_TRACE_BODY_MAX_CHARS',
        aliases: ['EVOMAP_PROXY_TRACE_MAX_FIELD_BYTES'],
        group: 'llm-trace',
        purpose: 'Per-body redacted capture cap.',
        requiredFor: 'LLM trace storage bounds',
        defaultValue: '4194304',
    },
    {
        name: 'EVOLVER_LLM_TRACE_ENVELOPE_MAX_CHARS',
        aliases: ['EVOMAP_PROXY_TRACE_ENVELOPE_MAX_BYTES'],
        group: 'llm-trace',
        purpose: 'Default envelope cap for trace body/stream capture.',
        requiredFor: 'LLM trace storage bounds',
        defaultValue: '4194304',
    },
    {
        name: 'EVOLVER_LLM_TRACE_ENCRYPTION',
        aliases: ['EVOMAP_PROXY_TRACE_ENCRYPTION'],
        group: 'llm-trace',
        purpose: 'Controls trace encryption envelope.',
        requiredFor: 'trace privacy mode',
        defaultValue: 'enabled',
    },
    {
        name: 'EVOLVER_LLM_TRACE_DIR',
        group: 'llm-trace',
        purpose: 'Override directory for local LLM trace files.',
        requiredFor: 'custom trace storage',
    },
    {
        name: 'EVOLVER_TRAJECTORY_RUNTIME_SESSIONS',
        aliases: ['EVOLVER_TRAJECTORY_EXPORT_RUNTIME_SESSIONS'],
        group: 'trajectory-export',
        purpose: 'Enables runtime session discovery during trajectory export.',
        requiredFor: 'offline trajectory export',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_TRAJECTORY_RUNTIME_SESSION_DIRS',
        aliases: ['EVOLVER_TRAJECTORY_EXPORT_RUNTIME_SESSION_DIRS'],
        group: 'trajectory-export',
        purpose: 'Extra runtime session directories for trajectory export.',
        requiredFor: 'offline trajectory export',
    },
    {
        name: 'EVOLVER_CURSOR_TRANSCRIPTS_DIR',
        group: 'trajectory-export',
        purpose: 'Cursor transcript directory override.',
        requiredFor: 'Cursor runtime session export',
    },
    {
        name: 'EVOLVER_SESSION_SOURCE',
        group: 'trajectory-export',
        purpose: 'Runtime session source selector.',
        requiredFor: 'runtime adapter filtering',
    },
    {
        name: 'EVOLVER_TRAJECTORY_INCLUDE_UNMARKED',
        group: 'trajectory-export',
        purpose: 'Includes unmarked runtime sessions in export.',
        requiredFor: 'legacy/full trajectory capture',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_TRAJECTORY_INCLUDE_GATEWAY_CAPTURED',
        group: 'trajectory-export',
        purpose: 'Includes gateway-captured sessions in export.',
        requiredFor: 'full trajectory capture',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE',
        group: 'phub-live-smoke',
        purpose: 'Opt-in switch for controlled PHub live smoke.',
        requiredFor: 'real PHub test-env verification',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE_SEARCH',
        group: 'phub-live-smoke',
        purpose: 'Enables live PHub search/fetch smoke side effects.',
        requiredFor: 'real PHub search/fetch verification',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE_REUSE_RESULT',
        group: 'phub-live-smoke',
        purpose: 'Enables live PHub reuse-result smoke side effects.',
        requiredFor: 'real PHub outcome verification',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE_PUBLISH',
        group: 'phub-live-smoke',
        purpose: 'Enables live PHub publish smoke side effects.',
        requiredFor: 'real PHub publish verification',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE_ASSET_ID',
        group: 'phub-live-smoke',
        purpose: 'Asset id used by live PHub reuse-result smoke when search is not enabled.',
        requiredFor: 'EVOLVER_PRIVATE_SMOKE_REUSE_RESULT=1 without search',
    },
    {
        name: 'EVOLVER_PRIVATE_SMOKE_SIGNALS',
        group: 'phub-live-smoke',
        purpose: 'Comma-separated signals used by live PHub search smoke.',
        requiredFor: 'EVOLVER_PRIVATE_SMOKE_SEARCH=1',
    },
    {
        name: 'EVOLVER_HOME',
        aliases: ['EVOMAP_HOME', 'EVOMAP_DIR'],
        group: 'local-paths',
        purpose: 'Local Evolver data/settings root.',
        requiredFor: 'custom local state location',
        defaultValue: '~/.evomap or ~/.evolver depending on component',
    },
    {
        name: 'EVOLVER_SETTINGS_DIR',
        group: 'local-paths',
        purpose: 'Settings directory override used by telemetry/settings readers.',
        requiredFor: 'custom settings location',
    },
    {
        name: 'EVOLVER_REPO_ROOT',
        group: 'local-paths',
        purpose: 'Repository root override for export/discovery flows.',
        requiredFor: 'trajectory/runtime discovery',
    },
    {
        name: 'EVOLVER_SOLO',
        group: 'safety-mode',
        purpose: 'Enables solo lockdown mode, disabling hub reuse and ATP paths.',
        requiredFor: 'local-only safe mode',
        defaultValue: '0',
    },
    {
        name: 'EVOLVER_SOLO_MAX_FAILS',
        group: 'safety-mode',
        purpose: 'Circuit-breaker threshold for solo mode.',
        requiredFor: 'solo lockdown tuning',
    },
    {
        name: 'EVOLVER_ATP',
        group: 'marketplace-atp',
        purpose: 'Controls ATP marketplace/payment feature surface.',
        requiredFor: 'ATP flows',
        defaultValue: 'off unless explicitly enabled',
    },
    {
        name: 'EVOLVER_ATP_AUTOBUY',
        group: 'marketplace-atp',
        purpose: 'Controls automatic ATP buy behavior.',
        requiredFor: 'operator-approved ATP automation',
        defaultValue: 'off',
    },
    {
        name: 'EVOLVER_ATP_AUTODELIVER',
        group: 'marketplace-atp',
        purpose: 'Controls automatic ATP delivery behavior.',
        requiredFor: 'operator-approved ATP automation',
        defaultValue: 'off',
    },
    {
        name: 'EVOLVER_LIFECYCLE_COMMAND',
        group: 'lifecycle',
        purpose: 'Command managed by the lifecycle supervisor.',
        requiredFor: 'lifecycle start/stop/status flows',
    },
    {
        name: 'EVOLVER_LIFECYCLE_STATE_DIR',
        group: 'lifecycle',
        purpose: 'Lifecycle state directory override.',
        requiredFor: 'custom lifecycle state location',
    },
    {
        name: 'EVOLVER_LIFECYCLE_LOG_DIR',
        group: 'lifecycle',
        purpose: 'Lifecycle log directory override.',
        requiredFor: 'custom lifecycle logs',
    },
    {
        name: 'EVOLVER_LIFECYCLE_REQUIRE_PROXY_STATUS',
        group: 'lifecycle',
        purpose: 'Requires proxy status readiness during lifecycle checks.',
        requiredFor: 'proxy service supervision',
    },
    {
        name: 'EVOLVER_SELF_UPDATE',
        group: 'self-update',
        purpose: 'Controls self-update behavior.',
        requiredFor: 'operator-controlled proxy update rollout',
        defaultValue: 'off unless explicitly enabled',
    },
    {
        name: 'EVOLVER_SELF_UPDATE_PUBLIC_KEY',
        group: 'self-update',
        purpose: 'Public key used to verify self-update artifacts.',
        requiredFor: 'self-update verification',
    },
    {
        name: 'EVOLVER_SELF_UPDATE_SUPERVISOR',
        group: 'self-update',
        purpose: 'Attests that a generated durable service launcher owns relaunch.',
        requiredFor: 'automatic self-update',
    },
    {
        name: 'EVOLVER_SELF_UPDATE_TARGET_PATH',
        group: 'self-update',
        purpose: 'Target path for self-update installation.',
        requiredFor: 'self-update installation',
    },
];
/** Mask token-like runs (>=16 chars of base64/hex/url-safe) so doctor output can never leak a secret value. */
export function redact(s) {
    return s.replace(/[A-Za-z0-9_\-+/=]{16,}/g, 'REDACTED');
}
// The EVOLVER_ENV_FILE pointer as written into a runtime config — JSON (`"EVOLVER_ENV_FILE": "…"`) or TOML
// (`EVOLVER_ENV_FILE = "…"`). Format-agnostic so doctor finds the pointer setup-hooks wrote even when the operator's
// shell does not export it (#279 Bugbot).
const POINTER_RE = /EVOLVER_ENV_FILE"?\s*[:=]\s*"([^"]+)"/;
/** Loopback hosts a NO_PROXY entry must EXACTLY be to cover local IPC/proxy ('*' = bypass all). Exact-entry match,
 *  not substring, so `127.0.0.10` / `notlocalhost.com` do not count (#279 Bugbot). */
const LOOPBACK_ENTRIES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '*']);
/**
 * Run the read-only doctor checks. Pure given its (injectable) deps — no config mutation, no env-file load into the
 * process. Returns the check list; the CLI formats + sets the exit code.
 */
export function runDoctorChecks(deps = {}) {
    const env = deps.env ?? process.env;
    const root = deps.configRoot ?? process.cwd();
    const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    const exists = deps.exists ?? existsSync;
    const statMode = deps.statMode ?? ((p) => {
        try {
            return statSync(p).mode;
        }
        catch {
            return undefined;
        }
    });
    const checks = [];
    // 1. env-file: EVOLVER_ENV_FILE should point at a readable credential store. The pointer may come from the
    //    operator's shell OR from the runtime config setup-hooks wrote (#279 Bugbot) — check both. Report KEY NAMES
    //    only (never values), parsed PURELY (parseEnvFile) so the file is not loaded into this process.
    const envFromProc = env['EVOLVER_ENV_FILE']?.trim();
    let envSource = 'env';
    let envPath = envFromProc;
    if (!envPath) {
        for (const rel of CONFIG_FILES) {
            const p = join(root, rel);
            if (!exists(p))
                continue;
            let text;
            try {
                text = read(p);
            }
            catch {
                continue;
            }
            const m = POINTER_RE.exec(text);
            if (m?.[1]) {
                envPath = m[1];
                envSource = rel;
                break;
            }
        }
    }
    let envFileValues = {};
    let envFileReadiness = { status: 'missing_pointer' };
    if (!envPath) {
        checks.push({ name: 'env-file', status: 'warn', detail: 'EVOLVER_ENV_FILE not set in env or runtime config — hub/proxy features have no credential store to read' });
    }
    else {
        const resolved = isAbsolute(envPath) ? envPath : expandHomePath(envPath);
        if (!exists(resolved)) {
            const detail = `EVOLVER_ENV_FILE points at a missing file: ${redact(resolved)}`;
            envFileReadiness = { status: 'unusable', detail };
            checks.push({ name: 'env-file', status: 'fail', detail });
        }
        else {
            try {
                const parsed = parseEnvFile(read(resolved));
                envFileValues = parsed;
                const keys = Object.keys(parsed);
                const insecureMode = insecureSecretFileMode(keys, statMode(resolved));
                if (insecureMode) {
                    const detail = `${redact(resolved)} readable (via ${envSource}), but mode ${insecureMode.modeText} exposes secret-like keys [${insecureMode.keys.join(', ')}]; run chmod 600 on the credential store`;
                    envFileReadiness = { status: 'unusable', detail };
                    checks.push({ name: 'env-file', status: 'fail', detail });
                }
                else {
                    envFileReadiness = { status: 'readable' };
                    checks.push({ name: 'env-file', status: 'pass', detail: `${redact(resolved)} readable (via ${envSource}), ${keys.length} key(s): ${keys.join(', ')}` });
                }
            }
            catch (e) {
                const detail = `EVOLVER_ENV_FILE unreadable: ${redact(e instanceof Error ? e.message : String(e))}`;
                envFileReadiness = { status: 'unusable', detail };
                checks.push({ name: 'env-file', status: 'fail', detail });
            }
        }
    }
    // 2. config-no-secrets: runtime config must reference creds via the EVOLVER_ENV_FILE pointer, never inline a secret.
    const offenders = [];
    for (const rel of CONFIG_FILES) {
        const p = join(root, rel);
        if (!exists(p))
            continue;
        let text;
        try {
            text = read(p);
        }
        catch {
            continue;
        }
        // Match an actual KEY ASSIGNMENT (`KEY:`/`KEY =`, JSON or TOML), with a left boundary, so the key name merely
        // appearing inside a path / comment / unrelated string is NOT a false positive (#279 Bugbot).
        const found = SECRET_KEYS.filter((k) => new RegExp(`(^|[^A-Za-z0-9_])${k}"?\\s*[:=]`).test(text));
        if (found.length > 0)
            offenders.push(`${rel} [${found.join(', ')}]`);
    }
    checks.push(offenders.length > 0
        ? { name: 'config-no-secrets', status: 'fail', detail: `runtime config inlines secret keys (use the EVOLVER_ENV_FILE pointer instead): ${offenders.join('; ')}` }
        : { name: 'config-no-secrets', status: 'pass', detail: 'no inline secret keys in runtime config (pointer-only)' });
    const effectiveEnv = { ...env, ...envFileValues };
    // 3. no-proxy-loopback: a system proxy must not intercept loopback IPC/LLM-proxy traffic (NO_PROXY must list 127.0.0.1).
    const noProxyEntries = `${effectiveEnv['NO_PROXY'] ?? ''},${effectiveEnv['no_proxy'] ?? ''}`.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const proxySet = Boolean(effectiveEnv['HTTP_PROXY'] || effectiveEnv['http_proxy'] || effectiveEnv['HTTPS_PROXY'] || effectiveEnv['https_proxy'] || effectiveEnv['ALL_PROXY'] || effectiveEnv['all_proxy']);
    const loopbackCovered = noProxyEntries.some((e) => LOOPBACK_ENTRIES.has(e));
    if (!proxySet) {
        checks.push({ name: 'no-proxy-loopback', status: 'pass', detail: 'no system proxy set — loopback IPC/proxy is not at risk' });
    }
    else if (loopbackCovered) {
        checks.push({ name: 'no-proxy-loopback', status: 'pass', detail: 'NO_PROXY covers loopback (127.0.0.1/localhost)' });
    }
    else {
        checks.push({ name: 'no-proxy-loopback', status: 'warn', detail: 'a system proxy is set but NO_PROXY lacks 127.0.0.1/localhost — local IPC/LLM-proxy traffic may be intercepted; add them to NO_PROXY' });
    }
    if (deps.profile === 'private-runtime') {
        checks.push(...privateRuntimeChecks(env, envFileValues, envFileReadiness));
    }
    try {
        const status = (deps.memoryGraphStatus ?? loadMemoryGraphOperatorStatus)(effectiveEnv);
        checks.push({
            name: 'memory-graph',
            status: status.recovery === 'degraded' ? 'warn' : 'pass',
            detail: formatMemoryGraphOperatorStatus(status),
        });
    }
    catch {
        checks.push({ name: 'memory-graph', status: 'warn', detail: 'state=degraded corrupt=1 oversized_lines=0 oversized_files=0 archives=0' });
    }
    return checks;
}
export function buildEnvCatalog(deps = {}) {
    const env = deps.env ?? process.env;
    const root = deps.configRoot ?? process.cwd();
    const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
    const exists = deps.exists ?? existsSync;
    const statMode = deps.statMode ?? ((p) => {
        try {
            return statSync(p).mode;
        }
        catch {
            return undefined;
        }
    });
    const envFile = readEnvFileForCatalog({ env, root, read, exists, statMode });
    const entries = ENV_CATALOG_DEFINITIONS.map((def) => materializeCatalogEntry(def, env, envFile.values, envFile.pointerSource));
    return { profile: deps.profile ?? 'general', envFile: envFile.readiness, entries };
}
function readEnvFileForCatalog(args) {
    const { env, root, read, exists, statMode } = args;
    const envFromProc = env['EVOLVER_ENV_FILE']?.trim();
    let pointerSource = envFromProc ? 'env' : undefined;
    let envPath = envFromProc;
    if (!envPath) {
        for (const rel of CONFIG_FILES) {
            const p = join(root, rel);
            if (!exists(p))
                continue;
            let text;
            try {
                text = read(p);
            }
            catch {
                continue;
            }
            const m = POINTER_RE.exec(text);
            if (m?.[1]) {
                envPath = m[1];
                pointerSource = rel;
                break;
            }
        }
    }
    if (!envPath)
        return { values: {}, readiness: { status: 'missing_pointer' } };
    const resolved = isAbsolute(envPath) ? envPath : expandHomePath(envPath);
    if (!exists(resolved))
        return withPointerSource({ values: {}, readiness: { status: 'unusable', detail: 'EVOLVER_ENV_FILE points at a missing file' } }, pointerSource);
    try {
        const values = parseEnvFile(read(resolved));
        const insecureMode = insecureSecretFileMode(Object.keys(values), statMode(resolved));
        if (insecureMode) {
            return withPointerSource({
                values,
                readiness: {
                    status: 'unusable',
                    detail: `EVOLVER_ENV_FILE is readable, but mode ${insecureMode.modeText} exposes secret-like keys [${insecureMode.keys.join(', ')}]; run chmod 600 on the credential store`,
                },
            }, pointerSource);
        }
        return withPointerSource({ values, readiness: { status: 'readable' } }, pointerSource);
    }
    catch {
        return withPointerSource({ values: {}, readiness: { status: 'unusable', detail: 'EVOLVER_ENV_FILE is unreadable or invalid; check credential store syntax and permissions' } }, pointerSource);
    }
}
function withPointerSource(read, pointerSource) {
    return pointerSource ? { ...read, pointerSource } : read;
}
function materializeCatalogEntry(def, env, envFile, envFilePointerSource) {
    const keys = [def.name, ...(def.aliases ?? [])];
    const sources = [];
    const setKeys = [];
    let sawEmpty = false;
    for (const key of keys) {
        const envOwn = Object.prototype.hasOwnProperty.call(env, key);
        const fileOwn = Object.prototype.hasOwnProperty.call(envFile, key);
        if (fileOwn && hasValue(envFile[key])) {
            sources.push('env-file');
            setKeys.push(key);
        }
        else if (fileOwn) {
            sources.push('env-file');
            sawEmpty = true;
        }
        else if (envOwn && hasValue(env[key])) {
            sources.push('env');
            setKeys.push(key);
        }
        else if (envOwn) {
            sources.push('env');
            sawEmpty = true;
        }
    }
    if (def.name === 'EVOLVER_ENV_FILE' && envFilePointerSource) {
        sources.push(envFilePointerSource);
        setKeys.push('EVOLVER_ENV_FILE');
    }
    const uniqueSources = [...new Set(sources)];
    const uniqueSetKeys = [...new Set(setKeys)];
    const state = uniqueSetKeys.length > 0 ? 'set' : sawEmpty ? 'empty' : 'unset';
    return {
        name: def.name,
        group: def.group,
        purpose: def.purpose,
        ...(def.requiredFor ? { requiredFor: def.requiredFor } : {}),
        ...(def.defaultValue ? { defaultValue: def.defaultValue } : {}),
        ...(def.aliases && def.aliases.length > 0 ? { aliases: [...def.aliases] } : {}),
        secret: Boolean(def.secret) || keys.some(isSecretKeyName),
        state,
        sources: uniqueSources,
        setKeys: uniqueSetKeys,
    };
}
function privateRuntimeChecks(env, envFile, envFileReadiness) {
    const checks = [];
    const mode = privateValue(env, envFile, 'EVOMAP_HUB_MODE')?.toLowerCase();
    if (mode === 'private') {
        checks.push({ name: 'phub-mode', status: 'pass', detail: 'EVOMAP_HUB_MODE=private' });
    }
    else if (!mode) {
        checks.push({ name: 'phub-mode', status: 'fail', detail: 'EVOMAP_HUB_MODE is missing; set EVOMAP_HUB_MODE=private in EVOLVER_ENV_FILE for PHub runtime' });
    }
    else {
        checks.push({ name: 'phub-mode', status: 'fail', detail: `EVOMAP_HUB_MODE=${redact(mode)}; expected private for PHub runtime` });
    }
    const hubUrl = privateHubUrlValue(env, envFile);
    if (!hubUrl) {
        checks.push({ name: 'phub-url', status: 'fail', detail: 'Hub URL is missing; set EVOMAP_HUB_URL in EVOLVER_ENV_FILE, or use A2A_HUB_URL / EVOLVER_DEFAULT_HUB_URL for explicit compatibility' });
    }
    else if (isProductionLikeHubUrl(hubUrl)) {
        checks.push({ name: 'phub-url', status: 'warn', detail: `${redact(hubUrl)} does not look like a test-env URL; do not run live smoke against production PHub` });
    }
    else {
        checks.push({ name: 'phub-url', status: 'pass', detail: `${redact(hubUrl)} configured` });
    }
    const tokenKeys = PRIVATE_TOKEN_KEYS.filter((key) => hasValue(privateValue(env, envFile, key)));
    if (tokenKeys.length === 0) {
        checks.push({ name: 'phub-token', status: 'fail', detail: `missing enterprise token key in EVOLVER_ENV_FILE; expected one of ${PRIVATE_TOKEN_KEYS.join(', ')}` });
    }
    else if (tokenKeys.length > 1) {
        checks.push({ name: 'phub-token', status: 'warn', detail: `multiple enterprise token aliases are set (${tokenKeys.join(', ')}); keep exactly one alias to avoid adapter precedence drift` });
    }
    else {
        checks.push({ name: 'phub-token', status: 'pass', detail: `enterprise token key present: ${tokenKeys.join(', ')}` });
    }
    const subjectKeys = ['EVOMAP_ENTERPRISE_SUBJECT', 'EVOMAP_PRIVATE_SUBJECT', 'PHUB_ENTERPRISE_SUBJECT', 'USER'];
    const subjectKey = subjectKeys.find((key) => hasValue(privateValue(env, envFile, key)));
    checks.push(subjectKey
        ? { name: 'phub-subject', status: 'pass', detail: `enterprise subject key present: ${subjectKey}` }
        : { name: 'phub-subject', status: 'warn', detail: 'enterprise subject not set; private adapter will fall back to evolver-proxy' });
    const adapter = privateValue(env, envFile, 'EVOMAP_PRIVATE_ADAPTER_MODULE');
    checks.push(adapter
        ? { name: 'phub-adapter', status: 'pass', detail: `private adapter module configured: ${redact(adapter)}` }
        : { name: 'phub-adapter', status: 'pass', detail: 'EVOMAP_PRIVATE_ADAPTER_MODULE not set; default @evomap/evolver-adapter-private will be used' });
    const proxyUrl = privateValue(env, envFile, 'EVOLVER_PROXY_URL');
    const ipcToken = privateValue(env, envFile, 'EVOLVER_IPC_TOKEN');
    if (proxyUrl && !isLoopbackProxyUrl(proxyUrl)) {
        checks.push({ name: 'phub-proxy', status: 'fail', detail: `EVOLVER_PROXY_URL must be loopback for local IPC, got ${redact(proxyUrl)}` });
    }
    else if (proxyUrl && ipcToken) {
        checks.push({ name: 'phub-proxy', status: 'pass', detail: `loopback proxy env configured at ${redact(proxyUrl)}` });
    }
    else if (proxyUrl || ipcToken) {
        checks.push({ name: 'phub-proxy', status: 'warn', detail: 'partial proxy env; set both EVOLVER_PROXY_URL and EVOLVER_IPC_TOKEN, or rely on ~/.evolver/settings.json after proxy start' });
    }
    else {
        checks.push({ name: 'phub-proxy', status: 'warn', detail: 'no explicit EVOLVER_PROXY_URL/EVOLVER_IPC_TOKEN; clients must read ~/.evolver/settings.json after evolver-proxy starts' });
    }
    const reuse = privateValue(env, envFile, 'EVOLVER_REUSE_BEFORE_SOLVE');
    checks.push(reuse === '1'
        ? { name: 'phub-reuse', status: 'pass', detail: 'EVOLVER_REUSE_BEFORE_SOLVE=1 enables autoexec private reuse through the proxy' }
        : { name: 'phub-reuse', status: 'warn', detail: 'EVOLVER_REUSE_BEFORE_SOLVE is not 1; autoexec will not use PHub reuse-before-solve' });
    checks.push(privateLiveSmokeCheck(env, envFile, {
        mode,
        hubUrl,
        envFileReadiness,
        tokenCount: tokenKeys.length,
    }));
    return checks;
}
function privateLiveSmokeCheck(env, envFile, essentials) {
    const enabled = privateValue(env, envFile, 'EVOLVER_PRIVATE_SMOKE') === '1';
    const optionalFlags = PRIVATE_LIVE_SMOKE_FLAGS.filter((key) => privateValue(env, envFile, key) === '1');
    if (essentials.envFileReadiness.status === 'unusable') {
        return {
            name: 'phub-live-smoke',
            status: 'fail',
            detail: `live smoke readiness cannot be verified because ${essentials.envFileReadiness.detail}`,
        };
    }
    if (!enabled && optionalFlags.length === 0) {
        return {
            name: 'phub-live-smoke',
            status: 'warn',
            detail: 'live PHub smoke is opt-in; set EVOLVER_PRIVATE_SMOKE=1 only in a controlled PHub test-env',
        };
    }
    if (!enabled && optionalFlags.length > 0) {
        return {
            name: 'phub-live-smoke',
            status: 'fail',
            detail: `${optionalFlags.join(', ')} set but EVOLVER_PRIVATE_SMOKE is not 1; live smoke would be skipped while side-effect flags look enabled`,
        };
    }
    const missing = [];
    if (essentials.mode !== 'private')
        missing.push('EVOMAP_HUB_MODE=private');
    if (!essentials.hubUrl)
        missing.push('EVOMAP_HUB_URL|A2A_HUB_URL|EVOLVER_DEFAULT_HUB_URL');
    if (essentials.tokenCount === 0)
        missing.push(`one of ${PRIVATE_TOKEN_KEYS.join('|')}`);
    if (missing.length > 0) {
        return {
            name: 'phub-live-smoke',
            status: 'fail',
            detail: `EVOLVER_PRIVATE_SMOKE=1 but required live smoke input is missing: ${missing.join(', ')}`,
        };
    }
    if (essentials.hubUrl && isProductionLikeHubUrl(essentials.hubUrl)) {
        return {
            name: 'phub-live-smoke',
            status: 'fail',
            detail: `EVOLVER_PRIVATE_SMOKE=1 refuses production-like PHub URL ${redact(essentials.hubUrl)}; use a test/staging/dev/local PHub URL`,
        };
    }
    const reuseResult = privateValue(env, envFile, 'EVOLVER_PRIVATE_SMOKE_REUSE_RESULT') === '1';
    const search = privateValue(env, envFile, 'EVOLVER_PRIVATE_SMOKE_SEARCH') === '1';
    const assetId = privateValue(env, envFile, 'EVOLVER_PRIVATE_SMOKE_ASSET_ID');
    if (reuseResult && !search && !assetId) {
        return {
            name: 'phub-live-smoke',
            status: 'fail',
            detail: 'EVOLVER_PRIVATE_SMOKE_REUSE_RESULT=1 needs EVOLVER_PRIVATE_SMOKE_ASSET_ID or EVOLVER_PRIVATE_SMOKE_SEARCH=1',
        };
    }
    const sideEffects = optionalFlags.length > 0 ? optionalFlags.join(', ') : 'hello/heartbeat only';
    return {
        name: 'phub-live-smoke',
        status: 'pass',
        detail: `live smoke inputs are ready for controlled test-env (${sideEffects})`,
    };
}
function insecureSecretFileMode(keys, mode) {
    if (mode === undefined)
        return undefined;
    if ((mode & 0o077) === 0)
        return undefined;
    const secretKeys = keys.filter(isSecretKeyName);
    return secretKeys.length > 0 ? { modeText: (mode & 0o777).toString(8).padStart(3, '0'), keys: secretKeys } : undefined;
}
function isSecretKeyName(key) {
    if (SECRET_KEYS.includes(key))
        return true;
    return /(^|_)(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|NODE_SECRET|IPC_TOKEN)(_|$)/.test(key);
}
function hasValue(value) {
    return value !== undefined && value.trim().length > 0;
}
function privateValue(env, envFile, key) {
    if (Object.prototype.hasOwnProperty.call(envFile, key))
        return envFile[key]?.trim();
    const fromEnv = env[key]?.trim();
    return fromEnv || undefined;
}
function privateHubUrlValue(env, envFile) {
    return privateValue(env, envFile, 'EVOMAP_HUB_URL')
        ?? privateValue(env, envFile, 'A2A_HUB_URL')
        ?? privateValue(env, envFile, 'EVOLVER_DEFAULT_HUB_URL');
}
function isLoopbackProxyUrl(raw) {
    try {
        const url = new URL(raw);
        const hostname = url.hostname.toLowerCase();
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]');
    }
    catch {
        return false;
    }
}
function isProductionLikeHubUrl(raw) {
    try {
        const host = new URL(raw).hostname.toLowerCase();
        if (isLocalHubHost(host))
            return false;
        return !/(^|[-.])(test|staging|stage|dev|local)([-.]|$)/.test(host);
    }
    catch {
        return true;
    }
}
function isLocalHubHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(host);
}
function parseFlags(argv) {
    let root;
    let json = false;
    let envCatalog = false;
    let profile = 'general';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json')
            json = true;
        else if (a === '--root') {
            const v = argv[++i];
            if (v)
                root = v;
        }
        else if (a?.startsWith('--root='))
            root = a.slice('--root='.length);
        else if (a === '--private-runtime' || a === '--phub')
            profile = 'private-runtime';
        else if (a === '--env-catalog')
            envCatalog = true;
    }
    return { ...(root !== undefined ? { root } : {}), json, profile, envCatalog };
}
const ICON = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' };
export async function runDoctor(argv, deps = {}) {
    const f = parseFlags(argv);
    if (f.envCatalog) {
        const catalog = buildEnvCatalog({ ...deps, profile: f.profile, ...(f.root !== undefined ? { configRoot: f.root } : {}) });
        if (f.json) {
            process.stdout.write(`${JSON.stringify({ ok: true, ...catalog })}\n`);
        }
        else {
            process.stdout.write(formatEnvCatalog(catalog, deps.label ?? (f.profile === 'private-runtime' ? 'evolver phub doctor' : 'evolver doctor')));
        }
        return 0;
    }
    const checks = runDoctorChecks({ ...deps, profile: f.profile, ...(f.root !== undefined ? { configRoot: f.root } : {}) });
    const failed = checks.some((c) => c.status === 'fail');
    if (f.json) {
        process.stdout.write(`${JSON.stringify({ ok: !failed, profile: f.profile, checks })}\n`);
    }
    else {
        process.stdout.write(`${deps.label ?? (f.profile === 'private-runtime' ? 'evolver phub doctor' : 'evolver doctor')} (read-only):\n`);
        for (const c of checks)
            process.stdout.write(`  [${ICON[c.status]}] ${c.name}: ${c.detail}\n`);
        process.stdout.write(failed ? 'doctor: FAIL — fix the items above.\n' : 'doctor: ok.\n');
    }
    return failed ? 1 : 0;
}
/** Registry-shaped handler (argv -> exit code). */
export const runDoctorCommand = (argv) => runDoctor(argv);
function formatEnvCatalog(catalog, label) {
    const groups = [...new Set(catalog.entries.map((entry) => entry.group))];
    const lines = [
        `${label} env catalog (read-only):`,
        `  env-file: ${catalog.envFile.status}`,
        ...('detail' in catalog.envFile ? [`  env-file-detail: ${catalog.envFile.detail}`] : []),
        '  values: never printed; secret entries only show state/source/key names',
    ];
    for (const group of groups) {
        lines.push('', `[${group}]`);
        for (const entry of catalog.entries.filter((item) => item.group === group)) {
            const aliases = entry.aliases && entry.aliases.length > 0 ? ` aliases=${entry.aliases.join(',')}` : '';
            const source = entry.sources.length > 0 ? entry.sources.join('+') : 'none';
            const setKeys = entry.setKeys.length > 0 ? ` keys=${entry.setKeys.join(',')}` : '';
            const secret = entry.secret ? ' secret' : '';
            const def = entry.defaultValue ? ` default=${entry.defaultValue}` : '';
            const required = entry.requiredFor ? ` required-for=${entry.requiredFor}` : '';
            lines.push(`  ${entry.name}: ${entry.state} source=${source}${setKeys}${aliases}${secret}${def}${required}`);
            lines.push(`    ${entry.purpose}`);
        }
    }
    return `${lines.join('\n')}\n`;
}