'use strict';

// Tests for scripts/check-changelog.js (#113 — pre-release CHANGELOG guard).
//
// Two layers:
//   1. Parser unit tests against `extractSection` / `listReleasedVersionHeadings`.
//   2. End-to-end integration: spin up a throwaway git repo, tag v1.0.0
//      against an "original" CHANGELOG, then mutate the [1.0.0] section
//      at HEAD and confirm `checkChangelogIntegrity` reports drift.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
  checkChangelogIntegrity,
  extractSection,
  listReleasedVersionHeadings,
} = require('../scripts/check-changelog');

describe('check-changelog parser', () => {
  it('lists released version headings but skips [Unreleased]', () => {
    const text = '## [Unreleased]\n\n## [1.85.0] - 2026-05-22\n\nbody\n\n## [1.84.0] - 2026-05-15\n\nold\n';
    const versions = listReleasedVersionHeadings(text);
    assert.deepEqual(versions, ['1.85.0', '1.84.0']);
  });

  it('extractSection returns body up to next heading, normalised', () => {
    const text = '## [1.85.0]\n\n- entry a\n- entry b\n\n## [1.84.0]\n\n- old\n';
    const section = extractSection(text, '1.85.0');
    assert.equal(section, '\n\n- entry a\n- entry b');
  });

  it('extractSection returns null for a missing version', () => {
    const text = '## [1.85.0]\n\nbody\n';
    const section = extractSection(text, '1.86.0');
    assert.equal(section, null);
  });

  it('extractSection ignores trailing whitespace and blank lines', () => {
    const a = extractSection('## [1.0.0]\nbody  \n\n\n## [0.9.0]\nx\n', '1.0.0');
    const b = extractSection('## [1.0.0]\nbody\n## [0.9.0]\nx\n', '1.0.0');
    assert.equal(a, b);
  });

  it('extractSection anchors on line start (does not match mid-line ## [X.Y.Z])', () => {
    // A fenced code block or quoted text containing `## [1.0.0]` mid-line
    // must not be picked up as the section heading. The pre-fix `indexOf`
    // implementation would have matched the first occurrence anywhere.
    const text = [
      '## [Unreleased]',
      '',
      '```md',
      'Example heading like ## [1.0.0] mentioned in docs',
      '```',
      '',
      '## [1.0.0]',
      '',
      '- real entry',
    ].join('\n');
    const section = extractSection(text, '1.0.0');
    assert.match(section, /real entry/);
    assert.doesNotMatch(section, /mentioned in docs/);
  });
});

describe('check-changelog integration (#113)', () => {
  function runGit(repoDir, args) {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function setupRepo() {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-changelog-guard-'));
    runGit(repoDir, ['init', '-q']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'test']);
    runGit(repoDir, ['config', 'commit.gpgsign', 'false']);
    return repoDir;
  }

  it('passes when [1.0.0] section matches its v1.0.0 tag', () => {
    const repoDir = setupRepo();
    try {
      const changelogV1 = '## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- shipped feature A\n';
      fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), changelogV1, 'utf8');
      runGit(repoDir, ['add', 'CHANGELOG.md']);
      runGit(repoDir, ['commit', '-q', '-m', 'release 1.0.0']);
      runGit(repoDir, ['tag', 'v1.0.0']);

      // No further changes -- HEAD still matches the tag.
      const r = checkChangelogIntegrity({ repoRoot: repoDir });
      assert.deepEqual(r.drift, [], 'expected no drift when sections are identical');
      assert.equal(r.checked, 1);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('detects drift when an entry is added under a released section after the tag (#540 / PR #107 pattern)', () => {
    const repoDir = setupRepo();
    try {
      const changelogV1 = '## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- shipped feature A\n';
      fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), changelogV1, 'utf8');
      runGit(repoDir, ['add', 'CHANGELOG.md']);
      runGit(repoDir, ['commit', '-q', '-m', 'release 1.0.0']);
      runGit(repoDir, ['tag', 'v1.0.0']);

      // Misattribute a later fix under the already-released [1.0.0] heading.
      const tampered = '## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- shipped feature A\n- BAD: fix landed AFTER v1.0.0 was published\n';
      fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), tampered, 'utf8');
      runGit(repoDir, ['add', 'CHANGELOG.md']);
      runGit(repoDir, ['commit', '-q', '-m', 'mis-attributed entry']);

      const r = checkChangelogIntegrity({ repoRoot: repoDir });
      assert.equal(r.drift.length, 1, `expected drift, got ${JSON.stringify(r)}`);
      assert.equal(r.drift[0].version, '1.0.0');
      assert.equal(r.drift[0].tag, 'v1.0.0');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips a version heading when its tag does not exist (mid-release-prep state)', () => {
    const repoDir = setupRepo();
    try {
      // [2.0.0] is about to be released but the tag has not yet been cut.
      const changelog = '## [Unreleased]\n\n## [2.0.0] - 2026-06-01\n\n- new entry\n';
      fs.writeFileSync(path.join(repoDir, 'CHANGELOG.md'), changelog, 'utf8');
      runGit(repoDir, ['add', 'CHANGELOG.md']);
      runGit(repoDir, ['commit', '-q', '-m', 'prepare release 2.0.0']);

      const r = checkChangelogIntegrity({ repoRoot: repoDir });
      assert.deepEqual(r.drift, []);
      assert.equal(r.checked, 0);
      assert.equal(r.skipped.length, 1);
      assert.equal(r.skipped[0].version, '2.0.0');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips cleanly when the repository has no CHANGELOG.md', () => {
    const repoDir = setupRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# no changelog here\n', 'utf8');
      runGit(repoDir, ['add', 'README.md']);
      runGit(repoDir, ['commit', '-q', '-m', 'initial']);

      const r = checkChangelogIntegrity({ repoRoot: repoDir });
      assert.deepEqual(r.drift, []);
      assert.equal(r.checked, 0);
      assert.equal(r.skipped.length, 1);
      assert.equal(r.skipped[0].reason, 'CHANGELOG.md not present in this repository');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
