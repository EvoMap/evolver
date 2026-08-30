import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalize } from '../wire/index.js';
import { MAX_LINE_BYTES } from '../events/eventStore.js';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { isValidationCommandAllowed } from '../verify/validation.js';
import { proofOfWork } from '../schema/proofOfWork.js';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const digest = z.string().regex(DIGEST_PATTERN, 'must be sha256:<64 lowercase hex>');
const MAX_INLINE_BINDING_BYTES = MAX_LINE_BYTES - 512;
const isoDate = z.string().datetime({ offset: true });
const boundedId = z.string().trim().min(1).max(512);
const boundedText = z.string().max(4_000);
const boundedStringArray = z.array(z.string().max(4_000)).max(128);
const targetDescriptorSchema = z.object({
    repo_id: boundedId,
    selector: boundedId,
    expected_effect: boundedText,
    base_revision: boundedId.nullable(),
}).strict();
const acceptanceSpecSchema = z.object({
    spec_id: boundedId,
    version: boundedId,
    digest,
    validation_plan_digest: digest,
}).strict();
const resourceGrantSchema = z.object({
    allowed_roots: z.array(boundedId).min(1).max(32),
    max_runtime_ms: z.number().int().positive().safe(),
    max_files: z.number().int().nonnegative().safe(),
    max_lines: z.number().int().nonnegative().safe(),
    validation_commands: z.array(z.string().trim().max(400)).max(64),
}).strict();
const consentGrantSchema = z.object({
    grant_id: boundedId,
    subject: boundedId,
    scopes: z.array(boundedId).min(1).max(64),
    issued_at: isoDate,
    expires_at: isoDate,
    target_digest: digest,
}).strict();
const selectedContextSchema = z.object({
    gene_id: boundedId.nullable(),
    gene_asset_id: digest.nullable(),
    capsule_id: boundedId.nullable(),
    capsule_asset_id: digest.nullable(),
    context_digest: digest,
}).strict();
export const executionBindingInputSchema = z.object({
    schema_version: z.literal('execution-binding.v1'),
    bounty_id: boundedId.nullable(),
    task_id: boundedId,
    claim_identity: z.object({ claim_id: boundedId, claimant_id: boundedId }).strict(),
    lease_identity: z.object({ lease_id: boundedId, lease_expires_at: isoDate }).strict(),
    target_descriptor: targetDescriptorSchema,
    target_digest: digest,
    acceptance_spec: acceptanceSpecSchema,
    deadline: isoDate,
    budget: z.object({ max_credits: z.number().int().nonnegative().safe() }).strict(),
    resource_grant: resourceGrantSchema,
    consent_grant: consentGrantSchema,
    correlation: z.object({ run_id: boundedId, cycle_id: boundedId }).strict(),
    selected_context: selectedContextSchema,
}).strict();
export class ExecutionBindingError extends Error {
    code;
    detail;
    unsafeToReplay;
    constructor(code, detail, unsafeToReplay = false) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.unsafeToReplay = unsafeToReplay;
        this.name = 'ExecutionBindingError';
    }
}
const terminalDispositionSchema = z.enum([
    'completed', 'denied', 'invalid_target', 'deadline_exceeded', 'budget_exceeded',
    'resource_denied', 'consent_denied', 'timed_out', 'cancelled', 'crashed', 'rejected', 'unsafe_to_replay',
]);
const toolDecisionSchema = z.object({
    tool_name: boundedId,
    decision: z.enum(['allowed', 'denied']),
    status: z.enum(['not_run', 'started', 'completed', 'failed']).optional(),
    call_id: boundedId.optional(),
    duration_ms: z.number().int().nonnegative().safe().optional(),
}).strict();
const policyDecisionSchema = z.object({
    version: boundedId,
    allowed: z.boolean(),
    violations: z.array(z.object({
        kind: z.enum(['blast_radius', 'forbidden_path', 'protected_path', 'destructive']),
        detail: boundedText,
    }).strict()).max(128),
}).strict();
const validatorEvidenceSchema = z.object({
    id: boundedId,
    version: boundedId,
    status: z.enum(['ran', 'not_run']),
    reason: z.enum(['policy_denied', 'no_commands', 'malformed_plan', 'sandbox_unavailable', 'not_configured']).optional(),
    plan_digest: digest.optional(),
    passed: z.boolean().optional(),
    score: z.number().finite().optional(),
    results: z.array(z.object({
        label: boundedText,
        cmd: z.string().max(400),
        allowed: z.boolean(),
        exitCode: z.number().int().nullable(),
        stdoutSummary: z.string().max(600),
        passed: z.boolean(),
    }).strict()).max(64),
    skipped: z.array(z.object({ cmd: z.string().max(400), script: z.string().max(400), reason: z.literal('missing_script') }).strict()).max(64),
    isolated: z.boolean(),
}).strict();
const provenanceSchema = z.object({
    gene_ids: boundedStringArray,
    capsule_ids: boundedStringArray,
    tool_decisions: z.array(toolDecisionSchema).max(128),
    policy_decisions: z.array(policyDecisionSchema).max(32),
    validator: validatorEvidenceSchema.nullable(),
    permit: z.object({ ok: z.boolean(), reason: boundedText.optional(), detail: boundedText.optional() }).strict().optional(),
    result_asset_refs: boundedStringArray,
    proof_refs: z.array(z.object({ kind: z.enum(['git_diff', 'artifact_hash', 'external_receipt', 'tool_call_trace']), ref: boundedId.optional(), asset_id: boundedId.optional() }).strict()).max(64).superRefine((refs, ctx) => {
        refs.forEach((reference, index) => {
            if (!reference.ref && !reference.asset_id)
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'proof reference requires ref or asset_id' });
        });
    }),
    terminal_disposition: terminalDispositionSchema,
}).strict();
const terminalRecordSchema = z.object({
    binding_digest: digest,
    task_id: boundedId,
    run_id: boundedId,
    disposition: terminalDispositionSchema,
    final_stage: boundedId.optional(),
    outcome: z.object({ status: boundedId, score: z.number().finite(), reason: boundedText.optional() }).strict().optional(),
    proof_of_work: proofOfWork.optional(),
    provenance: provenanceSchema,
}).strict();
function sha256(value) {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function withoutDigest(value, key) {
    const copy = { ...value };
    delete copy[key];
    return copy;
}
function freezeDeep(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            freezeDeep(child);
    }
    return value;
}
function parseOrThrow(input) {
    const result = executionBindingInputSchema.safeParse(input);
    if (!result.success)
        throw new ExecutionBindingError('binding_malformed', result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    return result.data;
}
function parseDate(value, field) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        throw new ExecutionBindingError('binding_malformed', `${field} is not a valid date`);
    return parsed;
}
function canonicalPath(path) {
    try {
        return realpathSync(resolve(path));
    }
    catch {
        return undefined;
    }
}
function pathWithin(root, target) {
    const canonicalRoot = canonicalPath(root);
    const canonicalTarget = canonicalPath(target);
    if (!canonicalRoot || !canonicalTarget)
        return false;
    const rel = relative(canonicalRoot, canonicalTarget);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${requirePathSeparator()}`) && !isAbsolute(rel));
}
function canonicalOverlap(left, right) {
    const leftPath = canonicalPath(left);
    const rightPath = canonicalPath(right);
    if (!leftPath || !rightPath)
        return undefined;
    if (pathWithin(leftPath, rightPath))
        return rightPath;
    if (pathWithin(rightPath, leftPath))
        return leftPath;
    return undefined;
}
function requirePathSeparator() {
    return process.platform === 'win32' ? '\\' : '/';
}
export function canonicalExecutionBinding(input) {
    const withoutBindingDigest = withoutDigest(input, 'binding_digest');
    return canonicalize(parseOrThrow(withoutBindingDigest));
}
export function computeTargetDigest(target) {
    const parsed = targetDescriptorSchema.safeParse(target);
    if (!parsed.success)
        throw new ExecutionBindingError('binding_target_invalid', parsed.error.message);
    return sha256(canonicalize(parsed.data));
}
export function computeValidationPlanDigest(commands) {
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string')) {
        throw new ExecutionBindingError('binding_acceptance_invalid', 'validation plan must contain strings');
    }
    return sha256(canonicalize({ commands: [...commands] }));
}
export function computeSelectedContextDigest(context) {
    return sha256(canonicalize(context));
}
export function computeExecutionBindingDigest(input) {
    return sha256(canonicalExecutionBinding(input));
}
export function freezeExecutionBinding(input) {
    const parsed = parseOrThrow(input);
    const targetDigest = computeTargetDigest(parsed.target_descriptor);
    if (parsed.target_digest !== targetDigest) {
        throw new ExecutionBindingError('binding_target_invalid', 'target_digest does not match target_descriptor');
    }
    const validationDigest = computeValidationPlanDigest(parsed.resource_grant.validation_commands);
    if (parsed.acceptance_spec.validation_plan_digest !== validationDigest) {
        throw new ExecutionBindingError('binding_acceptance_invalid', 'validation_plan_digest does not match validation_commands');
    }
    if (parsed.resource_grant.validation_commands.some((command) => !isValidationCommandAllowed(command))) {
        throw new ExecutionBindingError('binding_acceptance_invalid', 'validation command is not allowed by the sandbox contract');
    }
    const contextDigest = computeSelectedContextDigest({
        gene_id: parsed.selected_context.gene_id,
        gene_asset_id: parsed.selected_context.gene_asset_id,
        capsule_id: parsed.selected_context.capsule_id,
        capsule_asset_id: parsed.selected_context.capsule_asset_id,
    });
    if (parsed.selected_context.context_digest !== contextDigest) {
        throw new ExecutionBindingError('binding_mismatched', 'context_digest does not match selected_context');
    }
    if (parsed.consent_grant.target_digest !== parsed.target_digest) {
        throw new ExecutionBindingError('binding_consent_denied', 'consent target_digest does not match target_digest');
    }
    if (parsed.consent_grant.subject !== parsed.claim_identity.claimant_id) {
        throw new ExecutionBindingError('binding_consent_denied', 'consent subject does not match claimant identity');
    }
    const canonical = canonicalize(parsed);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_INLINE_BINDING_BYTES) {
        throw new ExecutionBindingError('binding_malformed', 'canonical binding exceeds durable root-event capacity');
    }
    const binding_digest = sha256(canonical);
    return freezeDeep({ ...parsed, binding_digest });
}
export async function preflightExecutionBinding(input, context) {
    if (!context || typeof context.taskId !== 'string' || context.taskId.length === 0) {
        throw new ExecutionBindingError('binding_missing', 'taskId is required');
    }
    const suppliedDigest = input && typeof input === 'object' && !Array.isArray(input)
        ? input['binding_digest']
        : undefined;
    const externalInput = suppliedDigest === undefined
        ? input
        : withoutDigest(input, 'binding_digest');
    const binding = freezeExecutionBinding(externalInput);
    if (suppliedDigest !== undefined && suppliedDigest !== binding.binding_digest) {
        throw new ExecutionBindingError('binding_mismatched', 'binding_digest does not match canonical binding');
    }
    const now = typeof context.now === 'function' ? context.now() : context.now ?? Date.now();
    if (!Number.isFinite(now))
        throw new ExecutionBindingError('binding_malformed', 'execution clock must be finite');
    for (const [field, value] of [['maxRuntimeMs', context.maxRuntimeMs], ['maxFiles', context.maxFiles], ['maxLines', context.maxLines]]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new ExecutionBindingError('binding_malformed', `${field} must be a nonnegative safe integer`);
    }
    const deadline = parseDate(binding.deadline, 'deadline');
    const leaseExpiry = parseDate(binding.lease_identity.lease_expires_at, 'lease_expires_at');
    const consentIssued = parseDate(binding.consent_grant.issued_at, 'consent issued_at');
    const consentExpiry = parseDate(binding.consent_grant.expires_at, 'consent expires_at');
    if (binding.task_id !== context.taskId)
        throw new ExecutionBindingError('binding_mismatched', 'task_id does not match execution task');
    if (context.runId !== undefined && binding.correlation.run_id !== context.runId)
        throw new ExecutionBindingError('binding_mismatched', 'run_id does not match execution context');
    if (context.cycleId !== undefined && binding.correlation.cycle_id !== context.cycleId)
        throw new ExecutionBindingError('binding_mismatched', 'cycle_id does not match execution context');
    if (deadline <= now)
        throw new ExecutionBindingError('binding_deadline_exceeded', 'execution deadline has expired');
    if (leaseExpiry <= now)
        throw new ExecutionBindingError('binding_stale', 'execution lease has expired');
    if (consentExpiry <= now)
        throw new ExecutionBindingError('binding_consent_denied', 'consent grant has expired');
    if (consentIssued > now)
        throw new ExecutionBindingError('binding_consent_denied', 'consent is not yet valid');
    const remaining = Math.min(deadline, leaseExpiry, consentExpiry) - now;
    if (binding.resource_grant.max_runtime_ms > remaining)
        throw new ExecutionBindingError('binding_deadline_exceeded', 'max_runtime_ms exceeds remaining binding lifetime');
    let effectiveRoots = [];
    if (context.allowedRoots === undefined || context.allowedRoots.length === 0) {
        throw new ExecutionBindingError('binding_resource_denied', 'local AutonomousSafety allowed roots are required');
    }
    if (context.repoPath !== undefined) {
        const bindingRepo = canonicalPath(binding.target_descriptor.repo_id);
        const executionRepo = canonicalPath(context.repoPath);
        if (!bindingRepo || !executionRepo || bindingRepo !== executionRepo)
            throw new ExecutionBindingError('binding_target_invalid', 'repo_id does not match execution repo');
        const grantRoots = binding.resource_grant.allowed_roots.filter((root) => pathWithin(root, executionRepo));
        const localRoots = context.allowedRoots.filter((root) => pathWithin(root, executionRepo));
        if (grantRoots.length === 0)
            throw new ExecutionBindingError('binding_resource_denied', 'execution repo is outside resource grant roots');
        if (localRoots.length === 0)
            throw new ExecutionBindingError('binding_resource_denied', 'execution repo is outside AutonomousSafety allowed roots');
        effectiveRoots = [executionRepo];
        if (context.target !== undefined && binding.target_descriptor.selector !== context.target)
            throw new ExecutionBindingError('binding_target_invalid', 'selector does not match execution target');
    }
    else {
        effectiveRoots = [...new Set(binding.resource_grant.allowed_roots.flatMap((grantRoot) => (context.allowedRoots.map((localRoot) => canonicalOverlap(grantRoot, localRoot)).filter((root) => root !== undefined))))];
        if (effectiveRoots.length === 0)
            throw new ExecutionBindingError('binding_resource_denied', 'resource grant has no canonical overlap with allowed roots');
    }
    if (context.expectedEffect !== undefined && binding.target_descriptor.expected_effect !== context.expectedEffect)
        throw new ExecutionBindingError('binding_target_invalid', 'expected_effect does not match execution task');
    if (context.baseRevision !== undefined && binding.target_descriptor.base_revision !== context.baseRevision)
        throw new ExecutionBindingError('binding_target_invalid', 'base_revision does not match repository HEAD');
    if (context.currentRevision !== undefined) {
        const currentRevision = typeof context.currentRevision === 'string' || context.currentRevision === null
            ? context.currentRevision
            : await context.currentRevision;
        if (binding.target_descriptor.base_revision !== currentRevision)
            throw new ExecutionBindingError('binding_target_invalid', 'base_revision does not match current repository revision');
    }
    if (context.maxRuntimeMs !== undefined && binding.resource_grant.max_runtime_ms > context.maxRuntimeMs)
        throw new ExecutionBindingError('binding_resource_denied', 'runtime grant exceeds local safety limit');
    if (context.maxFiles !== undefined && binding.resource_grant.max_files > context.maxFiles)
        throw new ExecutionBindingError('binding_resource_denied', 'file grant exceeds local safety limit');
    if (context.maxLines !== undefined && binding.resource_grant.max_lines > context.maxLines)
        throw new ExecutionBindingError('binding_resource_denied', 'line grant exceeds local safety limit');
    if (context.requiredConsentScope !== undefined && !binding.consent_grant.scopes.includes(context.requiredConsentScope))
        throw new ExecutionBindingError('binding_consent_denied', 'required consent scope is absent');
    if (binding.resource_grant.validation_commands.some((command) => !isValidationCommandAllowed(command)))
        throw new ExecutionBindingError('binding_acceptance_invalid', 'validation command is not allowed by the sandbox contract');
    const authority = context.authoritative;
    if (!authority)
        throw new ExecutionBindingError('binding_stale', 'authoritative claim, acceptance, budget, and consent checks are required');
    if (!(await authority.claimLease(binding)))
        throw new ExecutionBindingError('binding_stale', 'claim or lease is no longer authoritative');
    if (!(await authority.acceptanceSpec(binding)))
        throw new ExecutionBindingError('binding_acceptance_invalid', 'acceptance specification is not authoritative');
    if (!(await authority.budget(binding)))
        throw new ExecutionBindingError('binding_budget_exceeded', 'budget grant is not authoritative');
    if (!(await authority.consent(binding)))
        throw new ExecutionBindingError('binding_consent_denied', 'consent grant is not authoritative');
    const completedAt = typeof context.now === 'function' ? context.now() : context.now ?? Date.now();
    if (completedAt >= deadline)
        throw new ExecutionBindingError('binding_deadline_exceeded', 'execution deadline expired during authority checks');
    if (completedAt >= leaseExpiry)
        throw new ExecutionBindingError('binding_stale', 'execution lease expired during authority checks');
    if (completedAt >= consentExpiry)
        throw new ExecutionBindingError('binding_consent_denied', 'consent expired during authority checks');
    const remainingAfterAuthority = Math.min(deadline, leaseExpiry, consentExpiry) - completedAt;
    if (binding.resource_grant.max_runtime_ms > remainingAfterAuthority)
        throw new ExecutionBindingError('binding_deadline_exceeded', 'max_runtime_ms no longer fits remaining binding lifetime');
    return { binding, binding_digest: binding.binding_digest, remaining_deadline_ms: remainingAfterAuthority, effective_allowed_roots: effectiveRoots };
}
function normalizeTerminalRecord(input) {
    const provenance = input.provenance.validator && input.provenance.validator.plan_digest !== undefined
        ? { ...input.provenance.validator, plan_digest: input.provenance.validator.plan_digest }
        : input.provenance.validator;
    return {
        ...input,
        binding_digest: input.binding_digest,
        provenance: { ...input.provenance, validator: provenance },
    };
}
function eventPayload(event) {
    return event.payload && typeof event.payload === 'object' ? event.payload : null;
}
export class ExecutionBindingJournal {
    ingestor;
    lockPath;
    constructor(ingestor) {
        this.ingestor = ingestor;
        this.lockPath = `${ingestor.path}.execution-binding.lock`;
    }
    async withLock(fn) {
        acquireLock(this.lockPath);
        try {
            return await fn();
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    async appendCreated(binding) {
        const canonical_binding = canonicalExecutionBinding(binding);
        const payload = { task_id: binding.task_id, binding_digest: binding.binding_digest, canonical_binding };
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_INLINE_BINDING_BYTES) {
            throw new ExecutionBindingError('binding_malformed', 'created binding event exceeds durable root-event capacity');
        }
        await this.ingestor.ingest({
            type: 'execution.binding.created',
            human: { title: `execution binding ${binding.task_id} created` },
            payload,
        });
    }
    async claim(binding) {
        return this.withLock(async () => {
            let recovery = this.recover(binding.task_id, binding.binding_digest);
            if (recovery.kind === 'new') {
                await this.appendCreated(binding);
                recovery = { kind: 'created', task_id: binding.task_id, binding_digest: binding.binding_digest };
            }
            if (recovery.kind === 'created') {
                await this.ingestor.ingest({
                    type: 'execution.started',
                    human: { title: `execution ${binding.correlation.run_id} started` },
                    payload: { task_id: binding.task_id, run_id: binding.correlation.run_id, binding_digest: binding.binding_digest },
                });
                return { kind: 'claimed', task_id: binding.task_id, binding_digest: binding.binding_digest };
            }
            return recovery;
        });
    }
    async recordCreated(binding) {
        await this.withLock(async () => {
            const recovery = this.recover(binding.task_id, binding.binding_digest);
            if (recovery.kind === 'new')
                await this.appendCreated(binding);
            else if (recovery.kind !== 'created')
                throw new ExecutionBindingError('binding_replay_duplicate', `cannot create binding from ${recovery.kind}`);
        });
    }
    async recordStarted(binding) {
        await this.withLock(async () => {
            const recovery = this.recover(binding.task_id, binding.binding_digest);
            if (recovery.kind !== 'created') {
                throw new ExecutionBindingError('binding_replay_unsafe', `cannot start binding from ${recovery.kind}`, true);
            }
            await this.ingestor.ingest({
                type: 'execution.started',
                human: { title: `execution ${binding.correlation.run_id} started` },
                payload: { task_id: binding.task_id, run_id: binding.correlation.run_id, binding_digest: binding.binding_digest },
            });
        });
    }
    async recordDecision(first, second, third) {
        const legacyDecision = third === undefined && typeof second === 'object' ? second : undefined;
        const taskId = third === undefined
            ? (typeof legacyDecision?.['task_id'] === 'string' ? legacyDecision['task_id'] : undefined)
            : first;
        const bindingDigest = (third === undefined ? first : second);
        const decision = third ?? legacyDecision;
        if (!taskId)
            throw new ExecutionBindingError('binding_malformed', 'execution decision requires task_id');
        await this.ingestor.ingest({
            type: 'execution.decision',
            human: { title: `execution decision ${bindingDigest.slice(0, 20)}` },
            payload: { task_id: taskId, binding_digest: bindingDigest, decision },
        });
    }
    async recordTerminal(record) {
        const parsed = terminalRecordSchema.safeParse(record);
        if (!parsed.success)
            throw new ExecutionBindingError('binding_provenance_unavailable', parsed.error.message);
        const normalized = normalizeTerminalRecord(parsed.data);
        if (normalized.disposition !== normalized.provenance.terminal_disposition) {
            throw new ExecutionBindingError('binding_provenance_unavailable', 'terminal disposition disagrees with provenance', true);
        }
        await this.withLock(async () => {
            const recovery = this.recover(normalized.task_id, normalized.binding_digest);
            if (recovery.kind === 'terminal') {
                if (canonicalize(recovery.terminal) === canonicalize(normalized))
                    return;
                throw new ExecutionBindingError('binding_replay_duplicate', 'conflicting terminal record already exists', true);
            }
            // An incomplete started marker is the only unsafe state that can be
            // repaired by appending a terminal. Other unsafe states (invalid
            // provenance, conflicting terminals, activity without a created
            // binding, or a started event after a terminal) must remain immutable;
            // appending another terminal would hide the evidence and make recovery
            // non-convergent.
            const recoverableUnsafe = recovery.kind === 'unsafe_to_replay'
                && recovery.reason === 'execution started without terminal record';
            if ((!recoverableUnsafe && recovery.kind !== 'created' && recovery.kind !== 'claimed')) {
                throw new ExecutionBindingError('binding_replay_unsafe', `cannot record terminal from ${recovery.kind}`, true);
            }
            const payload = normalized;
            if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_INLINE_BINDING_BYTES) {
                throw new ExecutionBindingError('binding_provenance_unavailable', 'terminal event exceeds durable root-event capacity', true);
            }
            await this.ingestor.ingest({
                type: 'execution.terminal',
                human: { title: `execution ${record.disposition}` },
                payload,
            });
        });
    }
    async recordRecovered(taskId, bindingDigest, disposition) {
        await this.ingestor.ingest({
            type: 'execution.recovered',
            human: { title: `execution recovery ${disposition}` },
            payload: { task_id: taskId, binding_digest: bindingDigest, disposition },
        });
    }
    recover(taskId, bindingDigest) {
        const events = this.ingestor.readAllStrict();
        const created = events.filter((event) => event.type === 'execution.binding.created')
            .map((event) => eventPayload(event))
            .filter((payload) => payload?.['task_id'] === taskId);
        const existingActivity = events.some((event) => {
            const payload = eventPayload(event);
            return (event.type === 'execution.started' || event.type === 'execution.terminal' || event.type === 'execution.decision')
                && payload?.['task_id'] === taskId;
        });
        if (created.length === 0) {
            return existingActivity
                ? { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: bindingDigest ?? 'sha256:' + '0'.repeat(64), reason: 'execution activity exists without binding.created' }
                : { kind: 'new', task_id: taskId, binding_digest: bindingDigest ?? 'sha256:' + '0'.repeat(64) };
        }
        const digests = new Set(created.map((payload) => typeof payload['binding_digest'] === 'string' ? payload['binding_digest'] : ''));
        if (bindingDigest && [...digests].some((digestValue) => digestValue && digestValue !== bindingDigest)) {
            return { kind: 'mismatched', task_id: taskId, binding_digest: bindingDigest, reason: 'another binding digest already exists for task' };
        }
        if (!bindingDigest && digests.size !== 1)
            return { kind: 'mismatched', task_id: taskId, binding_digest: 'sha256:' + '0'.repeat(64), reason: 'multiple binding digests exist for task' };
        const chosen = bindingDigest && digests.has(bindingDigest) ? bindingDigest : [...digests][0];
        if (!chosen || !DIGEST_PATTERN.test(chosen))
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: bindingDigest ?? 'sha256:' + '0'.repeat(64), reason: 'created event has invalid binding digest' };
        const createdRecord = created.find((payload) => payload['binding_digest'] === chosen);
        const canonicalBinding = createdRecord?.['canonical_binding'];
        if (typeof canonicalBinding !== 'string' || sha256(canonicalBinding) !== chosen) {
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'created binding digest does not match canonical binding' };
        }
        let createdBinding;
        try {
            createdBinding = freezeExecutionBinding(JSON.parse(canonicalBinding));
        }
        catch {
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'created canonical binding is invalid' };
        }
        if (createdBinding.binding_digest !== chosen)
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'created canonical binding is inconsistent' };
        const activity = events.filter((event) => {
            const payload = eventPayload(event);
            return (event.type === 'execution.started' || event.type === 'execution.terminal')
                && payload?.['task_id'] === taskId && payload?.['binding_digest'] === chosen;
        });
        const startedEvents = activity.filter((event) => event.type === 'execution.started');
        const started = startedEvents.length > 0;
        const terminalEvents = activity.filter((event) => event.type === 'execution.terminal');
        if (startedEvents.some((event) => {
            const payload = eventPayload(event);
            return payload?.['run_id'] !== undefined && payload?.['run_id'] !== createdBinding.correlation.run_id;
        }))
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'started event run_id disagrees with binding' };
        if (terminalEvents.length > 0) {
            const parsed = terminalEvents.map((event) => terminalRecordSchema.safeParse(eventPayload(event) ?? {}));
            if (parsed.some((result) => !result.success))
                return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'terminal provenance is invalid' };
            const terminals = parsed.map((result) => normalizeTerminalRecord(result.data));
            if (terminals.some((terminal) => terminal.run_id !== createdBinding.correlation.run_id
                || terminal.disposition !== terminal.provenance.terminal_disposition)) {
                return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'terminal record disagrees with binding or provenance' };
            }
            const canonicalTerminal = canonicalize(terminals[0]);
            if (terminals.some((terminal) => canonicalize(terminal) !== canonicalTerminal)) {
                return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'conflicting terminal records exist' };
            }
            const terminalSeq = terminalEvents[0].seq;
            if (startedEvents.some((event) => event.seq > terminalSeq)) {
                return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'execution started after terminal record' };
            }
            return { kind: 'terminal', task_id: taskId, binding_digest: chosen, terminal: terminals[0] };
        }
        if (started)
            return { kind: 'unsafe_to_replay', task_id: taskId, binding_digest: chosen, reason: 'execution started without terminal record' };
        return { kind: 'created', task_id: taskId, binding_digest: chosen };
    }
}
export function parseExecutionTerminalRecord(input) {
    const parsed = terminalRecordSchema.safeParse(input);
    if (!parsed.success)
        throw new ExecutionBindingError('binding_provenance_unavailable', parsed.error.message, true);
    return freezeDeep(normalizeTerminalRecord(parsed.data));
}