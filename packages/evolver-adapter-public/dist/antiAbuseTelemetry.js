import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@evomap/evolver-core';
export const ANTI_ABUSE_SCHEMA_VERSION = 'anti_abuse.v1';
export const ANTI_ABUSE_REDACTION_VERSION = 'anti_abuse_redaction.v1';
export const DEFAULT_ANTI_ABUSE_TTL_DAYS = 90;
export const MAX_INTEGRITY_FILE_BYTES = 10 * 1024 * 1024;
export function antiAbuseTelemetryMode(env = process.env) {
    const raw = env['EVOLVER_ANTI_ABUSE_TELEMETRY'];
    const v = String(raw ?? '').trim().toLowerCase();
    if (v.length === 0)
        return 'heartbeat';
    if (v === '0' || v === 'false' || v === 'no' || v === 'off')
        return 'off';
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on' || v === 'heartbeat')
        return 'heartbeat';
    return 'off';
}
export function hmacPseudonym(value, opts = {}) {
    const raw = value == null ? '' : String(value);
    const salt = opts.salt ? String(opts.salt) : '';
    const purpose = opts.purpose ? String(opts.purpose) : 'anti_abuse';
    if (!raw || !salt)
        return null;
    return createHmac('sha256', salt).update(purpose).update('\0').update(raw).digest('hex').slice(0, 32);
}
export function antiAbuseEnvFingerprintKey(fp) {
    const nodeMajor = (fp.node_version || '').replace(/^v/, '').split('.')[0] ?? '';
    return [fp.platform, fp.arch, `node${nodeMajor}`, fp.region ?? '', fp.container ? 'container' : 'host'].join('|');
}
export function resolveAdapterPackageRoot(startDir = dirname(fileURLToPath(import.meta.url))) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (pkg.name === '@evomap/evolver-adapter-public')
                return dir;
        }
        catch {
            // Source and built layouts place package.json at different depths.
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return startDir;
}
export function resolveWorkspaceRoot(startDir = resolveAdapterPackageRoot()) {
    let dir = startDir;
    for (let i = 0; i < 12; i++) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'pnpm-lock.yaml')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return startDir;
}
export function resolveCliPackageRoot(packageRoot = resolveAdapterPackageRoot(), workspaceRoot = resolveWorkspaceRoot(packageRoot)) {
    const candidates = [
        join(workspaceRoot, 'packages', 'evolver-cli'),
        join(workspaceRoot, 'node_modules', '@evomap', 'evolver-cli'),
        join(dirname(packageRoot), 'evolver-cli'),
    ];
    for (const candidate of candidates) {
        const pkgPath = containedRealPath(candidate, join(candidate, 'package.json'));
        const pkg = pkgPath ? safeJsonFile(pkgPath) : {};
        if (pkg.name === '@evomap/evolver-cli')
            return candidate;
    }
    return null;
}
export function collectIntegrityHashes(packageRoot = resolveAdapterPackageRoot()) {
    const pkgPath = containedRealPath(packageRoot, join(packageRoot, 'package.json'));
    const workspaceRoot = resolveWorkspaceRoot(packageRoot);
    const cliRoot = resolveCliPackageRoot(packageRoot, workspaceRoot);
    const cliPkgPath = cliRoot ? containedRealPath(cliRoot, join(cliRoot, 'package.json')) : null;
    const cliPkg = cliPkgPath ? safeJsonFile(cliPkgPath) : {};
    const bin = typeof cliPkg.bin === 'object' && cliPkg.bin && typeof cliPkg.bin['evolver'] === 'string' ? cliPkg.bin['evolver'] : null;
    const binPath = bin && cliRoot ? containedRealPath(cliRoot, resolve(cliRoot, bin)) : null;
    const lockfileHashes = {};
    for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
        const p = containedRealPath(workspaceRoot, join(workspaceRoot, name));
        const digest = p ? sha256File(p) : null;
        if (digest)
            lockfileHashes[name] = digest;
    }
    return {
        package_json_hash: pkgPath ? sha256File(pkgPath) : null,
        cli_entry_hash: binPath ? sha256File(binPath) : null,
        lockfile_hashes: lockfileHashes,
    };
}
export function buildHeartbeatAntiAbuseTelemetry(opts = {}) {
    const env = opts.env ?? process.env;
    const fp = opts.envFingerprint ?? bootstrap.captureEnvFingerprint({ env });
    const salt = opts.salt ?? env['EVOLVER_ANTI_ABUSE_SALT'];
    const saltId = opts.saltId ?? env['EVOLVER_ANTI_ABUSE_SALT_ID'] ?? (salt ? 'env' : null);
    const pseudonymStatus = salt ? 'salt_configured' : 'salt_missing';
    const devicePseudonym = hmacPseudonym(fp.device, { salt, purpose: 'device' });
    const workspacePseudonym = hmacPseudonym(opts.workspaceId ?? process.cwd(), { salt, purpose: 'workspace' });
    const unavailableFields = [
        ...(devicePseudonym ? [] : [unavailable('device_pseudonym', 'anti_abuse_salt_missing', 'signed_policy_or_env')]),
        ...(workspacePseudonym ? [] : [unavailable('workspace_pseudonym', 'anti_abuse_salt_missing', 'signed_policy_or_env')]),
        unavailable('client_ip', 'server_observed_required', 'hub_edge'),
        unavailable('asn', 'server_observed_required', 'hub_edge'),
        unavailable('proxy_vpn_tor_datacenter_class', 'server_observed_required', 'hub_edge'),
        unavailable('account_security', 'account_service_required', 'hub_account'),
        unavailable('payout_method_token', 'payments_service_required', 'hub_payments'),
        unavailable('risk_action_case', 'risk_engine_required', 'hub_risk'),
    ];
    return {
        schema_version: ANTI_ABUSE_SCHEMA_VERSION,
        event_type: 'node.heartbeat',
        purpose: 'anti_abuse',
        pii_class: 'medium',
        consent_level: 'default',
        retention_ttl_days: ttlDays(env),
        policy_version: env['EVOLVER_ANTI_ABUSE_POLICY_VERSION'] ?? 'local-default',
        redaction_version: ANTI_ABUSE_REDACTION_VERSION,
        source: opts.source ?? 'evolver-client',
        generated_at: nowIso(opts.now),
        source_confidence: {
            node_identity: 'client_attested',
            device_integrity: 'client_attested',
            task_metrics: 'client_attested',
            network_source: 'server_observed_required',
            account_security: 'server_observed_required',
            payout: 'server_observed_required',
            risk_decision: 'server_observed_required',
        },
        identity: {
            node_id: opts.nodeId ?? null,
            account_id: null,
            org_id: null,
        },
        device: {
            device_pseudonym: devicePseudonym,
            workspace_pseudonym: workspacePseudonym,
            pseudonym_salt_id: saltId,
            pseudonym_status: pseudonymStatus,
            ...(pseudonymStatus === 'salt_missing' ? { pseudonym_warning: 'anti_abuse_salt_missing' } : {}),
            env_fingerprint_key: antiAbuseEnvFingerprintKey(fp),
            platform: fp.platform,
            arch: fp.arch,
            os_release: fp.os_release,
            node_version: fp.node_version,
            // Underlying LLM model, BEST-EFFORT from this node's OWN env (detectModelName() → 'unknown' fallback).
            // Anti-sybil clustering signal (v1 PR #174). Deliberately env-only: the long-lived evolver-proxy daemon and
            // the standalone evolver-llm-proxy are SEPARATE processes by design (the LLM proxy must not require a hub
            // credential), so the heartbeat can't see the per-request model the LLM proxy observes — piping it across
            // would re-couple the two binaries. Consequence: a proxy daemon whose env lacks a model var emits 'unknown'
            // here (honest, never fabricated). To populate it, set EVOLVER_MODEL_NAME in the daemon's environment. The
            // AUTHORITATIVE per-asset model lives on the capsule (threaded from input.model), so 'unknown' on a heartbeat
            // is "this node didn't say", never a contradiction of a capsule's real model.
            model: fp.model,
            evolver_version: opts.evolverVersion ?? null,
            client: '@evomap/evolver-adapter-public',
            client_version: null,
            region: fp.region ?? null,
            container: fp.container,
        },
        integrity: collectIntegrityHashes(opts.packageRoot),
        local_security_boundary: {
            proxy_bind_address_class: 'loopback',
            proxy_port_configured: opts.proxyPortConfigured != null
                ? Boolean(opts.proxyPortConfigured)
                : boolFromEnv(env['EVOMAP_PROXY']) || Boolean(env['EVOMAP_PROXY_PORT']),
            settings_permission_class: settingsPermissionClass(env),
        },
        task_timing: normalizeTaskMetrics(opts.taskMeta),
        unavailable_fields: unavailableFields,
    };
}
function containedRealPath(root, candidate) {
    try {
        const realRoot = realpathSync(root);
        const real = realpathSync(candidate);
        return real.startsWith(realRoot + sep) ? real : null;
    }
    catch {
        return null;
    }
}
function sha256File(filePath) {
    try {
        const st = statSync(filePath);
        if (!st.isFile() || st.size > MAX_INTEGRITY_FILE_BYTES)
            return null;
        return createHash('sha256').update(readFileSync(filePath)).digest('hex');
    }
    catch {
        return null;
    }
}
function safeJsonFile(filePath) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    }
    catch {
        return {};
    }
}
function nowIso(now) {
    if (now instanceof Date)
        return now.toISOString();
    if (typeof now === 'string' && now.length > 0)
        return now;
    return new Date().toISOString();
}
function boolFromEnv(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function ttlDays(env) {
    const raw = Number(env['EVOLVER_ANTI_ABUSE_TTL_DAYS']);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ANTI_ABUSE_TTL_DAYS;
}
function settingsPermissionClass(env) {
    const settingsDir = env['EVOLVER_SETTINGS_DIR']
        ?? env['EVOMAP_DIR']
        ?? env['EVOLVER_HOME']
        ?? env['EVOMAP_HOME']
        ?? join(homedir(), '.evomap');
    return filePermissionClass(join(settingsDir, 'settings.json'));
}
function filePermissionClass(filePath) {
    try {
        const st = statSync(filePath);
        if (!st.isFile())
            return 'not_file';
        const mode = st.mode & 0o777;
        if ((mode & 0o077) === 0)
            return 'owner_only';
        if ((mode & 0o007) !== 0)
            return 'world_accessible';
        return 'group_accessible';
    }
    catch {
        return existsSync(filePath) ? 'unreadable' : 'missing';
    }
}
function normalizeTaskMetrics(taskMeta) {
    const metrics = taskMeta?.['task_metrics'];
    if (!metrics || typeof metrics !== 'object')
        return null;
    const m = metrics;
    return {
        pending: finiteNumberOrNull(m['pending']),
        claimed: finiteNumberOrNull(m['claimed']),
        completed: finiteNumberOrNull(m['completed']),
        failed: finiteNumberOrNull(m['failed']),
        avg_completion_ms: finiteNumberOrNull(m['avg_completion_ms']),
    };
}
function finiteNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function unavailable(field, reason, expectedSource) {
    return { field, reason, expected_source: expectedSource };
}