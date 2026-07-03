// `evolver recall` — run the recallVerifier primitive (#204) over a real session transcript so an operator can
// SEE which injected genes the agent actually used. Manual entry point for the inject->recall attribution loop
// Genes come either from explicit `--gene <id>` flags or, with `--from-inject`, from the value.inject event tied to
// THIS transcript: the inject is stamped with the runtime session id (#205) and the Claude Code transcript is named
// `<session_id>.jsonl`, so recall matches them by session id (falling back to the most-recent inject for un-stamped
// events / runtimes with no id). Pure logic lives in evolver-core/ops/recall; this module is the IO glue (read
// transcript -> turns, resolve genes from the store, pull geneIds off the matching inject event).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assetstore, events, ops } from '@evomap/evolver-core';
import { adapterForPath } from '@evomap/evolver-runtime-adapters';
/** Claude Code names a transcript `<session_id>.jsonl`, so the basename (minus extension) is the session id used to
 *  match the inject event that produced THIS session (#205). Other runtimes' names simply won't match any stamped
 *  sessionId, and the caller falls back to the most-recent inject — safe, never wrong, just less precise. */
export function sessionIdFromTranscript(p) {
    const base = basename(p).replace(/\.jsonl$/i, '');
    return base.length > 0 ? base : undefined;
}
/** Pick the `value.inject` event for this run: the latest (max seq) one STAMPED with `sessionId` when that matches
 *  the transcript's session (#205 precise tie), else the latest inject overall (back-compat for un-stamped events
 *  and runtimes with no session id). Returns undefined when there is no inject event at all. */
