// First-run prompt that introduces the ATP auto-buyer to INTERACTIVE users (PORT v1 #10).
//
// v2 already owns the consent substrate (atp.ts: getAtpConsent/setAtpConsent/atpConsentPath, the same
// `atp-autobuy-ack.json` ack file). What it lacked is the onboarding seam: a one-shot prompt that surfaces the
// opt-in instead of expecting every operator to discover `evolver atp enable`. This module is that seam — it does
// NOT introduce a new ack format or a second source of truth; it writes through setAtpConsent so the prompt's
// decision and the `evolver atp` command land in the exact same file with the exact same precedence.
//
// Fires only when ALL hold (mirrors v1, but classified through getAtpConsent's source so the precedence can't
// drift from the gate):
//   - EVOLVER_ATP_AUTOBUY is unset (a set env always wins → nothing to ask)
//   - stdin is a TTY (skipped under systemd / Docker / CI — exactly where a blocking question would wedge a daemon)
//   - no ack file yet (the operator has not already decided)
//
// Outcomes:
//   - y / yes  -> ack enabled=true,  EVOLVER_ATP_AUTOBUY flipped to 'on' for this process (opt in now)
//   - n / no   -> ack enabled=false, never prompted again
//   - anything -> no file written, prompted again next run ("later")
import { createInterface } from 'node:readline';
import { atpConsentPath, getAtpConsent, setAtpConsent } from './atp.js';
const DEFAULT_AUTOBUY_PROMPT_TIMEOUT_MS = 10_000;
/**
 * Decide whether the prompt is eligible. Precedence (env_set > non_tty > ack_present > eligible) is read straight
 * off getAtpConsent's `source` so it stays bug-for-bug aligned with the runtime gate: a set env => source 'env'
 * regardless of any ack file, and an ack file (env unset) => source 'ack'. We classify env BEFORE TTY so a daemon
 * with the env already set reports 'env_set' (the actionable truth) rather than the generic 'non_tty'.
 */
export function classifyAutobuyPrompt(env, stdin, ackPath = atpConsentPath(env)) {
    const consent = getAtpConsent(env, ackPath);
    if (consent.source === 'env')
        return 'env_set';
    if (!stdin || !stdin.isTTY)
        return 'non_tty';
    if (consent.source === 'ack')
        return 'ack_present';
    return 'eligible';
}
/**
 * Default reader: a single readline question, settled exactly once. The 'close' handler covers EOF/Ctrl-D, and the
 * bounded timer covers open pseudo-TTYs where no operator ever types. Both fall through to '' -> the caller's safe
 * 'later' branch (no ack written, env untouched).
 */
export function defaultAsk(question, io, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs !== undefined && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_AUTOBUY_PROMPT_TIMEOUT_MS;
    return new Promise((resolve) => {
        const rl = createInterface({ input: io.input, output: io.output });
        let settled = false;
        const timer = setTimeout(() => settle(''), timeoutMs);
        function settle(answer) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rl.close();
            resolve((answer || '').trim().toLowerCase());
        }
        rl.on('close', () => settle('')); // EOF / Ctrl-D: settle as '' (later) and never leak the interface
        rl.question(question, (answer) => settle(answer));
    });
}
/**
 * Run the first-run auto-buyer prompt at most once per `evolver autoexec` invocation, BEFORE the resident loop
 * starts. A no-op (no I/O, no file) on every non-eligible branch. Callers should wrap in try/catch so a prompt
 * failure can never block the run — see runAutoExec.
 */
export async function runAutobuyPrompt(opts = {}) {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    const env = opts.env ?? process.env;
    const ask = opts.ask ?? defaultAsk;
    const ackPath = opts.consentPath ?? atpConsentPath(env);
    const state = classifyAutobuyPrompt(env, input, ackPath);
    if (state !== 'eligible')
        return { prompted: false, decision: null, reason: state };
    try {
        output.write('\n');
        output.write('[ATP-AutoBuyer] During autonomous execution your evolver can place small ATP\n');
        output.write('orders to fill a capability gap, instead of solving it from scratch (default OFF).\n');
        output.write('  - manual `evolver buy` is unaffected — this is only the autonomous spend path.\n');
        output.write('  - change anytime:  `evolver atp enable|disable|status`\n');
        output.write('  - or set EVOLVER_ATP_AUTOBUY=on|off to override the ack file at runtime.\n');
        output.write('\n');
    }
    catch {
        return { prompted: false, decision: null, reason: 'io_error' };
    }
    let answer;
    try {
        answer = await ask('Enable autoBuyer for this session? [y/n/later] ', { input, output }, {
            timeoutMs: opts.promptTimeoutMs ?? DEFAULT_AUTOBUY_PROMPT_TIMEOUT_MS,
        });
    }
    catch {
        return { prompted: true, decision: null, reason: 'ask_error' };
    }
    const now = opts.now ?? (() => new Date());
    if (answer === 'y' || answer === 'yes') {
        setAtpConsent(true, ackPath, now);
        env['EVOLVER_ATP_AUTOBUY'] = 'on';
        return { prompted: true, decision: 'yes', reason: 'user_accepted' };
    }
    if (answer === 'n' || answer === 'no') {
        setAtpConsent(false, ackPath, now);
        return { prompted: true, decision: 'no', reason: 'user_declined' };
    }
    return { prompted: true, decision: 'later', reason: 'user_postponed' };
}