// Environment fingerprint capture for GEP assets.
// Records the runtime environment so that cross-environment diffusion
// success rates (GDI) can be measured scientifically.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRepoRoot } = require('./paths');
const { getDeviceId } = require('./deviceId');

// Capture a structured environment fingerprint.
// This is embedded into Capsules, EvolutionEvents, and ValidationReports.
function captureEnvFingerprint() {
  const repoRoot = getRepoRoot();
  let pkgVersion = null;
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    pkgVersion = pkg && pkg.version ? String(pkg.version) : null;
  } catch (e) {}

  return {
    device_id: getDeviceId(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    hostname: os.hostname(),
    evolver_version: pkgVersion,
    cwd: process.cwd(),
  };
}

// Compute a short fingerprint key for comparison and grouping.
// Two nodes with the same key are considered "same environment class".
function envFingerprintKey(fp) {
  if (!fp || typeof fp !== 'object') return 'unknown';
  const parts = [
    fp.device_id || '',
    fp.node_version || '',
    fp.platform || '',
    fp.arch || '',
    fp.hostname || '',
    fp.evolver_version || '',
  ].join('|');
  return crypto.createHash('sha256').update(parts, 'utf8').digest('hex').slice(0, 16);
}

// Check if two fingerprints are from the same environment class.
function isSameEnvClass(fpA, fpB) {
  return envFingerprintKey(fpA) === envFingerprintKey(fpB);
}

module.exports = {
  captureEnvFingerprint,
  envFingerprintKey,
  isSameEnvClass,
};
