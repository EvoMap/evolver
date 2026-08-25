'use strict';

const fs = require('fs');
const path = require('path');
const { assertNotSymlink } = require('./hookAdapter');

const SERVER_NAME = 'evox-product';
const SHIM_NAME = 'evox-product-shim.js';
const MANAGED_KEY = '_evox_product_managed';
const TOML_MARKER = '# evox-product-managed';
const TOML_SECTION = `mcp_servers.${SERVER_NAME}`;
const GRANT_SCHEMA = 'evox.product_bridge.grant.v1';

function shimPath(evolverRoot) {
  return path.join(evolverRoot, 'src', 'adapters', 'scripts', SHIM_NAME);
}

function buildServerEntry(evolverRoot) {
  return {
    command: process.execPath,
    args: [shimPath(evolverRoot)],
    [MANAGED_KEY]: true,
  };
}

function isOwnedServer(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry[MANAGED_KEY] === true) return true;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.some(arg => String(arg).endsWith(SHIM_NAME));
}

function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function installClaudeJson({ configRoot, evolverRoot, force }) {
  const filePath = path.join(configRoot, '.mcp.json');
  assertNotSymlink(filePath, '.mcp.json');
  const entry = buildServerEntry(evolverRoot);
  if (!fs.existsSync(entry.args[0])) {
    return { changed: false, path: filePath, error: `missing shim ${entry.args[0]}` };
  }

  let data = { mcpServers: {} };
  try {
    if (fs.existsSync(filePath)) data = readJsonFile(filePath);
  } catch {
    data = { mcpServers: {} };
  }
  if (!data || typeof data !== 'object') data = {};
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }

  const existing = data.mcpServers[SERVER_NAME];
  if (existing && !isOwnedServer(existing) && !force) {
    return { changed: false, path: filePath, skipped: true };
  }

  data.mcpServers[SERVER_NAME] = entry;
  writeJsonAtomic(filePath, data);
  return { changed: true, path: filePath };
}

function uninstallClaudeJson({ configRoot }) {
  const filePath = path.join(configRoot, '.mcp.json');
  assertNotSymlink(filePath, '.mcp.json');
  if (!fs.existsSync(filePath)) return false;
  let data;
  try {
    data = readJsonFile(filePath);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || !data.mcpServers || typeof data.mcpServers !== 'object') {
    return false;
  }
  if (!isOwnedServer(data.mcpServers[SERVER_NAME])) return false;
  delete data.mcpServers[SERVER_NAME];
  if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  if (Object.keys(data).length === 0) {
    fs.unlinkSync(filePath);
    return true;
  }
  writeJsonAtomic(filePath, data);
  return true;
}

function verifyClaudeJson({ configRoot }) {
  const filePath = path.join(configRoot, '.mcp.json');
  const checks = [];
  let data = null;
  let error = null;
  try {
    data = readJsonFile(filePath);
  } catch (err) {
    error = err && err.message || String(err);
  }
  checks.push({
    id: 'product_bridge_mcp_json',
    ok: data !== null,
    detail: data ? filePath : `unreadable: ${error}`,
  });
  const entry = data && data.mcpServers && data.mcpServers[SERVER_NAME];
  const owned = isOwnedServer(entry);
  checks.push({
    id: 'product_bridge_managed',
    ok: owned,
    detail: owned
      ? `${SERVER_NAME} is evolver-managed`
      : `.mcp.json is missing a managed ${SERVER_NAME} server`,
  });
  const commandPath = owned && Array.isArray(entry.args) ? entry.args[0] : '';
  let shimOk = false;
  try {
    shimOk = Boolean(commandPath) && fs.lstatSync(commandPath).isFile();
  } catch { /* reported below */ }
  checks.push({
    id: 'product_bridge_shim',
    ok: shimOk,
    detail: shimOk
      ? `shim present at ${commandPath}`
      : `shim missing: ${commandPath || 'no args'}`,
  });
  return { checks, path: filePath };
}

function tomlBasicString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
  const header = String(line).match(/^\[([^\]]+)\]$/);
  return header ? header[1].trim() : null;
}

function findTomlSection(lines, name) {
  const structural = structuralTomlLines(lines);
  let start = -1;
  for (let index = 0; index < structural.length; index += 1) {
    const section = tomlSectionName(structural[index]);
    if (section === name) {
      start = index;
      continue;
    }
    if (start >= 0 && section !== null) {
      return { start, end: index };
    }
  }
  return start >= 0 ? { start, end: lines.length } : null;
}

function sectionLooksOwned(lines, section) {
  if (!section) return false;
  const before = section.start > 0 ? String(lines[section.start - 1]).trim() : '';
  if (before === TOML_MARKER) return true;
  return lines
    .slice(section.start, section.end)
    .some(line => String(line).includes(SHIM_NAME));
}

