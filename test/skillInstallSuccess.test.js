'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  reportSkillInstallSuccess,
  skillInstallCommitted,
} = require('../src/gep/skillInstallSuccess');

describe('skillInstallCommitted', () => {
  it('requires content or a non-empty bundled file', () => {
    assert.equal(skillInstallCommitted(null), false);
    assert.equal(skillInstallCommitted({}), false);
    assert.equal(skillInstallCommitted({ content: '' }), false);
    assert.equal(skillInstallCommitted({ content: '# Skill' }), true);
    assert.equal(
      skillInstallCommitted({
        bundled_files: [{ name: 'helper.js', content: 'module.exports = 1;' }],
      }),
      true,
    );
    assert.equal(
      skillInstallCommitted({ bundled_files: [{ name: 'helper.js', content: '' }] }),
      false,
    );
  });
});

describe('reportSkillInstallSuccess', () => {
  it('POSTs /install-success with sender_id after local commit', async () => {
    /** @type {{ url?: string, init?: object }} */
    const seen = {};
    const result = await reportSkillInstallSuccess({
      hubUrl: 'https://evomap.ai/',
      skillId: 'skill_demo',
      nodeId: 'node_abc',
      buildHeaders: () => ({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' }),
      hubFetch: async (url, init) => {
        seen.url = url;
        seen.init = init;
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.recorded, true);
    assert.equal(seen.url, 'https://evomap.ai/a2a/skill/store/skill_demo/install-success');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(seen.init.body), { sender_id: 'node_abc' });
  });

  it('fail-soft on HTTP errors and network failures', async () => {
    const httpFail = await reportSkillInstallSuccess({
      hubUrl: 'https://evomap.ai',
      skillId: 'skill_x',
      nodeId: 'node_1',
      buildHeaders: () => ({}),
      hubFetch: async () => ({ ok: false, status: 401, text: async () => 'nope' }),
    });
    assert.equal(httpFail.ok, false);
    assert.equal(httpFail.status, 401);

    const netFail = await reportSkillInstallSuccess({
      hubUrl: 'https://evomap.ai',
      skillId: 'skill_x',
      nodeId: 'node_1',
      buildHeaders: () => ({}),
      hubFetch: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(netFail.ok, false);
    assert.match(netFail.error, /boom/);
  });

  it('rejects missing identity without calling hubFetch', async () => {
    let called = false;
    const result = await reportSkillInstallSuccess({
      hubUrl: 'https://evomap.ai',
      skillId: 'skill_x',
      nodeId: '',
      buildHeaders: () => ({}),
      hubFetch: async () => {
        called = true;
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no_node_id');
    assert.equal(called, false);
  });
});

describe('fetch command wires install-success after disk commit', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  it('requires skillInstallSuccess and reports only after local write', () => {
    assert.ok(
      /require\('\.\/src\/gep\/skillInstallSuccess'\)/.test(indexSrc),
      'fetch must load skillInstallSuccess helper',
    );
    assert.ok(
      /reportSkillInstallSuccess\(/.test(indexSrc),
      'fetch must call reportSkillInstallSuccess after commit',
    );
    assert.ok(
      /skillInstallCommitted\(/.test(indexSrc),
      'fetch must gate report on skillInstallCommitted',
    );
    const downloadIdx = indexSrc.indexOf("/a2a/skill/store/' + encodeURIComponent(skillId) + '/download'");
    const reportIdx = indexSrc.indexOf('reportSkillInstallSuccess(');
    assert.ok(downloadIdx !== -1 && reportIdx !== -1 && reportIdx > downloadIdx,
      'install-success must run after download path, not replace it');
  });
});
