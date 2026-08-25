const fs = require('fs');
const path = require('path');
const { mergeJsonFile, copyHookScripts, verifyHookScriptCopies, appendSectionToFile, removeHookScripts, removeMarkedSection, assertSafeConfigDir, isEvolverHookCommand } = require('./hookAdapter');
const productBridgeMcp = require('./productBridgeMcp');

const HOOK_SCRIPTS_DIR_NAME = 'hooks';
const EVOLVER_MARKER = '<!-- evolver-evolution-memory -->';

function buildCodexHooksJson(evolverRoot) {
  const scriptsBase = '.codex/hooks';
  return {
    hooks: {
      SessionStart: [
        {
          type: 'command',
          command: `node ${scriptsBase}/evolver-session-start.js`,
          timeout: 3,
        },
      ],
      PostToolUse: [
        {
          type: 'command',
          command: `node ${scriptsBase}/evolver-signal-detect.js`,
          timeout: 2,
        },
      ],
      Stop: [
        {
          type: 'command',
          command: `node ${scriptsBase}/evolver-session-end.js`,
          timeout: 8,
        },
      ],
    },
  };
}

function isEscapedAt(line, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function structuralTomlLines(lines) {
  let multiline = null;
  return lines.map((rawLine) => {
    let structural = '';
    let singleQuoted = false;
    let doubleQuoted = false;
    for (let index = 0; index < rawLine.length; index += 1) {
      if (multiline) {
        if (
          rawLine.startsWith(multiline, index) &&
          (multiline === "'''" || !isEscapedAt(rawLine, index))
        ) {
          multiline = null;
          index += 2;
        }
        continue;
      }
      if (!singleQuoted && !doubleQuoted && rawLine[index] === '#') break;
      if (!singleQuoted && !doubleQuoted && rawLine.startsWith('"""', index)) {
        multiline = '"""';
        index += 2;
        continue;
      }
      if (!singleQuoted && !doubleQuoted && rawLine.startsWith("'''", index)) {
        multiline = "'''";
        index += 2;
        continue;
      }
      if (!doubleQuoted && rawLine[index] === "'") singleQuoted = !singleQuoted;
      if (!singleQuoted && rawLine[index] === '"' && !isEscapedAt(rawLine, index)) {
        doubleQuoted = !doubleQuoted;
      }
      structural += rawLine[index];
    }
    return structural.trim();
  });
}

function tomlSectionName(line) {
  const header = line.match(/^\[([^\]]+)\]$/);
  return header ? header[1].trim() : null;
}

function featuresSection(lines) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const section = tomlSectionName(lines[index]);
    if (section === 'features') {
      start = index;
      continue;
    }
    if (start >= 0 && section !== null) {
      return { start, end: index };
    }
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

function codexHooksLine(rawLine) {
  return /^codex_hooks\s*=\s*(true|false)$/.exec(
    String(rawLine).trim()
  );
}

function codexHooksEnabled(content) {
  const lines = String(content).split(/\r?\n/);
  const structural = structuralTomlLines(lines);
  const section = featuresSection(structural);
  if (!section) return false;
  return structural
    .slice(section.start + 1, section.end)
    .some(line => codexHooksLine(line)?.[1] === 'true');
}

function updateCodexHooksFeature(content, enabled) {
  const source = String(content);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const structural = structuralTomlLines(lines);
  let section = featuresSection(structural);
  if (!section && enabled) {
    let prefix = source;
    if (prefix && !prefix.endsWith('\n') && !prefix.endsWith('\r')) prefix += newline;
    if (prefix && !prefix.endsWith(newline + newline)) prefix += newline;
    return {
      changed: true,
      content: `${prefix}[features]${newline}codex_hooks = true${newline}`,
    };
  }
  if (!section) return { changed: false, content: source };

  const settingIndexes = [];
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (codexHooksLine(structural[index])) settingIndexes.push(index);
  }
  if (enabled) {
    if (
      settingIndexes.length === 1 &&
      codexHooksLine(structural[settingIndexes[0]])?.[1] === 'true'
    ) {
      return { changed: false, content: source };
    }
    if (settingIndexes.length === 0) {
      lines.splice(section.start + 1, 0, 'codex_hooks = true');
    } else {
      lines[settingIndexes[0]] = 'codex_hooks = true';
      for (const index of settingIndexes.slice(1).reverse()) lines.splice(index, 1);
    }
  } else {
    if (settingIndexes.length === 0) {
      return { changed: false, content: source };
    }
    for (const index of settingIndexes.reverse()) lines.splice(index, 1);
    section = featuresSection(structuralTomlLines(lines));
    const remaining = lines
      .slice(section.start + 1, section.end)
      .some(line => line.trim() !== '');
    if (!remaining) lines.splice(section.start, section.end - section.start);
  }
  return { changed: true, content: lines.join(newline) };
}

