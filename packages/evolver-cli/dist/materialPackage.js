import { readFileSync } from 'node:fs';
import { assetstore, algo, events, hub, material as materialNs, schema, signals } from '@evomap/evolver-core';
import { runtimeSessionSourcesForMaterial, runtimeSessionSourcesFromMaterialPayload } from './materialSnapshot.js';
import { draftGeneCandidate } from './distillPrimitives.js';
import { assessDraftAdmissionFromStore } from './distillAdmission.js';
import { reviewLedgerForStore } from './reviewFilter.js';
import { buildPublishBundle } from './cliContracts.js';
const GROUP = 'material.package_gene';
const USAGE = 'usage: evolver material package-gene --material <id> [--write] [--json]';
function parseMaterialArgs(argv) {
    if (argv.includes('--help') || argv.includes('-h'))
        return { ok: false, message: USAGE };
    const unknown = argv.find((arg) => arg.startsWith('--') && !['--material', '--write', '--json'].includes(arg) && !arg.startsWith('--material='));
    if (unknown)
        return { ok: false, message: `unsupported material argument: ${unknown}` };
    const materialId = flagValue(argv, '--material');
    if (!materialId)
        return { ok: false, message: 'material package-gene requires --material <id>' };
    return { ok: true, value: { materialId, write: argv.includes('--write'), json: argv.includes('--json') } };
}
function flagValue(argv, flag) {
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === flag) {
            const next = argv[i + 1];
            return next && !next.startsWith('--') ? next.trim() : undefined;
        }
        if (token?.startsWith(`${flag}=`)) {
            const value = token.slice(flag.length + 1).trim();
            return value || undefined;
        }
    }
    return undefined;
}
function assetIdOf(asset) {
    return String(asset.asset_id);
}
function assetLogicalId(asset) {
    const value = asset['id'];
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function summarizeGene(asset, review, written, reviewState) {
    const assetId = assetIdOf(asset);
    const record = review.get(assetId);
    return {
        type: 'Gene',
        assetId,
        ...(assetLogicalId(asset) ? { id: assetLogicalId(asset) } : {}),
        reviewState: reviewState ?? record?.state ?? 'default_approved',
        ...(written !== undefined ? { written } : {}),
    };
}
function summarizeCapsule(asset) {
    const outcome = asset['outcome'] && typeof asset['outcome'] === 'object' ? asset['outcome'] : {};
    const status = typeof outcome['status'] === 'string' ? outcome['status'] : undefined;
    return {
        type: 'Capsule',
        assetId: assetIdOf(asset),
        ...(assetLogicalId(asset) ? { id: assetLogicalId(asset) } : {}),
        ...(status ? { outcomeStatus: status } : {}),
    };
}
async function findAssetByRef(store, kind, ref) {
    if (!ref)
        return null;
    const direct = await store.get(ref);
    if (direct?.type === kind)
        return direct;
    const rows = await store.list(kind, 10_000);
    return rows.find((row) => row.asset_id === ref || row['id'] === ref) ?? null;
}
function terminalForMaterial(rootEvents, materialId) {
    const cycleIds = [];
    for (const event of rootEvents) {
        if (event.type !== 'cycle.consumed')
            continue;
        const payload = event.payload;
        if (payload?.['materialId'] !== materialId)
            continue;
        const value = payload['cycleId'];
        if (typeof value === 'string' && value.trim())
            cycleIds.push(value);
    }
    const defaultCycleId = `autoexec-material-${materialId}`;
    if (!cycleIds.includes(defaultCycleId))
        cycleIds.push(defaultCycleId);
    const cycleIdSet = new Set(cycleIds);
    const producedCapsules = new Map();
    for (const event of rootEvents) {
        if (event.type !== 'capsule.produced' && event.type !== 'evolution_event.projected')
            continue;
        const payload = event.payload;
        if (!payload)
            continue;
        const cycleId = typeof payload['cycleId'] === 'string' ? payload['cycleId'] : undefined;
        if (!cycleId || !cycleIdSet.has(cycleId))
            continue;
        const value = payload['capsuleId'];
        if (typeof value === 'string' && value.trim())
            producedCapsules.set(cycleId, value);
    }
    let terminal = null;
    for (const event of rootEvents) {
        if (event.type !== 'cycle.solidified' && event.type !== 'cycle.failed' && event.type !== 'cycle.aborted')
            continue;
        const payload = event.payload;
        if (!payload)
            continue;
        const cycleId = typeof payload['cycleId'] === 'string' ? payload['cycleId'] : undefined;
        if (!cycleId || !cycleIdSet.has(cycleId))
            continue;
        const geneRef = typeof payload['gene'] === 'string' ? payload['gene'] : undefined;
        const capsuleId = typeof payload['capsuleId'] === 'string' ? payload['capsuleId'] : producedCapsules.get(cycleId);
        terminal = {
            cycleId,
            status: event.type === 'cycle.solidified' ? 'solidified' : event.type === 'cycle.failed' ? 'failed' : 'aborted',
            ...(geneRef ? { geneRef } : {}),
            ...(capsuleId ? { capsuleId } : {}),
        };
    }
    return terminal;
}
function geneMatchesCapsule(gene, capsule) {
    const capsuleGene = capsule['gene'];
    return capsuleGene === gene.asset_id || capsuleGene === gene['id'];
}
function redactRuntimeSessionSources(sources) {
    return sources.map((source) => ({
        ...source,
        label: hub.redactString(source.label),
        ...(source.sessionId ? { sessionId: hub.redactString(source.sessionId) } : {}),
        turns: source.turns.map((turn) => ({
            ...turn,
            text: hub.redactString(turn.text ?? ''),
            ...(turn.toolName ? { toolName: hub.redactString(turn.toolName) } : {}),
            ...(turn.errorMessage ? { errorMessage: hub.redactString(turn.errorMessage) } : {}),
            ...(turn.toolResult ? { toolResult: hub.redactString(turn.toolResult) } : {}),
        })),
    }));
}
function packageRuntimeSessionSourcesForMaterial(material, readSource) {
    const snapshotSources = runtimeSessionSourcesFromMaterialPayload(material.payload);
    if (snapshotSources.length > 0)
        return redactRuntimeSessionSources(snapshotSources);
    return redactRuntimeSessionSources(runtimeSessionSourcesForMaterial(material, readSource));
}
async function findCapsuleForTerminal(store, terminal) {
    if (terminal.capsuleId)
        return findAssetByRef(store, 'Capsule', terminal.capsuleId);
    const rows = await store.list('Capsule', 10_000);
    return rows.find((capsule) => {
        const capsuleCycleId = capsule['cycleId'] ?? capsule['cycle_id'];
        return typeof capsuleCycleId === 'string' && capsuleCycleId === terminal.cycleId;
    }) ?? null;
}
async function draftGeneFromMaterial(material, store, readSource) {
    if (material.sourceKind !== 'runtime_session' || material.kind !== 'session_log') {
        return { blocker: 'unsupported_material', message: 'only runtime session material can be packaged into a Gene' };
    }
    let sources;
    try {
        sources = packageRuntimeSessionSourcesForMaterial(material, readSource);
    }
    catch {
        return { blocker: 'source_unavailable', message: 'material source is unavailable and no usable snapshot exists' };
    }
    if (sources.length === 0)
        return { blocker: 'source_unavailable', message: 'material has no usable runtime session source', sourceCount: 0, signalCount: 0 };
    let signalCount = 0;
    let sawCandidate = false;
    let lastIntakeError = '';
    for (const source of sources) {
        const sigs = signals.extractSignals(source.turns);
        signalCount += sigs.length;
        const candidate = draftGeneCandidate(source.turns, sigs, source.agent);
        if (!candidate)
            continue;
        sawCandidate = true;
        const normalized = algo.intakeGene(candidate, []);
        if (!normalized.ok || !normalized.gene) {
            lastIntakeError = normalized.errors.join('; ') || 'gene intake rejected the candidate';
            continue;
        }
        const alreadyStored = await store.get(normalized.gene.asset_id);
        if (alreadyStored?.type === 'Gene') {
            return { gene: alreadyStored, sourceCount: sources.length, signalCount, stored: true };
        }
        const { admission, existing } = await assessDraftAdmissionFromStore(store, candidate);
        if (!admission.admit) {
            lastIntakeError = admission.reason ?? 'gene draft admission rejected the candidate';
            continue;
        }
        const intake = algo.intakeGene(candidate, existing);
        if (!intake.ok || !intake.gene) {
            lastIntakeError = intake.errors.join('; ') || 'gene intake rejected the candidate';
            continue;
        }
        return { gene: intake.gene, sourceCount: sources.length, signalCount, stored: false };
    }
    if (sawCandidate) {
        return {
            blocker: 'gene_intake_rejected',
            message: lastIntakeError || 'gene intake rejected every candidate',
            sourceCount: sources.length,
            signalCount,
        };
    }
    return { blocker: 'draft_unavailable', message: 'material does not contain enough strong signals and strategy turns', sourceCount: sources.length, signalCount };
}
async function alreadyAudited(ingestor, assetId) {
    return ingestor.readAll().some((event) => {
        if (event.type !== 'gene.distilled')
            return false;
        const payload = event.payload;
        return payload?.['assetId'] === assetId;
    });
}
async function writeDraftGene(gene, material, store, review, ingestor) {
    const assetId = String(gene.asset_id);
    const existing = await store.get(assetId);
    if (existing?.type === 'Gene') {
        return { gene: existing, written: false };
    }
    if (!await alreadyAudited(ingestor, assetId)) {
        await ingestor.ingest({
            type: 'gene.distilled',
            payload: {
                geneId: gene['id'],
                assetId,
                category: gene['category'],
                source: 'material-package',
                materialId: material.materialId,
            },
            human: { title: `material-packaged gene ${String(gene['id'] ?? assetId)} (UNPROVEN - awaiting review)`, severity: 'info' },
            actor: { kind: 'machine', id: 'material-package' },
        });
    }
    review.quarantineIfAbsent(assetId, 'material-packaged gene - review before publish/reuse');
    const put = await store.put(gene);
    const stored = await store.get(assetId) ?? gene;
    return { gene: stored, written: put.stored };
}
async function validatePublishBundle(gene, capsule, store, env) {
    const bundle = await buildPublishBundle([String(gene.asset_id), String(capsule.asset_id)], { assetStore: store, env });
    if (!bundle.ok)
        return 'publish_bundle_invalid';
    return bundle.blockReasons.length > 0 ? 'publish_bundle_blocked' : null;
}
export async function buildMaterialGenePackage(opts, deps = {}) {
    const materialStore = deps.materialStore ?? new materialNs.MaterialStore({ path: events.materialStorePath() });
    const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const review = deps.review ?? reviewLedgerForStore(store);
    const ingestor = deps.ingestor ?? new events.Ingestor({ path: events.rootEventsPath() });
    const mode = opts.write ? 'write' : 'preview';
    const material = materialStore.get(opts.materialId);
    if (!material) {
        return {
            code: 1,
            result: { ok: false, group: GROUP, mode, materialId: opts.materialId, publishable: false, blockers: ['material_not_found'], message: 'material not found' },
        };
    }
    const base = {
        group: GROUP,
        mode,
        materialId: material.materialId,
        sourceKind: material.sourceKind,
        kind: material.kind,
    };
    if (material.sourceKind !== 'runtime_session' || material.kind !== 'session_log') {
        return { code: 1, result: { ok: false, ...base, publishable: false, blockers: ['unsupported_material'], message: 'only runtime session material can be packaged into a Gene' } };
    }
    const terminal = terminalForMaterial(ingestor.readAll(), material.materialId);
    if (terminal) {
        const terminalBase = { ...base, mode: 'preview' };
        if (terminal.status !== 'solidified') {
            return { code: 1, result: { ok: false, ...terminalBase, publishable: false, blockers: ['cycle_not_solidified'], message: 'material terminal cycle did not solidify Capsule evidence' } };
        }
        const capsule = await findCapsuleForTerminal(store, terminal);
        if (!capsule) {
            return { code: 1, result: { ok: false, ...terminalBase, publishable: false, blockers: ['capsule_not_found'], message: 'terminal cycle references a missing capsule' } };
        }
        const capsuleGeneRef = typeof capsule['gene'] === 'string' ? capsule['gene'] : undefined;
        const geneFromCapsule = await findAssetByRef(store, 'Gene', capsuleGeneRef);
        const geneFromTerminal = await findAssetByRef(store, 'Gene', terminal.geneRef);
        const gene = geneFromCapsule ?? (geneFromTerminal && geneMatchesCapsule(geneFromTerminal, capsule) ? geneFromTerminal : null);
        if (!gene) {
            return { code: 1, result: { ok: false, ...terminalBase, capsule: summarizeCapsule(capsule), publishable: false, blockers: ['gene_not_found'], message: 'terminal cycle references a missing Gene asset' } };
        }
        if (!geneMatchesCapsule(gene, capsule)) {
            return { code: 1, result: { ok: false, ...terminalBase, gene: summarizeGene(gene, review), capsule: summarizeCapsule(capsule), publishable: false, blockers: ['capsule_gene_mismatch'], message: 'capsule does not bind to the selected Gene' } };
        }
        const bundleBlocker = await validatePublishBundle(gene, capsule, store, deps.env ?? process.env);
        if (bundleBlocker) {
            return { code: 1, result: { ok: false, ...terminalBase, gene: summarizeGene(gene, review), capsule: summarizeCapsule(capsule), publishable: false, blockers: [bundleBlocker], message: 'Gene + Capsule bundle is not publishable' } };
        }
        const publishCommand = `evolver publish --asset ${gene.asset_id} --asset ${capsule.asset_id} --json`;
        return {
            code: 0,
            result: {
                ok: true,
                ...terminalBase,
                gene: summarizeGene(gene, review),
                capsule: summarizeCapsule(capsule),
                publishable: true,
                blockers: [],
                publishCommand,
            },
        };
    }
    const draft = await draftGeneFromMaterial(material, store, deps.readSource ?? ((path) => readFileSync(path, 'utf8')));
    if ('blocker' in draft) {
        return {
            code: 1,
            result: {
                ok: false,
                ...base,
                publishable: false,
                blockers: [draft.blocker],
                message: draft.message,
                ...(draft.sourceCount !== undefined ? { sourceCount: draft.sourceCount } : {}),
                ...(draft.signalCount !== undefined ? { signalCount: draft.signalCount } : {}),
            },
        };
    }
    let gene = draft.gene;
    let written;
    if (opts.write) {
        try {
            const write = await writeDraftGene(gene, material, store, review, ingestor);
            gene = write.gene;
            written = write.written;
        }
        catch {
            return { code: 1, result: { ok: false, ...base, publishable: false, blockers: ['write_failed'], message: 'failed to write Gene draft' } };
        }
    }
    return {
        code: 0,
        result: {
            ok: true,
            ...base,
            gene: summarizeGene(gene, review, written, !opts.write && !draft.stored ? 'unproven_preview' : undefined),
            publishable: false,
            blockers: ['missing_capsule_evidence'],
            sourceCount: draft.sourceCount,
            signalCount: draft.signalCount,
            message: 'Gene draft is available, but publish requires terminal Capsule evidence from cycle',
        },
    };
}
function emitResult(result, json, stdout) {
    if (json) {
        stdout(JSON.stringify(result));
        return;
    }
    const status = result.publishable ? 'publishable=true' : `publishable=false blockers=${result.blockers.join(',') || 'none'}`;
    stdout(`material package-gene: material=${result.materialId ?? 'unknown'} mode=${result.mode} ${status}`);
    if (result.gene) {
        const review = result.gene.reviewState ? ` review=${result.gene.reviewState}` : '';
        const written = result.gene.written !== undefined ? ` written=${result.gene.written}` : '';
        stdout(`  gene: ${result.gene.id ?? result.gene.assetId} asset=${result.gene.assetId}${review}${written}`);
    }
    if (result.capsule) {
        const outcome = result.capsule.outcomeStatus ? ` outcome=${result.capsule.outcomeStatus}` : '';
        stdout(`  capsule: ${result.capsule.id ?? result.capsule.assetId} asset=${result.capsule.assetId}${outcome}`);
    }
    if (result.publishCommand)
        stdout(`  publish: ${result.publishCommand}`);
    if (result.message)
        stdout(`  note: ${result.message}`);
}
function emitUsage(message, json, stdout, stderr) {
    if (message === USAGE) {
        stdout(USAGE);
        return 0;
    }
    if (json)
        stdout(JSON.stringify({ ok: false, group: GROUP, mode: 'preview', publishable: false, blockers: ['usage'], message }));
    else
        stderr(`${message}\n${USAGE}`);
    return 1;
}
export async function runMaterialCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
    const stderr = deps.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
    const sub = argv[0];
    if (sub !== 'package-gene') {
        if (sub === '--help' || sub === '-h') {
            stdout(USAGE);
            return 0;
        }
        stderr(`material subcommand must be package-gene\n${USAGE}`);
        return 1;
    }
    const parsed = parseMaterialArgs(argv.slice(1));
    if (!parsed.ok)
        return emitUsage(parsed.message, argv.includes('--json'), stdout, stderr);
    const { result, code } = await buildMaterialGenePackage(parsed.value, deps);
    emitResult(result, parsed.value.json, stdout);
    return code;
}