function renderTomlSection(evolverRoot) {
  return [
    TOML_MARKER,
    `[${TOML_SECTION}]`,
    `command = ${tomlBasicString(process.execPath)}`,
    `args = [${tomlBasicString(shimPath(evolverRoot))}]`,
    '',
  ].join('\n');
}

function installCodexToml({ configRoot, evolverRoot, force }) {
  const filePath = path.join(configRoot, '.codex', 'config.toml');
  assertNotSymlink(filePath, 'config.toml');
  const commandPath = shimPath(evolverRoot);
  if (!fs.existsSync(commandPath)) {
    return { changed: false, path: filePath, error: `missing shim ${commandPath}` };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let source = '';
  try { source = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source === '' ? [] : source.split(/\r?\n/);
  const section = findTomlSection(lines, TOML_SECTION);
  if (section && !sectionLooksOwned(lines, section) && !force) {
    return { changed: false, path: filePath, skipped: true };
  }

  const blockLines = renderTomlSection(evolverRoot)
    .replace(/\r\n/g, '\n')
    .replace(/\n$/g, '')
    .split('\n');
  if (section) {
    let start = section.start;
    if (start > 0 && String(lines[start - 1]).trim() === TOML_MARKER) start -= 1;
    lines.splice(start, section.end - start, ...blockLines);
  } else {
    // Prepend so a later user append still lands in the existing [features]
    // table, and so our ownership comment is never inside that table.
    if (lines.length && String(lines[0]).trim() !== '') blockLines.push('');
    lines.unshift(...blockLines);
  }
  const out = lines.join(newline);
  fs.writeFileSync(filePath, out.endsWith(newline) ? out : out + newline, 'utf8');
  return { changed: true, path: filePath };
}

function uninstallCodexToml({ configRoot }) {
  const filePath = path.join(configRoot, '.codex', 'config.toml');
  assertNotSymlink(filePath, 'config.toml');
  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const section = findTomlSection(lines, TOML_SECTION);
  if (!section || !sectionLooksOwned(lines, section)) return false;
  const remove = [];
  if (section.start > 0 && String(lines[section.start - 1]).trim() === TOML_MARKER) {
    remove.push(section.start - 1);
  }
  remove.push(section.start);
  for (let index = section.start + 1; index < section.end; index += 1) {
    const trimmed = String(lines[index]).trim();
    if (!trimmed) {
      remove.push(index);
      continue;
    }
    if (/^(command|args)\s*=/.test(trimmed)) remove.push(index);
  }
  const leftover = [];
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (!remove.includes(index) && String(lines[index]).trim()) leftover.push(index);
  }
  if (leftover.length > 0) {
    // A foreign key lives in this table. Keep the header; drop only our keys.
    const drop = new Set(remove.filter(index => index !== section.start));
    for (const index of [...drop].sort((a, b) => b - a)) lines.splice(index, 1);
  } else {
    for (const index of remove.sort((a, b) => b - a)) lines.splice(index, 1);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const next = lines.join(newline);
  fs.writeFileSync(filePath, next.trim() ? (next.endsWith(newline) ? next : next + newline) : '', 'utf8');
  return true;
}

function verifyCodexToml({ configRoot }) {
  const filePath = path.join(configRoot, '.codex', 'config.toml');
  const checks = [];
  let source = '';
  let error = null;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    error = err && err.message || String(err);
  }
  const readable = error === null;
  checks.push({
    id: 'product_bridge_codex_toml',
    ok: readable,
    detail: readable ? filePath : `unreadable: ${error}`,
  });
  const lines = readable ? source.split(/\r?\n/) : [];
  const section = findTomlSection(lines, TOML_SECTION);
  const owned = sectionLooksOwned(lines, section);
  checks.push({
    id: 'product_bridge_managed',
    ok: owned,
    detail: owned
      ? `${TOML_SECTION} is evolver-managed`
      : `config.toml is missing a managed ${TOML_SECTION} table`,
  });
  let commandPath = '';
  if (section) {
    for (const line of lines.slice(section.start, section.end)) {
      const match = String(line).match(/^\s*args\s*=\s*\[\s*"((?:\\.|[^"\\])*)"/);
      if (match) {
        commandPath = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        break;
      }
    }
  }
  let shimOk = false;
  try {
    shimOk = Boolean(commandPath) && fs.lstatSync(commandPath).isFile();
  } catch { /* reported below */ }
  checks.push({
    id: 'product_bridge_shim',
    ok: shimOk,
    detail: shimOk
      ? `shim present at ${commandPath}`
      : `shim missing: ${commandPath || 'no args'}`,
  });
  return { checks, path: filePath };
}

module.exports = {
  SERVER_NAME,
  SHIM_NAME,
  MANAGED_KEY,
  TOML_MARKER,
  TOML_SECTION,
  GRANT_SCHEMA,
  shimPath,
  installClaudeJson,
  uninstallClaudeJson,
  verifyClaudeJson,
  installCodexToml,
  uninstallCodexToml,
  verifyCodexToml,
};
