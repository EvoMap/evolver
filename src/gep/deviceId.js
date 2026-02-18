// Stable device identifier for node identity.
// Generates a hardware-based fingerprint that persists across directory changes,
// reboots, and evolver upgrades. Used by getNodeId() and env_fingerprint.
//
// Priority chain:
//   1. EVOMAP_DEVICE_ID env var   (explicit override, container-friendly)
//   2. ~/.evomap/device_id file   (persisted from previous run)
//   3. /etc/machine-id            (Linux, set at OS install)
//   4. IOPlatformUUID             (macOS hardware UUID)
//   5. hostname + MAC addresses   (network-based fallback)
//   6. random 128-bit hex         (last resort, persisted immediately)

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEVICE_ID_DIR = path.join(os.homedir(), '.evomap');
const DEVICE_ID_FILE = path.join(DEVICE_ID_DIR, 'device_id');

let _cachedDeviceId = null;

const DEVICE_ID_RE = /^[a-f0-9]{16,64}$/;

function readMachineId() {
  // Linux: /etc/machine-id is a stable, unique 128-bit ID set at OS install time.
  // Available in most containers that mount the host's /etc/machine-id.
  try {
    const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (mid && mid.length >= 16) return mid;
  } catch {}

  // macOS: IOPlatformUUID via ioreg (execFileSync avoids shell injection)
  if (process.platform === 'darwin') {
    try {
      const { execFileSync } = require('child_process');
      const raw = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = raw.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) return match[1];
    } catch {}
  }

  return null;
}

function getMacAddresses() {
  const ifaces = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macs.push(iface.mac);
      }
    }
  }
  macs.sort();
  return macs;
}

function generateDeviceId() {
  const machineId = readMachineId();
  if (machineId) {
    return crypto.createHash('sha256').update('evomap:' + machineId).digest('hex').slice(0, 32);
  }

  // Fallback: hostname + sorted MAC addresses
  const macs = getMacAddresses();
  if (macs.length > 0) {
    const raw = os.hostname() + '|' + macs.join(',');
    return crypto.createHash('sha256').update('evomap:' + raw).digest('hex').slice(0, 32);
  }

  // Last resort: random UUID, persisted so it stays stable.
  // If persist fails, this ID will change on next restart -- warn loudly.
  return crypto.randomBytes(16).toString('hex');
}

function persistDeviceId(id) {
  try {
    if (!fs.existsSync(DEVICE_ID_DIR)) {
      fs.mkdirSync(DEVICE_ID_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(DEVICE_ID_FILE, id, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error(
      '[evolver] WARN: failed to persist device_id to ' + DEVICE_ID_FILE +
      ' -- node identity may change on restart. Error: ' + (err.message || err)
    );
  }
}

function loadPersistedDeviceId() {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const id = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
      if (id && DEVICE_ID_RE.test(id)) return id;
    }
  } catch {}
  return null;
}

function getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;

  // 1. Env var override (validated) -- recommended for containers
  if (process.env.EVOMAP_DEVICE_ID) {
    const envId = String(process.env.EVOMAP_DEVICE_ID).trim().toLowerCase();
    if (DEVICE_ID_RE.test(envId)) {
      _cachedDeviceId = envId;
      return _cachedDeviceId;
    }
  }

  // 2. Previously persisted
  const persisted = loadPersistedDeviceId();
  if (persisted) {
    _cachedDeviceId = persisted;
    return _cachedDeviceId;
  }

  // 3. Generate from hardware and persist
  const generated = generateDeviceId();
  persistDeviceId(generated);
  _cachedDeviceId = generated;
  return _cachedDeviceId;
}

module.exports = { getDeviceId };