export function pickInjectEvent(evts, sessionId) {
    let bestMatch;
    let bestAny;
    for (const e of evts) {
        if (e.type !== ops.VALUE_INJECT_EVENT)
            continue;
        if (bestAny === undefined || e.seq > bestAny.seq)
            bestAny = e;
        if (sessionId !== undefined && e.payload?.['sessionId'] === sessionId && (bestMatch === undefined || e.seq > bestMatch.seq))
            bestMatch = e;
    }
    return bestMatch ?? bestAny;
}
export function geneIdsOf(e) {
    const ids = e?.payload?.['geneIds'];
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
}
export function geneFromAsset(a) {
    // Report under the logical id when present (the `gene-a` id value.inject records), else the content asset_id.
    const geneId = typeof a['id'] === 'string' ? String(a['id']) : String(a.asset_id);
    const strategy = Array.isArray(a['strategy']) ? a['strategy'].filter((s) => typeof s === 'string') : undefined;
    const summary = typeof a['summary'] === 'string' ? a['summary'] : undefined;
    return { geneId, ...(strategy ? { strategy } : {}), ...(summary ? { summary } : {}) };
}
// Resolve a --gene argument to its Gene asset, mirroring `evolver review`: an asset_id (sha256:…) hits the index
// directly (guarded to type Gene, since asset_id is a content hash), while a LOGICAL id (the `gene-a` style id that
// value.inject records in geneIds) falls back to a bounded Gene-only scan. Resolving via asset_id ALONE would report
// every inject-logged logical id as "not found" even when the gene exists — exactly the id an operator would paste in.
export async function resolveGene(store, id) {
    let g = id.startsWith('sha256:') ? await store.get(id) : null;
    if (g && g.type !== 'Gene')
        g = null;
    if (!g) {
        const genes = await store.list('Gene', 1000);
        g = genes.find((x) => String(x['id']) === id || String(x.asset_id) === id) ?? null;
    }
    return g;
}
/** Parse argv: positional <transcript> + repeatable `--gene <assetId>` + `--from-inject`. */
function parseArgs(argv) {
    const geneIds = [];
    let transcript;
    let fromInject = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--gene') {
            const v = argv[++i];
            if (v)
                geneIds.push(v);
            continue;
        }
        if (a === '--from-inject') {
            fromInject = true;
            continue;
        }
        if (!a.startsWith('-') && transcript === undefined)
            transcript = a;
    }
    return { ...(transcript !== undefined ? { transcript } : {}), geneIds, fromInject };
}
export async function runRecall(argv, deps = {}) {
    const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
    const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
    const { transcript, geneIds, fromInject } = parseArgs(argv);
    // --from-inject: pull the geneIds off the most recent value.inject root_event so the operator does not have to
    // retype them (a semi-automatic step toward the auto-loop, which still needs the inject<->session key #205 to
    // pick the RIGHT inject for THIS transcript). Union with any explicit --gene; dedupe preserving order.
    if (fromInject) {
        const evts = (deps.readEvents ?? events.readEvents)();
        const wantSession = transcript ? sessionIdFromTranscript(transcript) : undefined;
        const picked = pickInjectEvent(evts, wantSession);
        const fromEvent = geneIdsOf(picked);
        // Empty inject is fatal only when there is nothing else to run; with explicit --gene present, honour the union
        // and continue (just warn) rather than discarding the genes the operator typed.
        if (fromEvent.length === 0) {
            if (geneIds.length === 0) {
                err('recall: --from-inject found no value.inject event with geneIds');
                return 1;
            }
            err('recall: --from-inject found no value.inject geneIds; proceeding with explicit --gene only');
        }
        else if (wantSession !== undefined && picked?.payload?.['sessionId'] !== wantSession
            && evts.some((e) => e.type === ops.VALUE_INJECT_EVENT && typeof e.payload?.['sessionId'] === 'string')) {
            // Stamping IS in use (some inject carries a sessionId) but none matched this transcript's session, so the
            // genes come from the most-recent inject, not the one provably tied to this transcript. Stay silent when NO
            // inject is stamped at all (the precise-match path is simply dormant — e.g. pre-#205 events).
            err(`recall: no value.inject matched session ${wantSession}; using the most recent inject instead`);
        }
        for (const id of fromEvent)
            if (!geneIds.includes(id))
                geneIds.push(id);
    }
    if (!transcript || geneIds.length === 0) {
        err('用法: evolver recall <session-transcript> (--gene <id> ... | --from-inject)');
        return 2;
    }
    let content;
    try {
        content = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(transcript);
    }
    catch (e) {
        err(`recall: cannot read ${transcript}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    const parse = deps.parseTranscript ?? ((p, c) => (adapterForPath(p)?.parse(c) ?? []));
    const parsed = parse(transcript, content);
    if (parsed.length === 0) {
        err(`recall: no turns parsed from ${transcript} (unrecognized session format?)`);
        return 1;
    }
    // Drop meta turns (heartbeats, NO_REPLY, empty) before scoring: they are not substantive agent output, so
    // counting them would inflate overlap and, worse, flip a heartbeat-only session from 'unknown' (no judgeable
    // output) to 'unused'. Keep the format-recognition check above on the RAW parse so "only meta" is not mistaken
    // for "unrecognized format" — a transcript of pure heartbeats correctly yields 'unknown' per gene.
    const turns = parsed.filter((t) => !t.isMeta).map((t) => ({ role: t.role, text: t.text }));
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const genes = [];
    for (const id of geneIds) {
        const a = await resolveGene(store, id);
        if (!a) {
            err(`recall: gene not found in local store: ${id}`);
            continue;
        }
        genes.push(geneFromAsset(a));
    }
    if (genes.length === 0) {
        err('recall: no resolvable genes');
        return 1;
    }
    const results = ops.verifyInjectedGenes(genes, turns);
    const sum = ops.summarizeRecall(results);
    for (const r of results) {
        log(`${r.recalled.toUpperCase().padEnd(7)} ${r.geneId}  score=${r.score.toFixed(2)}  matched=[${r.matched.join(', ')}]`);
    }
    log(`recall: ${sum.used} used / ${sum.unused} unused / ${sum.unknown} unknown of ${sum.total}`);
    if (sum.pruneCandidates.length > 0)
        log(`prune candidates (injected but unused): ${sum.pruneCandidates.join(', ')}`);
    return 0;
}
/** Registry-shaped handler (argv -> exit code). */
export const runRecallCommand = (argv) => runRecall(argv);