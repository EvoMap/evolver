import { existsSync } from 'node:fs';
import { assetstore, authoring, events, hub } from '@evomap/evolver-core';
import { JsonCommandError, LARGE_REQUEST_BYTES, SMALL_REQUEST_BYTES, inputError, operationOf, optionalEnum, optionalString, optionalStrings, readJsonRequest, requestLocale, requiredEnum, requiredObject, requiredString, runJsonCommand, } from './jsonCommand.js';
const GENE_SCHEMA = 'evolver.gene.v1';
const OPERATIONS = ['template', 'build', 'get', 'lint', 'probe', 'ir-prompt', 'distill', 'prepare-publish'];
const CATEGORIES = ['repair', 'optimize', 'innovate', 'explore'];
const PLATFORMS = ['claude-code', 'codex', 'paste'];
const MAX_PROBE_TASKS = 5;
const MAX_TASK_CHARS = 300;
const SNAPSHOT_BUDGET = { maxRecords: 20_000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024 };
function template(request, locale) {
    const category = optionalEnum(request, 'category', CATEGORIES, locale) ?? 'repair';
    return {
        markdown: authoring.geneTemplateMarkdown(category, locale),
        gene: { type: 'Gene', category, signals_match: [], strategy: [], constraints: { max_files: 1, forbidden_paths: [...authoring.DEFAULT_FORBIDDEN_PATHS] }, validation: [] },
    };
}
function build(request, locale) {
    const format = requiredEnum(request, 'format', ['markdown', 'json'], locale);
    const source = requiredString(request, 'source', locale, SMALL_REQUEST_BYTES);
    const supersedes = optionalString(request, 'supersedes', locale, 80);
    return authoring.buildGene({ format, source, locale, ...(supersedes === undefined ? {} : { supersedes }) });
}
function probeState(gene, snapshot) {
    if (snapshot.provenance.get(gene.asset_id)?.trusted === false)
        return null;
    const review = snapshot.review.get(gene.asset_id);
    if (review?.state === 'quarantined')
        return 'pending';
    if (review?.state === 'rejected')
        return review.reason === 'experience:paused' ? 'paused' : null;
    return 'active';
}
async function localCandidates(locale) {
    const dir = events.assetsDir();
    if (!existsSync(dir))
        return [];
    let snapshot;
    try {
        snapshot = await assetstore.readLocalGeneSnapshot(dir, { ...SNAPSHOT_BUDGET, deadlineAt: Date.now() + 10_000 });
    }
    catch {
        throw new JsonCommandError('UNAVAILABLE', authoring.say(locale, '暂时读不到本地经验库，无法比较相似经验。', 'The local experience library cannot be read right now.'));
    }
    return snapshot.genes.flatMap((gene) => {
        const state = probeState(gene, snapshot);
        return state ? [{ gene, state }] : [];
    });
}
async function probe(request, locale) {
    const gene = requiredObject(request, 'gene', locale);
    const tasks = optionalStrings(request, 'tasks', locale, MAX_PROBE_TASKS, MAX_TASK_CHARS) ?? [];
    if (tasks.length === 0 || tasks.some((task) => !task.trim())) {
        throw inputError(locale, `请给 1–${MAX_PROBE_TASKS} 个任务描述，每个不超过 ${MAX_TASK_CHARS} 字。`, `Give 1–${MAX_PROBE_TASKS} task descriptions of at most ${MAX_TASK_CHARS} characters.`);
    }
    return authoring.probeGene(gene, tasks, await localCandidates(locale));
}
function recordsOf(request, locale) {
    const records = request['records'];
    if (records === undefined)
        return undefined;
    if (!Array.isArray(records) || records.some((line) => !line || typeof line !== 'object' || typeof line['kind'] !== 'string' || typeof line['text'] !== 'string')) {
        throw inputError(locale, 'records 需要是 {kind, text, exit?, failed?} 记录行列表。', 'records must be a list of {kind, text, exit?, failed?} record lines.');
    }
    return records;
}
function irPrompt(request, locale) {
    const kind = optionalEnum(request, 'kind', authoring.IR_KINDS, locale);
    const outcome = optionalEnum(request, 'outcome', ['success', 'failed'], locale);
    const focus = optionalString(request, 'focus', locale, 600);
    return {
        irVersion: hub.SESSION_GENE_IR_VERSION,
        prompt: authoring.irPrompt({ records: recordsOf(request, locale) ?? [], ...(kind ? { kind } : {}), ...(outcome ? { outcome } : {}), ...(focus ? { focus } : {}) }),
        outputSchema: authoring.IR_OUTPUT_SCHEMA,
        answerSchema: authoring.IR_ANSWER_SCHEMA,
    };
}
async function distill(request, locale) {
    const records = recordsOf(request, locale);
    if (request['ir'] !== undefined && (typeof request['ir'] !== 'object' || request['ir'] === null || Array.isArray(request['ir']))) {
        throw inputError(locale, 'ir 需要是一个 IR 对象。', 'ir must be one IR object.');
    }
    const draft = {
        outcome: requiredEnum(request, 'outcome', ['success', 'failed'], locale),
        platform: requiredEnum(request, 'platform', PLATFORMS, locale),
    };
    const text = (key, max) => {
        const value = optionalString(request, key, locale, max);
        if (value !== undefined)
            draft[key] = value;
    };
    const list = (key) => {
        const value = optionalStrings(request, key, locale);
        if (value !== undefined)
            draft[key] = value;
    };
    text('transcript', LARGE_REQUEST_BYTES);
    text('summary', 2000);
    text('title', 200);
    text('userPrompt', 20_000);
    text('finalAnswer', 20_000);
    for (const key of ['strategy', 'signals', 'preconditions', 'validation', 'identifiers'])
        list(key);
    if (records)
        draft.records = records;
    if (request['ir'] !== undefined)
        draft.ir = request['ir'];
    return authoring.distillDraft(draft);
}
/** Library failures keep their meaning across the envelope: a bad id stays an input error, a missing Gene stays not found. */
async function fromLibrary(locale, read) {
    try {
        return await read(new assetstore.ExperienceLibrary(events.assetsDir()));
    }
    catch (error) {
        if (!(error instanceof assetstore.ExperienceError))
            throw error;
        const code = error.code === 'INPUT_INVALID' || error.code === 'NOT_FOUND' ? error.code : 'UNAVAILABLE';
        throw new JsonCommandError(code, code === 'UNAVAILABLE' ? authoring.say(locale, '暂时读不到本地经验库。', 'The local experience library cannot be read right now.') : error.message);
    }
}
async function getGene(request, locale) {
    const { gene, item } = await fromLibrary(locale, (library) => library.gene(request['assetId']));
    return { gene, markdown: authoring.renderGeneMarkdown(gene, locale), state: item.state, title: item.title };
}
/** The stored Gene and one of its evidence Capsules: the named one, else the latest successful trial. */
async function storedBundle(request, locale) {
    const evidenceId = optionalString(request, 'evidenceId', locale, 200);
    return fromLibrary(locale, async (library) => {
        const { gene } = await library.gene(request['assetId']);
        const rows = (await library.evidence(gene.asset_id)).filter((row) => row.capsule !== null);
        const chosen = evidenceId ? rows.find((row) => row.evidenceId === evidenceId) : rows.filter((row) => row.outcome === 'success').at(-1);
        if (!chosen?.capsule)
            throw new JsonCommandError('NOT_FOUND', authoring.say(locale, '没有可以一起发布的试用记录。', 'No trial evidence to publish with this Gene.'));
        return { gene, capsule: chosen.capsule };
    });
}
async function preparePublish(request, locale, env) {
    const keep = request['keep'] && typeof request['keep'] === 'object' ? request['keep'] : {};
    const kept = { excerpt: keep['excerpt'] === true, prompt: keep['prompt'] === true };
    if (request['assetId'] !== undefined) {
        const { gene, capsule } = await storedBundle(request, locale);
        return authoring.preparePublication(gene, capsule, kept, env);
    }
    const gene = requiredObject(request, 'gene', locale);
    const capsule = request['capsule'] === undefined ? undefined : requiredObject(request, 'capsule', locale);
    if (gene['type'] !== 'Gene' || (capsule && capsule['type'] !== 'Capsule'))
        throw inputError(locale, '需要一条 Gene 和可选的一个 Capsule。', 'Expected one Gene and an optional Capsule.');
    return authoring.preparePublication(gene, capsule, kept, env);
}
async function resultFor(operation, request, io) {
    const locale = requestLocale(request, io);
    const env = io.env ?? process.env;
    switch (operation) {
        case 'template': return template(request, locale);
        case 'build': return build(request, locale);
        case 'get': return getGene(request, locale);
        case 'lint': return authoring.lintGene(requiredObject(request, 'gene', locale), locale, env);
        case 'probe': return probe(request, locale);
        case 'ir-prompt': return irPrompt(request, locale);
        case 'distill': return distill(request, locale);
        case 'prepare-publish': return preparePublish(request, locale, env);
    }
}
/** `evolver gene <operation> --json`: author, check and distill Genes locally. Nothing is stored, published or sent to a model. */
export async function runGeneCommand(argv, io = {}) {
    const { operation, error } = operationOf(argv, OPERATIONS, io);
    return runJsonCommand(GENE_SCHEMA, operation, io, async () => {
        if (error)
            throw error;
        const request = await readJsonRequest(operation === 'distill' ? LARGE_REQUEST_BYTES : SMALL_REQUEST_BYTES, io);
        return resultFor(operation, request, io);
    });
}