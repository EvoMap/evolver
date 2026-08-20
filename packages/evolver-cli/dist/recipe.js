import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assetstore, events, mailbox, verify } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError, connectPublicHub, isHubDryRunEnabled, isNodeSecret, parseNodeSecretVersion, resolveHubUrl } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { resolveExplicitNodeCredentials } from './identityHome.js';
import { getCliVersion } from './version.js';
import { parseSkillMd, reverseDistill, synthesizeGene } from './skill2gep.js';
import { recordSkillDistillation } from './skillDistill.js';
import { buildPublishBundle } from './cliContracts.js';
const MAX_RECIPE_STEPS = 20;
const MAX_RECIPE_VALIDATION_COMMANDS = 5;
const MAX_RECIPE_INPUT_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 200;
const SENSITIVE_ERROR_KEYS = new Set(['authorization', 'node_secret', 'nodesecret', 'token', 'access_token', 'refresh_token', 'secret']);
const STALE_NODE_SECRET_ERRORS = new Set(['node_secret_invalid', 'node_secret_not_set']);
function recipeIdempotencyKey(operation, value) {
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return `evolver-recipe-${operation}-${digest}`;
}
const recipeIdentityBootstraps = new WeakMap();
export async function runRecipeCommand(argv, deps = {}) {
    const parsed = parseRecipeArgs(argv);
    const err = deps.err ?? ((line) => { process.stderr.write(`${line}\n`); });
    const log = deps.log ?? ((line) => { process.stdout.write(`${line}\n`); });
    if (!parsed.ok) {
        err(`${parsed.error}\n${recipeUsage()}`);
        return 1;
    }
    try {
        const env = deps.env ?? process.env;
        loadEnvFileFromEnv(env);
        if (isHubDryRunEnabled(env)) {
            if (parsed.value.sub === 'build')
                return await runRecipeBuildDryRun(parsed.value, deps.store, { log, err });
            if (parsed.value.sub === 'from-skills')
                return await runRecipeFromSkills(parsed.value, undefined, deps, { log, err }, true);
            if (parsed.value.sub === 'search')
                return runRecipeSearchDryRun(parsed.value, { log });
            return runRecipeReuseDryRun(parsed.value, { log });
        }
        const hub = deps.hub ?? createRecipeHubFromEnv(env, deps.connectHub ?? connectPublicHub);
        await recipeIdentityBootstraps.get(hub)?.();
        if (!hub.recipes) {
            err('recipe capability is not available for the configured Hub adapter');
            return 1;
        }
        if (parsed.value.sub === 'build')
            return await runRecipeBuild(parsed.value, hub, deps.store, { log, err });
        if (parsed.value.sub === 'from-skills')
            return await runRecipeFromSkills(parsed.value, hub, deps, { log, err }, false);
        if (parsed.value.sub === 'search')
            return await runRecipeSearch(parsed.value, hub, { log, err });
        return await runRecipeReuse(parsed.value, hub, { log, err });
    }
    catch (e) {
        err(recipeErrorMessage(e));
        return 1;
    }
}
async function runRecipeBuildDryRun(opts, store, io) {
    const steps = await recipeStepsFromLocalAssets(opts.assetIds, store ?? new assetstore.LocalJsonlProvider(events.assetsDir()));
    if (steps.length === 0) {
        io.err('recipe build requires at least one asset id');
        return 1;
    }
    io.log(`[recipe build] dry-run: would create DRAFT recipe ("${opts.title}", ${steps.length} step${steps.length === 1 ? '' : 's'}).`);
    if (opts.publish) {
        io.log('[recipe build] dry-run: would publish the recipe after creation.');
    }
    else {
        io.log('[recipe build] dry-run: would leave the recipe as draft.');
    }
    return 0;
}
function runRecipeSearchDryRun(opts, io) {
    const action = opts.q ? 'search_recipe' : 'list_recipe';
    io.log(`[recipe search] dry-run: would ${opts.q ? `search recipes q=${JSON.stringify(opts.q)}` : 'list published recipes'}.`);
    if (opts.jsonOut) {
        io.log(JSON.stringify({
            dry_run: true,
            would: action,
            ...(opts.q ? { q: opts.q } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            recipes: [],
        }, null, 2));
    }
    return 0;
}
async function runRecipeSearch(opts, hub, io) {
    const recipes = hub.recipes;
    if (!recipes) {
        io.err('recipe capability is not available for the configured Hub adapter');
        return 1;
    }
    const request = {
        ...(opts.q ? { q: opts.q } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    const receipt = opts.q
        ? await callRecipeWithAuthRetry(hub, 'recipe search', () => recipes.search(request), io)
        : await callRecipeWithAuthRetry(hub, 'recipe search', () => recipes.list(request), io);
    io.log(`[recipe search] ${receipt.recipes.length} recipe(s).`);
    if (opts.jsonOut) {
        io.log(JSON.stringify(receipt.raw ?? receipt, null, 2));
        return 0;
    }
    for (const recipe of receipt.recipes) {
        const row = recipe && typeof recipe === 'object' && !Array.isArray(recipe) ? recipe : {};
        const id = typeof row['id'] === 'string' ? row['id']
            : typeof row['recipe_id'] === 'string' ? row['recipe_id']
                : typeof row['recipeId'] === 'string' ? row['recipeId']
                    : undefined;
        const title = typeof row['title'] === 'string' ? row['title'] : undefined;
        io.log(id && title ? `  ${id}  ${title}` : id ? `  ${id}` : `  ${JSON.stringify(recipe)}`);
    }
    return 0;
}
function runRecipeReuseDryRun(opts, io) {
    io.log(`[recipe reuse] dry-run: would fetch recipe ${opts.recipeId}.`);
    io.log(`[recipe reuse] dry-run: would express recipe ${opts.recipeId}.`);
    if (opts.jsonOut) {
        io.log(JSON.stringify({
            dry_run: true,
            would: 'express_recipe',
            recipe_id: opts.recipeId,
            input_payload: opts.inputPayload,
        }, null, 2));
    }
    return 0;
}
export function createRecipeHubFromEnv(env = process.env, connectHub = connectPublicHub) {
    loadEnvFileFromEnv(env);
    const hubUrl = resolveRecipeHubUrl(env);
    const credentials = resolveRecipeHubCredentials(env);
    if (!credentials.nodeSecret && !existsSync(join(credentials.evomapDir, 'token.json'))) {
        throw new Error(`recipe requires Hub credentials: run "evolver login" or set EVOMAP_NODE_SECRET`);
    }
    if (!credentials.nodeSecret && !credentials.senderId) {
        throw new Error('recipe OAuth mode requires a node identity: register a node first, set EVOMAP_NODE_ID or A2A_NODE_ID, or ensure the Evolver proxy store contains node_id');
    }
    let senderId = credentials.senderId;
    const connected = credentials.nodeSecret
        ? connectHub({
            hubUrl,
            authMode: 'legacy',
            evomapDir: credentials.evomapDir,
            nodeSecret: credentials.nodeSecret,
            ...(credentials.nodeSecretVersion !== undefined ? { nodeSecretVersion: credentials.nodeSecretVersion } : {}),
            senderId: () => senderId,
            onNodeSecretRotated: (secret, version) => persistRotatedNodeSecret(secret, version, senderId, env, credentials.rotatePersistDir),
            onNodeSecretVersionUpdated: (version) => persistNodeSecretVersion(version, env, credentials.rotatePersistDir),
        })
        : connectHub({ hubUrl, authMode: 'oauth', evomapDir: credentials.evomapDir, senderId: () => senderId });
    if (credentials.nodeSecret && !senderId) {
        recipeIdentityBootstraps.set(connected.hub, async () => {
            const hello = await connected.hub.hello({
                rotate: false,
                evolverVersion: getCliVersion(),
                preserveCredentials: true,
            });
            if (!hello.ok || !hello.nodeId) {
                throw new Error(`recipe could not establish Hub node identity: ${hello.error ?? 'node_id_missing'}`);
            }
            senderId = hello.nodeId;
            persistRecipeNodeId(senderId, env, credentials.rotatePersistDir);
            recipeIdentityBootstraps.delete(connected.hub);
        });
    }
    return connected.hub;
}
/** Opaque identity for resume isolation; raw credentials, account ids, and local paths never leave this helper. */
export function resolveRecipeHubResumeIdentityFingerprint(env) {
    loadEnvFileFromEnv(env);
    const credentials = resolveRecipeHubCredentials(env);
    let credential;
    if (credentials.nodeSecret) {
        credential = credentials.nodeSecret;
    }
    else {
        try {
            credential = createHash('sha256')
                .update(readFileSync(join(credentials.evomapDir, 'token.json'), 'utf8'))
                .digest('hex');
        }
        catch {
            throw new Error('Hub resume identity credentials are unavailable');
        }
    }
    return createHash('sha256').update(JSON.stringify({
        authMode: credentials.nodeSecret ? 'legacy' : 'oauth',
        senderId: credentials.senderId ?? '',
        credential,
    })).digest('hex');
}
function resolveRecipeHubUrl(env) {
    return resolveHubUrl(env);
}
export function parseRecipeArgs(argv) {
    const sub = argv[0];
    if (sub !== 'build' && sub !== 'reuse' && sub !== 'from-skills' && sub !== 'search') {
        return { ok: false, error: 'recipe subcommand must be build|reuse|from-skills|search' };
    }
    const args = argv.slice(1);
    if (sub === 'build')
        return parseBuildArgs(args);
    if (sub === 'from-skills')
        return parseFromSkillsArgs(args);
    if (sub === 'search')
        return parseSearchArgs(args);
    return parseReuseArgs(args);
}
async function runRecipeBuild(opts, hub, store, io) {
    const steps = await recipeStepsFromLocalAssets(opts.assetIds, store ?? new assetstore.LocalJsonlProvider(events.assetsDir()));
    if (steps.length === 0) {
        io.err('recipe build requires at least one asset id');
        return 1;
    }
    const createRequest = {
        title: opts.title,
        steps,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.pricePerExecution !== undefined ? { pricePerExecution: opts.pricePerExecution } : {}),
    };
    createRequest.idempotencyKey = recipeIdempotencyKey('create', createRequest);
    const createReceipt = await callRecipeWithAuthRetry(hub, 'recipe build', () => hub.recipes.create(createRequest), io);
    const recipeId = createReceipt.recipeId;
    if (createReceipt.status !== 'draft') {
        io.err(`[recipe build] Hub returned unexpected create status: ${createReceipt.status ?? 'unknown'}.`);
        return 1;
    }
    io.log(`[recipe build] Created DRAFT recipe ${recipeId ?? '(id pending)'} ("${opts.title}", ${steps.length} step${steps.length === 1 ? '' : 's'}).`);
    if (opts.publish) {
        if (!recipeId) {
            io.err('[recipe build] Hub did not return a recipe id; cannot publish.');
            return 1;
        }
        const publishReceipt = await callRecipeWithAuthRetry(hub, 'recipe build', () => hub.recipes.publish(recipeId, {
            idempotencyKey: recipeIdempotencyKey('publish', recipeId),
        }), io);
        if (publishReceipt.status !== 'published') {
            io.err(`[recipe build] Hub returned unexpected publish status: ${publishReceipt.status ?? 'unknown'}.`);
            return 1;
        }
        io.log(`[recipe build] Published recipe ${recipeId}.`);
    }
    else {
        io.log('[recipe build] Left as draft. Re-run with --publish to make it live.');
    }
    return 0;
}
async function runRecipeFromSkills(opts, hub, deps, io, dryRun) {
    const loaded = loadRecipeFromSkillsManifest(opts.manifestPath);
    if (!loaded.ok) {
        io.err(loaded.error);
        return 1;
    }
    const verified = await verifyRecipeFromSkillsSteps(loaded.value.steps, deps.runValidation ?? verify.runSandboxedValidation);
    if (!verified.ok) {
        io.err(verified.error);
        return 1;
    }
    const preflight = preflightRecipeFromSkillsSteps(verified.value);
    if (!preflight.ok) {
        io.err(preflight.error);
        return 1;
    }
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    const steps = [];
    const distilled = [];
    for (const prepared of preflight.value) {
        const existing = await findReusableRecipeStep(store, prepared);
        if (existing) {
            addRecipeFromSkillsStep(steps, distilled, existing);
            continue;
        }
        const step = prepared.step;
        const res = await recordSkillDistillation(step.skill, step.execution, {
            store,
            ...(deps.review ? { review: deps.review } : {}),
            ingestor,
        }, {
            evidenceMode: 'validation_only',
            geneIdentity: 'semantic',
            completeValidationPlan: true,
            ...(step.scenario ? { scenario: step.scenario } : {}),
        });
        if (!res.geneId || !res.geneAssetId) {
            const recovered = await findReusableRecipeStep(store, prepared);
            if (recovered) {
                addRecipeFromSkillsStep(steps, distilled, recovered);
                continue;
            }
            io.err(`recipe from-skills step ${prepared.position + 1} did not produce a Gene: ${res.errors.join('; ') || 'refused'}`);
            return 1;
        }
        if (!res.capsuleId) {
            io.err(`recipe from-skills step ${prepared.position + 1} missing Capsule evidence: ${res.capsuleDiagnostic ?? 'missing_capsule_evidence'}`);
            return 1;
        }
        if (!(await hasCapsuleEvidence(store, res.capsuleId, res.geneId))) {
            io.err(`recipe from-skills step ${prepared.position + 1} missing persisted Capsule evidence`);
            return 1;
        }
        addRecipeFromSkillsStep(steps, distilled, {
            position: prepared.position,
            geneId: res.geneId,
            geneAssetId: res.geneAssetId,
            capsuleId: res.capsuleId,
        });
    }
    const publishPrepared = await prepareRecipeFromSkillsAssets(distilled, store, dryRun ? undefined : hub, deps.env ?? process.env, io);
    if (!publishPrepared.ok) {
        io.err(publishPrepared.error);
        return 1;
    }
    steps.splice(0, steps.length, ...publishPrepared.value.steps);
    distilled.splice(0, distilled.length, ...publishPrepared.value.distilled);
    if (dryRun) {
        const payload = recipeFromSkillsPayload({
            mode: 'dry_run',
            title: loaded.value.title,
            publish: opts.publish,
            steps: distilled,
        });
        if (opts.jsonOut)
            io.log(JSON.stringify(payload, null, 2));
        else {
            io.log(`[recipe from-skills] dry-run: would create DRAFT recipe ("${loaded.value.title}", ${steps.length} step${steps.length === 1 ? '' : 's'}).`);
            if (opts.publish)
                io.log('[recipe from-skills] dry-run: would publish the recipe after creation.');
            else
                io.log('[recipe from-skills] dry-run: would leave the recipe as draft.');
        }
        return 0;
    }
    if (!hub?.recipes) {
        io.err('recipe capability is not available for the configured Hub adapter');
        return 1;
    }
    const createRequest = {
        title: loaded.value.title,
        steps,
        ...(loaded.value.description ? { description: loaded.value.description } : {}),
        ...(loaded.value.pricePerExecution !== undefined ? { pricePerExecution: loaded.value.pricePerExecution } : {}),
    };
    createRequest.idempotencyKey = recipeIdempotencyKey('create', createRequest);
    const createReceipt = await callRecipeWithAuthRetry(hub, 'recipe from-skills', () => hub.recipes.create(createRequest), io);
    const recipeId = createReceipt.recipeId;
    if (createReceipt.status !== 'draft') {
        if (opts.jsonOut) {
            io.log(JSON.stringify(recipeFromSkillsPayload({
                ok: false,
                mode: 'failed',
                title: loaded.value.title,
                publish: opts.publish,
                steps: distilled,
                recipeId,
                error: 'create_failed',
            }), null, 2));
        }
        else {
            io.err(`[recipe from-skills] Hub did not confirm draft creation for recipe ${recipeId ?? '(id missing)'} (status: ${createReceipt.status ?? 'missing'}).`);
        }
        return 1;
    }
    if (!opts.jsonOut) {
        io.log(`[recipe from-skills] Created DRAFT recipe ${recipeId ?? '(id pending)'} ("${loaded.value.title}", ${steps.length} step${steps.length === 1 ? '' : 's'}).`);
    }
    if (opts.publish) {
        if (!recipeId) {
            io.err('[recipe from-skills] Hub did not return a recipe id; cannot publish.');
            return 1;
        }
        try {
            const publishReceipt = await callRecipeWithAuthRetry(hub, 'recipe from-skills', () => hub.recipes.publish(recipeId, {
                idempotencyKey: recipeIdempotencyKey('publish', recipeId),
            }), io);
            if (publishReceipt.status !== 'published') {
                if (opts.jsonOut) {
                    io.log(JSON.stringify(recipeFromSkillsPayload({
                        ok: false,
                        mode: 'draft',
                        title: loaded.value.title,
                        publish: opts.publish,
                        steps: distilled,
                        recipeId,
                        error: 'publish_failed',
                    }), null, 2));
                }
                else {
                    io.err(`[recipe from-skills] Created DRAFT recipe ${recipeId}; Hub did not confirm publish (status: ${publishReceipt.status ?? 'missing'}).`);
                }
                return 1;
            }
        }
        catch (e) {
            if (opts.jsonOut) {
                io.log(JSON.stringify(recipeFromSkillsPayload({
                    ok: false,
                    mode: 'draft',
                    title: loaded.value.title,
                    publish: opts.publish,
                    steps: distilled,
                    recipeId,
                    error: 'publish_failed',
                }), null, 2));
            }
            else {
                io.err(`[recipe from-skills] Created DRAFT recipe ${recipeId}; publish failed before it was made live.`);
            }
            throw e;
        }
    }
    const payload = recipeFromSkillsPayload({
        mode: opts.publish ? 'published' : 'draft',
        title: loaded.value.title,
        publish: opts.publish,
        steps: distilled,
        recipeId,
    });
    if (opts.jsonOut)
        io.log(JSON.stringify(payload, null, 2));
    else {
        if (opts.publish)
            io.log(`[recipe from-skills] Published recipe ${recipeId}.`);
        else
            io.log('[recipe from-skills] Left as draft. Re-run with --publish to make it live.');
    }
    return 0;
}
async function runRecipeReuse(opts, hub, io) {
    await callRecipeWithAuthRetry(hub, 'recipe reuse', () => hub.recipes.get(opts.recipeId), io);
    const receipt = await callRecipeWithAuthRetry(hub, 'recipe reuse', () => hub.recipes.express(opts.recipeId, { inputPayload: opts.inputPayload }), io);
    io.log(`[recipe reuse] Expressed recipe ${opts.recipeId}.`);
    if (opts.jsonOut)
        io.log(JSON.stringify(receipt.raw, null, 2));
    return 0;
}
async function recipeStepsFromLocalAssets(assetIds, store) {
    const byId = new Map();
    for (const kind of ['Gene', 'Capsule']) {
        for (const asset of await store.list(kind, 10_000)) {
            if (asset.asset_id)
                byId.set(asset.asset_id, kind);
        }
    }
    return assetIds.map((assetId, index) => {
        const assetType = byId.get(assetId) ?? 'Gene';
        return { assetId, assetType, position: index };
    });
}
async function verifyRecipeFromSkillsSteps(steps, runValidation) {
    const verified = [];
    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        const parsed = parseSkillMd(step.skill, { completeValidationPlan: true });
        if (parsed.validation.length > MAX_RECIPE_VALIDATION_COMMANDS) {
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} supports at most ${MAX_RECIPE_VALIDATION_COMMANDS} validation commands`,
            };
        }
        const synthesized = synthesizeGene(parsed, step.execution, { strict: true });
        if (!synthesized.gene) {
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} did not produce a Gene: ${synthesized.errors.join('; ') || 'refused'}`,
            };
        }
        if (!recipeValidationPlanIsComplete(parsed.validation, synthesized.gene.validation)) {
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} contains unsupported validation commands; every declared command must be allowed`,
            };
        }
        const startedAt = new Date().toISOString();
        let validation;
        try {
            validation = await runValidation(synthesized.gene.validation ?? [], step.validationCwd, {
                requireIsolation: true,
                readOnlyRoot: step.validationRoot,
            });
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${i + 1} validation execution failed` };
        }
        if (!validation.isolated) {
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} requires Linux namespace isolation and cgroup v2 resource limits`,
            };
        }
        if (validation.skipped.length > 0) {
            const skipped = validation.skipped.map((item) => item.script).join(', ');
            return { ok: false, error: `recipe from-skills step ${i + 1} validation incomplete: missing ${skipped}` };
        }
        if (!validation.passed) {
            return { ok: false, error: `recipe from-skills step ${i + 1} validation failed` };
        }
        const execution = {
            ...(Array.isArray(step.execution.signals)
                ? { signals: step.execution.signals.map((value) => String(value)).filter(Boolean) }
                : {}),
            ...(Array.isArray(step.execution.trigger)
                ? { trigger: step.execution.trigger.map((value) => String(value)).filter(Boolean) }
                : {}),
            ...(typeof step.execution.summary === 'string' && step.execution.summary.trim()
                ? { summary: step.execution.summary.trim() }
                : {}),
            status: 'success',
            score: validation.score,
            started_at: startedAt,
            blast_radius: { files: 0, lines: 0 },
            reference_distilled: true,
            success_reason: 'All declared validation commands passed in the local verifier.',
            trace: validation.results.map((result, index) => ({
                step: index + 1,
                cmd: result.cmd,
                exit: result.exitCode ?? undefined,
                stdout_tail: '',
            })),
        };
        verified.push({ ...step, execution });
    }
    return { ok: true, value: verified };
}
function recipeValidationPlanIsComplete(declared, runnable) {
    const declaredCommands = normalizedStringList(declared);
    const runnableCommands = normalizedStringList(runnable);
    return declaredCommands.length === runnableCommands.length &&
        declaredCommands.every((command, index) => command === runnableCommands[index]);
}
function preflightRecipeFromSkillsSteps(steps) {
    const prepared = [];
    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        const parsed = parseSkillMd(step.skill, { completeValidationPlan: true });
        const preview = reverseDistill(parsed, step.execution, {
            evidenceMode: 'validation_only',
            ...(step.scenario ? { scenario: step.scenario } : {}),
        });
        if (!preview.gene) {
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} did not produce a Gene: ${preview.errors.join('; ') || 'refused'}`,
            };
        }
        if (!preview.capsule) {
            const diag = preview.capsuleDiagnostic
                ? (preview.capsuleDiagnostic.detail ?? preview.capsuleDiagnostic.reason)
                : 'missing_capsule_evidence';
            return {
                ok: false,
                error: `recipe from-skills step ${i + 1} missing Capsule evidence: ${diag}`,
            };
        }
        prepared.push({
            position: i,
            step,
            candidateSignals: normalizedSignalList(preview.gene.signals_match),
            candidateValidations: Array.isArray(preview.gene.validation) ? [...preview.gene.validation] : [],
            candidateDefinition: reusableGeneDefinition(preview.gene),
        });
    }
    return { ok: true, value: prepared };
}
async function prepareRecipeFromSkillsAssets(distilled, store, hub, env, io) {
    const steps = [];
    const prepared = [];
    const publishedByBundle = new Map();
    for (const step of distilled) {
        const bundle = await buildPublishBundle([step.geneAssetId, step.capsuleId], { assetStore: store, env });
        if (!bundle.ok) {
            return { ok: false, error: `recipe from-skills step ${step.position + 1} asset bundle rejected: ${bundle.reason}` };
        }
        if (bundle.blockReasons.length > 0) {
            return { ok: false, error: `recipe from-skills step ${step.position + 1} asset bundle rejected: ${bundle.blockReasons.join(',')}` };
        }
        const gene = bundle.sanitized.find((asset) => asset.type === 'Gene');
        const capsule = bundle.sanitized.find((asset) => asset.type === 'Capsule');
        if (!gene?.asset_id || !capsule?.asset_id) {
            return { ok: false, error: `recipe from-skills step ${step.position + 1} asset bundle is missing Gene or Capsule` };
        }
        const bundleKey = `${gene.asset_id}\n${capsule.asset_id}`;
        let geneAssetId = publishedByBundle.get(bundleKey);
        if (!geneAssetId && hub) {
            const receipt = await callRecipeWithAuthRetry(hub, 'recipe from-skills asset publish', () => hub.publish(bundle.sanitized), io);
            if (!assetPublishSucceeded(receipt, bundle.sanitized)) {
                const duplicateIsIncomplete = receipt.status === 'rejected' &&
                    (receipt.reason === 'already_published' || receipt.reason === 'duplicate');
                return {
                    ok: false,
                    error: duplicateIsIncomplete
                        ? `recipe from-skills step ${step.position + 1} duplicate asset publish did not identify the published Gene and Capsule bundle`
                        : `recipe from-skills step ${step.position + 1} asset publish rejected: ${receipt.reason ?? receipt.status}`,
                };
            }
            geneAssetId = publishedGeneAssetId(receipt, gene.asset_id);
            if (!geneAssetId) {
                return {
                    ok: false,
                    error: `recipe from-skills step ${step.position + 1} duplicate asset publish did not identify the published Gene`,
                };
            }
            publishedByBundle.set(bundleKey, geneAssetId);
        }
        geneAssetId ??= gene.asset_id;
        steps.push({ assetId: geneAssetId, assetType: 'Gene', position: step.position });
        prepared.push({ ...step, geneAssetId });
    }
    return { ok: true, value: { steps, distilled: prepared } };
}
function assetPublishSucceeded(receipt, submitted) {
    if (receipt.status === 'accepted')
        return true;
    if (receipt.status !== 'rejected' ||
        (receipt.reason !== 'already_published' && receipt.reason !== 'duplicate'))
        return false;
    const published = new Set(receipt.assetIds ?? []);
    return submitted.every((asset) => typeof asset.asset_id === 'string' && published.has(asset.asset_id));
}
function publishedGeneAssetId(receipt, localAssetId) {
    if (receipt.status === 'accepted')
        return localAssetId;
    if (receipt.assetId === localAssetId || receipt.assetIds?.includes(localAssetId))
        return localAssetId;
    return undefined;
}
async function findReusableRecipeStep(store, prepared) {
    const candidateSignals = prepared.candidateSignals;
    if (candidateSignals.length === 0)
        return null;
    const genes = await store.list('Gene', 10_000);
    const capsules = await store.list('Capsule', 10_000);
    for (const gene of genes) {
        const signals = normalizedSignalList(gene['signals_match']);
        if (signals.length !== candidateSignals.length ||
            !candidateSignals.every((signal, index) => signal === signals[index]))
            continue;
        if (reusableGeneDefinition(gene) !== prepared.candidateDefinition)
            continue;
        const geneId = typeof gene['id'] === 'string' && gene['id'].trim()
            ? gene['id'].trim()
            : String(gene['asset_id'] ?? '');
        const geneAssetId = typeof gene['asset_id'] === 'string' ? gene['asset_id'] : '';
        if (!geneId || !geneAssetId)
            continue;
        const capsule = capsules.find((record) => String(record['gene']) === geneId &&
            capsuleProvesValidations(record, prepared.candidateValidations));
        if (!capsule)
            continue;
        return {
            position: prepared.position,
            geneId,
            geneAssetId,
            capsuleId: String(capsule['id']),
        };
    }
    return null;
}
function capsuleProvesValidations(capsule, validations) {
    if (capsule['source_type'] !== 'skill2gep_validation')
        return false;
    const outcome = isPlainRecord(capsule['outcome']) ? capsule['outcome'] : null;
    if (outcome?.['status'] !== 'success')
        return false;
    const trace = Array.isArray(capsule['execution_trace']) ? capsule['execution_trace'] : [];
    return validations.every((validation) => trace.some((entry) => {
        if (!isPlainRecord(entry))
            return false;
        return normalizeValidationCommand(entry['cmd']) === normalizeValidationCommand(validation) && entry['exit'] === 0;
    }));
}
function normalizeValidationCommand(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function reusableGeneDefinition(gene) {
    const constraints = isPlainRecord(gene['constraints']) ? gene['constraints'] : {};
    return JSON.stringify({
        category: String(gene['category'] ?? ''),
        strategy: normalizedStringList(gene['strategy']),
        summary: String(gene['summary'] ?? ''),
        preconditions: normalizedStringList(gene['preconditions']),
        constraints: {
            maxFiles: Number(constraints['max_files'] ?? 0),
            forbiddenPaths: normalizedStringList(constraints['forbidden_paths']),
        },
        validation: normalizedStringList(gene['validation']).map(normalizeValidationCommand),
    });
}
function normalizedStringList(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : [];
}
function addRecipeFromSkillsStep(steps, distilled, result) {
    steps.push({ assetId: result.geneAssetId, assetType: 'Gene', position: result.position });
    distilled.push(result);
}
async function hasCapsuleEvidence(store, capsuleId, geneId) {
    const capsules = await store.list('Capsule', 10_000);
    return capsules.some((capsule) => String(capsule['id']) === capsuleId &&
        String(capsule['gene']) === geneId);
}
function normalizedSignalList(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean).sort()
        : [];
}
function loadRecipeFromSkillsManifest(path) {
    let raw;
    const manifestPath = resolve(path);
    try {
        raw = readRecipeInputFile(manifestPath);
    }
    catch {
        return { ok: false, error: 'recipe from-skills cannot read --manifest file' };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, error: 'recipe from-skills --manifest must be valid JSON' };
    }
    if (!isPlainRecord(parsed))
        return { ok: false, error: 'recipe from-skills --manifest must be a JSON object' };
    const title = typeof parsed['title'] === 'string' ? parsed['title'].trim() : '';
    if (!title)
        return { ok: false, error: 'recipe from-skills manifest requires title' };
    const rawSteps = parsed['steps'];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0)
        return { ok: false, error: 'recipe from-skills manifest requires non-empty steps[]' };
    if (rawSteps.length > MAX_RECIPE_STEPS)
        return { ok: false, error: `recipe from-skills supports at most ${MAX_RECIPE_STEPS} steps` };
    const priceRaw = parsed['pricePerExecution'];
    if (priceRaw === null)
        return { ok: false, error: 'recipe from-skills pricePerExecution must be a non-negative number' };
    const price = priceRaw === undefined ? undefined : Number(priceRaw);
    if (price !== undefined && (!Number.isFinite(price) || price < 0))
        return { ok: false, error: 'recipe from-skills pricePerExecution must be a non-negative number' };
    const baseDir = dirname(manifestPath);
    let validationRoot;
    try {
        validationRoot = realpathSync(baseDir);
    }
    catch {
        return { ok: false, error: 'recipe from-skills cannot resolve the manifest directory' };
    }
    const steps = [];
    for (let i = 0; i < rawSteps.length; i += 1) {
        const rawStep = rawSteps[i];
        if (!isPlainRecord(rawStep))
            return { ok: false, error: `recipe from-skills step ${i + 1} must be a JSON object` };
        const skillRef = typeof rawStep['skill'] === 'string' ? rawStep['skill'].trim() : '';
        if (!skillRef)
            return { ok: false, error: `recipe from-skills step ${i + 1} requires skill` };
        let skillPath;
        try {
            skillPath = realpathSync(resolveManifestRef(baseDir, skillRef));
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${i + 1} cannot read skill` };
        }
        if (!pathIsWithin(validationRoot, skillPath)) {
            return { ok: false, error: `recipe from-skills step ${i + 1} skill must stay within the manifest directory` };
        }
        let skill;
        try {
            skill = readRecipeInputFile(skillPath);
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${i + 1} cannot read skill` };
        }
        const execution = loadSkillExecution(rawStep['execution'], baseDir, validationRoot, i + 1);
        if (!execution.ok)
            return execution;
        const scenario = typeof rawStep['scenario'] === 'string' && rawStep['scenario'].trim()
            ? rawStep['scenario'].trim()
            : undefined;
        steps.push({
            skill,
            execution: execution.value,
            validationCwd: dirname(skillPath),
            validationRoot,
            ...(scenario ? { scenario } : {}),
        });
    }
    const description = typeof parsed['description'] === 'string' && parsed['description'].trim()
        ? parsed['description'].trim()
        : undefined;
    return {
        ok: true,
        value: {
            title,
            ...(description ? { description } : {}),
            ...(price !== undefined ? { pricePerExecution: price } : {}),
            steps,
        },
    };
}
function pathIsWithin(root, target) {
    const rel = relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function loadSkillExecution(raw, baseDir, validationRoot, stepNumber) {
    if (typeof raw === 'string' && raw.trim()) {
        let executionPath;
        try {
            executionPath = realpathSync(resolveManifestRef(baseDir, raw.trim()));
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${stepNumber} cannot read execution` };
        }
        if (!pathIsWithin(validationRoot, executionPath)) {
            return { ok: false, error: `recipe from-skills step ${stepNumber} execution must stay within the manifest directory` };
        }
        let text;
        try {
            text = readRecipeInputFile(executionPath);
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${stepNumber} cannot read execution` };
        }
        try {
            const parsed = JSON.parse(text);
            if (isPlainRecord(parsed))
                return { ok: true, value: parsed };
            return { ok: false, error: `recipe from-skills step ${stepNumber} execution must be a JSON object` };
        }
        catch {
            return { ok: false, error: `recipe from-skills step ${stepNumber} execution must be valid JSON` };
        }
    }
    if (isPlainRecord(raw))
        return { ok: true, value: raw };
    return { ok: false, error: `recipe from-skills step ${stepNumber} requires execution evidence` };
}
function readRecipeInputFile(path) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_RECIPE_INPUT_BYTES)
        throw new Error('invalid recipe input file');
    return readFileSync(path, 'utf8');
}
function resolveManifestRef(baseDir, ref) {
    return isAbsolute(ref) ? ref : resolve(baseDir, ref);
}
function isPlainRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function recipeFromSkillsPayload(opts) {
    return {
        ok: opts.ok ?? true,
        group: 'recipe.from_skills',
        mode: opts.mode,
        title: opts.title,
        ...(opts.recipeId ? { recipeId: opts.recipeId } : {}),
        ...(opts.error ? { error: opts.error } : {}),
        publish: opts.publish,
        steps: opts.steps.map((step) => ({
            position: step.position,
            geneId: step.geneId,
            geneAssetId: step.geneAssetId,
            capsuleId: step.capsuleId,
        })),
    };
}
async function callRecipeWithAuthRetry(hub, tag, fn, io) {
    try {
        return await fn();
    }
    catch (e) {
        if (!(e instanceof AuthError) || !hub.hello)
            throw e;
        if (!authErrorIndicatesStaleNodeSecret(e))
            throw e;
        io.err(`[${tag}] Hub reported a stale node secret; rotating credentials once and retrying...`);
        const hello = await hub.hello({ rotate: true, evolverVersion: getCliVersion() });
        if (!hello.ok) {
            io.err(`[${tag}] Could not auto-rotate credentials: ${hello.error ?? 'unknown'}`);
            io.err('  Recover by resetting the Hub credential, then re-run `evolver login` or update EVOMAP_NODE_SECRET.');
            throw e;
        }
        return await fn();
    }
}
function parseBuildArgs(args) {
    const title = flagValue(args, '--title');
    const genesRaw = flagValue(args, '--genes') ?? flagValue(args, '--assets');
    if (!title)
        return { ok: false, error: 'recipe build requires --title <title>' };
    if (!genesRaw)
        return { ok: false, error: 'recipe build requires --genes <asset_id,...>' };
    const assetIds = splitIds(genesRaw);
    if (assetIds.length === 0)
        return { ok: false, error: '--genes is empty' };
    if (assetIds.length > MAX_RECIPE_STEPS)
        return { ok: false, error: `recipe build supports at most ${MAX_RECIPE_STEPS} steps` };
    const priceRaw = flagValue(args, '--price');
    const price = priceRaw === null ? undefined : Number(priceRaw);
    if (price !== undefined && (!Number.isFinite(price) || price < 0))
        return { ok: false, error: '--price must be a non-negative number' };
    const description = flagValue(args, '--description');
    return {
        ok: true,
        value: {
            sub: 'build',
            title,
            assetIds,
            ...(description ? { description } : {}),
            ...(price !== undefined ? { pricePerExecution: price } : {}),
            publish: args.includes('--publish'),
        },
    };
}
function parseFromSkillsArgs(args) {
    const manifestPath = flagValue(args, '--manifest');
    if (!manifestPath)
        return { ok: false, error: 'recipe from-skills requires --manifest <file>' };
    return {
        ok: true,
        value: {
            sub: 'from-skills',
            manifestPath,
            publish: args.includes('--publish'),
            jsonOut: args.includes('--json'),
        },
    };
}
function parseSearchArgs(args) {
    const q = flagValue(args, '--q') ?? flagValue(args, '--query') ?? firstPositional(args) ?? undefined;
    const limitRaw = flagValue(args, '--limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        return { ok: false, error: '--limit must be a positive integer' };
    }
    return {
        ok: true,
        value: {
            sub: 'search',
            ...(q ? { q } : {}),
            ...(limit !== undefined ? { limit } : {}),
            jsonOut: args.includes('--json'),
        },
    };
}
function parseReuseArgs(args) {
    const recipeId = flagValue(args, '--id') ?? firstPositional(args);
    if (!recipeId)
        return { ok: false, error: 'recipe reuse requires --id <recipe_id>' };
    if (recipeId.length > MAX_ID_LENGTH)
        return { ok: false, error: `recipe id must be <= ${MAX_ID_LENGTH} characters` };
    const inputRaw = flagValue(args, '--input');
    const input = inputRaw === null ? { ok: true, value: {} } : parseJsonObject(inputRaw);
    if (!input.ok)
        return input;
    return { ok: true, value: { sub: 'reuse', recipeId, inputPayload: input.value, jsonOut: args.includes('--json') } };
}
function splitIds(raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => s.length <= MAX_ID_LENGTH);
}
function flagValue(args, flag) {
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === undefined)
            continue;
        if (token === flag) {
            const next = args[i + 1];
            return next && !next.startsWith('--') ? next : null;
        }
        if (token.startsWith(`${flag}=`))
            return token.slice(flag.length + 1);
    }
    return null;
}
function firstPositional(args) {
    return args.find((a) => typeof a === 'string' && !a.startsWith('--')) ?? null;
}
function parseJsonObject(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return { ok: true, value: parsed };
        return { ok: false, error: '--input must be a JSON object' };
    }
    catch {
        return { ok: false, error: '--input must be valid JSON' };
    }
}
function recipeErrorMessage(e) {
    if (e instanceof HubClientError)
        return `recipe Hub call failed (HTTP ${e.status}): ${JSON.stringify(redactHubErrorBody(e.body))}`;
    if (e instanceof AuthError) {
        const details = e.body === undefined ? '' : `: ${JSON.stringify(redactHubErrorBody(e.body))}`;
        return `recipe Hub auth failed (HTTP ${e.status})${details}; run "evolver login" or refresh EVOMAP_NODE_SECRET`;
    }
    if (e instanceof HubUnreachableError)
        return `recipe Hub is unreachable: ${e.message}`;
    return e instanceof Error ? e.message : String(e);
}
function redactHubErrorBody(value, depth = 0) {
    if (depth > 5)
        return '[redacted-depth]';
    if (typeof value === 'string')
        return redactSensitiveString(value);
    if (Array.isArray(value))
        return value.map((item) => redactHubErrorBody(item, depth + 1));
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
        out[key] = isSensitiveErrorKey(key) ? '[redacted]' : redactHubErrorBody(nested, depth + 1);
    }
    return out;
}
function authErrorIndicatesStaleNodeSecret(e) {
    const text = [
        e.errorCode,
        ...authErrorStringValues(e.body),
    ].filter((value) => typeof value === 'string' && value.length > 0).join(' ').toLowerCase();
    return [...STALE_NODE_SECRET_ERRORS].some((code) => text.includes(code));
}
function authErrorStringValues(value, depth = 0) {
    if (depth > 5 || value === undefined || value === null)
        return [];
    if (typeof value === 'string')
        return [value];
    if (typeof value === 'number' || typeof value === 'boolean')
        return [String(value)];
    if (Array.isArray(value))
        return value.flatMap((item) => authErrorStringValues(item, depth + 1));
    if (typeof value !== 'object')
        return [];
    return Object.entries(value).flatMap(([key, nested]) => [
        key,
        ...authErrorStringValues(nested, depth + 1),
    ]);
}
function isSensitiveErrorKey(key) {
    const normalized = key.toLowerCase();
    return SENSITIVE_ERROR_KEYS.has(normalized) || normalized.includes('token') || normalized.includes('secret');
}
function redactSensitiveString(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/\b(authorization|node_secret|nodeSecret|access_token|refresh_token|token|secret)\b\s*[:=]\s*["']?[^"',\s;}]+/gi, '$1=[redacted]');
}
function resolveRecipeHubCredentials(env) {
    const homeCandidates = recipeHomeCandidates(env);
    const defaultHome = homeCandidates[0] ?? events.evomapHome();
    const explicitCredentials = resolveExplicitNodeCredentials(env);
    const fromEnv = explicitCredentials.nodeSecret;
    const envNodeSecretVersion = parseNodeSecretVersion(explicitCredentials.nodeSecretVersion);
    const storedCandidate = readRecipeStoreNodeCredentials(env);
    const stored = storedCandidate?.source?.startsWith('pending_') ? undefined : storedCandidate;
    const explicitSenderId = explicitCredentials.senderId;
    const legacy = firstLegacyNodeCredentials(homeCandidates);
    const pairedStoredSenderId = stored?.nodeSecret
        ? stored.nodeId
            ?? (fromEnv === stored.nodeSecret ? explicitSenderId : undefined)
            ?? (legacy?.nodeSecret === stored.nodeSecret ? legacy.nodeId : undefined)
        : undefined;
    const completeExplicitOverridesOrphan = Boolean(fromEnv
        && explicitSenderId
        && fromEnv !== stored?.nodeSecret
        && pairedStoredSenderId !== explicitSenderId);
    if (stored?.source === 'hub_rotate' && stored.nodeSecret && !completeExplicitOverridesOrphan) {
        return {
            evomapDir: defaultHome,
            nodeSecret: stored.nodeSecret,
            ...(stored.nodeSecretVersion !== undefined ? { nodeSecretVersion: stored.nodeSecretVersion } : {}),
            senderId: pairedStoredSenderId,
            rotatePersistDir: defaultHome,
        };
    }
    if (fromEnv) {
        const nodeSecretVersion = envNodeSecretVersion ?? pairedStoreNodeSecretVersion(fromEnv, stored) ?? pairedLegacyNodeSecretVersion(fromEnv, homeCandidates);
        return {
            evomapDir: defaultHome,
            nodeSecret: fromEnv,
            ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
            senderId: explicitSenderId ?? (legacy?.nodeSecret === fromEnv ? legacy.nodeId : undefined),
            rotatePersistDir: defaultHome,
        };
    }
    if (stored?.nodeSecret) {
        return {
            evomapDir: defaultHome,
            nodeSecret: stored.nodeSecret,
            ...(stored.nodeSecretVersion !== undefined ? { nodeSecretVersion: stored.nodeSecretVersion } : {}),
            senderId: pairedStoredSenderId,
            rotatePersistDir: defaultHome,
        };
    }
    if (legacy) {
        return {
            evomapDir: legacy.dir,
            nodeSecret: legacy.nodeSecret,
            ...(legacy.nodeSecretVersion !== undefined ? { nodeSecretVersion: legacy.nodeSecretVersion } : {}),
            senderId: legacy.nodeId,
            rotatePersistDir: legacy.dir,
        };
    }
    const oauthDir = homeCandidates.find((dir) => existsSync(join(dir, 'token.json'))) ?? defaultHome;
    return {
        evomapDir: oauthDir,
        senderId: resolveRecipeOAuthSenderId(env, oauthDir),
        rotatePersistDir: oauthDir,
    };
}
function resolveRecipeOAuthSenderId(env, oauthDir) {
    const evomapNodeId = env['EVOMAP_NODE_ID']?.trim();
    if (evomapNodeId)
        return evomapNodeId;
    const identityNodeId = readLegacyNodeId(oauthDir);
    if (identityNodeId)
        return identityNodeId;
    const a2aNodeId = env['A2A_NODE_ID']?.trim();
    if (a2aNodeId)
        return a2aNodeId;
    return readRecipeStoreNodeCredentials(env)?.nodeId;
}
/**
 * The EXPLICIT home overrides (EVOMAP_DIR / EVOLVER_HOME / EVOMAP_HOME) the recipe credential layer honors,
 * resolved purely from the passed env with no process.env fallback. Exported so `reset-local-secret` (index.ts)
 * can clear the SAME explicit directories the recipe path may persist rotated legacy files into
 * (rotatePersistDir = recipeHomeCandidates(env)[0], which is the first explicit home when any is set) — otherwise
 * a reset that only wiped ~/.evomap would leave a stale node_secret under EVOMAP_DIR/EVOMAP_HOME that resurrects on
 * the next recipe run (H3). Kept env-pure (no events.evomapHome()) so reset stays hermetic under an injected env.
 */
export function explicitRecipeHomes(env) {
    // Identity-first order (#555 T2): EVOMAP_HOME is THE identity home and outranks the state root
    // (EVOLVER_HOME). This order decides BOTH the read fall-through AND rotatePersistDir (= homes[0]),
    // so under the evox agentDir split (EVOMAP_HOME=<agentDir>/evomap, EVOLVER_HOME=<agentDir>/evolver)
    // a hub-rotated secret persists into the evomap dir the desktop actually reads — the old
    // EVOLVER_HOME-first order would strand it in the state root and split-brain the node on rotation.
    // Read-your-writes holds because read and persist share this one order; single-home setups are unchanged.
    const explicit = [
        env['EVOMAP_HOME'],
        env['EVOMAP_DIR'],
        env['EVOLVER_HOME'],
    ];
    return uniqueStrings(explicit.map((value) => value?.trim()).filter((value) => Boolean(value)));
}
function recipeHomeCandidates(env) {
    const explicitHomes = explicitRecipeHomes(env);
    if (explicitHomes.length > 0)
        return explicitHomes;
    const candidates = [
        env['HOME'] ? join(env['HOME'], '.evomap') : undefined,
        events.evomapHome(),
    ];
    return uniqueStrings(candidates.map((value) => value?.trim()).filter((value) => Boolean(value)));
}
function readRecipeStoreNodeCredentials(env) {
    const storePath = recipeProxyStorePath(env);
    if (!existsSync(storePath))
        return undefined;
    const store = new mailbox.MailboxStore({ path: storePath });
    try {
        const nodeId = store.getState('node_id')?.trim() || undefined;
        const storedSecret = store.getState('node_secret');
        const nodeSecret = storedSecret && isNodeSecret(storedSecret) ? storedSecret : undefined;
        const nodeSecretVersion = parseNodeSecretVersion(store.getState('node_secret_version'));
        const source = store.getState('node_secret_source') || undefined;
        return {
            ...(nodeId ? { nodeId } : {}),
            ...(nodeSecret ? { nodeSecret } : {}),
            ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
            ...(source ? { source } : {}),
        };
    }
    finally {
        store.close();
    }
}
// Reuse the store's node_secret_version for an env-supplied secret ONLY when the store holds a node_secret
// EQUAL to it. v1 (manager.js nodeSecretVersion getter: `return storeSecret === envSecret ? storeVersion : null`)
// and v2's own proxy (evolver-proxy.ts: `envNodeSecret === storeSecret ? storedNodeSecretVersion : undefined`)
// both require strict equality — neither reuses a version when the store has a version but NO secret. The
// previous `!stored.nodeSecret` passthrough was strictly wider than both, pairing an orphan version onto an
// unrelated env secret. A version is meaningful only as the version OF a specific secret, so a versioned env
// secret whose pair is unknown locally must carry no version (the hub assigns one on hello).
function pairedStoreNodeSecretVersion(secret, stored) {
    if (!stored?.nodeSecretVersion)
        return undefined;
    return stored.nodeSecret === secret ? stored.nodeSecretVersion : undefined;
}
// Legacy-file counterpart of the rule above: v1 (extractor.js: `if (legacySecret === envSecret) return <version>`)
// requires the on-disk node_secret to equal the env secret before reusing its node_secret_version. Drop the
// previous `!rawSecret` passthrough so a version file with no matching secret file is never paired onto the env
// secret.
function pairedLegacyNodeSecretVersion(secret, dirs) {
    for (const dir of dirs) {
        const nodeSecretVersion = readLegacyNodeSecretVersion(dir);
        if (nodeSecretVersion === undefined)
            continue;
        const rawSecret = readTrimmedFile(join(dir, 'node_secret'));
        if (rawSecret === secret)
            return nodeSecretVersion;
    }
    return undefined;
}
function firstLegacyNodeCredentials(dirs) {
    for (const dir of dirs) {
        const nodeSecret = readLegacyNodeSecret(dir);
        if (!nodeSecret)
            continue;
        const nodeSecretVersion = readLegacyNodeSecretVersion(dir);
        return {
            dir,
            nodeSecret,
            ...(nodeSecretVersion !== undefined ? { nodeSecretVersion } : {}),
            nodeId: readLegacyNodeId(dir),
        };
    }
    return undefined;
}
function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
function recipeProxyStorePath(env) {
    const configuredStore = env['EVOLVER_PROXY_STORE'];
    if (configuredStore && configuredStore.length > 0)
        return configuredStore;
    const configuredHome = env['EVOLVER_HOME'];
    // `env['HOME'] || homedir()` (NOT `?? homedir()`): an empty-string HOME must fall back to homedir(), otherwise
    // `join('', '.evomap', ...)` resolves to the RELATIVE path `.evomap/proxy/mailbox.db` and the CLI reads/writes a
    // different mailbox.db than the proxy. This mirrors evolver-proxy's resolveLocalHome / evomapHome, which both
    // treat '' as unset, so cli and proxy land on the same store.
    const evomapHome = configuredHome && configuredHome.length > 0
        ? configuredHome
        : join(env['HOME'] || homedir(), '.evomap');
    return join(evomapHome, 'proxy', 'mailbox.db');
}
function setOptionalStoreState(store, key, value) {
    store.setState(key, value ?? '');
}
function persistRotatedNodeSecret(secret, version, nodeId, env, legacyDir) {
    const storePath = recipeProxyStorePath(env);
    const store = new mailbox.MailboxStore({ path: storePath });
    try {
        store.setState('node_secret_source', 'pending_rotate');
        if (nodeId)
            store.setState('node_id', nodeId);
        store.setState('node_secret', secret);
        setOptionalStoreState(store, 'node_secret_version', version !== undefined ? String(version) : undefined);
        store.setState('node_secret_source', 'hub_rotate');
    }
    finally {
        store.close();
    }
    persistLegacyNodeSecret(secret, version, legacyDir);
}
function persistRecipeNodeId(nodeId, env, legacyDir) {
    const store = new mailbox.MailboxStore({ path: recipeProxyStorePath(env) });
    try {
        store.setState('node_id', nodeId);
    }
    finally {
        store.close();
    }
    mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacyDir, 'node_id'), nodeId, { encoding: 'utf8', mode: 0o600 });
}
function persistNodeSecretVersion(version, env, legacyDir) {
    const storePath = recipeProxyStorePath(env);
    const store = new mailbox.MailboxStore({ path: storePath });
    try {
        setOptionalStoreState(store, 'node_secret_version', version !== undefined ? String(version) : undefined);
    }
    finally {
        store.close();
    }
    persistLegacyNodeSecretVersion(version, legacyDir);
}
function readLegacyNodeSecret(evomapDir) {
    const secret = readTrimmedFile(join(evomapDir, 'node_secret'));
    return secret && isNodeSecret(secret) ? secret : undefined;
}
function readLegacyNodeSecretVersion(evomapDir) {
    return parseNodeSecretVersion(readTrimmedFile(join(evomapDir, 'node_secret_version')));
}
function readLegacyNodeId(evomapDir) {
    return readTrimmedFile(join(evomapDir, 'node_id'));
}
function persistLegacyNodeSecret(secret, version, evomapDir) {
    if (!isNodeSecret(secret))
        return;
    try {
        mkdirSync(evomapDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(evomapDir, 'node_secret'), secret, { encoding: 'utf8', mode: 0o600 });
        writeLegacyNodeSecretVersion(version, evomapDir);
    }
    catch {
        // Mailbox persistence above is authoritative for v2; legacy file persistence is best effort.
    }
}
function persistLegacyNodeSecretVersion(version, evomapDir) {
    try {
        mkdirSync(evomapDir, { recursive: true, mode: 0o700 });
        writeLegacyNodeSecretVersion(version, evomapDir);
    }
    catch {
        // Mailbox persistence above is authoritative for v2; legacy file persistence is best effort.
    }
}
function writeLegacyNodeSecretVersion(version, evomapDir) {
    const versionPath = join(evomapDir, 'node_secret_version');
    if (version !== undefined) {
        writeFileSync(versionPath, String(version), { encoding: 'utf8', mode: 0o600 });
        return;
    }
    if (existsSync(versionPath))
        unlinkSync(versionPath);
}
function readTrimmedFile(path) {
    try {
        if (!existsSync(path))
            return undefined;
        const value = readFileSync(path, 'utf8').trim();
        return value.length > 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function recipeUsage() {
    return [
        'Recipe subcommands:',
        '  evolver recipe build --title <title> --genes <asset_id,...> [--description <text>] [--price <n>] [--publish]',
        '      Creates a draft recipe by default. --publish is explicit.',
        '  evolver recipe from-skills --manifest <file> [--publish] [--json]',
        '      Distills ordered SKILL.md steps with execution evidence, then creates a recipe.',
        '  evolver recipe reuse --id <recipe_id> [--input <json-object>] [--json]',
        '  evolver recipe search [--q <text>] [--limit <n>] [--json]',
        '      Default agent lookup. Express a hit with `evolver recipe reuse`. Gene/Capsule search is fallback.',
    ].join('\n');
}