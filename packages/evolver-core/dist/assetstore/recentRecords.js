import { types } from 'node:util';
import { brandReferenceObject, isExecutionEligible } from '../reference/guard.js';
export const MAX_RECENT_ASSETS = 1_000;
export function assertRecentLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECENT_ASSETS) {
        throw new Error('recent asset limit must be an integer from 1 to 1000');
    }
}
/** 输入必须已经按 asset_id 去重，且保留首次出现顺序；不根据可伪造的时间戳排序。 */
export function recentRecords(records, kind, limit = MAX_RECENT_ASSETS) {
    assertRecentLimit(limit);
    const ring = [];
    let count = 0;
    for (const record of records) {
        if (record.type !== kind)
            continue;
        ring[count % limit] = record;
        count += 1;
    }
    return Array.from({ length: Math.min(count, limit) }, (_, index) => ring[(count - 1 - index) % limit]);
}
/** 能力缺失时保留旧行为；能力错误时不能伪装成成功的旧语料。 */
export async function listRecentAssets(store, kind, limit = MAX_RECENT_ASSETS, capturedReader) {
    assertRecentLimit(limit);
    // An explicitly captured absence must not trigger a second capability lookup.
    const readRecent = arguments.length >= 4 ? capturedReader : store.listRecent;
    const records = readRecent ? await readRecent.call(store, kind, limit) : await store.list(kind, limit);
    return captureRecentAssetResult(records, kind, limit);
}
function hasPlainPrototype(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === (Array.isArray(value) ? Array.prototype : Object.prototype);
}
/** Validate own data before reading fields, including hidden qualification data. */
function assertStableRecentData(value, ancestors = new Set(), inspected = new Set()) {
    if (typeof value === 'function' || typeof value === 'symbol')
        throw new Error('unstable recent data');
    if (!value || typeof value !== 'object')
        return;
    if (types.isProxy(value) || ancestors.has(value))
        throw new Error('unstable recent data');
    if (inspected.has(value))
        return;
    if (!hasPlainPrototype(value))
        throw new Error('unstable recent data');
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
            throw new Error('unstable recent data');
        assertStableRecentData(descriptor.value, ancestors, inspected);
    }
    ancestors.delete(value);
    inspected.add(value);
}
/** Recent capability and legacy fallback share detached, qualification-preserving data. */
export function captureRecentAssetResult(records, kind, limit) {
    assertRecentLimit(limit);
    try {
        if (types.isProxy(records))
            throw new Error('unstable recent data');
        // Retain malformed/cap errors without traversing oversized results.
        if (Array.isArray(records) && records.length <= limit)
            assertStableRecentData(records);
    }
    catch {
        throw new Error('recent asset snapshot failed');
    }
    assertRecentAssetResult(records, kind, limit);
    try {
        const ineligible = records.map(record => !isExecutionEligible(record));
        const snapshot = structuredClone(records);
        assertRecentAssetResult(snapshot, kind, limit);
        for (let index = 0; index < records.length; index++) {
            if (ineligible[index] || !isExecutionEligible(snapshot[index]))
                brandReferenceObject(snapshot[index]);
        }
        return snapshot;
    }
    catch {
        throw new Error('recent asset snapshot failed');
    }
}
/** provider 直接入口与组合消费者共享同一结果合同；不截断、排序或修改原记录。 */
export function assertRecentAssetResult(records, kind, limit) {
    assertRecentLimit(limit);
    if (!Array.isArray(records) || records.length > limit)
        throw new Error('invalid recent asset result');
    const ids = new Set();
    for (const record of records) {
        if (!record || record.type !== kind || typeof record.asset_id !== 'string' || !record.asset_id
            || ids.has(record.asset_id))
            throw new Error('invalid recent asset record');
        ids.add(record.asset_id);
    }
}