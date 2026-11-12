import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { intakeGene } from '../algo/geneIntake.js';
import { Ingestor } from '../events/ingest.js';
import { rootEventsPath } from '../events/paths.js';
import { AuditWriteSkipped } from '../events/boundedAudit.js';
import { computeAssetId } from '../wire/index.js';
import { readLocalGeneSnapshot, readLocalExperienceSnapshot } from './boundedSnapshot.js';
import { approvedGenesFromSnapshot } from './reviewFilter.js';
import {} from './reviewLedger.js';
import { ExperienceSources } from './experienceSources.js';
import {} from './provider.js';
import {} from './boundedSnapshot.js';
import { regularFileFingerprint } from './assetStoreStorage.js';
import { normalizeForPut, frozenAssetRecordsEqual } from './provider.js';
import { journalDigest, journalParentIdentity, stableJson } from '../util/durableJournal.js';
import { ExperienceJournal, ExperienceJournalError } from './experienceJournal.js';
import { experienceAuditKey, snapshotExperienceAuditV1 } from '../events/experienceAuditJournal.js';
import { rootEvent } from '../events/eventSchema.js';
import { ExperienceError } from './experienceError.js';
import { authoredAntiGene, authoredCapsule, authoredGene, experienceFields, supersededBy, supersededReview, supersededTarget, supersedesOf, } from './experienceAuthoring.js';
import { EVIDENCE_FILE, ExperienceEvidence, captureEvidenceRow, evidenceInputOf } from './experienceEvidence.js';
export const EXPERIENCE_SCHEMA = 'evolver.experience.v1';
export const EXPERIENCE_PLAN_TTL = 120_000;
const ROOT_ADMISSION_RETRY_PAUSE_MS = 25;
export const EXPERIENCE_PAUSED = 'experience:paused';
export const EXPERIENCE_REMOVED = 'experience:removed';
export { ExperienceError } from './experienceError.js';
const activeExperienceProjections = new Map();
const projectionKey = (baseDir, commit) => `${baseDir}:${commit.commitId}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONFIRMATION_SCHEMA = 'evolver.experience-plan-confirmation.v1';
const MAX_CONFIRMATION_BYTES = 256 * 1024;
function detachPlan(input) {
    try {
        const json = stableJson(input);
        if (Buffer.byteLength(json, 'utf8') > MAX_CONFIRMATION_BYTES)
            throw new Error('plan_size');
        return JSON.parse(json);
    }
    catch {
        throw new ExperienceError('PLAN_INVALID', '确认内容不完整或过长，请重新查看后确认。');
    }
}
function confirmationHash(plan) {
    const body = { ...plan };
    delete body['id'];
    const confirmation = { ...plan.confirmation };
    delete confirmation['hash'];
    body['confirmation'] = confirmation;
    return journalDigest({ domain: CONFIRMATION_SCHEMA, plan: body });
}
function confirmationId(hash) {
    const value = hash.slice(0, 32), variant = ((Number.parseInt(value.charAt(16), 16) & 3) | 8).toString(16);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-8${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
function withConfirmation(input) {
    const plan = detachPlan(input);
    plan.confirmation = { schema: CONFIRMATION_SCHEMA, nonce: plan.id, hash: '' };
    const hash = confirmationHash(plan);
    plan.confirmation.hash = hash;
    plan.id = confirmationId(hash);
    return plan;
}
function confirmedPlanValid(plan) {
    const confirmation = plan.confirmation;
    if (!confirmation || confirmation.schema !== CONFIRMATION_SCHEMA
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(confirmation.nonce) || !/^[a-f0-9]{64}$/.test(confirmation.hash)
        || Object.keys(confirmation).sort().join(',') !== 'hash,nonce,schema')
        return false;
    try {
        const hash = confirmationHash(plan);
        return confirmation.hash === hash && plan.id === confirmationId(hash);
    }
    catch {
        return false;
    }
}
const text = (value, maximum) => {
    if (typeof value !== 'string' || value.length > maximum || value.includes('\0'))
        throw new ExperienceError('INPUT_INVALID', '内容过长或格式不正确。');
    return value.trim();
};
function strings(value, maximum = 12, length = 600) {
    if (!Array.isArray(value) || value.length > maximum)
        throw new ExperienceError('INPUT_INVALID', '请填写简短的条件和步骤。');
    return value.map(item => text(item, length)).filter(Boolean);
}
function inputAsset(value) {
    const title = text(value.title, 160);
    const task = text(value.task, 1200);
    const material = text(value.material, 16000);
    const conditions = strings(value.conditions);
    const steps = strings(value.steps);
    const signals = strings(value.signals, 12, 100);
    if (!title || !task || !material || conditions.length === 0 || steps.length === 0 || signals.length === 0) {
        throw new ExperienceError('INPUT_INVALID', '请填写任务、适用条件、步骤和关键词。');
    }
    const result = intakeGene({ id: `gene_distilled_experience_${digest({ title, conditions, steps, signals }).slice(0, 24)}`, category: 'innovate', summary: title, signals_match: signals, strategy: steps, generation_meta: { source: 'manual' } });
    if (!result.ok || !result.gene)
        throw new ExperienceError('INPUT_INVALID', '这条方法还不能保存，请检查内容。');
    const asset = { ...result.gene, type: 'Gene', asset_id: '', preconditions: conditions };
    asset.asset_id = computeAssetId(asset);
    return asset;
}
function assetIn(snapshot, assetId, kind) {
    return kind === 'AntiGene' ? snapshot.identities?.find(asset => asset.type === 'AntiGene' && asset.asset_id === assetId)
        : snapshot.genes.find(gene => gene.asset_id === assetId);
}
function sourceTask(asset) {
    const source = asset['source_task'];
    return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
}
function revision(snapshot) {
    return digest({ genes: snapshot.genes.map(asset => asset.asset_id).sort(),
        review: [...snapshot.review].sort(([a], [b]) => a.localeCompare(b)),
        provenance: [...snapshot.provenance].sort(([a], [b]) => a.localeCompare(b)),
    });
}
function item(asset, snapshot) {
    const reviewed = snapshot.review.get(asset.asset_id);
    const trusted = snapshot.provenance.get(asset.asset_id)?.trusted !== false;
    const state = reviewed?.state === 'rejected'
        ? reviewed.reason === EXPERIENCE_PAUSED ? 'paused' : 'removed'
        : !trusted ? 'untrusted' : reviewed?.state === 'quarantined' ? 'pending' : 'active';
    const source = sourceTask(asset);
    return { assetId: asset.asset_id, ...experienceFields(asset),
        task: String(source['title'] ?? ''), material: String(source['material'] ?? ''),
        state, review: reviewed?.state ?? 'eligible', verification: 'not_verified',
        supersedes: supersedesOf(asset), supersededBy: supersededBy(snapshot, asset.asset_id),
    };
}
/** Local curated Gene management. Never publishes, runs a strategy, or upgrades provenance trust. */
export class ExperienceLibrary {
    deps;
    baseDir;
    now;
    constructor(baseDir, deps = {}) {
        this.deps = deps;
        this.baseDir = resolve(baseDir);
        this.now = deps.now ?? Date.now;
    }
    async journalForConfirmedPlan(plan, requestHash) {
        const journal = new ExperienceJournal(this.baseDir);
        if (!confirmedPlanValid(plan)) {
            let previous;
            try {
                previous = journal.lookup(plan.id, requestHash);
            }
            catch (cause) {
                if (cause instanceof ExperienceJournalError)
                    throw cause;
                throw new ExperienceError('EXPERIENCE_RECOVERY_REQUIRED', '未能只读核对原提交，请先运行经验库恢复，再使用原确认重试。');
            }
            if (!previous?.commit)
                throw new ExperienceError('PLAN_INVALID', '确认内容已变化或未绑定，请重新查看后确认。');
        }
        // Only a complete confirmation or an exact immutable historical receipt
        // permits writable hot-journal/manifest recovery. Planning remains read-only.
        await journal.recoverBusiness();
        return journal;
    }
    async snapshot(allKinds = false) {
        try {
            return await (allKinds ? readLocalExperienceSnapshot : readLocalGeneSnapshot)(this.baseDir, { deadlineAt: Date.now() + 10_000, maxRecords: 20_000,
                maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024 });
        }
        catch (cause) {
            if (cause instanceof Error && cause.message === 'snapshot_writer_active')
                throw new ExperienceError('EXPERIENCE_RECOVERY_REQUIRED', '经验库正在写入；请稍后重试。如果进程已退出，请先运行恢复。');
            throw cause;
        }
    }
    files() {
        return Object.fromEntries(['genes.json', 'genes.jsonl', 'capsules.jsonl', 'events.jsonl', 'anti-genes.jsonl', 'review.jsonl', 'provenance.jsonl', 'experience-sources.jsonl',
            '.assetstore-bundle.json', 'references/references.json'].map(file => [file, regularFileFingerprint(join(this.baseDir, file))]));
    }
    rootGeneration() {
        try {
            return journalParentIdentity(join(this.baseDir, '.experience-root'));
        }
        catch (cause) {
            if (cause?.code === 'ENOENT')
                return undefined;
            throw cause;
        }
    }
    async stableSnapshot(allKinds = false) {
        const rootGeneration = this.rootGeneration();
        const files = this.files(), snapshot = await this.snapshot(allKinds);
        if (rootGeneration !== this.rootGeneration() || stableJson(files) !== stableJson(this.files()))
            throw new ExperienceError('STATE_CHANGED', '经验库有变化，请重新查看。');
        return { snapshot, files, rootGeneration };
    }
    async currentItem(assetId, kind) {
        const { snapshot, files } = await this.stableSnapshot(kind === 'AntiGene');
        const record = assetIn(snapshot, assetId, kind);
        if (!record)
            throw new ExperienceError('VERIFY_FAILED', '操作已完成，但未能核对当前经验，请重新查看经验库。');
        const source = new ExperienceSources(this.baseDir).read().get(assetId);
        if (stableJson(files) !== stableJson(this.files()))
            throw new ExperienceError('STATE_CHANGED', '操作已完成，经验库又有变化，请重新查看。');
        return { ...item(record, snapshot), ...(source ?? {}) };
    }
    async list(query = '', limit = 50, offset = 0) {
        query = text(query, 300).toLocaleLowerCase();
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 20_000) {
            throw new ExperienceError('INPUT_INVALID', '列表范围不正确。');
        }
        const { snapshot, files } = await this.stableSnapshot();
        const sources = new ExperienceSources(this.baseDir).read();
        if (stableJson(files) !== stableJson(this.files()))
            throw new ExperienceError('STATE_CHANGED', '经验库有变化，请重新查看。');
        const rows = snapshot.genes.map(asset => ({ ...item(asset, snapshot), ...(sources.get(asset.asset_id) ?? {}) })).filter(row => !query
            || [row.title, row.task, ...row.conditions, ...row.signals].join(' ').toLocaleLowerCase().includes(query));
        return { schema: EXPERIENCE_SCHEMA, items: rows.slice(offset, offset + limit), revision: revision(snapshot), hasMore: rows.length > offset + limit };
    }
    async geneRecord(assetId) {
        if (typeof assetId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(assetId))
            throw new ExperienceError('INPUT_INVALID', '请提供 sha256:… 资产 ID。');
        const { snapshot } = await this.stableSnapshot();
        const gene = snapshot.genes.find((candidate) => candidate.asset_id === assetId);
        if (!gene)
            throw new ExperienceError('NOT_FOUND', '没找到这条经验。');
        return gene;
    }
    /** One stored Gene exactly as kept (local-only fields included) with its library view. */
    async gene(assetId) {
        const gene = await this.geneRecord(assetId);
        return { gene, item: await this.currentItem(gene.asset_id) };
    }
    /** Records a trial or experiment outcome beside the Gene; never touches the Gene, its review or capsules.jsonl. */
    async recordEvidence(raw) {
        const input = evidenceInputOf(raw);
        return new ExperienceEvidence(this.baseDir, this.now).record(await this.geneRecord(input.assetId), input);
    }
    async evidence(assetId) {
        const gene = await this.geneRecord(assetId);
        return new ExperienceEvidence(this.baseDir).list(gene.asset_id);
    }
    async search(query, limit = 5) {
        const snapshot = await this.snapshot();
        const q = text(query, 300).toLocaleLowerCase();
        if (!Number.isInteger(limit) || limit < 1 || limit > 20)
            throw new ExperienceError('INPUT_INVALID', '查询数量不正确。');
        const words = q.split(/[\s,，、]+/u).filter(Boolean);
        return approvedGenesFromSnapshot(snapshot, 20_000, {}, 20_000).map(asset => ({ ...item(asset, snapshot), task: '', material: '' }))
            .filter(row => !q || [row.title, ...row.conditions, ...row.signals].join(' ').toLocaleLowerCase().includes(q)
            || words.some(word => [row.title, ...row.conditions, ...row.signals].join(' ').toLocaleLowerCase().includes(word))
            || row.signals.some(signal => q.includes(signal.toLocaleLowerCase()))).slice(0, limit);
    }
    async plan(action, assetId, input, authored = {}) {
        if (!['capture', 'approve', 'pause', 'resume', 'remove'].includes(action))
            throw new ExperienceError('INPUT_INVALID', '操作不正确。');
        let { snapshot, files, rootGeneration } = await this.stableSnapshot(action === 'capture');
        let asset;
        let capsule;
        let kind;
        if (action === 'capture') {
            if (!input)
                throw new ExperienceError('INPUT_INVALID', '请先填写要保存的方法。');
            if (authored.antiGene !== undefined && (authored.gene !== undefined || authored.capsule !== undefined))
                throw new ExperienceError('INPUT_INVALID', 'AntiGene 不能和 Gene 或 Capsule 一起保存。');
            if (authored.antiGene !== undefined)
                kind = 'AntiGene';
            asset = kind ? authoredAntiGene(authored.antiGene) : authored.gene === undefined ? inputAsset(input) : authoredGene(authored.gene);
            assetId = asset.asset_id;
            capsule = authored.capsule === undefined ? undefined : authoredCapsule(authored.capsule, asset);
            if (assetIn(snapshot, assetId, kind))
                throw new ExperienceError('ALREADY_SAVED', '这条方法已经保存过了。');
        }
        else {
            let found = snapshot.genes.find(gene => gene.asset_id === assetId);
            if (!found) {
                ({ snapshot, files, rootGeneration } = await this.stableSnapshot(true));
                found = assetIn(snapshot, assetId ?? '', 'AntiGene');
                if (found)
                    kind = 'AntiGene';
            }
            if (!found)
                throw new ExperienceError('NOT_FOUND', '没找到这条经验。');
            const current = item(found, snapshot);
            if ((action === 'approve' || action === 'resume') && current.state === 'untrusted')
                throw new ExperienceError('UNTRUSTED_SOURCE', '来源还未信任，不能直接启用。');
            if (action === 'approve' && current.state !== 'pending')
                throw new ExperienceError('STATE_CHANGED', '只有待审核的经验可以启用。');
            if (action === 'resume' && current.state !== 'paused')
                throw new ExperienceError('STATE_CHANGED', '这条经验不是暂停状态。');
            if (action === 'pause' && current.state !== 'active')
                throw new ExperienceError('STATE_CHANGED', '只有正在使用的经验可以暂停。');
            if (action === 'remove' && current.state === 'removed')
                throw new ExperienceError('STATE_CHANGED', '这条经验已经移出使用，不需要重复移出。');
        }
        return withConfirmation({ schema: EXPERIENCE_SCHEMA, id: randomUUID(), action, assetId: assetId, rootIdentity: digest(this.baseDir),
            expectedRevision: revision(snapshot), expectedFiles: files, expectedRoot: rootGeneration, auditTarget: this.deps.audit?.path ?? rootEventsPath(), expectedReview: snapshot.review.get(assetId) ?? null,
            provenanceRevision: regularFileFingerprint(join(this.baseDir, 'provenance.jsonl')),
            expiresAt: this.now() + EXPERIENCE_PLAN_TTL,
            ...(kind ? { kind } : {}),
            ...(asset ? { asset, ...(capsule ? { capsule } : {}), source: { task: text(input.task, 1200), material: text(input.material, 16000) } } : {}) });
    }
    audit(path = this.deps.audit?.path ?? rootEventsPath()) {
        if (this.deps.audit?.path && this.deps.audit.path !== path)
            throw new ExperienceError('AUDIT_TARGET_CHANGED', '审计目录与原提交不一致，请使用原安装恢复。');
        const audit = this.deps.audit ?? new Ingestor({ path });
        if (typeof audit.ingestExperienceAuditV1 !== 'function')
            throw new ExperienceError('AUDIT_CAPABILITY_REQUIRED', '审计写入器不支持持久恢复，请更新本地安装。');
        return audit;
    }
    async auditEvent(raw, key, path = this.deps.audit?.path ?? rootEventsPath(), deadlineAt = Date.now() + 30_000, expectedNamespace) {
        const snapshot = snapshotExperienceAuditV1(raw), hash = journalDigest(snapshot);
        const response = await this.admitRootAudit(path, snapshot, key, deadlineAt, expectedNamespace);
        let event;
        try {
            event = rootEvent.parse(JSON.parse(JSON.stringify(response)));
        }
        catch {
            throw new ExperienceError('AUDIT_RECEIPT_INVALID', '审计没有返回可核对的持久记录，请检查写入器，不要重复审批。');
        }
        const projected = snapshotExperienceAuditV1({ type: event.type, payload: event.payload, actor: event.actor, human: event.human });
        if (!event.experienceAuditNamespace || expectedNamespace !== undefined && event.experienceAuditNamespace !== expectedNamespace
            || event.auditOperationId !== key || event.auditRequestHash !== hash || journalDigest(projected) !== hash) {
            throw new ExperienceError('AUDIT_RECEIPT_INVALID', '审计回执与这次操作不一致，请检查恢复状态。');
        }
        return event;
    }
    // One Root admission is capped at 500ms so it never holds the Root lock for long, and a slow disk can expire it
    // before it writes. The key replays its reserved slot, so admitting again inside this operation's window cannot duplicate it.
    async admitRootAudit(path, snapshot, key, deadlineAt, expectedNamespace) {
        for (;;) {
            try {
                return await this.audit(path).ingestExperienceAuditV1(snapshot, key, deadlineAt, expectedNamespace);
            }
            catch (error) {
                if (!(error instanceof AuditWriteSkipped) || error.reason !== 'cancelled_or_expired' || Date.now() + ROOT_ADMISSION_RETRY_PAUSE_MS >= deadlineAt)
                    throw error;
                await new Promise(resolve => setTimeout(resolve, ROOT_ADMISSION_RETRY_PAUSE_MS));
            }
        }
    }
    completion(commit) {
        return { type: commit.action === 'recover-source' ? 'experience.source.recovered' : commit.action === 'capture' ? 'actor.human.teach' : ['approve', 'resume'].includes(commit.action)
                ? 'actor.human.review.approve' : 'actor.human.review.reject',
            payload: { assetId: commit.assetId, operationId: commit.operationId, action: commit.action, source: 'experience-library', sourceVerified: false,
                phase: 'committed', state: commit.state, namespace: commit.namespace, commitId: commit.commitId,
                commitSequence: commit.commitSequence, committedAt: commit.committedAt, requestHash: commit.requestHash, evidenceDigest: journalDigest(commit.evidence) },
            actor: { kind: 'human', id: 'local-experience-user' }, human: { title: `experience ${commit.action}`, severity: 'info' } };
    }
    project(commit, deadlineAt = Date.now() + 30_000) {
        const key = projectionKey(this.baseDir, commit), prior = activeExperienceProjections.get(key);
        if (prior)
            return prior;
        if (activeExperienceProjections.size >= 64)
            return Promise.reject(new ExperienceError('AUDIT_BUSY', '审计恢复正在进行，请稍后重试。'));
        const work = Promise.resolve().then(async () => {
            const target = commit.evidence['auditTarget'], namespace = commit.evidence['auditNamespace'];
            if (typeof target !== 'string' || typeof namespace !== 'string')
                throw new ExperienceError('AUDIT_TARGET_CHANGED', '原提交缺少审计目标身份；请保留证据并核对原安装。');
            const receipt = await this.auditEvent(this.completion(commit), experienceAuditKey('completion', commit.namespace, commit.operationId), target, deadlineAt, namespace);
            await new ExperienceJournal(this.baseDir).acknowledge(commit, receipt, deadlineAt);
        }).finally(() => { if (activeExperienceProjections.get(key) === work)
            activeExperienceProjections.delete(key); });
        activeExperienceProjections.set(key, work);
        return work;
    }
    async planSourceRecovery(assetId) {
        const { snapshot, files, rootGeneration } = await this.stableSnapshot();
        const source = new ExperienceSources(this.baseDir).read().get(assetId);
        if (!source)
            throw new ExperienceError('NOT_FOUND', '没找到待恢复的任务材料。');
        if (snapshot.genes.some(gene => gene.asset_id === assetId) || new ExperienceJournal(this.baseDir).hasCommitForAsset(assetId)
            || snapshot.review.get(assetId)?.state === 'approved' || snapshot.review.get(assetId)?.state === 'rejected') {
            throw new ExperienceError('SOURCE_BOUND', '这份材料已有方法或人工决定，不能解除绑定。');
        }
        if (stableJson(files) !== stableJson(this.files()))
            throw new ExperienceError('STATE_CHANGED', '经验库有变化，请重新查看。');
        return withConfirmation({ schema: 'evolver.experience-source-recovery.v1', id: randomUUID(), rootIdentity: digest(this.baseDir),
            assetId, sourceDigest: journalDigest(source), expectedRoot: rootGeneration, auditTarget: this.deps.audit?.path ?? rootEventsPath(), expectedFiles: files, expiresAt: this.now() + EXPERIENCE_PLAN_TTL });
    }
    async executeSourceRecovery(input) {
        const plan = detachPlan(input);
        if (plan?.schema !== 'evolver.experience-source-recovery.v1' || plan.rootIdentity !== digest(this.baseDir)
            || !/^[a-f0-9-]{36}$/.test(plan.id) || !Number.isFinite(plan.expiresAt))
            throw new ExperienceError('PLAN_INVALID', '恢复确认不正确。');
        const hash = journalDigest(plan), journal = await this.journalForConfirmedPlan(plan, hash);
        let commit = journal.lookup(plan.id, hash)?.commit;
        if (!commit) {
            if (plan.auditTarget !== (this.deps.audit?.path ?? rootEventsPath()))
                throw new ExperienceError('AUDIT_TARGET_CHANGED', '恢复的审计目录已变化，请重新确认。');
            if (this.now() >= plan.expiresAt)
                throw new ExperienceError('PLAN_EXPIRED', '恢复确认已过期，请重新查看。');
            const { snapshot, files } = await this.stableSnapshot();
            if (stableJson(files) !== stableJson(plan.expectedFiles) || snapshot.genes.some(gene => gene.asset_id === plan.assetId)
                || journal.hasCommitForAsset(plan.assetId) || ['approved', 'rejected'].includes(snapshot.review.get(plan.assetId)?.state ?? '')) {
                throw new ExperienceError('PLAN_STALE', '材料或方法已变化，不能解除绑定。');
            }
            const requested = await this.auditEvent({ type: 'experience.operation.requested',
                payload: { operationId: plan.id, assetId: plan.assetId, action: 'recover-source', phase: 'requested', source: 'experience-library', sourceVerified: false, requestHash: hash },
                actor: { kind: 'human', id: 'local-experience-user' }, human: { title: 'request experience source recovery' } }, experienceAuditKey('request', plan.rootIdentity, plan.id));
            commit = journal.commit(plan.id, hash, () => {
                const source = new ExperienceSources(this.baseDir).read().get(plan.assetId);
                if (this.now() >= plan.expiresAt || plan.expectedRoot !== undefined && plan.expectedRoot !== this.rootGeneration() || stableJson(this.files()) !== stableJson(plan.expectedFiles)
                    || !source || journalDigest(source) !== plan.sourceDigest || journal.hasCommitForAsset(plan.assetId))
                    throw new ExperienceError('PLAN_STALE', '恢复证据已有变化，请重新查看。');
                return { mutations: [{ file: 'experience-sources.jsonl', row: { schema: 2, kind: 'detached', assetId: plan.assetId,
                                sourceDigest: plan.sourceDigest, operationId: plan.id } }],
                    result: { action: 'recover-source', assetId: plan.assetId, state: 'detached',
                        evidence: { auditTarget: plan.auditTarget, auditNamespace: requested.experienceAuditNamespace, sourceDigest: plan.sourceDigest, previousFiles: plan.expectedFiles, legacyAttribution: 'unresolved' } } };
            }, this.now, this.deps.checkpoint);
        }
        try {
            await this.project(commit);
        }
        catch {
            throw new ExperienceError('AUDIT_COMPLETION_PENDING', '旧材料已保留并解除未提交绑定，恢复审计待补写。');
        }
        return { operationId: plan.id, assetId: plan.assetId, state: 'detached', originalMaterialPreserved: true };
    }
    operationStatus(limit = 50, offset = 0) { return new ExperienceJournal(this.baseDir).status(limit, offset); }
    async recover(operationId, limit = 32) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new ExperienceError('INPUT_INVALID', '恢复数量不正确。');
        const deadlineAt = Date.now() + 30_000;
        const journal = new ExperienceJournal(this.baseDir), business = await journal.recoverBusiness(deadlineAt);
        const saved = operationId ? journal.lookup(operationId) : undefined;
        if (operationId && !saved)
            throw new ExperienceError('NOT_FOUND', '没找到这次操作的恢复记录。');
        const commits = operationId ? [saved?.commit].filter((row) => !!row) : await journal.pending(limit, deadlineAt);
        let projected = 0;
        const pending = [];
        for (const commit of commits) {
            if (Date.now() >= deadlineAt) {
                pending.push(commit.operationId);
                continue;
            }
            if (activeExperienceProjections.has(projectionKey(this.baseDir, commit))) {
                pending.push(commit.operationId);
                continue;
            }
            try {
                await this.project(commit, deadlineAt);
                projected++;
            }
            catch {
                pending.push(commit.operationId);
            }
        }
        // If admission expires, do not claim that the uninspected backlog is empty.
        const backlog = await journal.backlog(operationId, deadlineAt);
        return { business, projected, pending, ...backlog, hasMore: backlog.remaining > 0,
            operations: await journal.recoveryStatus(100, deadlineAt) };
    }
    async executionEvidence(plan) {
        const { snapshot, files } = await this.stableSnapshot(plan.action === 'capture' || plan.kind === 'AntiGene');
        if (revision(snapshot) !== plan.expectedRevision || stableJson(files) !== stableJson(plan.expectedFiles))
            throw new ExperienceError('PLAN_STALE', '经验库有变化，请重新查看后确认。');
        if (stableJson(snapshot.review.get(plan.assetId) ?? null) !== stableJson(plan.expectedReview)
            || files['provenance.jsonl'] !== plan.provenanceRevision)
            throw new ExperienceError('PLAN_INVALID', '确认记录的审批或来源证据不正确。');
        const known = assetIn(snapshot, plan.assetId, plan.kind);
        const trusted = snapshot.provenance.get(plan.assetId)?.trusted !== false;
        let confirmedSource, record;
        if (plan.action === 'capture') {
            if (!plan.asset || plan.asset.type !== (plan.kind ?? 'Gene') || ['source_task', 'task', 'material'].some(key => Object.hasOwn(plan.asset, key)) || plan.asset.asset_id !== plan.assetId || computeAssetId(plan.asset) !== plan.assetId || known || !plan.source)
                throw new ExperienceError('PLAN_INVALID', '要保存的内容已变化。');
            confirmedSource = { task: text(plan.source.task, 1200), material: text(plan.source.material, 16000) };
            if (!confirmedSource.task || !confirmedSource.material)
                throw new ExperienceError('PLAN_INVALID', '没有确认任务材料。');
            record = normalizeForPut(plan.asset, snapshot.referenceScope).record;
            if (!frozenAssetRecordsEqual(record, plan.asset))
                throw new ExperienceError('PLAN_INVALID', '保存内容的规范形式已变化。');
            if (plan.capsule)
                authoredCapsule(plan.capsule, record);
        }
        else if (!known)
            throw new ExperienceError('NOT_FOUND', '没找到这条经验。');
        const superseded = plan.action === 'approve' && known ? supersededTarget(known, snapshot) : null;
        if (known) {
            const current = item(known, snapshot);
            if (plan.action === 'approve' && current.state !== 'pending')
                throw new ExperienceError('STATE_CHANGED', '只有待审核的经验可以启用。');
            if (plan.action === 'resume' && current.state !== 'paused')
                throw new ExperienceError('STATE_CHANGED', '这条经验不是暂停状态。');
            if (plan.action === 'pause' && current.state !== 'active')
                throw new ExperienceError('STATE_CHANGED', '只有正在使用的经验可以暂停。');
            if (plan.action === 'remove' && current.state === 'removed')
                throw new ExperienceError('STATE_CHANGED', '这条经验已经移出使用，不需要重复移出。');
            if (['approve', 'resume'].includes(plan.action) && !trusted)
                throw new ExperienceError('UNTRUSTED_SOURCE', '来源还未信任，不能直接启用。');
        }
        const frozen = record && snapshot.identities?.find(existing => existing.asset_id === record.asset_id);
        const frozenCollision = !!(record && frozen && !frozenAssetRecordsEqual(frozen, record));
        const logicalCollision = !!(record && snapshot.identities?.some(other => other.type === record.type && other['id'] === record['id'] && other.asset_id !== record.asset_id));
        // Only target evidence crosses the audit await. The complete corpus and its
        // reference-reader closures are released; the full file fence still applies.
        return { known, trusted, confirmedSource, record, frozenCollision, logicalCollision, superseded };
    }
    async execute(inputPlan) {
        const plan = detachPlan(inputPlan);
        if (!plan || plan.schema !== EXPERIENCE_SCHEMA || plan.rootIdentity !== digest(this.baseDir) || !Number.isFinite(plan.expiresAt)
            || !/^[a-f0-9-]{36}$/.test(plan.id) || !plan.expectedFiles)
            throw new ExperienceError('PLAN_INVALID', '安装记录不正确，请重新确认。');
        if (!['capture', 'approve', 'pause', 'resume', 'remove'].includes(plan.action))
            throw new ExperienceError('PLAN_INVALID', '操作不正确。');
        const requestHash = journalDigest(plan), journal = await this.journalForConfirmedPlan(plan, requestHash);
        const previous = journal.lookup(plan.id, requestHash);
        if (previous?.commit) {
            try {
                await this.project(previous.commit);
            }
            catch {
                throw new ExperienceError('AUDIT_COMPLETION_PENDING', '经验已变更，结果审计待恢复；请运行经验库恢复，不要重新审批。');
            }
            return this.currentItem(plan.assetId, plan.kind);
        }
        if (previous)
            throw new ExperienceError('OPERATION_ABORTED', '这次操作没有提交，请重新查看并确认。');
        if (plan.auditTarget !== (this.deps.audit?.path ?? rootEventsPath()))
            throw new ExperienceError('AUDIT_TARGET_CHANGED', '确认中的审计目录已变化，请重新确认。');
        if (this.now() >= plan.expiresAt)
            throw new ExperienceError('PLAN_EXPIRED', '这份确认已过期，请再检查一次。');
        const { known, trusted, confirmedSource, record, frozenCollision, logicalCollision, superseded } = await this.executionEvidence(plan);
        const payload = { assetId: plan.assetId, operationId: plan.id, action: plan.action, source: 'experience-library', sourceVerified: false,
            phase: 'requested', requestHash };
        const requested = await this.auditEvent({ type: 'experience.operation.requested', payload,
            actor: { kind: 'human', id: 'local-experience-user' }, human: { title: `request experience ${plan.action}`, severity: 'info' } }, experienceAuditKey('request', plan.rootIdentity, plan.id));
        let commit;
        try {
            commit = journal.commit(plan.id, requestHash, () => {
                if (this.now() >= plan.expiresAt)
                    throw new ExperienceError('PLAN_EXPIRED', '这份确认已过期，请再检查一次。');
                if ((plan.expectedRoot !== undefined && plan.expectedRoot !== this.rootGeneration()) || stableJson(this.files()) !== stableJson(plan.expectedFiles))
                    throw new ExperienceError('PLAN_STALE', '经验库有变化，请重新查看后确认。');
                const mutations = [];
                let assetDigest = known ? journalDigest(known) : '';
                const source = new ExperienceSources(this.baseDir).read().get(plan.assetId);
                if (source && confirmedSource && stableJson(source) !== stableJson(confirmedSource))
                    throw new ExperienceError('STATE_CHANGED', '相同经验的任务材料有变化，请先恢复未提交材料。');
                const state = plan.action === 'capture' ? !trusted ? 'untrusted' : 'pending' : ['approve', 'resume'].includes(plan.action) ? 'active' : plan.action === 'pause' ? 'paused' : 'removed';
                const reviewRecord = { assetId: plan.assetId, at: new Date(this.now()).toISOString(),
                    state: plan.action === 'capture' ? 'quarantined' : ['approve', 'resume'].includes(plan.action) ? 'approved' : 'rejected',
                    ...(plan.action === 'capture' ? {} : { by: 'local-experience-user' }),
                    reason: plan.action === 'capture' ? 'experience:capture — review before use' : plan.action === 'pause' ? EXPERIENCE_PAUSED : plan.action === 'remove' ? EXPERIENCE_REMOVED : `experience:${plan.action}` };
                if (plan.action === 'capture') {
                    if (!record)
                        throw new ExperienceError('PLAN_INVALID', '缺少已核对的保存内容。');
                    assetDigest = journalDigest(record);
                    if (frozenCollision)
                        throw new ExperienceError('FROZEN_ASSET_ID_COLLISION', '相同内容地址已有不同资产，不能覆盖；请先核对经验库。');
                    if (logicalCollision || plan.expectedReview && plan.expectedReview.state !== 'quarantined')
                        throw new ExperienceError('STATE_CHANGED', '相同标识或审批已存在，请重新查看。');
                    if (!plan.expectedReview)
                        mutations.push({ file: 'review.jsonl', row: { ...reviewRecord, operationId: plan.id } });
                    if (!source)
                        mutations.push({ file: 'experience-sources.jsonl', row: { schema: 1, assetId: plan.assetId, ...confirmedSource, operationId: plan.id } });
                    mutations.push({ file: plan.kind === 'AntiGene' ? 'anti-genes.jsonl' : 'genes.jsonl', row: record });
                    if (plan.capsule)
                        mutations.push({ file: EVIDENCE_FILE, row: { ...captureEvidenceRow(plan.capsule, plan.assetId, plan.id, reviewRecord.at) } });
                }
                else {
                    mutations.push({ file: 'review.jsonl', row: { ...reviewRecord, operationId: plan.id } });
                    if (superseded)
                        mutations.push({ file: 'review.jsonl', row: { ...supersededReview(superseded, reviewRecord.at), operationId: plan.id } });
                }
                return { mutations, result: { action: plan.action, assetId: plan.assetId, state,
                        evidence: { auditTarget: plan.auditTarget, auditNamespace: requested.experienceAuditNamespace, assetDigest,
                            review: plan.action === 'capture' && plan.expectedReview ? plan.expectedReview : { ...reviewRecord, operationId: plan.id }, previousReview: plan.expectedReview,
                            provenanceRevision: plan.provenanceRevision, sourceDigest: journalDigest(confirmedSource ?? source ?? null),
                            ...(superseded ? { superseded } : {}) } } };
            }, this.now, this.deps.checkpoint);
        }
        catch (cause) {
            let saved;
            try {
                saved = journal.lookup(plan.id, requestHash);
            }
            catch {
                throw new ExperienceError('EXPERIENCE_RECOVERY_UNKNOWN', '未能核对持久提交证据，请先检查恢复状态，不要重复审批。');
            }
            if (saved?.commit)
                throw new ExperienceError('EXPERIENCE_CLEANUP_PENDING', '经验已提交，写入资源清理待恢复；请先运行恢复。');
            if (cause instanceof ExperienceJournalError)
                throw new ExperienceError(cause.code, '经验操作需要恢复；请检查经验库恢复状态，不要重复执行。');
            throw cause;
        }
        try {
            this.deps.checkpoint?.('before_completion');
            await this.project(commit);
        }
        catch {
            throw new ExperienceError('AUDIT_COMPLETION_PENDING', '经验已变更，但结果审计待恢复；请运行经验库恢复，不要重新审批。');
        }
        // Bounded catch-up is opportunistic: a historical audit outage does not revoke a newer business commit.
        const catchupDeadline = Date.now() + 500;
        try {
            for (const pending of await journal.pending(4, catchupDeadline)) {
                if (Date.now() >= catchupDeadline)
                    break;
                if (activeExperienceProjections.has(projectionKey(this.baseDir, pending)))
                    continue;
                await this.project(pending, catchupDeadline);
            }
        }
        catch { /* Optional historical catch-up cannot revoke this confirmed commit. */ }
        return this.currentItem(plan.assetId, plan.kind);
    }
}