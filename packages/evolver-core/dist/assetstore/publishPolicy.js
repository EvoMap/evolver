import { join } from 'node:path';
import { ensureAssetStoreDirectory, readUtf8Regular, replaceUtf8Durable, withAssetStoreLock } from './assetStoreStorage.js';
export const PUBLISH_POLICY_SCHEMA = 'evolver.publish-policy.v1';
export const PUBLISH_POLICY_FILE = 'publish-policy.json';
export const PUBLISH_MODES = ['auto', 'manual'];
const policyOf = (mode) => ({ mode, backgroundAutoPublish: mode === 'auto' });
/**
 * The node's publish policy. No file keeps today's behaviour (`auto`); a file that cannot be read or parsed is read as
 * `manual`, because someone asked for a policy there and silently publishing would break that promise.
 */
export function readPublishPolicy(baseDir) {
    let raw;
    try {
        raw = readUtf8Regular(join(baseDir, PUBLISH_POLICY_FILE), 64 * 1024);
    }
    catch {
        return policyOf('manual');
    }
    if (raw === null)
        return policyOf('auto');
    try {
        const parsed = JSON.parse(raw);
        return parsed['schema'] === PUBLISH_POLICY_SCHEMA && parsed['mode'] === 'auto' ? policyOf('auto') : policyOf('manual');
    }
    catch {
        return policyOf('manual');
    }
}
export function writePublishPolicy(baseDir, mode, now = Date.now) {
    ensureAssetStoreDirectory(baseDir);
    withAssetStoreLock(join(baseDir, '.assetstore.lock'), () => {
        replaceUtf8Durable(join(baseDir, PUBLISH_POLICY_FILE), `${JSON.stringify({ schema: PUBLISH_POLICY_SCHEMA, mode, updatedAt: new Date(now()).toISOString() })}\n`);
    });
    return policyOf(mode);
}