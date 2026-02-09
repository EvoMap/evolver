const evolve = require('./src/evolve');
const { solidify } = require('./src/gep/solidify');
const path = require('path');
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
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`[Singleton] Evolver loop already running (PID ${pid}). Exiting.`);
        return false;
      } catch (e) {
        console.log(`[Singleton] Stale lock found (PID ${pid}). Taking over.`);
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

        const solidifyStatePath = path.join(__dirname, 'memory', 'evolution_solidify_state.json');

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

        let currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, minSleepMs));
        let cycleCount = 0;

        while (true) {
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
              releaseLock(); // Release before spawning to allow child to acquire
              const child = spawn(process.execPath, [__filename, ...args], {
                detached: true,
                stdio: 'ignore',
                env: process.env,
              });
              child.unref();
              process.exit(0);
            }
          }

          // Jitter to avoid lockstep restarts.
          const jitter = Math.floor(Math.random() * 250);
          await sleepMs(currentSleepMs + jitter);
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
      process.exit(res && res.ok ? 0 : 2);
    } catch (error) {
      console.error('[SOLIDIFY] Error:', error);
      process.exit(2);
    }
  } else {
    console.log(`Usage: node index.js [run|/evolve|solidify] [--loop]
  - solidify flags:
    - --dry-run
    - --no-rollback
    - --intent=repair|optimize|innovate
    - --summary=...`);
  }
}

if (require.main === module) {
  main();
}
