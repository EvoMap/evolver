'use strict';

/**
 * CHANGELOG release-section integrity guard.
 *
 * Catches the misattribution pattern that bit us with #540 / PR #107:
 * an entry filed under `## [X.Y.Z]` AFTER v1.85.0 was already published
 * to npm, so the changelog claimed a fix the binary didn't contain.
 *
 * Algorithm: for every `## [X.Y.Z]` heading in CHANGELOG.md that has a
 * matching git tag (`vX.Y.Z`), compare the section content at HEAD
 * against the section content at that tag. If they differ, somebody
 * edited a frozen-and-released section — fail loud.
 *
 * Notes:
 *   - `## [Unreleased]` is exempt (it's the staging area, no tag).
 *   - Version headings without a corresponding tag are exempt — that's
 *     usually the "preparing X.Y.Z" state right before the tag exists.
 *   - Tag lookup is local-only (`git rev-parse`); CI must `git fetch
 *     --tags` first if it runs on a shallow clone.
 *   - `repoRoot` is injectable so tests don't need to monkey-patch the
 *     module by re-evaluating source (autogame-17 PR #115 review).
 *
 * Usage:
 *   node scripts/check-changelog.js              # CLI mode, exits 0/1
 *   const { checkChangelogIntegrity } = require('./check-changelog');
 *   const result = checkChangelogIntegrity({ repoRoot });
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

function readChangelogAtHead(repoRoot) {
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  return fs.readFileSync(changelogPath, 'utf8');
}

function readChangelogAtRef(repoRoot, ref) {
  try {
    return execFileSync('git', ['show', `${ref}:CHANGELOG.md`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function tagExists(repoRoot, tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// Pull every `## [X.Y.Z]` heading from the file, skipping `[Unreleased]`.
function listReleasedVersionHeadings(text) {
  const versions = [];
  const re = /^## \[(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\]/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    versions.push(m[1]);
  }
  return versions;
}

// Extract the body between `## [X.Y.Z]` and the next `## [` (or EOF).
// Normalises trailing whitespace and trailing blank lines so a stray
// newline doesn't fail the equality check.
//
// Heading match is line-anchored (`/^## \[X\.Y\.Z\]/m`) so a fenced
// code block or quoted text containing `## [X.Y.Z]` mid-line cannot be
// mistaken for the section start (Bugbot PR #115 review).
function extractSection(text, version) {
  const escaped = version.replace(/[.+]/g, (c) => '\\' + c);
  const re = new RegExp(`^## \\[${escaped}\\]`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  const after = match.index + match[0].length;
  const rest = text.slice(after);
  const nextRel = rest.search(/\n## \[/);
  const raw = nextRel === -1 ? rest : rest.slice(0, nextRel);
  return raw
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function checkChangelogIntegrity(opts) {
  const repoRoot = (opts && opts.repoRoot) || DEFAULT_REPO_ROOT;
  const head = readChangelogAtHead(repoRoot);
  if (head == null) {
    return {
      drift: [],
      skipped: [{ version: '*', reason: 'CHANGELOG.md not present in this repository' }],
      checked: 0,
    };
  }
  const versions = listReleasedVersionHeadings(head);

  const drift = [];
  const skipped = [];

  for (const version of versions) {
    const tag = `v${version}`;
    if (!tagExists(repoRoot, tag)) {
      skipped.push({ version, reason: 'no matching git tag (probably preparing this release)' });
      continue;
    }
    const tagText = readChangelogAtRef(repoRoot, tag);
    if (tagText == null) {
      skipped.push({ version, reason: `tag ${tag} exists but its CHANGELOG.md is unreadable` });
      continue;
    }
    const headSection = extractSection(head, version);
    const tagSection = extractSection(tagText, version);
    if (headSection == null || tagSection == null) {
      skipped.push({ version, reason: 'section parse failed' });
      continue;
    }
    if (headSection !== tagSection) {
      drift.push({ version, tag });
    }
  }

  return { drift, skipped, checked: versions.length - skipped.length };
}

function main() {
  const result = checkChangelogIntegrity();

  process.stdout.write(`\n=== CHANGELOG release-section guard ===\n`);
  process.stdout.write(`Checked ${result.checked} released version section(s); skipped ${result.skipped.length}.\n`);

  for (const s of result.skipped) {
    process.stdout.write(`  [skip] ${s.version}: ${s.reason}\n`);
  }

  if (result.drift.length === 0) {
    process.stdout.write(`\n[OK] No released CHANGELOG section was edited after its release tag.\n`);
    return 0;
  }

  process.stderr.write(`\n[FAIL] ${result.drift.length} CHANGELOG section(s) diverged from their release tag:\n`);
  for (const d of result.drift) {
    process.stderr.write(`  - ## [${d.version}] differs from ${d.tag}:CHANGELOG.md\n`);
  }
  process.stderr.write(
    `\nReleased sections must stay frozen. Move any new entries under ## [Unreleased],\n` +
    `or, if the entry was genuinely missing from the release, amend it on a hotfix\n` +
    `branch and tag a patch release.\n`
  );
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  checkChangelogIntegrity,
  extractSection,         // for tests
  listReleasedVersionHeadings, // for tests
};
