'use strict';

function determineBridgeEnabled(env) {
  const source = env || process.env;
  const raw = source.EVOLVE_BRIDGE;
  if (raw !== undefined && String(raw) !== '') {
    return String(raw).toLowerCase() !== 'false';
  }
  return !!String(source.OPENCLAW_WORKSPACE || '').trim();
}

module.exports = { determineBridgeEnabled };