function ensureConfigToml(codexDir) {
  const tomlPath = path.join(codexDir, 'config.toml');
  let content = '';
  try { content = fs.readFileSync(tomlPath, 'utf8'); } catch { /* new file */ }

  const updated = updateCodexHooksFeature(content, true);
  if (!updated.changed) return false;
  fs.writeFileSync(tomlPath, updated.content, 'utf8');
  return true;
}

function cleanConfigToml(codexDir) {
  const tomlPath = path.join(codexDir, 'config.toml');
  let content;
  try { content = fs.readFileSync(tomlPath, 'utf8'); } catch { return false; }
  const updated = updateCodexHooksFeature(content, false);
  if (!updated.changed) return false;
  fs.writeFileSync(tomlPath, updated.content, 'utf8');
  return true;
}

function buildAgentsMdSection() {
  return `${EVOLVER_MARKER}
## Evolution Memory (Evolver)

This project uses evolver for self-evolution. Hooks automatically:
1. Run quietly at session start and load recent evolution memory when useful
2. Detect evolution signals during file edits
3. Record outcomes at session end

Use Evolver context only when it is directly relevant. Do not narrate routine Evolver checks, hook status, or empty recall/search results to the user.
Signals: log_error, perf_bottleneck, user_feature_request, capability_gap, deployment_issue, test_failure.`;
}

function install({ configRoot, evolverRoot, force }) {
  const codexDir = path.join(configRoot, '.codex');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');
  const hooksDir = path.join(codexDir, HOOK_SCRIPTS_DIR_NAME);
  const agentsMdPath = path.join(configRoot, 'AGENTS.md');
  assertSafeConfigDir(codexDir, '.codex', { subdirs: [HOOK_SCRIPTS_DIR_NAME] });

  if (!force && fs.existsSync(hooksJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      if (existing._evolver_managed) {
        const mcp = productBridgeMcp.installCodexToml({ configRoot, evolverRoot, force });
        if (mcp.changed) {
          console.log('[codex] Wrote product-bridge MCP ' + mcp.path);
        }
        console.log('[codex] Evolver hooks already installed. Use --force to overwrite.');
        return { ok: true, skipped: true, files: mcp.changed ? [mcp.path] : [] };
      }
    } catch { /* proceed */ }
  }

  fs.mkdirSync(codexDir, { recursive: true });

  const hooksCfg = buildCodexHooksJson(evolverRoot);
  mergeJsonFile(hooksJsonPath, hooksCfg);
  console.log('[codex] Wrote ' + hooksJsonPath);

  const copied = copyHookScripts(hooksDir, path.join(evolverRoot, 'src', 'adapters'));
  console.log('[codex] Copied ' + copied.length + ' hook scripts to ' + hooksDir);

  const tomlChanged = ensureConfigToml(codexDir);
  if (tomlChanged) {
    console.log('[codex] Enabled codex_hooks in config.toml');
  }

  const injected = appendSectionToFile(agentsMdPath, EVOLVER_MARKER, buildAgentsMdSection());
  if (injected) {
    console.log('[codex] Injected evolution section into ' + agentsMdPath);
  }

  const mcp = productBridgeMcp.installCodexToml({ configRoot, evolverRoot, force });
  if (mcp.changed) {
    console.log('[codex] Wrote product-bridge MCP ' + mcp.path);
  } else if (mcp.skipped) {
    console.log('[codex] Left a user-owned evox-product MCP table in place');
  }

  console.log('[codex] Installation complete.');

  return {
    ok: true,
    platform: 'codex',
    files: [hooksJsonPath, path.join(codexDir, 'config.toml'), agentsMdPath, ...copied],
  };
}

