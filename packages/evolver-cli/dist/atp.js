import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { events, mailbox } from '@evomap/evolver-core';
import { AtpHubClient, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES, connectPublicHub, globalFetchLike, } from '@evomap/evolver-adapter-public';
export function parseBuyArgs(args) {
    if (args.length === 0)
        return { ok: false, error: 'buy requires <capabilities>: comma-separated list (e.g. code_review,bug_fix)' };
    const capabilitiesRaw = firstPositional(args);
    if (!capabilitiesRaw)
        return { ok: false, error: 'buy requires <capabilities>: comma-separated list' };
    const capabilities = capabilitiesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (capabilities.length === 0)
        return { ok: false, error: `no valid capabilities parsed from: ${capabilitiesRaw}` };
    const budget = Math.max(1, Math.round(Number(parseNamed(args, '--budget', '-b')) || 10));
    const routingMode = enumArg(parseNamed(args, '--routing') ?? 'fastest', ATP_ROUTING_MODES, '--routing');
    if (!routingMode.ok)
        return routingMode;
    const verifyMode = enumArg(parseNamed(args, '--verify') ?? 'auto', ATP_VERIFY_MODES, '--verify');
    if (!verifyMode.ok)
        return verifyMode;
    const timeoutRaw = parseNamed(args, '--timeout');
    const timeoutMs = timeoutRaw ? Math.max(1000, Math.round(Number(timeoutRaw) * 1000)) : 300_000;
    return {
        ok: true,
        opts: {
            capabilities,
            budget,
            question: parseNamed(args, '--question', '-q') ?? '',
            routingMode: routingMode.value,
            verifyMode: verifyMode.value,
            noWait: args.includes('--no-wait'),
            timeoutMs,
        },
    };
}
export function parseOrdersArgs(args) {
    const role = enumArg(parseNamed(args, '--role') ?? 'consumer', ATP_ROLES, '--role');
    if (!role.ok)
        return role;
    const statusRaw = parseNamed(args, '--status');
    if (statusRaw !== null) {
        const status = enumArg(statusRaw, ATP_PROOF_STATUSES, '--status');
        if (!status.ok)
            return status;
    }
    const limitRaw = parseNamed(args, '--limit');
    const limit = limitRaw ? Math.max(1, Math.min(100, Math.round(Number(limitRaw)))) : 20;
    return { ok: true, opts: { role: role.value, status: statusRaw, limit, jsonOut: args.includes('--json') } };
}
export function parseVerifyArgs(args) {
    const orderId = firstPositional(args);
    if (!orderId)
        return { ok: false, error: 'verify requires <orderId>' };
    const action = enumArg(parseNamed(args, '--action') ?? 'confirm', ATP_VERIFY_ACTIONS, '--action');
    if (!action.ok)
        return action;
    return { ok: true, opts: { orderId, action: action.value } };
}
export function parseAtpArgs(args) {
    const sub = firstPositional(args)?.toLowerCase();
    if (sub !== 'enable' && sub !== 'disable' && sub !== 'status') {
        return { ok: false, error: `atp subcommand must be enable|disable|status (got: ${sub ?? '-'})` };
    }
    return { ok: true, opts: { sub } };
}
export async function runBuy(opts, deps = {}) {
    const client = deps.client ?? createAtpClientFromEnv(deps.env);
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    log(`[ATP] Placing order: capabilities=${opts.capabilities.join(',')} budget=${opts.budget} mode=${opts.routingMode}`);
    try {
        // Manual `buy` is explicit consent, but it STILL goes through the single enforced gate (#177) so the spend
        // path is the same chokepoint a future autonomous caller must use (and be gated by recorded consent).
        const order = await placeAtpOrderWithConsent(client, {
            capabilities: opts.capabilities,
            budget: opts.budget,
            routingMode: opts.routingMode,
            verifyMode: opts.verifyMode,
            question: opts.question,
        }, { explicit: true, ...(deps.env ? { env: deps.env } : {}), ...(deps.consentPath ? { consentPath: deps.consentPath } : {}) });
        if (!order.ok) {
            err(`[ATP] Order failed: ${order.error ?? 'unknown'}`);
            return { exitCode: 1, data: order };
        }
        const orderId = orderIdFrom(order.data);
        log(`[ATP] Order placed: ${orderId ?? '(id pending)'}`);
        if (opts.noWait || !orderId)
            return { exitCode: 0, data: order.data };
        const deadline = Date.now() + opts.timeoutMs;
        while (Date.now() < deadline) {
            await sleep(opts.pollIntervalMs ?? 10_000);
            const status = await client.getOrderStatus(orderId);
            if (!status.ok)
                continue;
            const proofStatus = proofStatusFrom(status.data);
            if (proofStatus === 'settled' || (proofStatus === 'verified' && opts.verifyMode === 'auto')) {
                log(`[ATP] Order settled: ${orderId}`);
                return { exitCode: 0, data: { order: order.data, finalStatus: status.data } };
            }
            if (proofStatus === 'disputed') {
                err(`[ATP] Order lifecycle failed: order_disputed`);
                return { exitCode: 1, data: { order: order.data, finalStatus: status.data }, error: 'order_disputed' };
            }
        }
        err('[ATP] Order lifecycle failed: order_timeout');
        return { exitCode: 1, data: order.data, error: 'order_timeout' };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`[ATP] buy error: ${msg}`);
        return { exitCode: 1, error: msg };
    }
}
export async function runOrders(opts, deps = {}) {
    const client = deps.client ?? createAtpClientFromEnv(deps.env);
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
    try {
        const query = { role: opts.role, limit: opts.limit };
        if (opts.status !== null)
            query.status = opts.status;
        const result = await client.listProofs(query);
        if (!result.ok) {
            err(`[ATP] listProofs failed: ${result.error ?? 'unknown'}`);
            return { exitCode: 1, data: result };
        }
        const proofs = proofsFrom(result.data);
        if (opts.jsonOut) {
            log(JSON.stringify(proofs, null, 2));
            return { exitCode: 0, data: proofs };
        }
        if (proofs.length === 0) {
            log(`[ATP] No orders found for role=${opts.role}${opts.status ? ` status=${opts.status}` : ''}`);
            return { exitCode: 0, data: [] };
        }
        log(`[ATP] Showing ${proofs.length} order(s):`);
        for (const p of proofs) {
            const row = asRecord(p);
            const id = row?.['taskId'] ?? row?.['order_id'] ?? row?.['id'] ?? '(unknown)';
            const status = row?.['status'] ?? row?.['proof_status'] ?? 'unknown';
            const when = row?.['createdAt'] ?? row?.['created_at'] ?? 'unknown';
            log(`  - ${String(id)} | status=${String(status)} | created=${String(when)}`);
        }
        return { exitCode: 0, data: proofs };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`[ATP] orders error: ${msg}`);
        return { exitCode: 1, error: msg };
    }
}
export async function runVerify(opts, deps = {}) {
    const client = deps.client ?? createAtpClientFromEnv(deps.env);
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
    try {
        const result = await client.verifyDelivery(opts.orderId, opts.action);
        if (!result.ok) {
            err(`[ATP] verify failed: ${result.error ?? 'unknown'}`);
            return { exitCode: 1, data: result };
        }
        log(`[ATP] verify ok (${opts.action}): ${JSON.stringify(result.data ?? {})}`);
        return { exitCode: 0, data: result.data };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`[ATP] verify error: ${msg}`);
        return { exitCode: 1, error: msg };
    }
}
export async function runAtp(opts, deps = {}) {
    const env = deps.env ?? process.env;
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
    const ackPath = deps.consentPath ?? atpConsentPath(env);
    try {
        if (opts.sub === 'status') {
            const consent = getAtpConsent(env, ackPath);
            log(`[ATP] auto-spend: ${consent.enabled ? 'ENABLED' : 'DISABLED'}  (source: ${consent.source})`);
            log(`      ack file: ${consent.ackPath}`);
            return { exitCode: 0, data: consent };
        }
        const enabled = opts.sub === 'enable';
        const body = setAtpConsent(enabled, ackPath, deps.now ?? (() => new Date()));
        log(`[ATP] auto-spend ${enabled ? 'ENABLED' : 'DISABLED'} (consent recorded ${body.acknowledged_at}).`);
        log('      Manual `evolver buy` orders are unaffected; this ack is for future auto-buyer wiring.');
        const override = envOverride(env);
        if (override !== null && override !== enabled) {
            const label = override ? 'on' : 'off';
            log('');
            log(`[ATP] WARNING: EVOLVER_ATP_AUTOBUY=${env['EVOLVER_ATP_AUTOBUY']} is set and will OVERRIDE the ack file at runtime.`);
            return { exitCode: 0, data: body, envOverride: label };
        }
        return { exitCode: 0, data: body };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        err(`[ATP] atp command error: ${msg}`);
        return { exitCode: 1, error: msg };
    }
}
export async function runBuyCommand(argv) {
    const parsed = parseBuyArgs(argv);
    if (!parsed.ok)
        return usageError(parsed.error);
    return (await runBuy(parsed.opts)).exitCode;
}
export async function runOrdersCommand(argv) {
    const parsed = parseOrdersArgs(argv);
    if (!parsed.ok)
        return usageError(parsed.error);
    return (await runOrders(parsed.opts)).exitCode;
}
export async function runVerifyCommand(argv) {
    const parsed = parseVerifyArgs(argv);
    if (!parsed.ok)
        return usageError(parsed.error);
    return (await runVerify(parsed.opts)).exitCode;
}
export async function runAtpCommand(argv) {
    const parsed = parseAtpArgs(argv);
    if (!parsed.ok)
        return usageError(parsed.error);
    return (await runAtp(parsed.opts)).exitCode;
}
export function createAtpClientFromEnv(env = process.env) {
    const hubUrl = env['EVOMAP_HUB_URL'] ?? 'https://evomap.ai';
    const evomapDir = resolveAtpHome(env);
    const resolvedSenderId = resolveAtpSenderId(env);
    const senderId = () => resolvedSenderId;
    const nodeSecret = env['EVOMAP_NODE_SECRET']?.trim();
    const connected = nodeSecret
        ? connectPublicHub({ hubUrl, authMode: 'legacy', evomapDir, nodeSecret, senderId })
        : connectPublicHub({ hubUrl, authMode: 'oauth', evomapDir, senderId });
    return new AtpHubClient({ baseUrl: hubUrl, auth: connected.auth, fetchFn: globalFetchLike, senderId });
}
export function resolveAtpHome(env = process.env) {
    return env['EVOMAP_DIR'] ?? env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? events.evomapHome();
}
export function atpConsentPath(env = process.env) {
    return join(resolveAtpHome(env), 'evolution', 'atp-autobuy-ack.json');
}
export function getAtpConsent(env = process.env, ackPath = atpConsentPath(env)) {
    const override = envOverride(env);
    if (override !== null)
        return { enabled: override, source: 'env', ackPath };
    const ack = readAck(ackPath);
    if (ack)
        return { enabled: ack.enabled, source: 'ack', ackPath };
    return { enabled: false, source: 'default', ackPath };
}
/** Thrown when an autonomous (non-explicit) spend is attempted without recorded/enabled auto-spend consent (#177). */
export class AtpSpendConsentError extends Error {
    source;
    constructor(source) {
        super(`autonomous ATP spend refused: auto-spend consent is disabled (source: ${source}) — run \`evolver atp enable\` (or set the consent env) before any autonomous spending path`);
        this.source = source;
        this.name = 'AtpSpendConsentError';
    }
}
/**
 * THE single enforced consent gate every ATP spend path MUST pass through (#177). One door, two callers:
 *  - explicit (a human ran `evolver buy`) → the invocation IS the consent, allowed through.
 *  - autonomous (future auto-buy / autoexec auto-order / swarm purchase) → must have getAtpConsent().enabled,
 *    else refused. This keeps consent enforcement UPSTREAM of money movement instead of a read-only status bit
 *    each caller might forget to check (the latent money-safety hole autogame-17 flagged). Any new autonomous
 *    spending path is required to call this (NOT client.placeOrder directly) — see placeAtpOrderWithConsent.
 */
