// Cross-platform install-path discovery for adapter hook scripts.
//
// The hook scripts (claude-code / codex / etc.) get copied OUT of the
// package install root into the IDE's `.<ide>/hooks/` directory, so they
// cannot use relative walks to find the original evolver install. They
// instead call `require.resolve('@evomap/evolver/package.json', { paths })`
// with an allowlist of trusted, user/system-scoped install roots.
//
// Pre-fix the allowlist had only 4 POSIX-standard entries and missed
// Apple Silicon Homebrew + the major per-user Node version managers
// (NVM / fnm / Volta / asdf). Net effect: on a Mac M1/M2/M3/M4 that
// installed evolver via `npm install -g`, the hook scripts could not
// find the package — `findEvolverRoot()` returned null, the
// session-start hook silently degraded (empty additionalContext), and
// evolution memory never reached the LLM.
//
// These tests cover the helper directly so they do not depend on a real
// install layout on the test machine.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const runtimePaths = require('../src/adapters/scripts/_runtimePaths');

describe('_buildInstallSearchPaths — Apple Silicon Homebrew + Linuxbrew', () => {
  const paths = runtimePaths.__internals.buildInstallSearchPaths();

  it('includes Apple Silicon Homebrew /opt/homebrew/lib/node_modules', () => {
    assert.ok(
      paths.includes('/opt/homebrew/lib/node_modules'),
      'Apple Silicon Homebrew is the default npm prefix for M1/M2/M3/M4 Macs since 2021 — pre-fix this was missing and `npm install -g @evomap/evolver` landed at /opt/homebrew/... with no way for the hook scripts to find it. Actual paths=' + JSON.stringify(paths),
    );
  });

  it('includes Linuxbrew /home/linuxbrew/.linuxbrew/lib/node_modules', () => {
    assert.ok(
      paths.includes('/home/linuxbrew/.linuxbrew/lib/node_modules'),
      'Linuxbrew is the Homebrew port for Linux — niche but real',
    );
  });

  it('preserves the original 4 POSIX-standard install roots', () => {
    const home = os.homedir();
    const required = [
      path.join(home, '.npm-global', 'lib', 'node_modules'),
      path.join(home, '.local', 'lib', 'node_modules'),
      '/usr/lib/node_modules',
      '/usr/local/lib/node_modules',
    ];
    for (const r of required) {
      assert.ok(paths.includes(r), 'pre-fix entry must still be present: ' + r);
    }
  });

  it('does NOT include process.cwd() (security: prompt-injection guard)', () => {
    // The original allowlist's security comment must survive: a hostile
    // workspace must not be able to plant a fake @evomap/evolver/package.json
    // that the hook scripts would then trust.
    assert.ok(
      !paths.some((p) => p === process.cwd() || p === path.join(process.cwd(), 'node_modules')),
      'cwd / cwd-node_modules must NOT be in the install search list',
    );
  });
});

