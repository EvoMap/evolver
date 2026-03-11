const path = require('path');
const fs = require('fs');

function getRepoRoot() {
  if (process.env.EVOLVER_REPO_ROOT) {
    return process.env.EVOLVER_REPO_ROOT;
  }

  const ownDir = path.resolve(__dirname, '..', '..');

  // Safety: check evolver's own directory first to prevent operating on a
  // parent repo that happens to contain .git (which could cause data loss
  // when git reset --hard runs in the wrong scope).
  if (fs.existsSync(path.join(ownDir, '.git'))) {
    return ownDir;
  }

  let dir = path.dirname(ownDir);
  while (dir !== '/' && dir !== '.') {
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (process.env.EVOLVER_USE_PARENT_GIT === 'true') {
        console.warn('[evolver] Using parent git repository at:', dir);
        return dir;
      }
      console.warn(
        '[evolver] Detected .git in parent directory', dir,
        '-- ignoring. Set EVOLVER_USE_PARENT_GIT=true to override,',
        'or EVOLVER_REPO_ROOT to specify the target directory explicitly.'
      );
      return ownDir;
    }
    dir = path.dirname(dir);
  }

  return ownDir;
}

function getWorkspaceRoot() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  const repoRoot = getRepoRoot();
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) {
    return workspaceDir;
  }

  return path.resolve(__dirname, '..', '..', '..', '..');
}

function getLogsDir() {
  return process.env.EVOLVER_LOGS_DIR || path.join(getWorkspaceRoot(), 'logs');
}

function getEvolverLogPath() {
  return path.join(getLogsDir(), 'evolver_loop.log');
}

function getMemoryDir() {
  return process.env.MEMORY_DIR || path.join(getWorkspaceRoot(), 'memory');
}

// --- Session Scope Isolation ---
// When EVOLVER_SESSION_SCOPE is set (e.g., to a Discord channel ID or project name),
// evolution state, memory graph, and assets are isolated to a per-scope subdirectory.
// This prevents cross-channel/cross-project memory contamination.
// When NOT set, everything works as before (global scope, backward compatible).
function getSessionScope() {
  const raw = String(process.env.EVOLVER_SESSION_SCOPE || '').trim();
  if (!raw) return null;
  // Sanitize: only allow alphanumeric, dash, underscore, dot (prevent path traversal).
  const safe = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 128);
  if (!safe || /^\.{1,2}$/.test(safe) || /\.\./.test(safe)) return null;
  return safe;
}

function getEvolutionDir() {
  const baseDir = process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  const baseDir = process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getSkillsDir() {
  return process.env.SKILLS_DIR || path.join(getWorkspaceRoot(), 'skills');
}

function getNarrativePath() {
  return path.join(getEvolutionDir(), 'evolution_narrative.md');
}

function getEvolutionPrinciplesPath() {
  const repoRoot = getRepoRoot();
  const custom = path.join(repoRoot, 'EVOLUTION_PRINCIPLES.md');
  if (fs.existsSync(custom)) return custom;
  return path.join(repoRoot, 'assets', 'gep', 'EVOLUTION_PRINCIPLES.md');
}

function getReflectionLogPath() {
  return path.join(getEvolutionDir(), 'reflection_log.jsonl');
}

module.exports = {
  getRepoRoot,
  getWorkspaceRoot,
  getLogsDir,
  getEvolverLogPath,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getSessionScope,
  getNarrativePath,
  getEvolutionPrinciplesPath,
  getReflectionLogPath,
};

