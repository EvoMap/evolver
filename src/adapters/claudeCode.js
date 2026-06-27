const fs = require('fs');
const path = require('path');
const { mergeJsonFile, copyHookScripts, appendSectionToFile, removeHookScripts, removeMarkedSection, assertSafeConfigDir, isEvolverHookCommand } = require('./hookAdapter');

const HOOK_SCRIPTS_DIR_NAME = 'hooks';
const EVOLVER_MARKER = '<!-- evolver-evolution-memory -->';

// Resolve an evolver hook script from the PROJECT's .claude/hooks first, then
// fall back to the user-home install. The evolver can be installed at the
// home/global scope (one shared install), but Claude Code resolves a bare
// `.claude/hooks/...` command path against each *project* dir — so a bare
// relative command silently fails in every project except the install root.
// This emits a project-or-home fallback, cross-platform, so the hook fires no
// matter where the scripts were copied.
function buildHookCommand(scriptName) {
  if (process.platform === 'win32') {
    const proj = `%CLAUDE_PROJECT_DIR%\\.claude\\hooks\\${scriptName}`;
    const home = `%USERPROFILE%\\.claude\\hooks\\${scriptName}`;
    return `cmd /c "IF EXIST "${proj}" (node "${proj}") ELSE (node "${home}")"`;
  }
  return `sh -c 'f="$CLAUDE_PROJECT_DIR/.claude/hooks/${scriptName}"; [ -f "$f" ] || f="$HOME/.claude/hooks/${scriptName}"; node "$f"'`;
}

function buildClaudeHooks(evolverRoot) {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: buildHookCommand('evolver-session-start.js'),
              timeout: 3,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              // Runtime asset injection (P4-c). DEFAULT off (EVOLVER_RECALL_MODE
              // unset/off -> emits {} without reading the prompt). The script
              // owns an absolute 3.3s watchdog that always exits 0 with valid
              // JSON (fail-open); this host timeout (5s) is a strict backstop
              // ABOVE that watchdog, so the host never kills the script
              // mid-write. A stuck/slow recall can never block or erase the
              // user's prompt.
              command: buildHookCommand('evolver-task-recall.js'),
              timeout: 5,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [
            {
              type: 'command',
              command: buildHookCommand('evolver-signal-detect.js'),
              timeout: 2,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: buildHookCommand('evolver-session-end.js'),
              timeout: 8,
            },
          ],
        },
      ],
    },
  };
}

function buildClaudeMdSection() {
  return `${EVOLVER_MARKER}
## Evolution Memory (Evolver)

This project uses evolver for self-evolution. Hooks automatically:
1. Inject recent evolution memory at session start
2. Detect evolution signals during file edits
3. Record outcomes at session end
4. (Opt-in) Surface matching distilled capabilities for each prompt — set
   \`EVOLVER_RECALL_MODE=shadow\` to preview, \`enforce\` to inject (default off).

For substantive tasks, call \`gep_recall\` before work and \`gep_record_outcome\` after.
Signals: log_error, perf_bottleneck, user_feature_request, capability_gap, deployment_issue, test_failure.`;
}

function install({ configRoot, evolverRoot, force }) {
  const claudeDir = path.join(configRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hooksDir = path.join(claudeDir, HOOK_SCRIPTS_DIR_NAME);
  const claudeMdPath = path.join(configRoot, 'CLAUDE.md');
  assertSafeConfigDir(claudeDir, '.claude', { subdirs: [HOOK_SCRIPTS_DIR_NAME] });

  if (!force && fs.existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (existing._evolver_managed) {
        console.log('[claude-code] Evolver hooks already installed. Use --force to overwrite.');
        return { ok: true, skipped: true };
      }
    } catch { /* proceed */ }
  }

  fs.mkdirSync(claudeDir, { recursive: true });

  const hooksCfg = buildClaudeHooks(evolverRoot);
  mergeJsonFile(settingsPath, hooksCfg);
  console.log('[claude-code] Wrote ' + settingsPath);

  const copied = copyHookScripts(hooksDir, path.join(evolverRoot, 'src', 'adapters'));
  console.log('[claude-code] Copied ' + copied.length + ' hook scripts to ' + hooksDir);

  const injected = appendSectionToFile(claudeMdPath, EVOLVER_MARKER, buildClaudeMdSection());
  if (injected) {
    console.log('[claude-code] Injected evolution section into ' + claudeMdPath);
  }

  console.log('[claude-code] Installation complete.');

  return {
    ok: true,
    platform: 'claude-code',
    files: [settingsPath, claudeMdPath, ...copied],
  };
}

function uninstall({ configRoot }) {
  const claudeDir = path.join(configRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hooksDir = path.join(claudeDir, HOOK_SCRIPTS_DIR_NAME);
  const claudeMdPath = path.join(configRoot, 'CLAUDE.md');
  assertSafeConfigDir(claudeDir, '.claude', { subdirs: [HOOK_SCRIPTS_DIR_NAME] });

  let changed = false;

  // Strip evolver entries from settings.json. Even without the marker we
  // still try to filter by command — a missing/dropped marker should not
  // strand obvious evolver-owned entries (#538).
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let touched = false;
      if (data.hooks) {
        for (const event of Object.keys(data.hooks)) {
          if (Array.isArray(data.hooks[event])) {
            const beforeLen = data.hooks[event].length;
            data.hooks[event] = data.hooks[event]
              .map(matcher => {
                if (!matcher || !Array.isArray(matcher.hooks)) return matcher;
                const innerBefore = matcher.hooks.length;
                const filtered = matcher.hooks.filter(h => {
                  const cmd = (h && h.command) || '';
                  return !isEvolverHookCommand(cmd);
                });
                // A matcher containing both evolver and user hooks shrinks
                // its inner array without changing the outer matcher count.
                // Track the inner-array shrink so `touched` reflects it.
                if (filtered.length !== innerBefore) touched = true;
                return { ...matcher, hooks: filtered };
              })
              .filter(matcher => matcher && Array.isArray(matcher.hooks) && matcher.hooks.length > 0);
            if (data.hooks[event].length !== beforeLen) touched = true;
            if (data.hooks[event].length === 0) delete data.hooks[event];
          }
        }
        if (Object.keys(data.hooks).length === 0) delete data.hooks;
      }
      if (data._evolver_managed) {
        delete data._evolver_managed;
        touched = true;
      }
      if (touched) {
        fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        changed = true;
      }
    }
  } catch (e) {
    console.warn(`[claude-code] Failed to clean ${settingsPath}: ${e.message || e}`);
  }

  const scripts = removeHookScripts(hooksDir);
  if (scripts > 0) changed = true;
  try {
    if (fs.existsSync(hooksDir) && fs.readdirSync(hooksDir).length === 0) {
      fs.rmdirSync(hooksDir);
    }
  } catch { /* best-effort */ }

  if (removeMarkedSection(claudeMdPath, EVOLVER_MARKER)) {
    changed = true;
  }

  console.log(changed
    ? '[claude-code] Uninstalled evolver hooks.'
    : '[claude-code] No evolver hooks found to uninstall.');

  return { ok: true, removed: changed };
}

module.exports = { install, uninstall, buildClaudeHooks };
