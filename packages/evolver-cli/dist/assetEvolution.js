import { existsSync } from 'node:fs';
import { assetstore, events, ops } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const MAX_GENES = 5_000;
const MAX_CAPSULES = 20_000;
const MAX_EVENTS = 100_000;
const ASSET_REF = /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9_.:-]{0,199})$/;
const USAGE = [
    'Usage:',
    '  evolver asset-evolution --json [--limit=N]          overview of local experiences, reuse and lineage',
    '  evolver asset-evolution --json --asset=<id> [--limit=N]   one asset by content id or logical id',
    '',
    'Read-only. Reads the local asset store, review/provenance sidecars and root events; never calls the Hub.',
    '',
].join('\n');
class AssetEvolutionFailure extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function flagValue(argv, index, name) {
    const arg = argv[index];
    if (arg.startsWith(`--${name}=`))
        return { value: arg.slice(name.length + 3), next: index + 1 };
    if (arg !== `--${name}`)
        return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
        throw new AssetEvolutionFailure('INPUT_INVALID', `--${name} 需要填写内容。`);
    return { value, next: index + 2 };
}
function parseLimit(value) {
    if (!/^\d+$/.test(value) || Number(value) < 1)
        throw new AssetEvolutionFailure('INPUT_INVALID', '--limit 需要正整数。');
    return Math.min(MAX_LIMIT, Number(value));
}
function operationOf(argv) {
    return argv.some((arg) => arg === '--asset' || arg.startsWith('--asset=')) ? 'asset' : 'overview';
}
function parseRequest(argv) {
    const request = { operation: operationOf(argv), limit: DEFAULT_LIMIT, help: false };
    for (let index = 0; index < argv.length;) {
        const arg = argv[index];
        if (arg === '--json') {
            index += 1;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            request.help = true;
            index += 1;
            continue;
        }
        const limit = flagValue(argv, index, 'limit');
        const asset = limit ? null : flagValue(argv, index, 'asset');
        if (!limit && !asset)
            throw new AssetEvolutionFailure('INPUT_INVALID', `不支持的参数：${arg.slice(0, 40)}`);
        if (limit)
            request.limit = parseLimit(limit.value);
        if (asset && !ASSET_REF.test(asset.value))
            throw new AssetEvolutionFailure('INPUT_INVALID', '--asset 需要资产 ID（sha256:…）或逻辑 ID。');
        if (asset)
            request.asset = asset.value;
        index = (limit ?? asset).next;
    }
    return request;
}
// The provider loads its whole index either way, so the caps bound the projection's work and output, not the read;
// they keep the newest records, and a cut is reported so absence is never read as proof.
async function readStore(dir) {
    if (!existsSync(dir))
        return { genes: [], capsules: [], ok: true, truncated: false };
    try {
        const store = new assetstore.LocalJsonlProvider(dir);
        const allGenes = await store.list('Gene', Number.MAX_SAFE_INTEGER);
        const allCapsules = await store.list('Capsule', Number.MAX_SAFE_INTEGER);
        return {
            genes: allGenes.slice(-MAX_GENES), capsules: allCapsules.slice(-MAX_CAPSULES), ok: true,
            truncated: allGenes.length > MAX_GENES || allCapsules.length > MAX_CAPSULES,
        };
    }
    catch {
        return { genes: [], capsules: [], ok: false, truncated: false };
    }
}
function readSidecars(dir) {
    if (!existsSync(dir))
        return { reviewHistory: [], provenance: new Map(), ok: true };
    try {
        return { reviewHistory: new assetstore.ReviewLedger(dir).history(), provenance: new assetstore.ProvenanceStore(dir).snapshot(), ok: true };
    }
    catch {
        return { reviewHistory: [], provenance: new Map(), ok: false };
    }
}
/** Root events go through the core reader, which reaches the protected-audit store over RPC where one is installed. */
function readRootEvents(deps) {
    try {
        const all = deps.readEvents ? deps.readEvents() : events.readEvents(events.rootEventsPath());
        return { events: all.slice(-MAX_EVENTS), ok: true, truncated: all.length > MAX_EVENTS };
    }
    catch {
        return { events: [], ok: false, truncated: false };
    }
}
async function readInput(deps) {
    if (loadEnvFileFromEnv(process.env).error)
        throw new AssetEvolutionFailure('UNAVAILABLE', '无法读取 EVOLVER_ENV_FILE，请检查本地 Evolver 配置。');
    const dir = deps.assetsDir ?? events.assetsDir();
    const stored = await readStore(dir);
    const sidecars = readSidecars(dir);
    const rootEvents = readRootEvents(deps);
    return {
        now: (deps.now ?? Date.now)(),
        genes: stored.genes,
        capsules: stored.capsules,
        reviewHistory: sidecars.reviewHistory,
        provenance: sidecars.provenance,
        events: rootEvents.events,
        sources: { assets: stored.ok, review: sidecars.ok, rootEvents: rootEvents.ok, truncated: stored.truncated || rootEvents.truncated },
    };
}
function unavailable(input) {
    return !input.sources.assets && !input.sources.review && !input.sources.rootEvents;
}
async function resultFor(request, deps) {
    const input = await readInput(deps);
    if (unavailable(input))
        throw new AssetEvolutionFailure('UNAVAILABLE', '本地经验库和事件记录暂时都读不到，请检查 Evolver 安装与目录权限。');
    if (request.operation === 'overview')
        return ops.projectAssetEvolutionOverview(input, { limit: request.limit });
    const dossier = ops.projectAssetEvolutionDossier(input, request.asset, { limit: request.limit });
    if (dossier)
        return dossier;
    if (!input.sources.assets || !input.sources.rootEvents)
        throw new AssetEvolutionFailure('UNAVAILABLE', '部分本地记录暂时读不到，无法确认这条经验。');
    if (input.sources.truncated)
        throw new AssetEvolutionFailure('UNAVAILABLE', '本地记录超出本次读取范围，无法确认这条经验是否存在。');
    throw new AssetEvolutionFailure('NOT_FOUND', '本机没有这条经验的记录。');
}
/** `evolver asset-evolution`: the local reuse/evolution read model as one versioned JSON envelope. */
export async function runAssetEvolutionCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const operation = operationOf(argv);
    const emit = (payload) => stdout(`${JSON.stringify({ schema: ops.ASSET_EVOLUTION_SCHEMA, operation, ...payload })}\n`);
    try {
        const request = parseRequest(argv);
        if (request.help) {
            stdout(USAGE);
            return 0;
        }
        emit({ ok: true, result: await resultFor(request, deps) });
        return 0;
    }
    catch (error) {
        const failure = error instanceof AssetEvolutionFailure ? error
            : new AssetEvolutionFailure('UNAVAILABLE', '未能读取资产演进记录，请检查本地 Evolver 安装与目录权限。');
        emit({ ok: false, code: failure.code, error: failure.message });
        return failure.code === 'INPUT_INVALID' ? 2 : 1;
    }
}