const path = require('path');

function getRepoRoot() {
  // src/gep/paths.js -> repo root
  return path.resolve(__dirname, '..', '..');
}

function getMemoryDir() {
  const repoRoot = getRepoRoot();
  return process.env.MEMORY_DIR || path.join(repoRoot, 'memory');
}

function getEvolutionDir() {
  return process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  return process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
}

module.exports = {
  getRepoRoot,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
};

