// Cursor rewrite composition (#124) — the CLI layer that turns the core `cursorRewriteObserver` into a LIVE
// rewrite of `.cursor/rules/evolver.mdc`. Core owns the trigger policy (which events count + debounce); this
// layer owns the side effects core must not: reading the gene pool from the asset store and rendering+writing
// the cursor rules file via the cursorRulesInstaller.
//
// It is hung off the SAME ObserverBus that fans out from the daemon's Ingestor (autoexec.ts), exactly like the
// value-digest observer — so a real cycle solidifying a gene re-renders the cursor rules file. This is the
// cursor analogue of CC's SessionStart hook: cursor has no pull-at-start, so freshness is rewrite-on-change.
//
// Two gates keep it safe and quiet:
//   1. opt-in: it only maintains the file when the user actually installed cursor injection
//      (`evolver setup-hooks --runtime=cursor` wrote a managed evolver.mdc). No install ⇒ the observer is not
//      registered, so a non-cursor user pays nothing.
//   2. one-switch off: EVOLVER_CURSOR_REWRITE=0 disables it even when installed.
import { assetstore, events, observers } from '@evomap/evolver-core';
import { cursorRulesInstalled, rewriteCursorRules, formatCursorGeneLine } from '@evomap/evolver-mcp';
import { startResidentLoop } from './daemonLoop.js';
import { listApprovedGenes, provenanceStoreForStore, reviewLedgerForStore } from './reviewFilter.js';
/**
 * Map a stored gene asset onto the renderer's minimal CursorGene shape. Mirrors the CC SessionStart line voice
 * (id + category + a short hint = summary, else the first few signals_match) so cursor users see the same memory
 * the CC SessionStart hook would inject. Deterministic.
 */
export function geneToCursorGene(g) {
    const id = typeof g['id'] === 'string' ? String(g['id']) : String(g.asset_id);
    const summary = String(g['summary'] ?? '').replace(/\s+/g, ' ').trim();
    const hint = summary || (Array.isArray(g['signals_match']) ? g['signals_match'].slice(0, 4).join(', ') : '');
    const category = g['category'] ? String(g['category']) : undefined;
    return { id, ...(category ? { category } : {}), ...(hint ? { hint } : {}) };
}
/**
 * Build the live cursor rewrite observer from the environment. Returns enabled=false (no observer) when
 * EVOLVER_CURSOR_REWRITE=0 OR cursor injection is not installed at `projectRoot` (the user never opted in). When
 * enabled, the injected `rewrite` callback reads the current top genes from the store and re-renders
 * .cursor/rules/evolver.mdc; the installer's own idempotency makes an unchanged gene set a true no-op (no write).
 */
export function resolveCursorRewriteObserver(env = process.env, opts = {}) {
    if (env['EVOLVER_CURSOR_REWRITE'] === '0')
        return { enabled: false, reason: 'off', observer: null };
    const projectRoot = opts.projectRoot ?? process.cwd();
    // Opt-in gate: only maintain the file the user installed. cursorRulesInstalled is a cheap lstat+read of one file.
    if (!cursorRulesInstalled(projectRoot))
        return { enabled: false, reason: 'not-installed', observer: null };
    const store = opts.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = opts.review ?? reviewLedgerForStore(store); // co-located with the store, not pinned to live dir
    const provenance = opts.provenance ?? provenanceStoreForStore(store); // co-located with the store, not pinned to live dir
    const benchmark = assetstore.benchmarkContext(env['EVOLVER_BENCHMARK_ID']);
    const maxGenes = benchmark ? Math.min(opts.maxGenes ?? 8, 8) : (opts.maxGenes ?? 8);
    let lastRevision;
    const observer = observers.cursorRewriteObserver({
        ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
        // The real side effect: read the current top TRUSTED + REVIEW-APPROVED genes and re-render the rules file.
        // The gates also apply to sidecar refreshes; drafts must never reach alwaysApply rules.
        async rewrite() {
            try {
                if (benchmark && (!Number.isSafeInteger(maxGenes) || maxGenes < 1))
                    throw new Error('invalid_benchmark_gene_limit');
                // 此wiring已从env选定上下文；刷新只重读账本，不再从process.env选择另一个benchmark。
                const genes = (await assetstore.listApprovedGenes(store, review, maxGenes, provenance, { ...(benchmark ? { benchmark } : {}) })).map(geneToCursorGene);
                return rewriteCursorRules(projectRoot, genes, maxGenes);
            }
            catch (error) {
                // A damaged or unavailable qualification ledger must not leave old benchmark memory active.
                // 清空派生规则后不能继续信任旧revision，事件触发的失败同样需要轮询恢复。
                lastRevision = undefined;
                if (benchmark)
                    rewriteCursorRules(projectRoot, [], maxGenes);
                throw error;
            }
        },
    });
    let loop;
    let stopped = false;
    let started = false;
    let lastDiagnostic;
    const reconcile = async () => {
        let revision;
        try {
            revision = JSON.stringify([provenance.revision(), review.revision()]);
        }
        catch { /* Re-read through the normal gate to clear unsafe rules. */ }
        if (revision !== undefined && revision === lastRevision)
            return;
        try {
            observer.invalidate();
            await observer.flush();
            lastRevision = revision;
            lastDiagnostic = undefined;
        }
        catch (error) {
            lastRevision = undefined;
            const diagnostic = error instanceof Error ? error.message : String(error);
            if (diagnostic !== lastDiagnostic)
                process.stderr.write(`[cursor-rewrite] source reconciliation failed; retrying: ${diagnostic}\n`);
            lastDiagnostic = diagnostic;
        }
    };
    return {
        enabled: true, observer,
        async start() {
            if (started || stopped || !benchmark)
                return;
            started = true;
            // Reconcile at startup too: a qualification can change while this daemon is stopped.
            await reconcile();
            if (!stopped)
                loop = startResidentLoop({ tick: reconcile, basePollMs: opts.pollMs ?? 1000,
                    idleAware: false, runFirstImmediately: false });
        },
        async stop() {
            stopped = true;
            await loop?.stop();
            await observer.stop();
        },
    };
}
/** Re-export for the installer composition: `setup-hooks --runtime=cursor` seeds evolver.mdc with the current
 *  top REVIEW-APPROVED genes (so the file is useful immediately, before the first daemon rewrite — without
 *  seeding an unapproved draft into the always-on rules, same gate as the live rewrite). */
export async function currentTopCursorGenes(store, review, maxGenes = 8, provenance = provenanceStoreForStore(store)) {
    return (await listApprovedGenes(store, review, maxGenes, provenance)).map(geneToCursorGene);
}
export { formatCursorGeneLine };