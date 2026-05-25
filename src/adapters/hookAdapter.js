const fs = require('fs');
const path = require('path');
const os = require('os');

const PLATFORMS = {
  cursor: { name: 'Cursor', configDir: '.cursor', detector: '.cursor' },
  'claude-code': { name: 'Claude Code', configDir: '.claude', detector: '.claude' },
  codex: { name: 'Codex', configDir: '.codex', detector: '.codex' },
  kiro: { name: 'Kiro', configDir: '.kiro', detector: '.kiro' },
  opencode: { name: 'opencode', configDir: '.opencode', detector: '.opencode' },
};

function detectPlatform(cwd) {
  const root = cwd || process.cwd();
  const home = os.homedir();
  for (const [id, meta] of Object.entries(PLATFORMS)) {
    if (fs.existsSync(path.join(root, meta.detector))) return id;
  }
  for (const [id, meta] of Object.entries(PLATFORMS)) {
    if (fs.existsSync(path.join(home, meta.detector))) return id;
  }
  return null;
}

function resolveConfigRoot(platformId, cwd) {
  const root = cwd || process.cwd();
  const home = os.homedir();
  const meta = PLATFORMS[platformId];
  if (!meta) return null;
  if (fs.existsSync(path.join(root, meta.detector))) return root;
  if (fs.existsSync(path.join(home, meta.detector))) return home;
  return root;
}

function loadAdapter(platformId) {
  switch (platformId) {
    case 'cursor': return require('./cursor');
    case 'claude-code': return require('./claudeCode');
    case 'codex': return require('./codex');
    case 'kiro': return require('./kiro');
    case 'opencode': return require('./opencode');
    default: return null;
  }
}

function mergeJsonFile(filePath, patch, { markerKey = '_evolver_managed' } = {}) {
  let existing = {};
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw) existing = JSON.parse(raw);
    }
  } catch { /* start fresh */ }
  const merged = mergeWithHooksUnion(existing, patch);
  merged[markerKey] = true;
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return merged;
}

// Like deepMerge, but for `hooks.<event>` arrays specifically: instead of
// replacing the user's existing entries, keep them and append/refresh evolver-
// owned entries (matched by command containing `evolver-session/-signal`).
// This preserves user-installed Stop/SessionStart hooks (#539) while still
// updating evolver hooks across reinstalls.
function mergeWithHooksUnion(target, source) {
  const result = deepMerge(target, source);
  if (
    target && target.hooks && typeof target.hooks === 'object' &&
    source && source.hooks && typeof source.hooks === 'object'
  ) {
    for (const event of Object.keys(source.hooks)) {
      const tArr = Array.isArray(target.hooks[event]) ? target.hooks[event] : null;
      const sArr = Array.isArray(source.hooks[event]) ? source.hooks[event] : null;
      if (tArr && sArr) {
        const isEvolverOwned = (entry) => {
          const cmds = collectCommands(entry);
          return cmds.some(c => c.includes('evolver-session') || c.includes('evolver-signal'));
        };
        const userEntries = tArr.filter(e => !isEvolverOwned(e));
        result.hooks[event] = [...userEntries, ...sArr];
      }
    }
  }
  return result;
}

// Pull all `command` strings out of an event entry, supporting both flat
// shape (Codex: `{type, command}`) and Claude Code matcher shape
// (`{matcher, hooks: [{type, command}]}`). Returns [] when neither applies.
function collectCommands(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const out = [];
  if (typeof entry.command === 'string') out.push(entry.command);
  if (Array.isArray(entry.hooks)) {
    for (const h of entry.hooks) {
      if (h && typeof h.command === 'string') out.push(h.command);
    }
  }
  return out;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Refuse to write/read through a symbolic link at the adapter's
// platform config dir (`<root>/.codex`, `<root>/.claude`, …) or any
// nested adapter-owned subdir (`hooks/`, `plugins/`, …). A
// repository-controlled symlink at any of these paths would let
// install/uninstall writes land on attacker-chosen files outside the
// workspace (PR #94 round-4 surfaced the top-level case; round-5
// surfaced that a hostile repo can keep `.codex` real and only
// symlink `.codex/hooks`). Missing dirs are fine — install will
// create them.
function assertSafeConfigDir(dir, label, { subdirs = [] } = {}) {
  assertNotSymlink(dir, label || 'config dir');
  for (const sub of subdirs) {
    assertNotSymlink(path.join(dir, sub), `${label || 'config dir'}/${sub}`);
  }
}

function assertNotSymlink(p, label) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `[setup-hooks] Refusing to operate: ${label} ${p} is a ` +
      `symbolic link. evolver will not follow symlinks for ` +
      `adapter-owned dirs — a hostile workspace could redirect ` +
      `writes/unlinks outside the project root. Replace it with a ` +
      `real directory and rerun.`
    );
  }
}

function copyHookScripts(destDir, evolverRoot) {
  const scriptsDir = path.join(evolverRoot || __dirname, 'scripts');
  // Helper modules are required by copied hook scripts via relative require()
  // calls, which resolve against the destination hook directory at runtime.
  const scripts = [
    '_runtimePaths.js',
    '_memoryFiltering.js',
    'evolver-session-start.js',
    'evolver-signal-detect.js',
    'evolver-session-end.js',
  ];
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of scripts) {
    const src = path.join(scriptsDir, name);
    const dest = path.join(destDir, name);
    if (!fs.existsSync(src)) {
      console.warn(`[setup-hooks] Warning: script not found: ${src}`);
      continue;
    }
    // PR #94 round-6 HIGH: reject if the destination is a pre-planted
    // symlink. fs.copyFileSync follows symlinks at the destination, so
    // a hostile repo that pre-creates `.codex/hooks/evolver-session-end.js`
    // pointing at e.g. `~/.bashrc` would have its target overwritten with
    // evolver script content. Round-5 closed the directory hole; this
    // closes the per-file hole.
    assertNotSymlink(dest, `hook destination ${name}`);
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o755); } catch { /* windows */ }
    copied.push(dest);
  }
  return copied;
}

