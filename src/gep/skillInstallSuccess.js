'use strict';

/**
 * B-5 / KDP-3: after a local Hub skill install *commit*, confirm to Hub so
 * trailing-30d unique successful-install trending can populate.
 *
 * Fail-soft: never throws to the caller; install already landed on disk.
 * Auth: node_secret Bearer via buildHeaders (same as skill download).
 */

/**
 * @param {object} opts
 * @param {string} opts.hubUrl
 * @param {string} opts.skillId
 * @param {string} opts.nodeId
 * @param {(url: string, init: object) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} opts.hubFetch
 * @param {() => Record<string, string>} opts.buildHeaders
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, recorded?: boolean }>}
 */
async function reportSkillInstallSuccess(opts) {
  const hubUrl = String(opts && opts.hubUrl || '').replace(/\/+$/, '');
  const skillId = String(opts && opts.skillId || '').trim();
  const nodeId = String(opts && opts.nodeId || '').trim();
  const hubFetch = opts && opts.hubFetch;
  const buildHeaders = opts && opts.buildHeaders;
  const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;

  if (!hubUrl) return { ok: false, error: 'no_hub_url' };
  if (!skillId) return { ok: false, error: 'no_skill_id' };
  if (!nodeId) return { ok: false, error: 'no_node_id' };
  if (typeof hubFetch !== 'function') return { ok: false, error: 'no_hub_fetch' };
  if (typeof buildHeaders !== 'function') return { ok: false, error: 'no_build_headers' };

  const endpoint =
    hubUrl + '/a2a/skill/store/' + encodeURIComponent(skillId) + '/install-success';

  try {
    const resp = await hubFetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ sender_id: nodeId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp || !resp.ok) {
      const status = resp && typeof resp.status === 'number' ? resp.status : 0;
      return { ok: false, status, error: 'install_success_http_' + status };
    }
    return { ok: true, status: resp.status, recorded: true };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err || 'install_success_failed'),
    };
  }
}

/**
 * True when fetch wrote at least one skill artifact to disk.
 * @param {{ content?: string, bundled_files?: Array<{ name?: string, content?: string }> }} data
 */
function skillInstallCommitted(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.content === 'string' && data.content.length > 0) return true;
  const bundled = Array.isArray(data.bundled_files) ? data.bundled_files : [];
  return bundled.some(
    (f) => f && f.name && typeof f.content === 'string' && f.content.length > 0,
  );
}

module.exports = {
  reportSkillInstallSuccess,
  skillInstallCommitted,
};
