// Solo-mode detection, source-level lockdown, and banner for `evolver autoexec --solo`.
//
// Solo = the "constrained wild" profile: the immediacy of Mad Dog (no human-
// review gate) plus four mechanical backstops — offline, ATP disabled, per-cycle
// git snapshot/rollback, and a consecutive-failure circuit breaker.
//
// The lockdown mutates process.env IN-PROCESS before autoexec reads any gate, so
// that BOTH the startup wiring and any in-cycle path see the network + ATP as
// disabled. These are OVERWRITES, not defaults: under --solo a user cannot re-
// enable hub/ATP by setting the env themselves — that is the "no escape valve"
// requirement. Numeric knobs (EVOLVER_SOLO_MAX_FAILS) stay tunable; the four
// safety cuts do not.
export const SOLO_DEFAULT_MAX_FAILS = 5;
/** True when this autoexec invocation is solo (CLI flag or explicit env). */
export function isSoloRun(argv, env = process.env) {
    return argv.includes('--solo') || env['EVOLVER_SOLO'] === '1';
}
/** Circuit-breaker threshold; tunable via EVOLVER_SOLO_MAX_FAILS, clamped to >= 1. */
export function soloMaxFails(env = process.env) {
    const raw = Number(env['EVOLVER_SOLO_MAX_FAILS']);
    return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : SOLO_DEFAULT_MAX_FAILS;
}
/**
 * Hard-cut the network + autonomous spend at the source, in-process. Returns the
 * keys it forced (for logging/tests). Idempotent.
 */
export function applySoloLockdown(env = process.env) {
    const forced = {
        // Offline: the hub-reuse + question links are gated on this flag; forcing it
        // off means resolveHubLink/resolveHubQuestionLink return undefined → zero hub calls.
        EVOLVER_REUSE_BEFORE_SOLVE: '0',
        EVOLVER_REUSE_SIGNAL: '0',
        // ATP: disable autonomous spend on every path (autobuy + autodeliver).
        EVOLVER_ATP: 'off',
        EVOLVER_ATP_AUTOBUY: 'off',
        EVOLVER_ATP_AUTODELIVER: 'off',
        EVOLVER_LEARNING_TRACE_UPLOAD: '0',
        // Empty hub creds so any lower-level connector short-circuits.
        A2A_HUB_URL: '',
        EVOMAP_HUB_URL: '',
        // MemoryGraph event mirror is hub telemetry too. Force it off even when a
        // token.json remains on disk and the public adapter could fall back to the
        // compiled default Hub URL.
        MEMORY_GRAPH_SYNC_HUB: '0',
        EVOLVER_MEMORY_GRAPH_SYNC_HUB: '0',
    };
    for (const [k, v] of Object.entries(forced))
        env[k] = v;
    return forced;
}
/** The solo startup banner lines (returned so the caller writes them and tests assert them). */
export function soloBanner(repoRoot) {
    return [
        '════════════════════════════════════════════════════════',
        '[Solo] Mad Dog · 受约束的野性模式已启动',
        '[Solo] 兜底四道：断网 · 禁ATP · 每 cycle git 快照/失败回滚 · 连续失败熔断',
        '[Solo] 默认免人审。目标仓：' + repoRoot,
        '[Solo] 无 hub 审计，仅本地 git 可追溯。',
        '════════════════════════════════════════════════════════',
    ];
}