describe('_buildInstallSearchPaths — env-base absolute-path guard (anti-cwd-injection)', () => {
  it('rejects relative VM-base env overrides so no cwd-relative entry enters the allowlist', () => {
    const VM_KEYS = ['NVM_DIR', 'FNM_DIR', 'XDG_DATA_HOME', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)'];
    const saved = {};
    for (const k of VM_KEYS) saved[k] = process.env[k];
    try {
      for (const k of VM_KEYS) delete process.env[k];
      process.env.NVM_DIR = 'relative-nvm';
      process.env.ASDF_DATA_DIR = './relative-asdf';
      process.env.FNM_DIR = 'rel/fnm';
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      for (const p of paths) {
        assert.ok(path.isAbsolute(p), 'every install-search entry must be absolute — got ' + p);
      }
      assert.ok(!paths.some((p) => p.includes('relative-nvm') || p.includes('relative-asdf') || p.includes('rel/fnm')),
        'a relative VM-base env override must NOT pollute the require.resolve allowlist — got ' + JSON.stringify(paths));
    } finally {
      for (const k of VM_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});

describe('_buildInstallSearchPaths — Windows npm-global + system Node install', () => {
  // Override process.platform safely (it's a getter normally) so the Windows
  // branch can be exercised on a non-Windows test host (and the POSIX branch
  // can be exercised on Windows).
  const _realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  function setPlatform(value) {
    Object.defineProperty(process, 'platform', { value: value, configurable: true });
  }
  function restorePlatform() {
    if (_realPlatform) Object.defineProperty(process, 'platform', _realPlatform);
  }

  // Node's `path` binds its separator to the real host OS at load time —
  // overriding process.platform does NOT make path.join emit backslashes on a
  // POSIX test host. Build Windows expectations with the same path.join the
  // product uses: matches on any host, and yields true backslash paths only
  // when the suite actually runs on Windows. Do not hardcode backslash literals.
  const WIN_ENV_KEYS = ['APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'VOLTA_HOME', 'LOCALAPPDATA'];
  let _savedEnv;

  function setupWin() {
    _savedEnv = {};
    for (const k of WIN_ENV_KEYS) _savedEnv[k] = process.env[k];
    setPlatform('win32');
  }
  function teardown() {
    for (const k of WIN_ENV_KEYS) {
      if (_savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = _savedEnv[k];
    }
    restorePlatform();
  }

  it('includes %APPDATA%\\npm\\node_modules (default npm-global on Windows)', () => {
    setupWin();
    try {
      process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
      delete process.env.ProgramFiles;
      delete process.env['ProgramFiles(x86)'];
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(
        paths.includes(path.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'node_modules')),
        '%APPDATA%\\npm\\node_modules is where `npm install -g` lands on Windows by default — pre-fix this was missing entirely. Got=' + JSON.stringify(paths),
      );
    } finally { teardown(); }
  });

  it('falls back to ~/AppData/Roaming/npm when APPDATA env is unset', () => {
    setupWin();
    try {
      delete process.env.APPDATA;
      delete process.env.ProgramFiles;
      delete process.env['ProgramFiles(x86)'];
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const expected = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules');
      assert.ok(paths.includes(expected),
        'APPDATA-unset fallback must derive from os.homedir() — expected ' + expected + ' in ' + JSON.stringify(paths));
    } finally { teardown(); }
  });

  it('adds %ProgramFiles%\\nodejs\\node_modules when ProgramFiles is set (system-wide installer)', () => {
    setupWin();
    try {
      process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
      process.env.ProgramFiles = 'C:\\Program Files';
      delete process.env['ProgramFiles(x86)'];
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(paths.includes(path.join('C:\\Program Files', 'nodejs', 'node_modules')),
        'system-wide Node installer puts globals under %ProgramFiles%\\nodejs');
    } finally { teardown(); }
  });

  it('adds %ProgramFiles(x86)%\\nodejs\\node_modules when present (32-bit Node on 64-bit host)', () => {
    setupWin();
    try {
      process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
      process.env.ProgramFiles = 'C:\\Program Files';
      process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(paths.includes(path.join('C:\\Program Files (x86)', 'nodejs', 'node_modules')));
    } finally { teardown(); }
  });

  it('roots Volta at %LOCALAPPDATA%\\Volta on Windows when VOLTA_HOME is unset (not ~/.volta)', () => {
    setupWin();
    try {
      delete process.env.VOLTA_HOME;
      process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const expected = path.join('C:\\Users\\me\\AppData\\Local', 'Volta',
        'tools', 'image', 'packages', '@evomap', 'evolver', 'lib', 'node_modules');
      assert.ok(paths.includes(expected),
        'Windows Volta globals live under %LOCALAPPDATA%\\Volta, not ~/.volta — got ' + JSON.stringify(paths));
      assert.ok(!paths.some((p) => p.includes(path.join('.volta', 'tools'))),
        'must NOT fall back to the POSIX ~/.volta layout on Windows');
    } finally { teardown(); }
  });

  it('does NOT add Windows paths when platform is not win32 (POSIX hosts stay clean)', () => {
    setupWin();
    try {
      setPlatform('linux');
      process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
      process.env.ProgramFiles = 'C:\\Program Files';
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const winLeaks = paths.filter((p) => p.includes('AppData') || p.includes('Program Files') || p.includes('nodejs\\node_modules'));
      assert.deepEqual(winLeaks, [],
        'POSIX run must not include Windows-rooted entries even when the Windows env vars are set');
    } finally { teardown(); }
  });
});

describe('_scanVersionedNodeModules — NVM / fnm / Volta / asdf', () => {
  let tmpRoot;

  function makeVersionedLayout(prefix, versions, subdir) {
    // Mirror the on-disk layout of one Node version manager into a tmpdir.
    // Each `versions/<ver>/<subdir>/node_modules` lives as a real directory
    // so the scanner's fs.statSync call works.
    const root = path.join(tmpRoot, prefix);
    for (const v of versions) {
      const versionDir = path.join(root, v);
      const nmDir = path.join(versionDir, subdir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
    }
    return root;
  }

  function setup() {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-runtime-paths-'));
  }

  function teardown() {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  }

  it('appends one entry per version subdir (NVM-style layout)', () => {
    setup();
    try {
      const nvm = makeVersionedLayout(path.join('.nvm', 'versions', 'node'), ['v22.15.0', 'v20.10.0'], 'lib');
      const out = [];
      runtimePaths.__internals.scanVersionedNodeModules(nvm, 'lib', out);
      assert.equal(out.length, 2, 'one entry per installed Node version');
      for (const entry of out) {
        assert.ok(entry.endsWith(path.join('lib', 'node_modules')),
          'each entry must point at <ver>/lib/node_modules — got ' + entry);
      }
    } finally { teardown(); }
  });

  it('returns silently when the versions dir does not exist (most users have at most one VM)', () => {
    setup();
    try {
      const missing = path.join(tmpRoot, 'does', 'not', 'exist');
      const out = [];
      assert.doesNotThrow(() => runtimePaths.__internals.scanVersionedNodeModules(missing, 'lib', out));
      assert.deepEqual(out, [], 'missing dir must NOT add anything to out');
    } finally { teardown(); }
  });

  it('sorts newest version first (most-recent mtime, so the active version is preferred)', () => {
    setup();
    try {
      const nvm = makeVersionedLayout(path.join('.nvm', 'versions', 'node'), ['v18.0.0', 'v22.15.0'], 'lib');
      // Backdate the older version so the sort has a stable ordering.
      const older = path.join(nvm, 'v18.0.0');
      const oldTs = new Date(Date.now() - 86400_000);
      fs.utimesSync(older, oldTs, oldTs);

      const out = [];
      runtimePaths.__internals.scanVersionedNodeModules(nvm, 'lib', out);
      assert.equal(out.length, 2);
      assert.ok(out[0].includes('v22.15.0'),
        'newest version must come first — got order: ' + JSON.stringify(out));
      assert.ok(out[1].includes('v18.0.0'));
    } finally { teardown(); }
  });

  it('respects the per-VM subdir layout (fnm uses installation/lib, not lib)', () => {
    setup();
    try {
      const fnm = makeVersionedLayout(path.join('.fnm', 'node-versions'), ['v22.15.0'], path.join('installation', 'lib'));
      const out = [];
      runtimePaths.__internals.scanVersionedNodeModules(fnm, path.join('installation', 'lib'), out);
      assert.equal(out.length, 1);
      assert.ok(out[0].includes(path.join('installation', 'lib', 'node_modules')),
        'fnm path must include installation/lib/node_modules — got ' + out[0]);
    } finally { teardown(); }
  });
});

describe('_buildInstallSearchPaths — Volta (fixed per-package path, not a version scan)', () => {
  // Volta does NOT store globals alongside the Node image; it sandboxes
  // each `npm install -g`'d package under
  // <VOLTA_HOME>/tools/image/packages/<name>/lib/node_modules (the scope
  // is a real nested dir). Since we know the package name, this is a single
  // fixed path, not a version scan. Verified against volta-cli/volta
  // volta-layout v4 `package_image_dir` + package/manager.rs `source_dir`.
  function withEnv(key, val, fn) {
    const orig = process.env[key];
    if (val === undefined) delete process.env[key]; else process.env[key] = val;
    try { return fn(); }
    finally { if (orig === undefined) delete process.env[key]; else process.env[key] = orig; }
  }

  it('includes <VOLTA_HOME>/tools/image/packages/@evomap/evolver/lib/node_modules', () => {
    withEnv('VOLTA_HOME', path.join(os.tmpdir(), 'fake-volta'), () => {
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const expected = path.join(
        os.tmpdir(), 'fake-volta', 'tools', 'image', 'packages', '@evomap', 'evolver', 'lib', 'node_modules');
      assert.ok(paths.includes(expected),
        'Volta sandboxes globals per-package (image/packages/<name>), not alongside the node image — got ' +
        JSON.stringify(paths.filter((p) => p.includes('volta'))));
    });
  });

  it('does NOT scan the node image dir (tools/image/node) — that holds only Node itself', () => {
    withEnv('VOLTA_HOME', path.join(os.tmpdir(), 'fake-volta'), () => {
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(
        !paths.some((p) => p.includes(path.join('tools', 'image', 'node'))),
        'tools/image/node holds the Node.js install (built-ins + bundled npm), never user globals',
      );
    });
  });

  it('honors $VOLTA_HOME override (defaults to ~/.volta on POSIX, %LOCALAPPDATA%\\Volta on Windows)', () => {
    // Mirror the platform branching in _runtimePaths.js: Volta on Windows
    // installs to %LOCALAPPDATA%\Volta (the default that `volta install`
    // chooses), not %USERPROFILE%\.volta. The production code already
    // handles both; this assertion has to as well, or it fires on every
    // Windows CI run with no actual Volta install present.
    withEnv('VOLTA_HOME', undefined, () => {
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const voltaHome = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Volta')
        : path.join(os.homedir(), '.volta');
      const expected = path.join(
        voltaHome, 'tools', 'image', 'packages', '@evomap', 'evolver', 'lib', 'node_modules');
      assert.ok(paths.includes(expected),
        'default Volta home: %LOCALAPPDATA%\\Volta on Windows, ~/.volta on POSIX. Got ' +
        JSON.stringify(paths.filter((p) => p.toLowerCase().includes('volta'))));
    });
  });
});

describe('_buildInstallSearchPaths — asdf (modern lib + legacy .npm/lib)', () => {
  it('scans BOTH lib/node_modules (post-#228) and .npm/lib/node_modules (legacy)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-asdf-'));
    const orig = process.env.ASDF_DATA_DIR;
    try {
      // asdf-nodejs PR #228 (Sept 2022) dropped the `.npm` prefix override.
      // Plant a version that has both layouts and assert we cover each.
      const verRoot = path.join(tmp, 'installs', 'nodejs', 'v22.15.0');
      fs.mkdirSync(path.join(verRoot, 'lib', 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(verRoot, '.npm', 'lib', 'node_modules'), { recursive: true });
      process.env.ASDF_DATA_DIR = tmp;
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(paths.includes(path.join(verRoot, 'lib', 'node_modules')),
        'modern asdf layout (lib/node_modules) must be scanned');
      assert.ok(paths.includes(path.join(verRoot, '.npm', 'lib', 'node_modules')),
        'legacy asdf layout (.npm/lib/node_modules) must still be scanned');
    } finally {
      if (orig === undefined) delete process.env.ASDF_DATA_DIR; else process.env.ASDF_DATA_DIR = orig;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe('_buildInstallSearchPaths — fnm + NVM env-relocated bases', () => {
  it('resolves fnm via the XDG base ($XDG_DATA_HOME/fnm), not just legacy ~/.fnm', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-fnm-'));
    const origXdg = process.env.XDG_DATA_HOME;
    const origFnm = process.env.FNM_DIR;
    try {
      delete process.env.FNM_DIR; // ensure XDG path (not FNM_DIR) is exercised
      process.env.XDG_DATA_HOME = tmp;
      const verNm = path.join(tmp, 'fnm', 'node-versions', 'v22.15.0', 'installation', 'lib', 'node_modules');
      fs.mkdirSync(verNm, { recursive: true });
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(paths.includes(verNm),
        'fnm XDG base ($XDG_DATA_HOME/fnm) must be scanned — ~/.fnm is only the legacy fallback. Got ' +
        JSON.stringify(paths.filter((p) => p.includes('fnm'))));
    } finally {
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = origXdg;
      if (origFnm === undefined) delete process.env.FNM_DIR; else process.env.FNM_DIR = origFnm;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('honors $NVM_DIR for relocated NVM installs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-nvm-'));
    const orig = process.env.NVM_DIR;
    try {
      const verNm = path.join(tmp, 'versions', 'node', 'v22.15.0', 'lib', 'node_modules');
      fs.mkdirSync(verNm, { recursive: true });
      process.env.NVM_DIR = tmp;
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(paths.includes(verNm), 'relocated $NVM_DIR must be honored — got ' +
        JSON.stringify(paths.filter((p) => p.includes(tmp))));
    } finally {
      if (orig === undefined) delete process.env.NVM_DIR; else process.env.NVM_DIR = orig;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe('_buildInstallSearchPaths → require.resolve (genuine allowlist integration)', () => {
  // Unlike the EVOLVER_ROOT-branch test below, this exercises the real
  // path the fix is about: an entry produced by _buildInstallSearchPaths()
  // is fed to require.resolve and actually resolves a planted package.
  // (findEvolverRoot itself can't reach this branch in-process because its
  // earlier repoRoot `../../..` check always wins inside the evolver repo.)
  it('an entry from buildInstallSearchPaths() resolves a planted @evomap/evolver', () => {
    // Canonicalize the tmp root via realpathSync. macOS os.tmpdir() returns
    // /var/folders/... which is a symlink to /private/var/folders/..., and
    // require.resolve follows that symlink, so the returned absolute path
    // would not byte-equal a path.join built from the un-canonicalized
    // mkdtempSync return. Doing realpath once up front keeps both sides on
    // the same canonical form on every platform (Linux/Windows realpath is
    // a no-op when no symlinks are in play).
    const tmpRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-allowlist-'));
    const tmp = fs.realpathSync(tmpRaw);
    const orig = process.env.VOLTA_HOME;
    try {
      process.env.VOLTA_HOME = tmp; // makes the Volta node_modules dir appear in the list
      const nm = path.join(tmp, 'tools', 'image', 'packages', '@evomap', 'evolver', 'lib', 'node_modules');
      const pkgDir = path.join(nm, '@evomap', 'evolver');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@evomap/evolver', version: '0.0.0-test' }),
      );
      const searchPaths = runtimePaths.__internals.buildInstallSearchPaths();
      assert.ok(searchPaths.includes(nm), 'the planted node_modules dir must be in the search paths');
      const isolatedRequire = Module.createRequire(path.join(tmp, 'resolver.js'));
      const resolved = isolatedRequire.resolve('@evomap/evolver/package.json', { paths: [nm] });
      assert.equal(resolved, path.join(pkgDir, 'package.json'),
        'buildInstallSearchPaths output must actually resolve the package via require.resolve');
    } finally {
      if (orig === undefined) delete process.env.VOLTA_HOME; else process.env.VOLTA_HOME = orig;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe('findEvolverRoot — EVOLVER_ROOT explicit-override branch', () => {
  // NOTE: this only exercises the EVOLVER_ROOT escape hatch — NOT the
  // allowlist branch (see the integration describe above for that). Kept
  // because EVOLVER_ROOT is the documented production override.

  it('resolves a planted @evomap/evolver via EVOLVER_ROOT', () => {
    // Plant a real package.json under a tmpdir and point EVOLVER_ROOT at it
    // so findEvolverRoot returns it through the explicit-override branch.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-find-root-'));
    try {
      const fakeRoot = path.join(tmp, 'fake-homebrew', 'lib', 'node_modules');
      const pkgDir = path.join(fakeRoot, '@evomap', 'evolver');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@evomap/evolver', version: '0.0.0-test' }),
      );

      // Re-require with EVOLVER_ROOT pointed at the plant so findEvolverRoot
      // hits the env override branch — that branch is what production
      // operators actually use as the explicit-trust escape hatch and is
      // the simplest reliable way to assert "given a real install layout
      // we discover the package.json".
      const origRoot = process.env.EVOLVER_ROOT;
      process.env.EVOLVER_ROOT = pkgDir;
      try {
        // Bust cache so the env read is fresh.
        delete require.cache[require.resolve('../src/adapters/scripts/_runtimePaths')];
        const fresh = require('../src/adapters/scripts/_runtimePaths');
        const found = fresh.findEvolverRoot();
        assert.equal(found, pkgDir,
          'findEvolverRoot must return the planted Homebrew-style install root');
      } finally {
        if (origRoot === undefined) delete process.env.EVOLVER_ROOT;
        else process.env.EVOLVER_ROOT = origRoot;
        delete require.cache[require.resolve('../src/adapters/scripts/_runtimePaths')];
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });
});
