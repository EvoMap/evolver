'use strict';

function resolveLoopBridgeMode(env) {
  const source = env || process.env;
  if (!source.EVOLVE_BRIDGE) {
    source.EVOLVE_BRIDGE = 'true';
  }
  const value = String(source.EVOLVE_BRIDGE);
  const enabled = value.toLowerCase() !== 'false';
  return {
    value,
    enabled,
    banner: enabled
      ? [
          '[Daemon] EVOLVE_BRIDGE=true (default since v1.85.0).',
          '[Daemon]   evolver may modify your working tree.',
          '[Daemon]   Failed cycles auto-stash via "git stash push --include-untracked".',
          '[Daemon]   Recover: git stash list | grep evolver-rollback',
          '[Daemon]   Set EVOLVE_BRIDGE=false to opt out (observe-only mode).',
        ]
      : [
          '[Daemon] EVOLVE_BRIDGE=false: evolver will NOT modify your working tree (observe-only).',
          '[Daemon]   To enable real evolution: unset EVOLVE_BRIDGE or set it to "true".',
        ],
  };
}

module.exports = { resolveLoopBridgeMode };
