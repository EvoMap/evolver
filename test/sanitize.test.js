const assert = require('assert');
const { sanitizePayload, redactString, scanForLeaks, fullLeakCheck } = require('../src/gep/sanitize');

const REDACTED = '[REDACTED]';

// --- redactString ---

// Existing patterns (regression)
assert.strictEqual(redactString('Bearer abc123def456ghi789jkl0'), REDACTED);
assert.strictEqual(redactString('sk-abcdefghijklmnopqrstuvwxyz'), REDACTED);
assert.strictEqual(redactString('token=abcdefghijklmnop1234'), REDACTED);
assert.strictEqual(redactString('api_key=abcdefghijklmnop1234'), REDACTED);
assert.strictEqual(redactString('secret: abcdefghijklmnop1234'), REDACTED);
assert.strictEqual(redactString('/home/user/secret/file.txt'), REDACTED);
assert.strictEqual(redactString('/Users/admin/docs'), REDACTED);
assert.strictEqual(redactString('user@example.com'), REDACTED);

// GitHub tokens (bare, without token= prefix)
assert.ok(redactString('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234').includes(REDACTED),
  'bare ghp_ token should be redacted');
assert.ok(redactString('gho_abcdefghijklmnopqrstuvwxyz1234567890').includes(REDACTED),
  'bare gho_ token should be redacted');
assert.ok(redactString('github_pat_abcdefghijklmnopqrstuvwxyz123456').includes(REDACTED),
  'github_pat_ token should be redacted');
assert.ok(redactString('use ghs_abcdefghijklmnopqrstuvwxyz1234567890 for auth').includes(REDACTED),
  'ghs_ in sentence should be redacted');

// AWS keys
assert.ok(redactString('AKIAIOSFODNN7EXAMPLE').includes(REDACTED),
  'AWS access key should be redacted');

// OpenAI project tokens
assert.ok(redactString('sk-proj-bxOCXoWsaPj0IDE1yqlXCXIkWO1f').includes(REDACTED),
  'sk-proj- token should be redacted');

// Anthropic tokens
assert.ok(redactString('sk-ant-api03-abcdefghijklmnopqrst').includes(REDACTED),
  'sk-ant- token should be redacted');

// npm tokens
assert.ok(redactString('npm_abcdefghijklmnopqrstuvwxyz1234567890').includes(REDACTED),
  'npm token should be redacted');

// Private keys
assert.ok(redactString('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').includes(REDACTED),
  'RSA private key should be redacted');
assert.ok(redactString('-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----').includes(REDACTED),
  'generic private key should be redacted');

// Password fields
assert.ok(redactString('password=mysecretpassword123').includes(REDACTED),
  'password= should be redacted');
assert.ok(redactString('PASSWORD: "hunter2xyz"').includes(REDACTED),
  'PASSWORD: should be redacted');

// Basic auth in URLs (should preserve scheme and @)
var urlResult = redactString('https://user:pass123@github.com/repo');
assert.ok(urlResult.includes(REDACTED), 'basic auth in URL should be redacted');
assert.ok(urlResult.startsWith('https://'), 'URL scheme should be preserved');
assert.ok(urlResult.includes('@github.com'), '@ and host should be preserved');

// Slack tokens (bot/user/app/refresh/verification)
assert.ok(redactString('xoxb-1234567890-abcdefghij').includes(REDACTED),
  'xoxb- Slack bot token should be redacted');
assert.ok(redactString('xoxp-1234567890-abcdefghij').includes(REDACTED),
  'xoxp- Slack user token should be redacted');
assert.ok(redactString('xoxa-2-abc-def-ghi-j1234567').includes(REDACTED),
  'xoxa- Slack app token should be redacted');

// JSON Web Tokens (3 base64url segments)
var jwtSample = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz12';
assert.ok(redactString(jwtSample).includes(REDACTED), 'JWT should be redacted');

// Azure storage AccountKey
assert.ok(redactString('AccountKey=AbCdEfGh1234567890+/==').includes(REDACTED),
  'Azure AccountKey should be redacted');

