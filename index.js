const evolve = require('./src/evolve');
const { solidify } = require('./src/gep/solidify');
const path = require('path');
// Hardened Env Loading: Ensure .env is loaded before anything else
try { require('dotenv').config({ path: path.resolve(__dirname, './.env') }); } catch (e) { console.warn('[Evolver] Warning: dotenv not found or failed to load .env'); }
const fs = require('fs');
const { spawn } = require('child_process');

function sleepMs(ms) {
  const n = parseInt(String(ms), 10);
  const t = Number.isFinite(n) ? Math.max(0, n) : 0;
  return new Promise(resolve => setTimeout(resolve, t));
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function rejectPendingRun(statePath) {
  try {
    const { getRepoRoot } = require('./src/gep/paths');
    const { execSync } = require('child_process');
    const repoRoot = getRepoRoot();

    execSync('git checkout -- .', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
    execSync('git clean -fd', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    console.warn('[Loop] Pending run rollback failed: ' + (e.message || e));
  }

  try {
    const state = readJsonSafe(statePath);
    if (state && state.last_run && state.last_run.run_id) {
      state.last_solidify = {
        run_id: state.last_run.run_id,
        rejected: true,
        reason: 'loop_bridge_disabled_autoreject',
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
      return true;
    }
  } catch (e) {
    console.warn('[Loop] Failed to clear pending run state: ' + (e.message || e));
  }

  return false;
}

function isPendingSolidify(state) {
  const lastRun = state && state.last_run ? state.last_run : null;
  const lastSolid = state && state.last_solidify ? state.last_solidify : null;
  if (!lastRun || !lastRun.run_id) return false;
  if (!lastSolid || !lastSolid.run_id) return true;
  return String(lastSolid.run_id) !== String(lastRun.run_id);
}

function parseMs(v, fallback) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (Number.isFinite(n)) return Math.max(0, n);
  return fallback;
}

// Singleton Guard - prevent multiple evolver daemon instances
function acquireLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    if (fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        console.log('[Singleton] Corrupt lock file (invalid PID). Taking over.');
      } else {
        try {
          process.kill(pid, 0);
          console.log(`[Singleton] Evolver loop already running (PID ${pid}). Exiting.`);
          return false;
        } catch (e) {
          console.log(`[Singleton] Stale lock found (PID ${pid}). Taking over.`);
        }
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    return true;
  } catch (err) {
    console.error('[Singleton] Lock acquisition failed:', err);
    return false;
  }
}

function releaseLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    if (fs.existsSync(lockFile)) {
       const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
       if (pid === process.pid) fs.unlinkSync(lockFile);
    }
  } catch (e) { /* ignore */ }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const isLoop = args.includes('--loop') || args.includes('--mad-dog');

  if (command === 'run' || command === '/evolve' || isLoop) {
    console.log('Starting capability evolver...');
    
    if (isLoop) {
        // Internal daemon loop (no wrapper required).
        if (!acquireLock()) process.exit(0);
        process.on('exit', releaseLock);
        process.on('SIGINT', () => { releaseLock(); process.exit(); });
        process.on('SIGTERM', () => { releaseLock(); process.exit(); });

        process.env.EVOLVE_LOOP = 'true';
        process.env.EVOLVE_BRIDGE = 'false';
        console.log('Loop mode enabled (internal daemon).');

        const { getEvolutionDir } = require('./src/gep/paths');
        const solidifyStatePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');

        const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
        const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
        const idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
        const pendingSleepMs = parseMs(
          process.env.EVOLVE_PENDING_SLEEP_MS ||
            process.env.EVOLVE_MIN_INTERVAL ||
            process.env.FEISHU_EVOLVER_INTERVAL,
          120000
        );

        const maxCyclesPerProcess = parseMs(process.env.EVOLVER_MAX_CYCLES_PER_PROCESS, 100) || 100;
        const maxRssMb = parseMs(process.env.EVOLVER_MAX_RSS_MB, 500) || 500;
        const suicideEnabled = String(process.env.EVOLVER_SUICIDE || '').toLowerCase() !== 'false';

        // Start hub heartbeat (keeps node alive independently of evolution cycles)
        try {
          const { startHeartbeat } = require('./src/gep/a2aProtocol');
          startHeartbeat();
        } catch (e) {
          console.warn('[Heartbeat] Failed to start: ' + (e.message || e));
        }

        let currentSleepMs = minSleepMs;
        let cycleCount = 0;

        while (true) {
          try {
          cycleCount += 1;

          // Ralph-loop gating: do not run a new cycle while previous run is pending solidify.
          const st0 = readJsonSafe(solidifyStatePath);
          if (isPendingSolidify(st0)) {
            await sleepMs(Math.max(pendingSleepMs, minSleepMs));
            continue;
          }

          const t0 = Date.now();
          let ok = false;
          try {
            await evolve.run();
            ok = true;

            if (String(process.env.EVOLVE_BRIDGE || '').toLowerCase() === 'false') {
              const stAfterRun = readJsonSafe(solidifyStatePath);
              if (isPendingSolidify(stAfterRun)) {
                const cleared = rejectPendingRun(solidifyStatePath);
                if (cleared) {
                  console.warn('[Loop] Auto-rejected pending run because bridge is disabled in loop mode.');
                }
              }
            }
          } catch (error) {
            const msg = error && error.message ? String(error.message) : String(error);
            console.error(`Evolution cycle failed: ${msg}`);
          }
          const dt = Date.now() - t0;

          // Adaptive sleep: treat very fast cycles as "idle", backoff; otherwise reset to min.
          if (!ok || dt < idleThresholdMs) {
            currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
          } else {
            currentSleepMs = minSleepMs;
          }

          // Suicide check (memory leak protection)
          if (suicideEnabled) {
            const memMb = process.memoryUsage().rss / 1024 / 1024;
            if (cycleCount >= maxCyclesPerProcess || memMb > maxRssMb) {
              console.log(`[Daemon] Restarting self (cycles=${cycleCount}, rssMb=${memMb.toFixed(0)})`);
              try {
                const spawnOpts = {
                  detached: true,
                  stdio: 'ignore',
                  env: process.env,
                  windowsHide: true,
                };
                const child = spawn(process.execPath, [__filename, ...args], spawnOpts);
                child.unref();
                releaseLock();
                process.exit(0);
              } catch (spawnErr) {
                console.error('[Daemon] Spawn failed, continuing current process:', spawnErr.message);
              }
            }
          }

          let saturationMultiplier = 1;
          try {
            const st1 = readJsonSafe(solidifyStatePath);
            const lastSignals = st1 && st1.last_run && Array.isArray(st1.last_run.signals) ? st1.last_run.signals : [];
            if (lastSignals.includes('force_steady_state')) {
              saturationMultiplier = 10;
              console.log('[Daemon] Saturation detected. Entering steady-state mode (10x sleep).');
            } else if (lastSignals.includes('evolution_saturation')) {
              saturationMultiplier = 5;
              console.log('[Daemon] Approaching saturation. Reducing evolution frequency (5x sleep).');
            }
          } catch (e) {}

          // Jitter to avoid lockstep restarts.
          const jitter = Math.floor(Math.random() * 250);
          await sleepMs((currentSleepMs + jitter) * saturationMultiplier);

          } catch (loopErr) {
            console.error('[Daemon] Unexpected loop error (recovering): ' + (loopErr && loopErr.message ? loopErr.message : String(loopErr)));
            await sleepMs(Math.max(minSleepMs, 10000));
          }
        }
    } else {
        // Normal Single Run
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);
            process.exit(1);
        }
    }

    // Post-run hint
    console.log('\n' + '=======================================================');
    console.log('Capability evolver finished. If you use this project, consider starring the upstream repository.');
    console.log('Upstream: https://github.com/autogame-17/capability-evolver');
    console.log('=======================================================\n');
    
  } else if (command === 'solidify') {
    const dryRun = args.includes('--dry-run');
    const noRollback = args.includes('--no-rollback');
    const intentFlag = args.find(a => typeof a === 'string' && a.startsWith('--intent='));
    const summaryFlag = args.find(a => typeof a === 'string' && a.startsWith('--summary='));
    const intent = intentFlag ? intentFlag.slice('--intent='.length) : null;
    const summary = summaryFlag ? summaryFlag.slice('--summary='.length) : null;

    try {
      const res = solidify({
        intent: intent || undefined,
        summary: summary || undefined,
        dryRun,
        rollbackOnFailure: !noRollback,
      });
      const st = res && res.ok ? 'SUCCESS' : 'FAILED';
      console.log(`[SOLIDIFY] ${st}`);
      if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
      if (res && res.event) console.log(JSON.stringify(res.event, null, 2));
      if (res && res.capsule) console.log(JSON.stringify(res.capsule, null, 2));

      if (res && res.ok && !dryRun) {
        try {
          const { shouldDistill, prepareDistillation } = require('./src/gep/skillDistiller');
          if (shouldDistill()) {
            const dr = prepareDistillation();
            if (dr && dr.ok && dr.promptPath) {
              console.log('\n[DISTILL_REQUEST]');
              console.log('Distillation prompt ready. Read the prompt file, process it with your LLM,');
              console.log('save the LLM response to a file, then run:');
              console.log('  node index.js distill --response-file=<path_to_llm_response>');
              console.log('Prompt file: ' + dr.promptPath);
              console.log('[/DISTILL_REQUEST]');
            }
          }
        } catch (e) {
          console.warn('[Distiller] Init failed (non-fatal): ' + (e.message || e));
        }
      }

      if (res && res.hubReviewPromise) {
        await res.hubReviewPromise;
      }
      process.exit(res && res.ok ? 0 : 2);
    } catch (error) {
      console.error('[SOLIDIFY] Error:', error);
      process.exit(2);
    }
  } else if (command === 'distill') {
    const responseFileFlag = args.find(a => typeof a === 'string' && a.startsWith('--response-file='));
    if (!responseFileFlag) {
      console.error('Usage: node index.js distill --response-file=<path>');
      process.exit(1);
    }
    const responseFilePath = responseFileFlag.slice('--response-file='.length);
    try {
      const responseText = fs.readFileSync(responseFilePath, 'utf8');
      const { completeDistillation } = require('./src/gep/skillDistiller');
      const result = completeDistillation(responseText);
      if (result && result.ok) {
        console.log('[Distiller] Gene produced: ' + result.gene.id);
        console.log(JSON.stringify(result.gene, null, 2));
      } else {
        console.warn('[Distiller] Distillation did not produce a gene: ' + (result && result.reason || 'unknown'));
      }
      process.exit(result && result.ok ? 0 : 2);
    } catch (error) {
      console.error('[DISTILL] Error:', error);
      process.exit(2);
    }

  } else if (command === 'review' || command === '--review') {
    const { getEvolutionDir, getRepoRoot } = require('./src/gep/paths');
    const { loadGenes } = require('./src/gep/assetStore');
    const { execSync } = require('child_process');

    const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
    const state = readJsonSafe(statePath);
    const lastRun = state && state.last_run ? state.last_run : null;

    if (!lastRun || !lastRun.run_id) {
      console.log('[Review] No pending evolution run to review.');
      console.log('Run "node index.js run" first to produce changes, then review before solidifying.');
      process.exit(0);
    }

    const lastSolid = state && state.last_solidify ? state.last_solidify : null;
    if (lastSolid && String(lastSolid.run_id) === String(lastRun.run_id)) {
      console.log('[Review] Last run has already been solidified. Nothing to review.');
      process.exit(0);
    }

    const repoRoot = getRepoRoot();
    let diff = '';
    try {
      const unstaged = execSync('git diff', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim();
      const staged = execSync('git diff --cached', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8', timeout: 10000 }).trim();
      if (staged) diff += '=== Staged Changes ===\n' + staged + '\n\n';
      if (unstaged) diff += '=== Unstaged Changes ===\n' + unstaged + '\n\n';
      if (untracked) diff += '=== Untracked Files ===\n' + untracked + '\n';
    } catch (e) {
      diff = '(failed to capture diff: ' + (e.message || e) + ')';
    }

    const genes = loadGenes();
    const geneId = lastRun.selected_gene_id ? String(lastRun.selected_gene_id) : null;
    const gene = geneId ? genes.find(g => g && g.type === 'Gene' && g.id === geneId) : null;
    const signals = Array.isArray(lastRun.signals) ? lastRun.signals : [];
    const mutation = lastRun.mutation || null;

    console.log('\n' + '='.repeat(60));
    console.log('[Review] Pending evolution run: ' + lastRun.run_id);
    console.log('='.repeat(60));
    console.log('\n--- Gene ---');
    if (gene) {
      console.log('  ID:       ' + gene.id);
      console.log('  Category: ' + (gene.category || '?'));
      console.log('  Summary:  ' + (gene.summary || '?'));
      if (Array.isArray(gene.strategy) && gene.strategy.length > 0) {
        console.log('  Strategy:');
        gene.strategy.forEach((s, i) => console.log('    ' + (i + 1) + '. ' + s));
      }
    } else {
      console.log('  (no gene selected or gene not found: ' + (geneId || 'none') + ')');
    }

    console.log('\n--- Signals ---');
    if (signals.length > 0) {
      signals.forEach(s => console.log('  - ' + s));
    } else {
      console.log('  (no signals)');
    }

    console.log('\n--- Mutation ---');
    if (mutation) {
      console.log('  Category:   ' + (mutation.category || '?'));
      console.log('  Risk Level: ' + (mutation.risk_level || '?'));
      if (mutation.rationale) console.log('  Rationale:  ' + mutation.rationale);
    } else {
      console.log('  (no mutation data)');
    }

    if (lastRun.blast_radius_estimate) {
      console.log('\n--- Blast Radius Estimate ---');
      const br = lastRun.blast_radius_estimate;
      console.log('  Files changed: ' + (br.files_changed || '?'));
      console.log('  Lines changed: ' + (br.lines_changed || '?'));
    }

    console.log('\n--- Diff ---');
    if (diff.trim()) {
      console.log(diff.length > 5000 ? diff.slice(0, 5000) + '\n... (truncated, ' + diff.length + ' chars total)' : diff);
    } else {
      console.log('  (no changes detected)');
    }
    console.log('='.repeat(60));

    if (args.includes('--approve')) {
      console.log('\n[Review] Approved. Running solidify...\n');
      try {
        const res = solidify({
          intent: lastRun.intent || undefined,
          rollbackOnFailure: true,
        });
        const st = res && res.ok ? 'SUCCESS' : 'FAILED';
        console.log(`[SOLIDIFY] ${st}`);
        if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
        if (res && res.hubReviewPromise) {
          await res.hubReviewPromise;
        }
        process.exit(res && res.ok ? 0 : 2);
      } catch (error) {
        console.error('[SOLIDIFY] Error:', error);
        process.exit(2);
      }
    } else if (args.includes('--reject')) {
      console.log('\n[Review] Rejected. Rolling back changes...');
      try {
        execSync('git checkout -- .', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('git clean -fd', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        const evolDir = getEvolutionDir();
        const sp = path.join(evolDir, 'evolution_solidify_state.json');
        if (fs.existsSync(sp)) {
          const s = readJsonSafe(sp);
          if (s && s.last_run) {
            s.last_solidify = { run_id: s.last_run.run_id, rejected: true, timestamp: new Date().toISOString() };
            fs.writeFileSync(sp, JSON.stringify(s, null, 2));
          }
        }
        console.log('[Review] Changes rolled back.');
      } catch (e) {
        console.error('[Review] Rollback failed:', e.message || e);
        process.exit(2);
      }
    } else {
      console.log('\nTo approve and solidify:  node index.js review --approve');
      console.log('To reject and rollback:   node index.js review --reject');
    }

  } else if (command === 'asset-log') {
    const { summarizeCallLog, readCallLog, getLogPath } = require('./src/gep/assetCallLog');

    const runIdFlag = args.find(a => typeof a === 'string' && a.startsWith('--run='));
    const actionFlag = args.find(a => typeof a === 'string' && a.startsWith('--action='));
    const lastFlag = args.find(a => typeof a === 'string' && a.startsWith('--last='));
    const sinceFlag = args.find(a => typeof a === 'string' && a.startsWith('--since='));
    const jsonMode = args.includes('--json');

    const opts = {};
    if (runIdFlag) opts.run_id = runIdFlag.slice('--run='.length);
    if (actionFlag) opts.action = actionFlag.slice('--action='.length);
    if (lastFlag) opts.last = parseInt(lastFlag.slice('--last='.length), 10);
    if (sinceFlag) opts.since = sinceFlag.slice('--since='.length);

    if (jsonMode) {
      const entries = readCallLog(opts);
      console.log(JSON.stringify(entries, null, 2));
    } else {
      const summary = summarizeCallLog(opts);
      console.log(`\n[Asset Call Log] ${getLogPath()}`);
      console.log(`  Total entries: ${summary.total_entries}`);
      console.log(`  Unique assets: ${summary.unique_assets}`);
      console.log(`  Unique runs:   ${summary.unique_runs}`);
      console.log(`  By action:`);
      for (const [action, count] of Object.entries(summary.by_action)) {
        console.log(`    ${action}: ${count}`);
      }
      if (summary.entries.length > 0) {
        console.log(`\n  Recent entries:`);
        const show = summary.entries.slice(-10);
        for (const e of show) {
          const ts = e.timestamp ? e.timestamp.slice(0, 19) : '?';
          const assetShort = e.asset_id ? e.asset_id.slice(0, 20) + '...' : '(none)';
          const sigPreview = Array.isArray(e.signals) ? e.signals.slice(0, 3).join(', ') : '';
          console.log(`    [${ts}] ${e.action || '?'}  asset=${assetShort}  score=${e.score || '-'}  mode=${e.mode || '-'}  signals=[${sigPreview}]  run=${e.run_id || '-'}`);
        }
      } else {
        console.log('\n  No entries found.');
      }
      console.log('');
    }

  } else {
    console.log(`Usage: node index.js [run|/evolve|solidify|review|distill|asset-log] [--loop]
  - solidify flags:
    - --dry-run
    - --no-rollback
    - --intent=repair|optimize|innovate
    - --summary=...
  - review flags:
    - --approve                (approve and solidify the pending changes)
    - --reject                 (reject and rollback the pending changes)
  - distill flags:
    - --response-file=<path>  (LLM response file for skill distillation)
  - asset-log flags:
    - --run=<run_id>           (filter by run ID)
    - --action=<action>        (filter: hub_search_hit, hub_search_miss, asset_reuse, asset_reference, asset_publish, asset_publish_skip)
    - --last=<N>               (show last N entries)
    - --since=<ISO_date>       (entries after date)
    - --json                   (raw JSON output)`);
  }
}

if (require.main === module) {
  main();
}
