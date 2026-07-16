import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assetstore, wire } from '@evomap/evolver-core';
import { AuthError, HubClientError, HubUnreachableError, connectPublicHub, isHubDryRunEnabled, } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { createRecipeHubFromEnv } from './recipe.js';
import { geneToSkillMd } from './skillDistill.js';
const GROUP = 'skill.fetch';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_ID_LENGTH = 200;
const USAGE = [
    'usage: evolver skill fetch --asset <asset_id_or_gene_id> [--out <dir>] [--write] [--force] [--json]',
    '       evolver skill fetch --signals <s1,s2> [--limit N] [--select <asset_id_or_gene_id>] [--out <dir>] [--write] [--force] [--json]',
    '       evolver skill fetch --query <text> [--limit N] [--select <asset_id_or_gene_id>] [--out <dir>] [--write] [--force] [--json]',
].join('\n');
const HUB_METADATA_KEYS = new Set([
    'credit_cost',
    'gdi_score',
    'success_rate',
    'reuse_count',
    'ranking_score',
    'source_node_id',
    'fetched_at',
    'receipt',
    'hub_receipt',
    'already_purchased',
    '_semantic_similarity',
    'semantic_similarity',
    '_search_score',
    'search_score',
    '_match_score',
    'match_score',
    '_retrieval_rank',
    'retrieval_rank',
    'original_asset_id',
]);
export async function runSkillCommand(argv, deps = {}) {
    const sub = argv[0];
    if (sub === 'fetch')
        return runSkillFetchCommand(argv.slice(1), deps);
    const stderr = deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
    const stdout = deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
    if (sub === '--help' || sub === '-h') {
        stdout(`Skill subcommands:\n  ${USAGE}`);
        return 0;
    }
    stderr(`skill subcommand must be fetch\n${USAGE}`);
    return 1;
}
async function runSkillFetchCommand(argv, deps = {}) {
    const io = {
        stdout: deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); }),
        stderr: deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); }),
    };
    const parsed = parseSkillFetchArgs(argv);
    if (!parsed.ok)
        return emitFailure(parsed.reason, parsed.message, argv.includes('--json'), io);
    const opts = parsed.value;
    if (opts.source.kind === 'asset' && !opts.write && opts.outDir) {
        // Preview with --out is still read-only; target paths are shown below.
    }
    try {
        const env = deps.env ?? process.env;
        loadEnvFileFromEnv(env);
        if (isHubDryRunEnabled(env)) {
            emitSuccess(buildDryRunSkillFetchResult(opts), opts.json, io);
            return 0;
        }
        const hub = deps.hub ?? createSkillFetchHubFromEnv(deps, env);
        const run = await buildSkillFetchResult(hub, opts);
        if (!run.ok)
            return emitFailure(run.reason, run.message, opts.json, io);
        emitSuccess(run.value, opts.json, io);
        return 0;
    }
    catch (err) {
        const mapped = mapSkillFetchError(err);
        return emitFailure(mapped.reason, mapped.message, opts.json, io);
    }
}
function parseSkillFetchArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return { ok: false, reason: 'usage', message: USAGE };
    }
    const unknown = firstUnknownArg(argv);
    if (unknown)
        return { ok: false, reason: 'unsupported', message: `unsupported skill fetch argument: ${unknown}` };
    const asset = flagValue(argv, '--asset');
    const signalsRaw = flagValue(argv, '--signals');
    const query = flagValue(argv, '--query');
    const sources = [asset, signalsRaw, query].filter((value) => Boolean(value && value.trim()));
    if (sources.length !== 1)
        return { ok: false, reason: 'invalid_arg', message: 'skill fetch requires exactly one of --asset, --signals, or --query' };
    const limitRaw = flagValue(argv, '--limit');
    const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit <= 0)
        return { ok: false, reason: 'invalid_arg', message: '--limit must be a positive integer' };
    const write = argv.includes('--write');
    const outDir = flagValue(argv, '--out') ?? undefined;
    if (write && !outDir)
        return { ok: false, reason: 'invalid_arg', message: 'skill fetch --write requires --out <dir>' };
    const select = flagValue(argv, '--select') ?? undefined;
    const source = asset
        ? { kind: 'asset', id: asset.trim() }
        : signalsRaw
            ? { kind: 'signals', signals: splitList(signalsRaw) }
            : { kind: 'query', text: query.trim() };
    if (source.kind === 'asset' && source.id.length > MAX_ID_LENGTH)
        return { ok: false, reason: 'invalid_arg', message: 'asset id must be <= 200 characters' };
    if (source.kind === 'signals' && source.signals.length === 0)
        return { ok: false, reason: 'invalid_arg', message: '--signals is empty' };
    if (source.kind === 'query' && source.text.length === 0)
        return { ok: false, reason: 'invalid_arg', message: '--query is empty' };
    if (select && select.length > MAX_ID_LENGTH)
        return { ok: false, reason: 'invalid_arg', message: 'selected asset id must be <= 200 characters' };
    return {
        ok: true,
        value: {
            source,
            limit: Math.min(Math.floor(limit), MAX_LIMIT),
            ...(select ? { select } : {}),
            ...(outDir ? { outDir } : {}),
            write,
            force: argv.includes('--force'),
            json: argv.includes('--json'),
        },
    };
}
async function buildSkillFetchResult(hub, opts) {
    const direct = opts.source.kind === 'asset' ? await fetchGeneById(hub, opts.source.id) : null;
    if (direct && !direct.ok)
        return direct;
    const candidates = direct
        ? [candidateFromGene(direct.asset, opts.outDir)]
        : await candidatesFromSearch(hub, opts, opts.outDir);
    if (candidates.length === 0)
        return { ok: false, reason: 'not_found', message: 'no matching Gene assets found on the hub' };
    if (!opts.write)
        return { ok: true, value: { mode: 'preview', candidates } };
    const selectedId = opts.source.kind === 'asset'
        ? opts.source.id
        : opts.select ?? (candidates.length === 1 ? candidates[0]?.assetId : undefined);
    if (!selectedId)
        return { ok: false, reason: 'invalid_arg', message: 'skill fetch --write with multiple candidates requires --select <asset_id_or_gene_id>' };
    const previewed = opts.source.kind === 'asset'
        ? candidates[0]
        : candidates.find((candidate) => candidate.assetId === selectedId || candidate.geneId === selectedId);
    if (opts.source.kind !== 'asset' && opts.select && !previewed) {
        return { ok: false, reason: 'invalid_arg', message: 'skill fetch --select must match one of the previewed candidates' };
    }
    if (!previewed)
        return { ok: false, reason: 'integrity_error', message: 'selected Gene is not bound to a previewed candidate' };
    const selected = await fetchGeneById(hub, selectedId);
    if (!selected.ok)
        return selected;
    if (selected.asset.asset_id !== previewed.assetId) {
        return { ok: false, reason: 'integrity_error', message: 'selected Gene asset_id changed after preview' };
    }
    const written = writeSkill(selected.asset, opts.outDir, opts.force);
    if (!written.ok)
        return written;
    return { ok: true, value: { mode: 'write', candidates: [candidateFromGene(selected.asset, opts.outDir)], written: written.value } };
}
function buildDryRunSkillFetchResult(opts) {
    const source = opts.source.kind === 'asset'
        ? `fetch Gene ${opts.source.id}`
        : opts.source.kind === 'signals'
            ? `search Genes by signals ${opts.source.signals.join(',')}`
            : `search Genes by query`;
    const write = opts.write ? ' and would render SKILL.md if a selected Gene is available' : '';
    return {
        mode: 'preview',
        candidates: [],
        dryRun: true,
        message: `HUB_DRY_RUN is set; would ${source}${write}`,
    };
}
async function candidatesFromSearch(hub, opts, outDir) {
    if (opts.source.kind === 'asset')
        return [];
    const query = opts.source.kind === 'query'
        ? { text: opts.source.text, limit: opts.limit }
        : { kind: 'Gene', signalsAny: opts.source.signals, limit: opts.limit };
    const rows = await hub.search(query);
    return rows
        .map((row) => normalizeRemoteGene(row))
        .filter((result) => result.ok)
        .map((result) => candidateFromGene(result.asset, outDir));
}
async function fetchGeneById(hub, id) {
    if (!hub.fetchAssetById)
        return { ok: false, reason: 'unsupported', message: 'configured Hub adapter does not support fetchAssetById' };
    const asset = await hub.fetchAssetById(id);
    if (!asset)
        return { ok: false, reason: 'not_found', message: `Gene asset not found: ${id}` };
    return normalizeRemoteGene(asset, id);
}
function normalizeRemoteGene(asset, requestedId) {
    if (asset.type !== 'Gene')
        return { ok: false, reason: 'unsupported', message: `skill fetch only supports Gene assets, got ${asset.type}` };
    const cleaned = stripHubMetadata(asset);
    const claimed = stringField(cleaned, 'asset_id');
    if (!claimed)
        return { ok: false, reason: 'integrity_error', message: 'remote Gene is missing asset_id' };
    const actual = wire.computeAssetId(cleaned);
    if (!actual || actual !== claimed)
        return { ok: false, reason: 'integrity_error', message: 'remote Gene asset_id failed integrity verification' };
    if (requestedId) {
        if (isContentAssetId(requestedId) && actual !== requestedId)
            return { ok: false, reason: 'integrity_error', message: 'remote Gene asset_id does not match requested asset id' };
        if (!isContentAssetId(requestedId) && stringField(cleaned, 'id') !== requestedId)
            return { ok: false, reason: 'integrity_error', message: 'remote Gene id does not match requested id' };
    }
    return { ok: true, asset: cleaned };
}
function candidateFromGene(gene, outDir) {
    const name = skillNameForGene(gene);
    const candidate = {
        assetId: gene.asset_id,
        name,
        signals: arrayOfStrings(gene['signals_match']),
    };
    const geneId = stringField(gene, 'id');
    if (geneId)
        candidate.geneId = geneId;
    const summary = stringField(gene, 'summary');
    if (summary)
        candidate.summary = summary;
    if (outDir)
        candidate.target = relativeSkillPath(name);
    return candidate;
}
function writeSkill(gene, outDir, force) {
    const name = skillNameForGene(gene);
    const target = relativeSkillPath(name);
    const targetPath = targetSkillPath(outDir, name);
    if (!isInside(resolve(outDir), resolve(targetPath)))
        return { ok: false, reason: 'invalid_arg', message: 'resolved skill target escapes --out directory' };
    if (existsSync(targetPath) && !force)
        return { ok: false, reason: 'conflict', message: `SKILL.md already exists for skill ${name}; use --force to overwrite` };
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, geneToSkillMd(gene, { name }), 'utf8');
    const written = { target, assetId: gene.asset_id, name };
    const geneId = stringField(gene, 'id');
    if (geneId)
        written.geneId = geneId;
    return { ok: true, value: written };
}
function createSkillFetchHubFromEnv(deps, env = deps.env ?? process.env) {
    return createRecipeHubFromEnv(env, deps.connectHub ?? connectPublicHub);
}
function emitSuccess(value, json, io) {
    if (json) {
        io.stdout(JSON.stringify({ ok: true, group: GROUP, ...value }));
        return;
    }
    if (value.dryRun) {
        io.stdout(`skill fetch: dry-run: ${value.message ?? 'Hub calls skipped'}`);
        return;
    }
    io.stdout(`skill fetch: ${value.candidates.length} candidate(s), mode=${value.mode}`);
    for (const c of value.candidates) {
        const gene = c.geneId ? ` gene=${c.geneId}` : '';
        const signals = c.signals.length > 0 ? ` signals=${c.signals.join(',')}` : '';
        const target = c.target ? ` target=${c.target}` : '';
        io.stdout(`  ${c.assetId}${gene} name=${c.name}${signals}${target}`);
        if (c.summary)
            io.stdout(`    ${c.summary}`);
    }
    if (value.written)
        io.stdout(`skill fetch: wrote ${value.written.target}`);
}
function emitFailure(reason, message, json, io) {
    if (json)
        io.stdout(JSON.stringify({ ok: false, group: GROUP, reason, message: redact(message) }));
    else if (reason === 'usage')
        io.stdout(message);
    else
        io.stderr(`skill fetch failed (${reason}): ${redact(message)}`);
    return reason === 'usage' ? 0 : 1;
}
function mapSkillFetchError(err) {
    if (err instanceof AuthError)
        return { reason: 'unauthorized', message: 'Hub authentication failed; run `evolver login` or set EVOMAP_NODE_SECRET' };
    if (err instanceof HubUnreachableError)
        return { reason: 'network', message: 'Hub is unreachable' };
    if (err instanceof HubClientError) {
        if (err.status === 401 || err.status === 403)
            return { reason: 'unauthorized', message: 'Hub authentication failed; run `evolver login` or set EVOMAP_NODE_SECRET' };
        if (err.status === 404)
            return { reason: 'not_found', message: 'Gene asset not found on the hub' };
        if (err.status === 429 || err.status >= 500)
            return { reason: 'network', message: 'Hub is temporarily unavailable' };
        return { reason: 'internal_error', message: 'Hub rejected the skill fetch request' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/credential|login|node_secret|auth|401|403/i.test(msg))
        return { reason: 'unauthorized', message: redact(msg) };
    if (/\b(network|fetch failed|ECONN[A-Z_]*|ENOTFOUND|ETIMEDOUT|hub 5\d\d)\b/i.test(msg))
        return { reason: 'network', message: 'Hub is unreachable' };
    return { reason: 'internal_error', message: redact(msg) };
}
function firstUnknownArg(argv) {
    const valueFlags = new Set(['--asset', '--signals', '--query', '--limit', '--select', '--out']);
    const booleanFlags = new Set(['--write', '--force', '--json', '--help', '-h']);
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token)
            continue;
        if (!token.startsWith('-'))
            return token;
        const eq = token.indexOf('=');
        const flag = eq >= 0 ? token.slice(0, eq) : token;
        if (booleanFlags.has(flag))
            continue;
        if (valueFlags.has(flag)) {
            if (eq < 0)
                i += 1;
            continue;
        }
        return flag;
    }
    return null;
}
function flagValue(args, flag) {
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (!token)
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
function splitList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}
function stripHubMetadata(asset) {
    const out = {};
    for (const [key, value] of Object.entries(asset))
        if (!HUB_METADATA_KEYS.has(key))
            out[key] = value;
    return out;
}
function skillNameForGene(gene) {
    const signals = arrayOfStrings(gene['signals_match']).slice(0, 4).join('-');
    const raw = signals || stringField(gene, 'id') || gene.asset_id.replace(/^sha256:/, '').slice(0, 12);
    return safeSkillName(raw);
}
function safeSkillName(value) {
    const slug = value
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return slug || 'skill';
}
function targetSkillPath(outDir, name) {
    return resolve(outDir, 'skills', safeSkillName(name), 'SKILL.md');
}
function relativeSkillPath(name) {
    return `skills/${safeSkillName(name)}/SKILL.md`;
}
function isInside(parent, child) {
    const rel = relative(parent, child);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}
function arrayOfStrings(value) {
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function isContentAssetId(value) {
    return value.startsWith('sha256:');
}
function redact(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/\b([A-Z][A-Z0-9_]*(?:_SECRET|_TOKEN))\b\s*[:=]\s*["']?[^"',\s;}]+/g, '$1=[redacted]')
        .replace(/\b(authorization|node_secret|nodeSecret|access_token|refresh_token|token|secret)\b\s*[:=]\s*["']?[^"',\s;}]+/gi, '$1=[redacted]')
        .replace(/\bsk-[A-Za-z0-9-]{16,}/g, 'sk-[redacted]')
        .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[redacted]');
}