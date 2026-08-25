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

const HOOK_SCRIPT_NAMES = Object.freeze([
  '_runtimePaths.js',
  '_memoryFiltering.js',
  '_lockPaths.js',
  'evolver-session-start.js',
  'evolver-signal-detect.js',
  'evolver-session-end.js',
  'evolver-task-recall.js',
]);

// Detect the host agent from runtime environment signals, which are far more
// reliable than scanning for `.claude` / `.cursor` directories when both exist
// on disk (e.g. under $HOME). Precedence when signals conflict (#590):
//   1. strong Claude Code signals (set only by the Claude Code runtime)
//   2. Cursor signals
//   3. Codex signals
//   4. CLAUDE_PROJECT_DIR — a weak Claude alias some hosts (incl. Cursor's
//      Claude integration) export, so it loses to explicit Cursor signals.
function detectPlatformFromEnv(env = process.env) {
  const hasStrongClaudeSignal = env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT;
  if (hasStrongClaudeSignal) {
    return 'claude-code';
  }

  const hasCursorSignal =
    env.CURSOR_TRACE_ID ||
    env.CURSOR_SESSION_ID ||
    env.CURSOR_PROJECT_DIR ||
    env.CURSOR_AGENT ||
    String(env.TERM_PROGRAM || '').toLowerCase() === 'cursor';
  if (hasCursorSignal) {
    return 'cursor';
  }
  const hasCodexSignal =
    env.CODEX_THREAD_ID ||
    env.CODEX_SHELL ||
    env.CODEX_CI ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (hasCodexSignal) {
    return 'codex';
  }
  if (env.CLAUDE_PROJECT_DIR) {
    return 'claude-code';
  }
  return null;
}

function detectPlatform(cwd) {
  const envPlatform = detectPlatformFromEnv();
  if (envPlatform) return envPlatform;

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

// Quote `value` as a single shell argument for the host that runs hook
// `command` strings (POSIX sh, or cmd.exe on Windows).
function shellQuoteForHost(value) {
  const raw = String(value);
  if (process.platform === 'win32') {
    return `"${raw.replace(/"/g, '\\"')}"`;
  }
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

// Build a hook `command` that runs `scriptPath` with node WITHOUT exposing the
// path bytes to the shell. The absolute path is base64-encoded into a `node -e`
// wrapper that decodes it and spawns the real script with `shell:false`, so
// spaces / `$()` / backticks / `%VAR%` in the path can never be expanded by sh
// or cmd.exe (#590). The plaintext basename is appended as a final, inert arg
// so uninstall/reinstall can still match evolver-owned hooks by command
// substring (see isEvolverHookCommand) even though the path itself is encoded.
//
// Shared across adapters so there is exactly one implementation to audit.
function buildSafeNodeHookCommand(scriptPath) {
  const encodedPath = Buffer.from(String(scriptPath), 'utf8').toString('base64');
  const js = [
    "const{spawnSync}=require('child_process')",
    `const p=Buffer.from('${encodedPath}','base64').toString('utf8')`,
    "const r=spawnSync(process.execPath,[p],{stdio:'inherit',shell:false})",
    "if(r.error){console.error(r.error.message||String(r.error));process.exit(1)}",
    "process.exit(r.status==null?1:r.status)",
  ].join(';');
  return `node -e ${shellQuoteForHost(js)} ${path.basename(scriptPath)}`;
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
        const userEntries = tArr
          .map(stripEvolverCommands)
          .filter(Boolean);
        result.hooks[event] = [...userEntries, ...sArr];
      }
    }
  }
  return result;
}

function stripEvolverCommands(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.command === 'string' && isEvolverHookCommand(entry.command)) {
    return null;
  }
  if (!Array.isArray(entry.hooks)) return entry;

  const hooks = entry.hooks.filter(h => {
    const cmd = h && h.command;
    return !(typeof cmd === 'string' && isEvolverHookCommand(cmd));
  });
  if (hooks.length === 0) return null;
  if (hooks.length === entry.hooks.length) return entry;
  return { ...entry, hooks };
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