function appendSectionToFile(filePath, marker, content) {
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
  if (existing.includes(marker)) {
    console.log(`[setup-hooks] Section already present in ${filePath}, skipping.`);
    return false;
  }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
  fs.writeFileSync(filePath, existing + separator + content + '\n', 'utf8');
  return true;
}

function removeEvolverHooks(filePath, { markerKey = '_evolver_managed' } = {}) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data[markerKey]) return false;

    let changed = false;
    if (data.hooks) {
      for (const event of Object.keys(data.hooks)) {
        if (Array.isArray(data.hooks[event])) {
          const before = data.hooks[event].length;
          data.hooks[event] = data.hooks[event].filter(h => {
            const cmd = h.command || '';
            return !cmd.includes('evolver-session') && !cmd.includes('evolver-signal');
          });
          if (data.hooks[event].length !== before) changed = true;
          if (data.hooks[event].length === 0) delete data.hooks[event];
        }
      }
      if (Object.keys(data.hooks).length === 0) delete data.hooks;
    }
    if (data.mcpServers) {
      // Claude Code / Codex: hooks in mcpServers sub-key -- not relevant, skip
    }
    delete data[markerKey];
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
    return changed;
  } catch {
    return false;
  }
}

function removeHookScripts(hooksDir) {
  const scripts = [
    '_runtimePaths.js',
    '_memoryFiltering.js',
    'evolver-session-start.js',
    'evolver-signal-detect.js',
    'evolver-session-end.js',
  ];
  let removed = 0;
  for (const name of scripts) {
    const p = path.join(hooksDir, name);
    try {
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
    } catch (e) {
      // Surface unlink failures so users can see why a "successful"
      // uninstall left files behind (Windows file-locking, perms, …).
      console.warn(`[setup-hooks] Failed to remove ${p}: ${e.message || e}`);
    }
  }
  return removed;
}

// Remove a marker-bracketed section from a markdown file. Used by adapter
// uninstall to clean up CLAUDE.md / AGENTS.md without nuking surrounding
// user content.
//
// The previous inline implementations (codex/claude/kiro/opencode) searched
// for the *next* `\n## ` after the marker, which matched evolver's own
// `## Evolution Memory` heading and left the entire injected section in
// place (#538). This helper skips any `## ` heading on the same line as the
// marker, then looks for the next H2 to know where the user's content
// resumes.
function removeMarkedSection(filePath, marker) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    const idx = raw.indexOf(marker);
    if (idx === -1) return false;

    // Skip past the marker line (and any heading on the same line).
    let scanFrom = idx + marker.length;
    const eol = raw.indexOf('\n', scanFrom);
    if (eol !== -1) scanFrom = eol + 1;

    // Skip past evolver's own `## ...` heading line if present.
    if (raw.startsWith('## ', scanFrom)) {
      const eol2 = raw.indexOf('\n', scanFrom);
      scanFrom = eol2 !== -1 ? eol2 + 1 : raw.length;
    }

    const nextSection = raw.indexOf('\n## ', scanFrom);
    const endIdx = nextSection !== -1 ? nextSection : raw.length;
    const before = raw.slice(0, idx).trimEnd();
    const after = nextSection !== -1 ? raw.slice(endIdx) : '';
    const next = (before ? before + (after.startsWith('\n') ? '' : '\n') : '') + after;
    fs.writeFileSync(filePath, next.trimEnd() + '\n', 'utf8');
    return true;
  } catch (e) {
    console.warn(`[setup-hooks] Failed to clean section in ${filePath}: ${e.message || e}`);
    return false;
  }
}

async function setupHooks({ platform, cwd, force, uninstall, evolverRoot } = {}) {
  const effectiveCwd = cwd || process.cwd();
  const effectiveEvolverRoot = evolverRoot || path.resolve(__dirname, '..');
  const platformId = platform || detectPlatform(effectiveCwd);

  if (!platformId) {
    console.error('[setup-hooks] Could not detect platform. Use --platform=cursor|claude-code|codex|kiro|opencode');
    return { ok: false, error: 'platform_not_detected' };
  }

  const meta = PLATFORMS[platformId];
  if (!meta) {
    console.error(`[setup-hooks] Unknown platform: ${platformId}`);
    return { ok: false, error: 'unknown_platform' };
  }

  const configRoot = resolveConfigRoot(platformId, effectiveCwd);
  const adapter = loadAdapter(platformId);
  if (!adapter) {
    console.error(`[setup-hooks] No adapter found for ${platformId}`);
    return { ok: false, error: 'no_adapter' };
  }

  console.log(`[setup-hooks] Platform: ${meta.name}`);
  console.log(`[setup-hooks] Config root: ${configRoot}`);

  if (uninstall) {
    return adapter.uninstall({ configRoot, evolverRoot: effectiveEvolverRoot });
  }

  return adapter.install({ configRoot, evolverRoot: effectiveEvolverRoot, force });
}

module.exports = {
  detectPlatform,
  resolveConfigRoot,
  loadAdapter,
  mergeJsonFile,
  deepMerge,
  mergeWithHooksUnion,
  collectCommands,
  copyHookScripts,
  appendSectionToFile,
  assertSafeConfigDir,
  assertNotSymlink,
  removeEvolverHooks,
  removeHookScripts,
  removeMarkedSection,
  setupHooks,
  PLATFORMS,
};