function verify({ configRoot }) {
  const codexDir = path.join(configRoot, '.codex');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');
  const hooksDir = path.join(codexDir, HOOK_SCRIPTS_DIR_NAME);
  const configTomlPath = path.join(codexDir, 'config.toml');
  const agentsMdPath = path.join(configRoot, 'AGENTS.md');
  const checks = [];
  let hooks = null;
  let hooksError = null;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch (error) {
    hooksError = error && error.message || String(error);
  }
  checks.push({
    id: 'hooks_json_readable',
    ok: hooks !== null,
    detail: hooks ? hooksJsonPath : `unreadable: ${hooksError}`,
  });
  checks.push({
    id: 'managed_marker',
    ok: hooks?._evolver_managed === true,
    detail: hooks?._evolver_managed === true
      ? '_evolver_managed is true'
      : 'hooks.json is not marked as evolver-managed',
  });

  const expectedHooks = buildCodexHooksJson('').hooks;
  const missingCommands = [];
  for (const [event, expectedEntries] of Object.entries(expectedHooks)) {
    const actualEntries = Array.isArray(hooks?.hooks?.[event])
      ? hooks.hooks[event]
      : [];
    for (const expected of expectedEntries) {
      const present = actualEntries.some(entry =>
        entry?.type === expected.type &&
        entry?.command === expected.command &&
        entry?.timeout === expected.timeout
      );
      if (!present) {
        missingCommands.push(`${event}:${path.basename(expected.command)}`);
      }
    }
  }
  checks.push({
    id: 'hooks_registered',
    ok: missingCommands.length === 0,
    detail: missingCommands.length === 0
      ? 'all Codex hooks are registered'
      : 'missing commands: ' + missingCommands.join(', '),
  });

  checks.push(verifyHookScriptCopies(hooksDir));

  let configToml = '';
  try { configToml = fs.readFileSync(configTomlPath, 'utf8'); } catch { /* reported below */ }
  const hooksEnabled = codexHooksEnabled(configToml);
  checks.push({
    id: 'codex_hooks_enabled',
    ok: hooksEnabled,
    detail: hooksEnabled
      ? 'config.toml enables codex_hooks'
      : 'config.toml does not enable codex_hooks',
  });

  let hasMemorySection = false;
  try {
    hasMemorySection = fs.readFileSync(agentsMdPath, 'utf8').includes(EVOLVER_MARKER);
  } catch { /* reported below */ }
  checks.push({
    id: 'agents_md_section',
    ok: hasMemorySection,
    detail: hasMemorySection
      ? 'AGENTS.md contains the managed evolution section'
      : 'AGENTS.md is missing the managed evolution section',
  });
  checks.push(...productBridgeMcp.verifyCodexToml({ configRoot }).checks);

  return {
    ok: checks.every(check => check.ok),
    platform: 'codex',
    config_root: configRoot,
    hooks_path: hooksJsonPath,
    hooks_dir: hooksDir,
    checks,
  };
}

function printVerifyReport(report) {
  console.log('[codex] Verify report');
  for (const check of report.checks) {
    console.log(`[codex]   ${check.ok ? '[OK]  ' : '[FAIL]'} ${check.id} -- ${check.detail}`);
  }
}

function uninstall({ configRoot }) {
  const codexDir = path.join(configRoot, '.codex');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');
  const hooksDir = path.join(codexDir, HOOK_SCRIPTS_DIR_NAME);
  const agentsMdPath = path.join(configRoot, 'AGENTS.md');
  assertSafeConfigDir(codexDir, '.codex', { subdirs: [HOOK_SCRIPTS_DIR_NAME] });

  let changed = false;

  // Strip evolver entries from hooks.json. Even when the
  // `_evolver_managed` marker is missing (older install, hand-edited
  // file), we still try to filter by command — a missing marker should
  // not strand obvious evolver-owned entries (#538).
  try {
    if (fs.existsSync(hooksJsonPath)) {
      const data = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      let touched = false;
      if (data.hooks) {
        for (const event of Object.keys(data.hooks)) {
          if (Array.isArray(data.hooks[event])) {
            const before = data.hooks[event].length;
            data.hooks[event] = data.hooks[event].filter(h => {
              const cmd = (h && h.command) || '';
              return !isEvolverHookCommand(cmd);
            });
            if (data.hooks[event].length !== before) touched = true;
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
        fs.writeFileSync(hooksJsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        changed = true;
      }
    }
  } catch (e) {
    console.warn(`[codex] Failed to clean ${hooksJsonPath}: ${e.message || e}`);
  }

  const scripts = removeHookScripts(hooksDir);
  if (scripts > 0) changed = true;
  // If hooks dir is now empty (only evolver scripts lived there), remove it
  // so a subsequent install starts from a clean slate.
  try {
    if (fs.existsSync(hooksDir) && fs.readdirSync(hooksDir).length === 0) {
      fs.rmdirSync(hooksDir);
    }
  } catch { /* best-effort */ }

  if (cleanConfigToml(codexDir)) {
    console.log('[codex] Removed codex_hooks flag from config.toml');
    changed = true;
  }

  if (productBridgeMcp.uninstallCodexToml({ configRoot })) {
    changed = true;
  }

  if (removeMarkedSection(agentsMdPath, EVOLVER_MARKER)) {
    changed = true;
  }

  console.log(changed
    ? '[codex] Uninstalled evolver hooks.'
    : '[codex] No evolver hooks found to uninstall.');

  return { ok: true, removed: changed };
}

module.exports = {
  install,
  uninstall,
  verify,
  printVerifyReport,
  buildCodexHooksJson,
  codexHooksEnabled,
  ensureConfigToml,
  cleanConfigToml,
};