function isEvolverHookCommand(command) {
  if (typeof command !== 'string') return false;
  return command.includes('evolver-session') ||
    command.includes('evolver-signal') ||
    command.includes('evolver-task-recall') ||
    // Legacy installs briefly shipped this companion daemon hook. Treat it
    // as evolver-owned so reinstall/merge can remove it instead of preserving
    // a stale supervisor that may point clients at a dead proxy.
    command.includes('evolver-daemon-start');
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
  // Every helper required by the entry-point hooks via `require('./_xxx')`
  // resolves relative to the *destination* (`__dirname` after copy), so
  // every such helper MUST appear here or the hook crashes with
  // MODULE_NOT_FOUND at runtime. Two regressions of this shape have shipped
  // already:
  //   - PR #94 review caught `_runtimePaths.js` missing from this list.
  //   - Issue #547 (rendigua, v1.87.0): `_memoryFiltering.js` was added to
  //     evolver-session-start.js but not here, so fresh installs failed
  //     immediately on `node .codex/hooks/evolver-session-start.js`.
  // To keep future helpers from re-living this, the regression test in
  // test/adapters.test.js scans every `require('./_*')` in the source
  // adapter scripts and asserts the target file is in this list.
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of HOOK_SCRIPT_NAMES) {
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
    // NOTE(windows): fs.chmodSync is a no-op on Windows; hook scripts remain
    // executable via file extension association (.js), not Unix mode bits.
    try { fs.chmodSync(dest, 0o755); } catch { /* best-effort; no-op on Windows */ }
    copied.push(dest);
  }
  return copied;
}

function verifyHookScriptCopies(hooksDir) {
  const scriptsDir = path.join(__dirname, 'scripts');
  const invalid = [];
  for (const name of HOOK_SCRIPT_NAMES) {
    const source = path.join(scriptsDir, name);
    const installed = path.join(hooksDir, name);
    try {
      const installedStat = fs.lstatSync(installed);
      if (!installedStat.isFile()) {
        invalid.push(`${name} is not a regular file`);
        continue;
      }
      if (!fs.readFileSync(source).equals(fs.readFileSync(installed))) {
        invalid.push(`${name} differs from the installed Evolver version`);
      }
    } catch {
      invalid.push(`${name} is missing`);
    }
  }
  return {
    id: 'hook_scripts_present',
    ok: invalid.length === 0,
    detail: invalid.length === 0
      ? `all ${HOOK_SCRIPT_NAMES.length} runtime files match this Evolver version`
      : invalid.join(', '),
  };
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
            return !isEvolverHookCommand(cmd);
          });
          if (data.hooks[event].length !== before) changed = true;
          if (data.hooks[event].length === 0) delete data.hooks[event];
        }
      }
      if (Object.keys(data.hooks).length === 0) delete data.hooks;
    }
    if (data.mcpServers) {
      // Product-bridge MCP is owned by productBridgeMcp.js, not this
      // hooks cleaner. Leaving mcpServers untouched avoids deleting a
      // user server just because the file also carries _evolver_managed.
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
  // Must mirror the install list above. If install copies a helper but
  // uninstall doesn't remove it, `setup-hooks --uninstall` leaves orphan
  // files behind that the user then has to clean up by hand (#547 fix
  // would have introduced exactly this gap if only the install side
  // had been updated).
  let removed = 0;
  for (const name of HOOK_SCRIPT_NAMES) {
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

async function setupHooks({ platform, cwd, configRoot, force, uninstall, evolverRoot } = {}) {
  const effectiveCwd = cwd || process.cwd();
  const effectiveEvolverRoot = evolverRoot || path.resolve(__dirname, '..');
  const platformId = platform || detectPlatform(configRoot || effectiveCwd);

  if (!platformId) {
    console.error('[setup-hooks] Could not detect platform. Use --platform=cursor|claude-code|codex|kiro|opencode');
    return { ok: false, error: 'platform_not_detected' };
  }

  const meta = PLATFORMS[platformId];
  if (!meta) {
    console.error(`[setup-hooks] Unknown platform: ${platformId}`);
    return { ok: false, error: 'unknown_platform' };
  }

  const resolvedConfigRoot = configRoot
    ? path.resolve(configRoot)
    : resolveConfigRoot(platformId, effectiveCwd);
  const adapter = loadAdapter(platformId);
  if (!adapter) {
    console.error(`[setup-hooks] No adapter found for ${platformId}`);
    return { ok: false, error: 'no_adapter' };
  }

  console.log(`[setup-hooks] Platform: ${meta.name}`);
  console.log(`[setup-hooks] Config root: ${resolvedConfigRoot}`);

  if (uninstall) {
    return adapter.uninstall({ configRoot: resolvedConfigRoot, evolverRoot: effectiveEvolverRoot });
  }

  return adapter.install({ configRoot: resolvedConfigRoot, evolverRoot: effectiveEvolverRoot, force });
}

module.exports = {
  detectPlatformFromEnv,
  detectPlatform,
  buildSafeNodeHookCommand,
  resolveConfigRoot,
  loadAdapter,
  mergeJsonFile,
  deepMerge,
  mergeWithHooksUnion,
  collectCommands,
  isEvolverHookCommand,
  copyHookScripts,
  verifyHookScriptCopies,
  appendSectionToFile,
  assertSafeConfigDir,
  assertNotSymlink,
  removeEvolverHooks,
  removeHookScripts,
  removeMarkedSection,
  setupHooks,
  HOOK_SCRIPT_NAMES,
  PLATFORMS,
};
