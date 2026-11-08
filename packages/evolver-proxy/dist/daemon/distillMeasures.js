import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const MAX_OUTCOMES = 1_000;
const MAX_CONTROLS = 5_000;
const WINDOW_HOURS = 24;
const WITHHOLDING_TTL_MS = 24 * 3_600_000;
// One trial recall in five is withheld, so a draft's pass rate can be compared with sessions that did without it.
const HOLDOUT_BUCKETS = 5;
const MAX_EFFECT_ROWS = 10;
const MAX_LISTED_CAPSULES = 20_000;
/** An append-only JSON-lines file that keeps its newest `max` entries. */
class BoundedJsonl {
    path;
    max;
    constructor(path, max) {
        this.path = path;
        this.max = max;
    }
    read() {
        if (!existsSync(this.path))
            return [];
        return readFileSync(this.path, 'utf8').split('\n').flatMap((line) => {
            if (!line.trim())
                return [];
            try {
                return [JSON.parse(line)];
            }
            catch {
                return [];
            }
        });
    }
    append(entry) {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        const entries = this.read();
        if (entries.length <= this.max)
            return;
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, entries.slice(-this.max).map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
        renameSync(temporary, this.path);
    }
}
export function distillOutcomeOf(result, at) {
    const stamp = at.toISOString();
    if (!result.ok)
        return { at: stamp, status: 'skipped', reason: result.quality?.reason ?? result.reason };
    if (result.status === 'stored')
        return { at: stamp, status: 'stored' };
    return result.quality.ok ? { at: stamp, status: 'draft' } : { at: stamp, status: 'rejected', reason: result.quality.reason ?? 'quality_gate' };
}
export class DistillOutcomeLog {
    log;
    constructor(assetStoreDir) {
        this.log = new BoundedJsonl(join(assetStoreDir, 'distill-outcomes.jsonl'), MAX_OUTCOMES);
    }
    record(outcome) {
        this.log.append(outcome);
    }
    summary(now) {
        const since = now.getTime() - WINDOW_HOURS * 3_600_000;
        const status = { window_hours: WINDOW_HOURS, stored: 0, drafts: 0, rejected: {}, skipped: {} };
        const count = (byReason, reason = 'unknown') => { byReason[reason] = (byReason[reason] ?? 0) + 1; };
        for (const outcome of this.log.read()) {
            if (Date.parse(outcome.at) < since)
                continue;
            if (outcome.status === 'stored')
                status.stored += 1;
            else if (outcome.status === 'draft')
                status.drafts += 1;
            else
                count(outcome.status === 'skipped' ? status.skipped : status.rejected, outcome.reason);
        }
        return status;
    }
}
export class TrialControlLog {
    log;
    withholdings;
    constructor(assetStoreDir) {
        this.log = new BoundedJsonl(join(assetStoreDir, 'trial-control.jsonl'), MAX_CONTROLS);
        this.withholdings = new BoundedJsonl(join(assetStoreDir, 'trial-withheld.jsonl'), MAX_CONTROLS);
    }
    /** Records one withholding and names it; the turn that went without the draft reports its control under this id. */
    withheld(assetId, at) {
        const id = randomUUID();
        this.withholdings.append({ id, asset_id: assetId, at: at.toISOString() });
        return id;
    }
    /** A control counts only against the withholding it names: of that draft, in the last day, and only once. */
    record(entry) {
        const withholding = this.withholdings.read().find((known) => known.id === entry.withheld_id);
        if (!withholding || withholding.asset_id !== entry.asset_id
            || Date.parse(withholding.at) < Date.parse(entry.at) - WITHHOLDING_TTL_MS)
            return 'not_withheld';
        if (this.log.read().some((known) => known.withheld_id === entry.withheld_id))
            return 'duplicate';
        this.log.append(entry);
        return 'recorded';
    }
    list() {
        return this.log.read();
    }
}
/**
 * Keyed by the Gene's own id, not its asset id: the asset id also hashes runtime metadata (model, `env_class`), so the
 * same draft would land in another arm on another machine.
 */
export function isTrialHoldout(geneId, recallText) {
    return createHash('sha256').update(`${geneId}\n${recallText}`).digest()[0] % HOLDOUT_BUCKETS === 0;
}
const arm = () => ({ runs: 0, passed: 0 });
/** Each trial draft with a control arm: how often checks passed with it recalled, and without. */
export async function trialEffect(store, controls) {
    const rows = new Map();
    for (const entry of controls.list()) {
        const row = rows.get(entry.asset_id) ?? { treated: arm(), control: arm() };
        row.control.runs += 1;
        if (entry.passed)
            row.control.passed += 1;
        rows.set(entry.asset_id, row);
    }
    if (rows.size === 0)
        return [];
    for (const capsule of await store.list('Capsule', MAX_LISTED_CAPSULES)) {
        const row = capsule['source_type'] === 'reused' ? rows.get(String(capsule['reused_asset_id'] ?? '')) : undefined;
        if (!row)
            continue;
        row.treated.runs += 1;
        if (capsule['outcome']?.status === 'success')
            row.treated.passed += 1;
    }
    const ranked = [...rows].sort(([, a], [, b]) => (b.treated.runs + b.control.runs) - (a.treated.runs + a.control.runs)).slice(0, MAX_EFFECT_ROWS);
    return Promise.all(ranked.map(async ([assetId, row]) => {
        const gene = await store.get(assetId);
        return { gene_asset_id: assetId, title: String(gene?.['summary'] ?? '').slice(0, 80), ...row };
    }));
}