// Azure AD client_secret
assert.ok(redactString('client_secret=aB3~cD4.eF5_gH6-iJ7').includes(REDACTED),
  'Azure client_secret should be redacted');

// Application Insights instrumentation key
assert.ok(redactString('InstrumentationKey=12345678-1234-1234-1234-1234567890ab').includes(REDACTED),
  'Azure instrumentationkey should be redacted');

// Discord bot token (uppercase leading char, three segments).
// The sample is split and joined at runtime so static secret scanners do not
// flag the test fixture as a real token; the regex still matches the joined
// value end-to-end.
var discordSampleParts = ['MTEzMjI3NDU2Nzg5MDEyMzQ1', 'ABC123', 'qwerty_zxcv_qwertyu1234567890'];
var discordSample = discordSampleParts.join('.');
assert.ok(redactString(discordSample).includes(REDACTED),
  'Discord bot token should be redacted');

// Negative: plain dotted python path must NOT match Discord pattern
var dottedPath = 'my.module.path is fine';
assert.strictEqual(redactString(dottedPath), dottedPath,
  'lowercase dotted identifiers must not match Discord token pattern');

// Safe strings should NOT be redacted
assert.strictEqual(redactString('hello world'), 'hello world');
assert.strictEqual(redactString('error: something failed'), 'error: something failed');
assert.strictEqual(redactString('fix the bug in parser'), 'fix the bug in parser');

// --- sanitizePayload ---

// Deep sanitization
var payload = {
  summary: 'Fixed auth using ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx5678',
  nested: {
    path: '/home/user/.ssh/id_rsa',
    email: 'admin@internal.corp',
    safe: 'this is fine',
  },
};
var sanitized = sanitizePayload(payload);
assert.ok(sanitized.summary.includes(REDACTED), 'ghp token in summary');
assert.ok(sanitized.nested.path.includes(REDACTED), 'path in nested');
assert.ok(sanitized.nested.email.includes(REDACTED), 'email in nested');
assert.strictEqual(sanitized.nested.safe, 'this is fine');

// Null/undefined/number inputs
assert.strictEqual(sanitizePayload(null), null);
assert.strictEqual(sanitizePayload(undefined), undefined);
assert.strictEqual(redactString(null), null);
assert.strictEqual(redactString(123), 123);

// --- Allowlist for false positives (M-NEW-2 follow-up) ---
// Goal: keep useful debug signal in capsules. The patterns above match a
// broader-than-ideal set; this allowlist carves out a handful of
// non-sensitive matches that we previously over-redacted.

// CI runner paths — not user PII, useful for understanding capsule context.
assert.strictEqual(
  redactString('error in /home/runner/work/evolver/evolver/src/foo.js'),
  'error in /home/runner/work/evolver/evolver/src/foo.js',
  'GitHub Actions runner path must NOT be redacted'
);
assert.strictEqual(
  redactString('build failed at /home/circleci/project/test.js'),
  'build failed at /home/circleci/project/test.js',
  'CircleCI runner path must NOT be redacted'
);
assert.strictEqual(
  redactString('macOS CI: /Users/runner/work/repo/file.ts'),
  'macOS CI: /Users/runner/work/repo/file.ts',
  'GitHub Actions macOS runner path must NOT be redacted'
);

// Real user paths still redact.
assert.ok(
  redactString('opened /home/alice/secret/credentials.json').includes(REDACTED),
  'real /home/<user>/ path must still be redacted'
);
assert.ok(
  redactString('saved to /Users/bob/Documents/notes.txt').includes(REDACTED),
  'real /Users/<user>/ path must still be redacted'
);