export function assertAtpSpendConsent(opts = {}) {
    if (opts.explicit)
        return; // a human explicitly invoked the spend → explicit consent (still through this door)
    const env = opts.env ?? process.env;
    const consent = getAtpConsent(env, opts.consentPath ?? atpConsentPath(env));
    if (!consent.enabled)
        throw new AtpSpendConsentError(consent.source);
}
/**
 * Place an ATP order through the enforced consent gate (#177) — the composition layer money movement goes
 * through so consent can't be bypassed. Manual `buy` passes explicit:true; an autonomous caller omits it and is
 * gated by recorded/env consent. Throws AtpSpendConsentError before any order is placed when refused.
 */
export async function placeAtpOrderWithConsent(client, order, consent = {}) {
    assertAtpSpendConsent(consent); // throws AtpSpendConsentError → a rejected promise (async), before any spend
    return client.placeOrder(order);
}
export function setAtpConsent(enabled, ackPath = atpConsentPath(), now = () => new Date()) {
    const body = { enabled, acknowledged_at: now().toISOString(), version: 1 };
    mkdirSync(dirname(ackPath), { recursive: true });
    const tmp = `${ackPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, ackPath);
    return body;
}
export function resolveAtpSenderId(env = process.env) {
    const direct = env['EVOMAP_NODE_ID']?.trim();
    if (direct)
        return direct;
    for (const p of proxyStoreCandidates(env)) {
        if (!existsSync(p))
            continue;
        try {
            const store = new mailbox.MailboxStore({ path: p });
            const nodeId = store.getState('node_id');
            store.close();
            if (nodeId)
                return nodeId;
        }
        catch {
            // Best effort only: a corrupt or locked proxy store must not prevent manual ATP commands.
        }
    }
    return undefined;
}
export function printAtpUsage() {
    return [
        'ATP subcommands:',
        `  evolver buy <caps> [--budget=N] [--question "..."] [--routing=${ATP_ROUTING_MODES.join('|')}]`,
        `              [--verify=${ATP_VERIFY_MODES.join('|')}] [--no-wait] [--timeout=<seconds>]`,
        `  evolver orders [--role=${ATP_ROLES.join('|')}] [--status=${ATP_PROOF_STATUSES.join('|')}]`,
        '                 [--limit=N] [--json]',
        `  evolver verify <orderId> [--action=${ATP_VERIFY_ACTIONS.join('|')}]`,
        '  evolver atp <enable|disable|status>   -- manage auto-spend consent',
    ].join('\n');
}
function parseNamed(args, longFlag, shortFlag) {
    const flags = shortFlag ? [longFlag, shortFlag] : [longFlag];
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === undefined)
            continue;
        for (const flag of flags) {
            if (token === flag) {
                const next = args[i + 1];
                return next && !next.startsWith('--') ? next : null;
            }
            if (token.startsWith(`${flag}=`))
                return token.slice(flag.length + 1);
        }
    }
    return null;
}
function firstPositional(args) {
    return args.find((a) => typeof a === 'string' && !a.startsWith('--')) ?? null;
}
function enumArg(value, allowed, flag) {
    if (allowed.includes(value))
        return { ok: true, value: value };
    return { ok: false, error: `invalid ${flag}: ${value} (expected ${allowed.join('|')})` };
}
function usageError(msg) {
    process.stderr.write(`${msg}\n${printAtpUsage()}\n`);
    return 1;
}
function orderIdFrom(value) {
    const rec = asRecord(value);
    const raw = rec?.['order_id'] ?? rec?.['orderId'] ?? rec?.['id'];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
function proofStatusFrom(value) {
    const rec = asRecord(value);
    const raw = rec?.['proof_status'] ?? rec?.['status'];
    return typeof raw === 'string' ? raw : undefined;
}
function proofsFrom(value) {
    if (Array.isArray(value))
        return value;
    const rec = asRecord(value);
    const proofs = rec?.['proofs'] ?? rec?.['orders'] ?? rec?.['results'];
    return Array.isArray(proofs) ? proofs : [];
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function readAck(path) {
    try {
        if (!existsSync(path))
            return null;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const rec = asRecord(parsed);
        return typeof rec?.['enabled'] === 'boolean' ? { enabled: rec['enabled'] } : null;
    }
    catch {
        return null;
    }
}
// Allowlist-to-ENABLE on a money/spend gate: this toggles AUTONOMOUS spending, so only an explicit enable value
// turns it on. The old denylist ("anything not off/0/false = enabled") fail-OPENed on ambiguous values — e.g.
// EVOLVER_ATP_AUTOBUY=no / disable / disabled / n all enabled auto-spend, the opposite of the operator's intent.
// Unrecognized values now fail CLOSED (not enabled) rather than green-light spending on a typo.
function envOverride(env) {
    const raw = env['EVOLVER_ATP_AUTOBUY'];
    if (typeof raw !== 'string')
        return null;
    const s = raw.trim().toLowerCase();
    if (!s)
        return null;
    if (s === 'on' || s === '1' || s === 'true' || s === 'yes' || s === 'enable' || s === 'enabled')
        return true;
    if (s === 'off' || s === '0' || s === 'false' || s === 'no' || s === 'disable' || s === 'disabled' || s === 'none')
        return false;
    return false; // ambiguous value on a spend gate → fail closed (never auto-enable spending on an unexpected/typo value)
}
function proxyStoreCandidates(env) {
    const home = resolveAtpHome(env);
    const candidates = [
        env['EVOLVER_PROXY_STORE'],
        join(home, 'proxy', 'mailbox.db'),
        join(env['HOME'] ?? homedir(), '.evomap', 'proxy', 'mailbox.db'),
    ].filter((x) => typeof x === 'string' && x.length > 0);
    return [...new Set(candidates)];
}