import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { algo, assetstore, hub as hubNs, verify } from '@evomap/evolver-core';
const MAX_DIFF_BYTES = 256 * 1024;
export class VerificationContextStore {
    dir;
    constructor(assetStoreDir) {
        this.dir = join(assetStoreDir, 'verification-context');
    }
    pathOf(geneAssetId) {
        return join(this.dir, `${createHash('sha256').update(geneAssetId).digest('hex').slice(0, 40)}.json`);
    }
    get(geneAssetId) {
        const path = this.pathOf(geneAssetId);
        if (!existsSync(path))
            return undefined;
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            return parsed.geneAssetId === geneAssetId ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** A Gene is addressed by its content, so once it is published a later plan for it keeps that mark. */
    put(context) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const path = this.pathOf(context.geneAssetId);
        const published = context.published ?? this.get(context.geneAssetId)?.published;
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(published ? { ...context, published } : context)}\n`, { mode: 0o600 });
        renameSync(tmp, path);
    }
    list() {
        if (!existsSync(this.dir))
            return [];
        const out = [];
        for (const name of readdirSync(this.dir)) {
            if (!name.endsWith('.json'))
                continue;
            try {
                out.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
            }
            catch { /* a torn file is skipped, never fatal */ }
        }
        return out;
    }
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function planDigest({ root, head, diff, checks }) {
    return hubNs.publishBindingDigest('observed-validation-plan.v1', { root, head, diff: diff ?? '', checks });
}
function checkMatchesCommand(check, command) {
    return Boolean(check && typeof check.command === 'string' && check.command === command
        && check.command.length <= 180 && verify.isValidationCommandAllowed(check.command)
        && (check.cwd === undefined || (typeof check.cwd === 'string' && !isAbsolute(check.cwd))));
}
/** Old sidecars may already have lost cwd occurrences and must be observed again. */
export function hasVerificationPlan(context) {
    if (typeof context.root !== 'string' || !isAbsolute(context.root)
        || typeof context.head !== 'string' || !/^[0-9a-f]{7,64}$/.test(context.head)
        || (context.diff !== undefined && (typeof context.diff !== 'string' || Buffer.byteLength(context.diff, 'utf8') > MAX_DIFF_BYTES))
        || !Array.isArray(context.commands) || !Array.isArray(context.checks)
        || context.checks.length < 1 || context.checks.length > 8 || context.commands.length !== context.checks.length)
        return false;
    return context.checks.every((check, index) => checkMatchesCommand(check, context.commands[index]))
        && typeof context.planDigest === 'string' && context.planDigest === planDigest(context);
}
/** The project state a host hook recorded with an observed distillation, or none when it cannot be replayed. */
export function verificationContextOf(body, gene, now, checks) {
    const project = record(body['project']);
    const root = typeof project['root'] === 'string' ? project['root'] : '';
    const head = typeof project['head'] === 'string' ? project['head'] : '';
    if (!checks?.length || project['diff_omitted'] !== undefined)
        return undefined;
    if (project['diff'] !== undefined && typeof project['diff'] !== 'string')
        return undefined;
    const diff = project['diff'];
    const validation = Array.isArray(gene['validation']) ? gene['validation'] : [];
    if (validation.includes('node --version'))
        return undefined;
    const plan = { root, head, ...(diff ? { diff } : {}), checks: checks.map((check) => ({ ...check })) };
    const { project: _project, execution: _execution, persist: _persist, publish: _publish, ...distillInput } = body;
    const context = {
        geneAssetId: gene.asset_id,
        geneId: String(gene['id'] ?? gene.asset_id),
        ...plan, commands: validation, planDigest: planDigest(plan), distillInput, recordedAt: now.toISOString(),
    };
    return hasVerificationPlan(context) ? context : undefined;
}
/** Whether a host hook observed the reused turn's last check and its result; agent-reported evidence never qualifies. */
export function isObservedCheckEvidence(evidence) {
    return evidence?.['source'] === 'observed' && evidence['tier'] === 'L1' && typeof record(evidence['check'])['passed'] === 'boolean';
}
export async function recordObservedReuse(store, assetId, taskId, passed) {
    if (!taskId)
        return 'no_task';
    const gene = await store.get(assetId);
    if (!gene || gene.type !== 'Gene')
        return 'not_local';
    const capsule = algo.observedReuseCapsule({
        geneId: String(gene['id'] ?? gene.asset_id),
        geneAssetId: gene.asset_id,
        trigger: Array.isArray(gene['signals_match']) ? gene['signals_match'].map(String).slice(0, 8) : [],
        taskId,
        passed,
    });
    const existing = await store.search({ kind: 'Capsule', gene: String(gene['id'] ?? gene.asset_id), limit: 10_000 });
    if (existing.some((c) => c['id'] === capsule.id))
        return 'duplicate';
    await store.put(capsule);
    return 'recorded';
}