// Bot / no-reply email addresses — not personal.
assert.strictEqual(
  redactString('committed by noreply@github.com last week'),
  'committed by noreply@github.com last week',
  'noreply@github.com must NOT be redacted'
);
assert.strictEqual(
  redactString('SSH remote: git@github.com'),
  'SSH remote: git@github.com',
  'git@github.com SSH alias must NOT be redacted'
);
assert.strictEqual(
  redactString('author: 8275028+autogame-17@users.noreply.github.com'),
  'author: 8275028+autogame-17@users.noreply.github.com',
  'GitHub commit-author noreply must NOT be redacted'
);
assert.strictEqual(
  redactString('Do-Not-Reply@github.com'),
  'Do-Not-Reply@github.com',
  'donotreply prefix variants must NOT be redacted (case-insensitive), allowed host'
);
assert.strictEqual(
  redactString('robot noreply@anthropic.com replied'),
  'robot noreply@anthropic.com replied',
  'noreply@anthropic.com must NOT be redacted (well-known public host)'
);

// Bugbot PR #151 Low: noreply on UNKNOWN domains must still redact, so a
// corp infra domain like noreply@internal-codename.corp doesn't leak.
assert.ok(
  redactString('mail noreply@internal-codename.corp').includes(REDACTED),
  'noreply on unknown corp domain must be redacted (no internal infra leak)'
);
assert.ok(
  redactString('donotreply@private-saas.example').includes(REDACTED),
  'donotreply on unknown domain must be redacted'
);

// Real personal emails still redact.
assert.ok(
  redactString('contact alice@personal.example').includes(REDACTED),
  'real email must still be redacted'
);
assert.ok(
  redactString('user.name@corp.example.com').includes(REDACTED),
  'real email must still be redacted'
);

// `.env` references — prose mentions are NOT redacted; real paths still are.
assert.strictEqual(
  redactString('Read from `.env` file'),
  'Read from `.env` file',
  'prose mention of .env in backticks must NOT be redacted'
);
assert.strictEqual(
  redactString('the .env file is gitignored'),
  'the .env file is gitignored',
  'prose mention of .env must NOT be redacted'
);
assert.strictEqual(
  redactString('Configure your .env before running'),
  'Configure your .env before running',
  'standalone .env in instructions must NOT be redacted'
);
assert.ok(
  redactString('reading /etc/evolver/.env at startup').includes(REDACTED),
  'real path /etc/.../.env must still be redacted (preceded by /)'
);
assert.ok(
  redactString('loaded .env.production from disk').includes(REDACTED),
  '.env.<suffix> form must still be redacted'
);
assert.ok(
  redactString('config: .env.local overrides .env').includes(REDACTED),
  '.env.local must still be redacted even when bare .env is in same string'
);

// --- Bugbot PR #151 Medium: scanForLeaks honours the same allowlist ---
// selfPR uses fullLeakCheck to gate self-PR creation. If a leak is reported
// the entire self-PR is blocked. Without applying the allowlist here too,
// the redactor would say "this is fine" while the leak scanner blocked the
// PR over the same false positives — a logical contradiction within the
// same module.

const ciPathScan = scanForLeaks('error in /home/runner/work/evolver/foo.js');
assert.strictEqual(ciPathScan.found, false,
  'scanForLeaks must NOT report /home/runner/ as a leak (allowlist)');
assert.deepStrictEqual(ciPathScan.leaks, [],
  'scanForLeaks must return empty leaks for CI runner path');

const noreplyScan = scanForLeaks('committed by noreply@github.com');
assert.strictEqual(noreplyScan.found, false,
  'scanForLeaks must NOT report noreply@github.com as ssh_target leak (allowlist)');

const sshAliasScan = scanForLeaks('git remote: git@github.com:evomap/evolver.git');
assert.strictEqual(sshAliasScan.found, false,
  'scanForLeaks must NOT report git@github.com as ssh_target leak (allowlist)');

// Real PII paths / emails STILL trigger the leak scanner — allowlist is
// narrowly scoped and the security guarantee for genuine secrets is intact.
const realPathScan = scanForLeaks('opened /home/alice/.ssh/id_rsa');
assert.strictEqual(realPathScan.found, true,
  'scanForLeaks must still flag /home/<real-user>/ paths');
assert.ok(
  realPathScan.leaks.some((l) => l.type === 'local_path'),
  'real local path leak must be classified as local_path'
);

const realSshScan = scanForLeaks('ssh deploy@prod.example.com');
assert.strictEqual(realSshScan.found, true,
  'scanForLeaks must still flag real SSH targets');

