// Value digest composition (#113) — the CLI layer that turns the core `valueDigestObserver` into a LIVE
// notification. Core owns the observer logic + the gate; this composition layer owns the side-effecting pieces
// core must not: the concrete sinks (a local markdown file + a terminal MOTD), the file-backed cadence state,
// and the summary provider wired to the adapter's price table + the proxy traces + root_events on disk.
//
// Off by default for the MOTD (it prints to the operator's terminal); the file sink always writes (cheap, local,
// inspectable). EVOLVER_VALUE_DIGEST=0 disables the digest observer entirely (the退订 one-switch the issue asks
// for). The observer is hung off the SAME ObserverBus that fans out from the Ingestor, so a real run's events
// tick the cadence check — this is the bus's first live built-in observer.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { events, observers, ops } from '@evomap/evolver-core';
import { loadPriceTable } from '@evomap/evolver-adapter-public';
/** Markdown file sink: appends each weekly digest to <home>/evolution/value-digest.md (inspectable history). */
export function fileDigestSink(path) {
    return {
        name: 'file',
        deliver(markdown, meta) {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `\n<!-- ${meta.at} -->\n${markdown}\n`, 'utf8');
        },
    };
}
/** Terminal MOTD sink: prints the digest to stdout (the operator sees it on the next daemon tick). */
export function motdDigestSink(write = (s) => process.stdout.write(s)) {
    return { name: 'motd', deliver(markdown) { write(`\n${markdown}\n`); } };
}
/** Fan a digest out to several sinks; one sink throwing does not stop the others (the bus still isolates the
 *  observer as a whole, but a single bad sink should not starve a working one). */
export function multiSink(sinks) {
    return {
        name: sinks.map((s) => s.name).join('+') || 'none',
        async deliver(markdown, meta) {
            const errs = [];
            for (const s of sinks) {
                try {
                    await s.deliver(markdown, meta);
                }
                catch (e) {
                    errs.push(e);
                }
            }
            if (errs.length === sinks.length && errs.length > 0)
                throw errs[0]; // all failed → surface to the bus DLQ
        },
    };
}
/** File-backed cadence state so "weekly" survives daemon restarts (the bus is in-process; a week is not). */
export class FileDigestState {
    path;
    constructor(path) {
        this.path = path;
    }
    lastDeliveredAt() {
        try {
            const v = JSON.parse(readFileSync(this.path, 'utf8'));
            return typeof v.lastDeliveredAt === 'number' ? v.lastDeliveredAt : undefined;
        }
        catch {
            return undefined;
        }
    }
    markDelivered(at) {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify({ lastDeliveredAt: at }), 'utf8');
    }
}
/**
 * Build the live value-digest observer from the environment, reading the SAME ledger material `evolver value`
 * reads (proxy traces + root_events) priced with the adapter's table. Returns enabled=false (no observer) when
 * EVOLVER_VALUE_DIGEST=0. The summaryProvider re-reads disk each tick so the digest reflects current state; the
 * cadence + the measured-value gate (in the core observer) keep that cheap and quiet.
 */
export function resolveValueDigestObserver(env = process.env, opts = {}) {
    if (env['EVOLVER_VALUE_DIGEST'] === '0')
        return { enabled: false, observer: null };
    const home = opts.home ?? events.evomapHome();
    const eventsPath = opts.eventsPath ?? events.rootEventsPath();
    const tracesDir = opts.tracesDir ?? events.tracesDir();
    const prices = loadPriceTable();
    const sinks = [fileDigestSink(join(home, 'evolution', 'value-digest.md'))];
    if (opts.motd ?? env['EVOLVER_VALUE_DIGEST_MOTD'] === '1')
        sinks.push(motdDigestSink());
    const observer = observers.valueDigestObserver({
        summaryProvider: (window) => ops.loadValueSummary({
            traces: ops.readTraceRecords(tracesDir),
            events: events.readEvents(eventsPath),
            prices,
        }, window),
        sink: multiSink(sinks),
        state: new FileDigestState(join(home, 'evolution', 'value-digest-state.json')),
    });
    return { enabled: true, observer };
}