const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadGenes, upsertGene, appendEventJsonl, appendCapsule, upsertCapsule, getLastEventId } = require('./assetStore');
const { computeSignalKey, memoryGraphPath } = require('./memoryGraph');
const { computeCapsuleSuccessStreak, isBlastRadiusSafe } = require('./a2a');
const { getRepoRoot, getMemoryDir, getEvolutionDir, getWorkspaceRoot } = require('./paths');
const { extractSignals } = require('./signals');
const { selectGene } = require('./selector');
const { isValidMutation, normalizeMutation, isHighRiskMutationAllowed, isHighRiskPersonality } = require('./mutation');
const {
  isValidPersonalityState,
  normalizePersonalityState,
  personalityKey,
  updatePersonalityStats,
} = require('./personality');
const { computeAssetId, SCHEMA_VERSION } = require('./contentHash');
const { captureEnvFingerprint } = require('./envFingerprint');
const { buildValidationReport } = require('./validationReport');

function nowIso() {
  return new Date().toISOString();
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function stableHash(input) {
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function runCmd(cmd, opts = {}) {
  const cwd = opts.cwd || getRepoRoot();
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 120000;
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
}

function tryRunCmd(cmd, opts = {}) {
  try {
    return { ok: true, out: runCmd(cmd, opts), err: '' };
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr) : '';
    const stdout = e && e.stdout ? String(e.stdout) : '';
    const msg = e && e.message ? String(e.message) : 'command_failed';
    return { ok: false, out: stdout, err: stderr || msg };
  }
}

function gitListChangedFiles({ repoRoot }) {
  const files = new Set();
  const s1 = tryRunCmd('git diff --name-only', { cwd: repoRoot, timeoutMs: 60000 });
  if (s1.ok) for (const line of String(s1.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  const s2 = tryRunCmd('git diff --cached --name-only', { cwd: repoRoot, timeoutMs: 60000 });
  if (s2.ok) for (const line of String(s2.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  const s3 = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  if (s3.ok) for (const line of String(s3.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  return Array.from(files);
}

function countFileLines(absPath) {
  try {
    if (!fs.existsSync(absPath)) return 0;
    const buf = fs.readFileSync(absPath);
    if (!buf || buf.length === 0) return 0;
    let n = 1;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function readOpenclawConstraintPolicy() {
  const defaults = {
    excludePrefixes: ['logs/', 'memory/', 'assets/gep/', 'out/', 'temp/', 'node_modules/'],
    excludeExact: ['event.json', 'temp_gep_output.json', 'temp_evolution_output.json', 'evolution_error.log'],
    excludeRegex: ['capsule', 'events?\\.jsonl$'],
    includePrefixes: ['src/', 'scripts/', 'config/'],
    includeExact: ['index.js', 'package.json'],
    includeExtensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh'],
  };
  try {
    const root = path.resolve(getWorkspaceRoot(), '..');
    const cfgPath = path.join(root, 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return defaults;
    const obj = readJsonIfExists(cfgPath, {});
    const pol =
      obj &&
      obj.evolver &&
      obj.evolver.constraints &&
      obj.evolver.constraints.countedFilePolicy &&
      typeof obj.evolver.constraints.countedFilePolicy === 'object'
        ? obj.evolver.constraints.countedFilePolicy
        : {};
    return {
      excludePrefixes: Array.isArray(pol.excludePrefixes) ? pol.excludePrefixes.map(String) : defaults.excludePrefixes,
      excludeExact: Array.isArray(pol.excludeExact) ? pol.excludeExact.map(String) : defaults.excludeExact,
      excludeRegex: Array.isArray(pol.excludeRegex) ? pol.excludeRegex.map(String) : defaults.excludeRegex,
      includePrefixes: Array.isArray(pol.includePrefixes) ? pol.includePrefixes.map(String) : defaults.includePrefixes,
      includeExact: Array.isArray(pol.includeExact) ? pol.includeExact.map(String) : defaults.includeExact,
      includeExtensions: Array.isArray(pol.includeExtensions) ? pol.includeExtensions.map(String) : defaults.includeExtensions,
    };
  } catch (_) {
    return defaults;
  }
}

function matchAnyPrefix(rel, prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [];
  for (const p of list) {
    const n = normalizeRelPath(p).replace(/\/+$/, '');
    if (!n) continue;
    if (rel === n || rel.startsWith(n + '/')) return true;
  }
  return false;
}

function matchAnyExact(rel, exacts) {
  const set = new Set((Array.isArray(exacts) ? exacts : []).map(x => normalizeRelPath(x)));
  return set.has(rel);
}

function matchAnyRegex(rel, regexList) {
  for (const raw of Array.isArray(regexList) ? regexList : []) {
    try {
      if (new RegExp(String(raw), 'i').test(rel)) return true;
    } catch (_) {}
  }
  return false;
}

function isConstraintCountedPath(relPath, policy) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;
  if (matchAnyExact(rel, policy.excludeExact)) return false;
  if (matchAnyPrefix(rel, policy.excludePrefixes)) return false;
  if (matchAnyRegex(rel, policy.excludeRegex)) return false;
  if (matchAnyExact(rel, policy.includeExact)) return true;
  if (matchAnyPrefix(rel, policy.includePrefixes)) return true;
  const lower = rel.toLowerCase();
  for (const ext of Array.isArray(policy.includeExtensions) ? policy.includeExtensions : []) {
    const e = String(ext || '').toLowerCase();
    if (!e) continue;
    if (lower.endsWith(e)) return true;
  }
  return false;
}

function parseNumstatRows(text) {
  const rows = [];
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = Number(parts[0]);
    const d = Number(parts[1]);
    let rel = normalizeRelPath(parts.slice(2).join('\t'));
    if (rel.includes('=>')) {
      const right = rel.split('=>').pop();
      rel = normalizeRelPath(String(right || '').replace(/[{}]/g, '').trim());
    }
    rows.push({
      file: rel,
      added: Number.isFinite(a) ? a : 0,
      deleted: Number.isFinite(d) ? d : 0,
    });
  }
  return rows;
}

function computeBlastRadius({ repoRoot, baselineUntracked }) {
  const policy = readOpenclawConstraintPolicy();
  let changedFiles = gitListChangedFiles({ repoRoot }).map(normalizeRelPath).filter(Boolean);
  if (Array.isArray(baselineUntracked) && baselineUntracked.length > 0) {
    const baselineSet = new Set(baselineUntracked.map(normalizeRelPath));
    changedFiles = changedFiles.filter(f => !baselineSet.has(f));
  }
  const countedFiles = changedFiles.filter(f => isConstraintCountedPath(f, policy));
  const ignoredFiles = changedFiles.filter(f => !isConstraintCountedPath(f, policy));
  const filesCount = countedFiles.length;

  const u = tryRunCmd('git diff --numstat', { cwd: repoRoot, timeoutMs: 60000 });
  const c = tryRunCmd('git diff --cached --numstat', { cwd: repoRoot, timeoutMs: 60000 });
  const unstagedRows = u.ok ? parseNumstatRows(u.out) : [];
  const stagedRows = c.ok ? parseNumstatRows(c.out) : [];
  let stagedUnstagedChurn = 0;
  for (const row of [...unstagedRows, ...stagedRows]) {
    if (!isConstraintCountedPath(row.file, policy)) continue;
    stagedUnstagedChurn += row.added + row.deleted;
  }

  const untracked = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  let untrackedLines = 0;
  if (untracked.ok) {
    const rels = String(untracked.out).split('\n').map(normalizeRelPath).filter(Boolean);
    const baselineSet = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(normalizeRelPath));
    for (const rel of rels) {
      if (baselineSet.has(rel)) continue;
      if (!isConstraintCountedPath(rel, policy)) continue;
      const abs = path.join(repoRoot, rel);
      untrackedLines += countFileLines(abs);
    }
  }
  const churn = stagedUnstagedChurn + untrackedLines;
  return {
    files: filesCount,
    lines: churn,
    changed_files: countedFiles,
    ignored_files: ignoredFiles,
    all_changed_files: changedFiles,
  };
}

function isForbiddenPath(relPath, forbiddenPaths) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  const list = Array.isArray(forbiddenPaths) ? forbiddenPaths : [];
  for (const fp of list) {
    const f = String(fp || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!f) continue;
    if (rel === f) return true;
    if (rel.startsWith(f + '/')) return true;
  }
  return false;
}

function checkConstraints({ gene, blast, blastRadiusEstimate, repoRoot }) {
  const violations = [];
  const warnings = [];
  let blastSeverity = null;

  if (!gene || gene.type !== 'Gene') return { ok: true, violations, warnings, blastSeverity };
  const constraints = gene.constraints || {};
  const maxFiles = Number(constraints.max_files);

  // --- Blast radius severity classification ---
  blastSeverity = classifyBlastSeverity({ blast, maxFiles });

  // Hard cap breach is always a violation, regardless of gene config.
  if (blastSeverity.severity === 'hard_cap_breach') {
    violations.push(blastSeverity.message);
    console.error(`[Solidify] ${blastSeverity.message}`);
  } else if (blastSeverity.severity === 'critical_overrun') {
    violations.push(blastSeverity.message);
    // Log directory breakdown for diagnostics.
    const breakdown = analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || []);
    console.error(`[Solidify] ${blastSeverity.message}`);
    console.error(`[Solidify] Top contributing directories: ${breakdown.map(function (d) { return d.dir + ' (' + d.files + ')'; }).join(', ')}`);
  } else if (blastSeverity.severity === 'exceeded') {
    violations.push(`max_files exceeded: ${blast.files} > ${maxFiles}`);
  } else if (blastSeverity.severity === 'approaching_limit') {
    warnings.push(blastSeverity.message);
  }

  // --- Estimate vs actual drift detection ---
  const estimateComparison = compareBlastEstimate(blastRadiusEstimate, blast);
  if (estimateComparison && estimateComparison.drifted) {
    warnings.push(estimateComparison.message);
    console.log(`[Solidify] WARNING: ${estimateComparison.message}`);
  }

  // --- Forbidden paths ---
  const forbidden = Array.isArray(constraints.forbidden_paths) ? constraints.forbidden_paths : [];
  for (const f of blast.all_changed_files || blast.changed_files || []) {
    if (isForbiddenPath(f, forbidden)) violations.push(`forbidden_path touched: ${f}`);
  }

  // --- Critical protection: reject any evolution that deletes/empties core dependencies ---
  for (const f of blast.all_changed_files || blast.changed_files || []) {
    if (isCriticalProtectedPath(f)) {
      const norm = normalizeRelPath(f);
      if (norm.startsWith('skills/evolver/') && gene.category !== 'repair') {
        violations.push(`critical_path_modified_without_repair_intent: ${norm}`);
      }
    }
  }

  // --- New skill directory completeness check ---
  // Detect when an innovation cycle creates a skill directory with too few files.
  // This catches the "empty directory" problem where AI creates skills/<name>/ but
  // fails to write any code into it. A real skill needs at least index.js + SKILL.md.
  if (repoRoot) {
    var newSkillDirs = new Set();
    var changedList = blast.all_changed_files || blast.changed_files || [];
    for (var sci = 0; sci < changedList.length; sci++) {
      var scNorm = normalizeRelPath(changedList[sci]);
      var scMatch = scNorm.match(/^skills\/([^\/]+)\//);
      if (scMatch && !isCriticalProtectedPath(scNorm)) {
        newSkillDirs.add(scMatch[1]);
      }
    }
    newSkillDirs.forEach(function (skillName) {
      var skillDir = path.join(repoRoot, 'skills', skillName);
      try {
        var entries = fs.readdirSync(skillDir).filter(function (e) { return !e.startsWith('.'); });
        if (entries.length < 2) {
          warnings.push('incomplete_skill: skills/' + skillName + '/ has only ' + entries.length + ' file(s). New skills should have at least index.js + SKILL.md.');
        }
      } catch (e) { /* dir might not exist yet */ }
    });
  }

  return { ok: violations.length === 0, violations, warnings, blastSeverity };
}

function readStateForSolidify() {
  const memoryDir = getMemoryDir();
  const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
  return readJsonIfExists(statePath, { last_run: null });
}

function writeStateForSolidify(state) {
  const memoryDir = getMemoryDir();
  const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
  try {
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
  } catch {}
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

function buildEventId(tsIso) {
  const t = Date.parse(tsIso);
  return `evt_${Number.isFinite(t) ? t : Date.now()}`;
}

function buildCapsuleId(tsIso) {
  const t = Date.parse(tsIso);
  return `capsule_${Number.isFinite(t) ? t : Date.now()}`;
}

// --- System-wide blast radius hard caps ---
// These are absolute maximums that NO gene can override.
// Even if a gene sets max_files: 1000, the hard cap prevails.
const BLAST_RADIUS_HARD_CAP_FILES = Number(process.env.EVOLVER_HARD_CAP_FILES) || 60;
const BLAST_RADIUS_HARD_CAP_LINES = Number(process.env.EVOLVER_HARD_CAP_LINES) || 20000;

// Severity thresholds (as ratios of gene max_files).
const BLAST_WARN_RATIO = 0.8;   // >80% of limit: warning
const BLAST_CRITICAL_RATIO = 2.0; // >200% of limit: critical overrun

// Classify blast radius severity relative to a gene's max_files constraint.
// Returns: { severity, message }
//   severity: 'within_limit' | 'approaching_limit' | 'exceeded' | 'critical_overrun' | 'hard_cap_breach'
function classifyBlastSeverity({ blast, maxFiles }) {
  const files = Number(blast.files) || 0;
  const lines = Number(blast.lines) || 0;

  // Hard cap breach is always the highest severity -- system-level guard.
  if (files > BLAST_RADIUS_HARD_CAP_FILES || lines > BLAST_RADIUS_HARD_CAP_LINES) {
    return {
      severity: 'hard_cap_breach',
      message: `HARD CAP BREACH: ${files} files / ${lines} lines exceeds system limit (${BLAST_RADIUS_HARD_CAP_FILES} files / ${BLAST_RADIUS_HARD_CAP_LINES} lines)`,
    };
  }

  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    return { severity: 'within_limit', message: 'no max_files constraint defined' };
  }

  if (files > maxFiles * BLAST_CRITICAL_RATIO) {
    return {
      severity: 'critical_overrun',
      message: `CRITICAL OVERRUN: ${files} files > ${maxFiles * BLAST_CRITICAL_RATIO} (${BLAST_CRITICAL_RATIO}x limit of ${maxFiles}). Agent likely performed bulk/unintended operation.`,
    };
  }

  if (files > maxFiles) {
    return {
      severity: 'exceeded',
      message: `max_files exceeded: ${files} > ${maxFiles}`,
    };
  }

  if (files > maxFiles * BLAST_WARN_RATIO) {
    return {
      severity: 'approaching_limit',
      message: `approaching limit: ${files} / ${maxFiles} files (${Math.round((files / maxFiles) * 100)}%)`,
    };
  }

  return { severity: 'within_limit', message: `${files} / ${maxFiles} files` };
}

// Analyze which directory prefixes contribute the most changed files.
// Returns top N directory groups sorted by count descending.
function analyzeBlastRadiusBreakdown(changedFiles, topN) {
  const n = Number.isFinite(topN) && topN > 0 ? topN : 5;
  const dirCount = {};
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    const rel = normalizeRelPath(f);
    if (!rel) continue;
    // Use first two path segments as the group key (e.g. "skills/feishu-post").
    const parts = rel.split('/');
    const key = parts.length >= 2 ? parts.slice(0, 2).join('/') : parts[0];
    dirCount[key] = (dirCount[key] || 0) + 1;
  }
  return Object.entries(dirCount)
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, n)
    .map(function (e) { return { dir: e[0], files: e[1] }; });
}

// Compare agent's pre-edit estimate against actual blast radius.
// Returns null if no estimate, or { estimateFiles, actualFiles, ratio, drifted }.
function compareBlastEstimate(estimate, actual) {
  if (!estimate || typeof estimate !== 'object') return null;
  const estFiles = Number(estimate.files);
  const actFiles = Number(actual.files);
  if (!Number.isFinite(estFiles) || estFiles <= 0) return null;
  const ratio = actFiles / estFiles;
  return {
    estimateFiles: estFiles,
    actualFiles: actFiles,
    ratio: Math.round(ratio * 100) / 100,
    drifted: ratio > 3 || ratio < 0.1,
    message: ratio > 3
      ? `Estimate drift: actual ${actFiles} files is ${ratio.toFixed(1)}x the estimated ${estFiles}. Agent did not plan accurately.`
      : null,
  };
}

// --- Critical skills / paths that evolver must NEVER delete or overwrite ---
// These are core dependencies; destroying them will crash the entire system.
const CRITICAL_PROTECTED_PREFIXES = [
  'skills/feishu-evolver-wrapper/',
  'skills/feishu-common/',
  'skills/feishu-post/',
  'skills/feishu-card/',
  'skills/feishu-doc/',
  'skills/common/',
  'skills/clawhub/',
  'skills/clawhub-batch-undelete/',
  'skills/git-sync/',
  'skills/evolver/',
];

// Files at workspace root that must never be deleted by evolver.
const CRITICAL_PROTECTED_FILES = [
  'MEMORY.md',
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'USER.md',
  'HEARTBEAT.md',
  'RECENT_EVENTS.md',
  'TOOLS.md',
  'TROUBLESHOOTING.md',
  'openclaw.json',
  '.env',
  'package.json',
];

function isCriticalProtectedPath(relPath) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;
  // Check protected prefixes (skill directories)
  for (const prefix of CRITICAL_PROTECTED_PREFIXES) {
    const p = prefix.replace(/\/+$/, '');
    if (rel === p || rel.startsWith(p + '/')) return true;
  }
  // Check protected root files
  for (const f of CRITICAL_PROTECTED_FILES) {
    if (rel === f) return true;
  }
  return false;
}

function detectDestructiveChanges({ repoRoot, changedFiles, baselineUntracked }) {
  const violations = [];
  const baselineSet = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(normalizeRelPath));

  for (const rel of changedFiles) {
    const norm = normalizeRelPath(rel);
    if (!norm) continue;
    if (!isCriticalProtectedPath(norm)) continue;

    const abs = path.join(repoRoot, norm);
    const normAbs = path.resolve(abs);
    const normRepo = path.resolve(repoRoot);
    if (!normAbs.startsWith(normRepo + path.sep) && normAbs !== normRepo) continue;

    // If a critical file existed before but is now missing/empty, that is destructive.
    if (!baselineSet.has(norm)) {
      // It was tracked before, check if it still exists
      if (!fs.existsSync(normAbs)) {
        violations.push(`CRITICAL_FILE_DELETED: ${norm}`);
      } else {
        try {
          const stat = fs.statSync(normAbs);
          if (stat.isFile() && stat.size === 0) {
            violations.push(`CRITICAL_FILE_EMPTIED: ${norm}`);
          }
        } catch (e) {}
      }
    }
  }
  return violations;
}

// --- Validation command safety ---
const VALIDATION_ALLOWED_PREFIXES = ['node ', 'npm ', 'npx '];

function isValidationCommandAllowed(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  if (!VALIDATION_ALLOWED_PREFIXES.some(p => c.startsWith(p))) return false;
  if (/`|\$\(/.test(c)) return false;
  const stripped = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  if (/[;&|><]/.test(stripped)) return false;
  return true;
}

function runValidations(gene, opts = {}) {
  const repoRoot = opts.repoRoot || getRepoRoot();
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 180000;
  const validation = Array.isArray(gene && gene.validation) ? gene.validation : [];
  const results = [];
  const startedAt = Date.now();
  for (const cmd of validation) {
    const c = String(cmd || '').trim();
    if (!c) continue;
    if (!isValidationCommandAllowed(c)) {
      results.push({ cmd: c, ok: false, out: '', err: 'BLOCKED: validation command rejected by safety check (allowed prefixes: node/npm/npx; shell operators prohibited)' });
      return { ok: false, results, startedAt, finishedAt: Date.now() };
    }
    const r = tryRunCmd(c, { cwd: repoRoot, timeoutMs });
    results.push({ cmd: c, ok: r.ok, out: String(r.out || ''), err: String(r.err || '') });
    if (!r.ok) return { ok: false, results, startedAt, finishedAt: Date.now() };
  }
  return { ok: true, results, startedAt, finishedAt: Date.now() };
}

// --- Canary via Fork: verify index.js loads in an isolated child process ---
// This is the last safety net before solidify commits an evolution.
// If a patch broke index.js, the canary catches it BEFORE the daemon
// restarts with broken code. Runs with a short timeout to avoid blocking.
function runCanaryCheck(opts) {
  const repoRoot = (opts && opts.repoRoot) ? opts.repoRoot : getRepoRoot();
  const timeoutMs = (opts && Number.isFinite(Number(opts.timeoutMs))) ? Number(opts.timeoutMs) : 30000;
  const canaryScript = path.join(repoRoot, 'src', 'canary.js');
  if (!fs.existsSync(canaryScript)) {
    return { ok: true, skipped: true, reason: 'canary.js not found' };
  }
  const r = tryRunCmd(`node "${canaryScript}"`, { cwd: repoRoot, timeoutMs });
  return {
    ok: r.ok,
    skipped: false,
    out: String(r.out || '').slice(0, 500),
    err: String(r.err || '').slice(0, 500),
  };
}

function rollbackTracked(repoRoot) {
  tryRunCmd('git restore --staged --worktree .', { cwd: repoRoot, timeoutMs: 60000 });
  tryRunCmd('git reset --hard', { cwd: repoRoot, timeoutMs: 60000 });
}

function gitListUntrackedFiles(repoRoot) {
  const r = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  if (!r.ok) return [];
  return String(r.out).split('\n').map(l => l.trim()).filter(Boolean);
}

function rollbackNewUntrackedFiles({ repoRoot, baselineUntracked }) {
  const baseline = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(String));
  const current = gitListUntrackedFiles(repoRoot);
  const toDelete = current.filter(f => !baseline.has(String(f)));
  const skipped = [];
  const deleted = [];
  for (const rel of toDelete) {
    const safeRel = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!safeRel) continue;
    // CRITICAL: Never delete files inside protected skill directories during rollback.
    if (isCriticalProtectedPath(safeRel)) {
      skipped.push(safeRel);
      continue;
    }
    const abs = path.join(repoRoot, safeRel);
    const normRepo = path.resolve(repoRoot);
    const normAbs = path.resolve(abs);
    if (!normAbs.startsWith(normRepo + path.sep) && normAbs !== normRepo) continue;
    try {
      if (fs.existsSync(normAbs) && fs.statSync(normAbs).isFile()) {
        fs.unlinkSync(normAbs);
        deleted.push(safeRel);
      }
    } catch (e) {}
  }
  if (skipped.length > 0) {
    console.log(`[Rollback] Skipped ${skipped.length} critical protected file(s): ${skipped.slice(0, 5).join(', ')}`);
  }
  // Clean up empty directories left after file deletion.
  // This prevents "ghost skill directories" where mkdir succeeded but
  // file creation failed/was rolled back. Without this, empty dirs like
  // skills/anima/, skills/oblivion/ etc. accumulate after failed innovations.
  var dirsToCheck = new Set();
  for (var di = 0; di < deleted.length; di++) {
    var dir = path.dirname(deleted[di]);
    while (dir && dir !== '.' && dir !== '/') {
      dirsToCheck.add(dir);
      dir = path.dirname(dir);
    }
  }
  // Sort deepest first to ensure children are removed before parents
  var sortedDirs = Array.from(dirsToCheck).sort(function (a, b) { return b.length - a.length; });
  var removedDirs = [];
  for (var si = 0; si < sortedDirs.length; si++) {
    var dirAbs = path.join(repoRoot, sortedDirs[si]);
    try {
      var entries = fs.readdirSync(dirAbs);
      if (entries.length === 0) {
        fs.rmdirSync(dirAbs);
        removedDirs.push(sortedDirs[si]);
      }
    } catch (e) { /* ignore -- dir may already be gone */ }
  }
  if (removedDirs.length > 0) {
    console.log('[Rollback] Removed ' + removedDirs.length + ' empty director' + (removedDirs.length === 1 ? 'y' : 'ies') + ': ' + removedDirs.slice(0, 5).join(', '));
  }

  return { deleted, skipped, removedDirs: removedDirs };
}

function inferCategoryFromSignals(signals) {
  const list = Array.isArray(signals) ? signals.map(String) : [];
  if (list.includes('log_error')) return 'repair';
  if (list.includes('protocol_drift')) return 'optimize';
  return 'optimize';
}

function buildAutoGene({ signals, intent }) {
  const sigs = Array.isArray(signals) ? Array.from(new Set(signals.map(String))).filter(Boolean) : [];
  const signalKey = computeSignalKey(sigs);
  const id = `gene_auto_${stableHash(signalKey)}`;
  const category = intent && ['repair', 'optimize', 'innovate'].includes(String(intent))
    ? String(intent)
    : inferCategoryFromSignals(sigs);
  const signalsMatch = sigs.length ? sigs.slice(0, 8) : ['(none)'];
  const gene = {
    type: 'Gene',
    schema_version: SCHEMA_VERSION,
    id,
    category,
    signals_match: signalsMatch,
    preconditions: [`signals_key == ${signalKey}`],
    strategy: [
      'Extract structured signals from logs and user instructions',
      'Select an existing Gene by signals match (no improvisation)',
      'Estimate blast radius (files, lines) before editing and record it',
      'Apply smallest reversible patch',
      'Validate using declared validation steps; rollback on failure',
      'Solidify knowledge: append EvolutionEvent, update Gene/Capsule store',
    ],
    constraints: {
      max_files: 12,
      forbidden_paths: [
        '.git', 'node_modules',
        'skills/feishu-evolver-wrapper', 'skills/feishu-common',
        'skills/feishu-post', 'skills/feishu-card', 'skills/feishu-doc',
        'skills/common', 'skills/clawhub', 'skills/clawhub-batch-undelete',
        'skills/git-sync',
      ],
    },
    validation: ['node -e "require(\'./src/gep/solidify\'); console.log(\'ok\')"'],
  };
  gene.asset_id = computeAssetId(gene);
  return gene;
}

function ensureGene({ genes, selectedGene, signals, intent, dryRun }) {
  if (selectedGene && selectedGene.type === 'Gene') return { gene: selectedGene, created: false, reason: 'selected_gene_id_present' };
  const res = selectGene(Array.isArray(genes) ? genes : [], Array.isArray(signals) ? signals : [], {
    bannedGeneIds: new Set(), preferredGeneId: null, driftEnabled: false,
  });
  if (res && res.selected) return { gene: res.selected, created: false, reason: 'reselected_from_existing' };
  const auto = buildAutoGene({ signals, intent });
  if (!dryRun) upsertGene(auto);
  return { gene: auto, created: true, reason: 'no_match_create_new' };
}

function readRecentSessionInputs() {
  const repoRoot = getRepoRoot();
  const memoryDir = getMemoryDir();
  const rootMemory = path.join(repoRoot, 'MEMORY.md');
  const dirMemory = path.join(memoryDir, 'MEMORY.md');
  const memoryFile = fs.existsSync(rootMemory) ? rootMemory : dirMemory;
  const userFile = path.join(repoRoot, 'USER.md');
  const todayLog = path.join(memoryDir, new Date().toISOString().split('T')[0] + '.md');
  const todayLogContent = fs.existsSync(todayLog) ? fs.readFileSync(todayLog, 'utf8') : '';
  const memorySnippet = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8').slice(0, 50000) : '';
  const userSnippet = fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8') : '';
  const recentSessionTranscript = '';
  return { recentSessionTranscript, todayLog: todayLogContent, memorySnippet, userSnippet };
}

function solidify({ intent, summary, dryRun = false, rollbackOnFailure = true } = {}) {
  const repoRoot = getRepoRoot();
  const state = readStateForSolidify();
  const lastRun = state && state.last_run ? state.last_run : null;
  const genes = loadGenes();
  const geneId = lastRun && lastRun.selected_gene_id ? String(lastRun.selected_gene_id) : null;
  const selectedGene = geneId ? genes.find(g => g && g.type === 'Gene' && g.id === geneId) : null;
  const parentEventId =
    lastRun && typeof lastRun.parent_event_id === 'string' ? lastRun.parent_event_id : getLastEventId();
  const signals =
    lastRun && Array.isArray(lastRun.signals) && lastRun.signals.length
      ? Array.from(new Set(lastRun.signals.map(String)))
      : extractSignals(readRecentSessionInputs());
  const signalKey = computeSignalKey(signals);

  const mutationRaw = lastRun && lastRun.mutation && typeof lastRun.mutation === 'object' ? lastRun.mutation : null;
  const personalityRaw =
    lastRun && lastRun.personality_state && typeof lastRun.personality_state === 'object' ? lastRun.personality_state : null;
  const mutation = mutationRaw && isValidMutation(mutationRaw) ? normalizeMutation(mutationRaw) : null;
  const personalityState =
    personalityRaw && isValidPersonalityState(personalityRaw) ? normalizePersonalityState(personalityRaw) : null;
  const personalityKeyUsed = personalityState ? personalityKey(personalityState) : null;
  const protocolViolations = [];
  if (!mutation) protocolViolations.push('missing_or_invalid_mutation');
  if (!personalityState) protocolViolations.push('missing_or_invalid_personality_state');
  if (mutation && mutation.risk_level === 'high' && !isHighRiskMutationAllowed(personalityState || null)) {
    protocolViolations.push('high_risk_mutation_not_allowed_by_personality');
  }
  if (mutation && mutation.risk_level === 'high' && !(lastRun && lastRun.personality_known)) {
    protocolViolations.push('high_risk_mutation_forbidden_under_unknown_personality');
  }
  if (mutation && mutation.category === 'innovate' && personalityState && isHighRiskPersonality(personalityState)) {
    protocolViolations.push('forbidden_innovate_with_high_risk_personality');
  }

  const ensured = ensureGene({ genes, selectedGene, signals, intent, dryRun: !!dryRun });
  const geneUsed = ensured.gene;
  const blast = computeBlastRadius({
    repoRoot,
    baselineUntracked: lastRun && Array.isArray(lastRun.baseline_untracked) ? lastRun.baseline_untracked : [],
  });
  const blastRadiusEstimate = lastRun && lastRun.blast_radius_estimate ? lastRun.blast_radius_estimate : null;
  const constraintCheck = checkConstraints({ gene: geneUsed, blast, blastRadiusEstimate, repoRoot });

  // Log blast radius diagnostics when severity is elevated.
  if (constraintCheck.blastSeverity &&
      constraintCheck.blastSeverity.severity !== 'within_limit' &&
      constraintCheck.blastSeverity.severity !== 'approaching_limit') {
    const breakdown = analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || []);
    console.error(`[Solidify] Blast radius breakdown: ${JSON.stringify(breakdown)}`);
    const estComp = compareBlastEstimate(blastRadiusEstimate, blast);
    if (estComp) {
      console.error(`[Solidify] Estimate comparison: estimated ${estComp.estimateFiles} files, actual ${estComp.actualFiles} files (${estComp.ratio}x)`);
    }
  }

  // Log warnings even on success (approaching limit, estimate drift).
  if (constraintCheck.warnings && constraintCheck.warnings.length > 0) {
    for (const w of constraintCheck.warnings) {
      console.log(`[Solidify] WARNING: ${w}`);
    }
  }

  // Critical safety: detect destructive changes to core dependencies.
  const destructiveViolations = detectDestructiveChanges({
    repoRoot,
    changedFiles: blast.all_changed_files || blast.changed_files || [],
    baselineUntracked: lastRun && Array.isArray(lastRun.baseline_untracked) ? lastRun.baseline_untracked : [],
  });
  if (destructiveViolations.length > 0) {
    for (const v of destructiveViolations) {
      constraintCheck.violations.push(v);
    }
    constraintCheck.ok = false;
    console.error(`[Solidify] CRITICAL: Destructive changes detected: ${destructiveViolations.join('; ')}`);
  }

  // Capture environment fingerprint before validation.
  const envFp = captureEnvFingerprint();

  let validation = { ok: true, results: [], startedAt: null, finishedAt: null };
  if (geneUsed) {
    validation = runValidations(geneUsed, { repoRoot, timeoutMs: 180000 });
  }

  // Canary safety: verify index.js loads in an isolated child process.
  // This catches broken entry points that gene validations might miss.
  const canary = runCanaryCheck({ repoRoot, timeoutMs: 30000 });
  if (!canary.ok && !canary.skipped) {
    constraintCheck.violations.push(
      `canary_failed: index.js cannot load in child process: ${canary.err}`
    );
    constraintCheck.ok = false;
    console.error(`[Solidify] CANARY FAILED: ${canary.err}`);
  }

  // Build standardized ValidationReport (machine-readable, interoperable).
  const validationReport = buildValidationReport({
    geneId: geneUsed && geneUsed.id ? geneUsed.id : null,
    commands: validation.results.map(function (r) { return r.cmd; }),
    results: validation.results,
    envFp: envFp,
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
  });

  const success = constraintCheck.ok && validation.ok && protocolViolations.length === 0;
  const ts = nowIso();
  const outcomeStatus = success ? 'success' : 'failed';
  const score = clamp01(success ? 0.85 : 0.2);

  const selectedCapsuleId =
    lastRun && typeof lastRun.selected_capsule_id === 'string' && lastRun.selected_capsule_id.trim()
      ? String(lastRun.selected_capsule_id).trim() : null;
  const capsuleId = success ? selectedCapsuleId || buildCapsuleId(ts) : null;
  const derivedIntent = intent || (mutation && mutation.category) || (geneUsed && geneUsed.category) || 'repair';
  const intentMismatch =
    intent && mutation && typeof mutation.category === 'string' && String(intent) !== String(mutation.category);
  if (intentMismatch) protocolViolations.push(`intent_mismatch_with_mutation:${String(intent)}!=${String(mutation.category)}`);

  const sourceType = lastRun && lastRun.source_type ? String(lastRun.source_type) : 'generated';
  const reusedAssetId = lastRun && lastRun.reused_asset_id ? String(lastRun.reused_asset_id) : null;

  const event = {
    type: 'EvolutionEvent',
    schema_version: SCHEMA_VERSION,
    id: buildEventId(ts),
    parent: parentEventId || null,
    intent: derivedIntent,
    signals,
    genes_used: geneUsed && geneUsed.id ? [geneUsed.id] : [],
    mutation_id: mutation && mutation.id ? mutation.id : null,
    personality_state: personalityState || null,
    blast_radius: { files: blast.files, lines: blast.lines },
    outcome: { status: outcomeStatus, score },
    capsule_id: capsuleId,
    source_type: sourceType,
    reused_asset_id: reusedAssetId,
    env_fingerprint: envFp,
    validation_report_id: validationReport.id,
    meta: {
      at: ts,
      signal_key: signalKey,
      selector: lastRun && lastRun.selector ? lastRun.selector : null,
      blast_radius_estimate: lastRun && lastRun.blast_radius_estimate ? lastRun.blast_radius_estimate : null,
      mutation: mutation || null,
      personality: {
        key: personalityKeyUsed,
        known: !!(lastRun && lastRun.personality_known),
        mutations: lastRun && Array.isArray(lastRun.personality_mutations) ? lastRun.personality_mutations : [],
      },
      gene: {
        id: geneUsed && geneUsed.id ? geneUsed.id : null,
        created: !!ensured.created,
        reason: ensured.reason,
      },
      constraints_ok: constraintCheck.ok,
      constraint_violations: constraintCheck.violations,
      constraint_warnings: constraintCheck.warnings || [],
      blast_severity: constraintCheck.blastSeverity ? constraintCheck.blastSeverity.severity : null,
      blast_breakdown: (!constraintCheck.ok && blast)
        ? analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || [])
        : null,
      blast_estimate_comparison: compareBlastEstimate(blastRadiusEstimate, blast),
      validation_ok: validation.ok,
      validation: validation.results.map(r => ({ cmd: r.cmd, ok: r.ok })),
      validation_report: validationReport,
      canary_ok: canary.ok,
      canary_skipped: !!canary.skipped,
      protocol_ok: protocolViolations.length === 0,
      protocol_violations: protocolViolations,
      memory_graph: memoryGraphPath(),
    },
  };
  event.asset_id = computeAssetId(event);

  let capsule = null;
  if (success) {
    const s = String(summary || '').trim();
    const autoSummary = geneUsed
      ? `固化：${geneUsed.id} 命中信号 ${signals.join(', ') || '(none)'}，变更 ${blast.files} 文件 / ${blast.lines} 行。`
      : `固化：命中信号 ${signals.join(', ') || '(none)'}，变更 ${blast.files} 文件 / ${blast.lines} 行。`;
    let prevCapsule = null;
    try {
      if (selectedCapsuleId) {
        const list = require('./assetStore').loadCapsules();
        prevCapsule = Array.isArray(list) ? list.find(c => c && c.type === 'Capsule' && String(c.id) === selectedCapsuleId) : null;
      }
    } catch (e) {}
    capsule = {
      type: 'Capsule',
      schema_version: SCHEMA_VERSION,
      id: capsuleId,
      trigger: prevCapsule && Array.isArray(prevCapsule.trigger) && prevCapsule.trigger.length ? prevCapsule.trigger : signals,
      gene: geneUsed && geneUsed.id ? geneUsed.id : prevCapsule && prevCapsule.gene ? prevCapsule.gene : null,
      summary: s || (prevCapsule && prevCapsule.summary ? String(prevCapsule.summary) : autoSummary),
      confidence: clamp01(score),
      blast_radius: { files: blast.files, lines: blast.lines },
      outcome: { status: 'success', score },
      success_streak: 1,
      env_fingerprint: envFp,
      source_type: sourceType,
      reused_asset_id: reusedAssetId,
      a2a: { eligible_to_broadcast: false },
    };
    capsule.asset_id = computeAssetId(capsule);
  }

  // Bug fix: dry-run must NOT trigger rollback (it should only observe, not mutate).
  if (!dryRun && !success && rollbackOnFailure) {
    rollbackTracked(repoRoot);
    rollbackNewUntrackedFiles({ repoRoot, baselineUntracked: lastRun && lastRun.baseline_untracked ? lastRun.baseline_untracked : [] });
  }

  if (!dryRun) {
    appendEventJsonl(validationReport);
    if (capsule) upsertCapsule(capsule);
    appendEventJsonl(event);
    if (capsule) {
      const streak = computeCapsuleSuccessStreak({ capsuleId: capsule.id });
      capsule.success_streak = streak || 1;
      capsule.a2a = {
        eligible_to_broadcast:
          isBlastRadiusSafe(capsule.blast_radius) &&
          (capsule.outcome.score || 0) >= 0.7 &&
          (capsule.success_streak || 0) >= 2,
      };
      capsule.asset_id = computeAssetId(capsule);
      upsertCapsule(capsule);
    }
    try {
      if (personalityState) {
        updatePersonalityStats({ personalityState, outcome: outcomeStatus, score, notes: `event:${event.id}` });
      }
    } catch (e) {}
  }

  const runId = lastRun && lastRun.run_id ? String(lastRun.run_id) : stableHash(`${parentEventId || 'root'}|${geneId || 'none'}|${signalKey}`);
  state.last_solidify = {
    run_id: runId, at: ts, event_id: event.id, capsule_id: capsuleId, outcome: event.outcome,
  };
  if (!dryRun) writeStateForSolidify(state);

  // Search-First Evolution: auto-publish eligible capsules to the Hub (as Gene+Capsule bundle).
  let publishResult = null;
  if (!dryRun && capsule && capsule.a2a && capsule.a2a.eligible_to_broadcast) {
    const sourceType = lastRun && lastRun.source_type ? String(lastRun.source_type) : 'generated';
    const autoPublish = String(process.env.EVOLVER_AUTO_PUBLISH || 'true').toLowerCase() !== 'false';
    const visibility = String(process.env.EVOLVER_DEFAULT_VISIBILITY || 'public').toLowerCase();
    const minPublishScore = Number(process.env.EVOLVER_MIN_PUBLISH_SCORE) || 0.78;

    // Skip publishing if: disabled, private, reused asset, or below minimum score
    if (autoPublish && visibility === 'public' && sourceType !== 'reused' && (capsule.outcome.score || 0) >= minPublishScore) {
      try {
        const { buildPublishBundle, httpTransportSend } = require('./a2aProtocol');
        const { sanitizePayload } = require('./sanitize');
        const hubUrl = (process.env.A2A_HUB_URL || '').replace(/\/+$/, '');

        if (hubUrl) {
          // Hub requires bundle format: Gene + Capsule published together.
          // Build a Gene object from geneUsed if available; otherwise synthesize a minimal Gene.
          var publishGene = null;
          if (geneUsed && geneUsed.type === 'Gene' && geneUsed.id) {
            publishGene = sanitizePayload(geneUsed);
          } else {
            // Synthesize minimal Gene from capsule data so bundle validation passes
            var { computeAssetId: computeId } = require('./a2aProtocol');
            publishGene = {
              type: 'Gene',
              id: capsule.gene || ('gene_auto_' + (capsule.id || Date.now())),
              category: event && event.intent ? event.intent : 'repair',
              signals_match: Array.isArray(capsule.trigger) ? capsule.trigger : [],
              summary: capsule.summary || '',
            };
            publishGene.asset_id = computeId(publishGene);
          }

          var sanitizedCapsule = sanitizePayload(capsule);
          // Ensure Gene has asset_id
          if (!publishGene.asset_id) {
            var { computeAssetId: computeId2 } = require('./a2aProtocol');
            publishGene.asset_id = computeId2(publishGene);
          }

          var msg = buildPublishBundle({
            gene: publishGene,
            capsule: sanitizedCapsule,
            event: event && event.type === 'EvolutionEvent' ? sanitizePayload(event) : null,
          });
          var result = httpTransportSend(msg, { hubUrl });
          // httpTransportSend returns a Promise
          if (result && typeof result.then === 'function') {
            result
              .then(function (res) {
                if (res && res.ok) {
                  console.log('[AutoPublish] Published bundle (Gene+Capsule) ' + (capsule.asset_id || capsule.id) + ' to Hub.');
                } else {
                  console.log('[AutoPublish] Hub rejected: ' + JSON.stringify(res));
                }
              })
              .catch(function (err) {
                console.log('[AutoPublish] Failed (non-fatal): ' + err.message);
              });
          }
          publishResult = { attempted: true, asset_id: capsule.asset_id || capsule.id, bundle: true };
        } else {
          publishResult = { attempted: false, reason: 'no_hub_url' };
        }
      } catch (e) {
        console.log('[AutoPublish] Error (non-fatal): ' + e.message);
        publishResult = { attempted: false, reason: e.message };
      }
    } else {
      const reason = !autoPublish ? 'auto_publish_disabled'
        : visibility !== 'public' ? 'visibility_private'
        : sourceType === 'reused' ? 'skip_reused_asset'
        : 'below_min_score';
      publishResult = { attempted: false, reason };
    }
  }

  return { ok: success, event, capsule, gene: geneUsed, constraintCheck, validation, validationReport, blast, publishResult };
}

module.exports = {
  solidify,
  readStateForSolidify,
  writeStateForSolidify,
  isValidationCommandAllowed,
  isCriticalProtectedPath,
  detectDestructiveChanges,
  classifyBlastSeverity,
  analyzeBlastRadiusBreakdown,
  compareBlastEstimate,
  runCanaryCheck,
  BLAST_RADIUS_HARD_CAP_FILES,
  BLAST_RADIUS_HARD_CAP_LINES,
};