const corpNoreplyScan = scanForLeaks('contact noreply@internal-codename.corp for details');
assert.strictEqual(corpNoreplyScan.found, true,
  'scanForLeaks must still flag noreply on unknown corp domains');

// fullLeakCheck (pattern + env-value reverse scan) also honours the
// allowlist via scanForLeaks. selfPR can now self-PR on a CI runner
// without being blocked over the runner path.
const fullClean = fullLeakCheck('build trace from /home/runner/work/evolver/evolver/src/foo.js by noreply@github.com');
assert.strictEqual(fullClean.found, false,
  'fullLeakCheck on CI-runner + GitHub-noreply content must return clean');

// Bugbot PR #151 round 2 Medium: ssh_target scanner uses
// `[a-zA-Z0-9_.-]+` (no `+` in char class), so for input
// `8275028+autogame-17@users.noreply.github.com` it captures just
// `autogame-17@users.noreply.github.com`. The full-form allowlist anchor
// `^[0-9]+\+...` could not match the truncated value, so the leak scanner
// reported a false positive. A second allowlist entry now covers any
// local part on users.noreply.github.com.
const ghCommitAuthorScan = scanForLeaks('author: 8275028+autogame-17@users.noreply.github.com');
assert.strictEqual(ghCommitAuthorScan.found, false,
  'scanForLeaks must NOT flag GitHub commit-author noreply, including the truncated suffix form');

const ghCommitAuthorFull = fullLeakCheck('Co-Authored-By: 8275028+autogame-17@users.noreply.github.com');
assert.strictEqual(ghCommitAuthorFull.found, false,
  'fullLeakCheck must accept GitHub commit-author noreply even when the ssh_target scanner truncates the local part');

// Defensive: any other local part on the GitHub noreply domain (e.g. legacy
// `username@users.noreply.github.com` without the digits+ prefix) is also
// allowlisted.
const ghLegacyNoreply = scanForLeaks('opened by classicuser@users.noreply.github.com');
assert.strictEqual(ghLegacyNoreply.found, false,
  'scanForLeaks must NOT flag legacy GitHub noreply addresses (any local part)');

// Regression: CI runners + npm populate several env vars with the repo checkout
// path — GITHUB_WORKSPACE / RUNNER_WORKSPACE from the runner, and INIT_CWD /
// npm_config_local_prefix / npm_package_json / PWD from `npm test`. When capsule
// content legitimately references that build path, detectEnvValueLeaks must NOT
// report it as an env-value leak, or every self-PR from CI would be blocked over
// its own build path. This failed only under CI (where these vars are set to
// /home/runner/work/...) until path/URL-shaped env values were skipped.
const RUNNER_PATH = '/home/runner/work/evolver/evolver';
const SECRET_VAL = 'zzz9988aa77bb66cc55dd';
const _ciEnvKeys = ['GITHUB_WORKSPACE', 'INIT_CWD', 'npm_config_local_prefix', 'EVOLVER_TEST_SECRET'];
const _savedCiEnv = {};
for (const k of _ciEnvKeys) _savedCiEnv[k] = process.env[k];
process.env.GITHUB_WORKSPACE = RUNNER_PATH;
process.env.INIT_CWD = RUNNER_PATH;
process.env.npm_config_local_prefix = RUNNER_PATH;
process.env.EVOLVER_TEST_SECRET = SECRET_VAL;
try {
  assert.strictEqual(
    fullLeakCheck('build trace from /home/runner/work/evolver/evolver/src/foo.js').found,
    false,
    'CI runner/npm checkout-path env vars must NOT be flagged as env-value leaks'
  );
  // Security guarantee intact: a non-path secret env value is still reverse-detected.
  assert.strictEqual(
    fullLeakCheck('config contains ' + SECRET_VAL + ' inline').found,
    true,
    'non-path secret env value must still be reverse-detected'
  );
} finally {
  for (const k of _ciEnvKeys) {
    if (_savedCiEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedCiEnv[k];
  }
}

console.log('All sanitize tests passed (70 assertions)');
