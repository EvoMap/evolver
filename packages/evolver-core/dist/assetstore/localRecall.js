import { verifyAssetId } from '../wire/index.js';
import { signalsOf } from './localJsonl.js';
import { InverseDocumentFrequency, cosineSimilarity, isContentToken, jaccard, recallTokens, withoutFileNames } from './recallText.js';
/** What one injected strategy may cost: hosts drop a longer one outright rather than cut it. */
export const RECALL_STRATEGY_BUDGET_CHARS = 4000;
const STEP_MAX_CHARS = 400;
const MIN_STRATEGY_STEPS = 4;
const DEFAULT_LIMIT = 1;
// A recalled Gene that matched on one signal made dsh runs 92%-328% more expensive in the benchmark, while two or more
// matched signals saved 26%: a single hit is not evidence of the same kind of task.
const MIN_SIGNAL_HITS = 2;
// A Gene no local Capsule vouches for (cached from the Hub, imported) was not distilled from work on this machine;
// the Hub's own recall already offers such generic skills, so locally it needs more evidence.
const MIN_SIGNAL_HITS_WITHOUT_LOCAL_CAPSULE = 3;
// A phrase whose words most indexed assets share ("data", "file") says nothing about this task.
const MIN_SIGNAL_SPECIFICITY = 0.5;
// One word ("timeout", "csv") is found in many unrelated prompts; alone it must be rare across the store to count.
const MIN_WORD_SIGNAL_SPECIFICITY = 0.7;
const MIN_PROMPT_SIMILARITY = 0.3;
const DUPLICATE_PROFILE_OVERLAP = 0.5;
const REUSE_WEIGHT = 0.5;
const PRUNE_AFTER_FAILURES = 3;
const SAME_PROJECT_BONUS = 0.2;
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
}
function contentOf(capsule) {
    const content = capsule['content'];
    return content && typeof content === 'object' && !Array.isArray(content) ? content : {};
}
function triggerPromptOf(capsule) {
    const context = capsule['trigger_context'];
    if (!context || typeof context !== 'object')
        return '';
    const prompt = context['prompt'];
    return typeof prompt === 'string' ? prompt : '';
}
/** Characters a host injects for these steps: each step is cut to STEP_MAX_CHARS. */
export function injectedChars(lines) {
    return lines.reduce((total, line) => total + Math.min(line.trim().length, STEP_MAX_CHARS), 0);
}
function capsulesByGene(records) {
    const byGene = new Map();
    for (const record of records) {
        if (record.type !== 'Capsule')
            continue;
        const gene = stringField(record, 'gene');
        if (!gene)
            continue;
        byGene.set(gene, [...(byGene.get(gene) ?? []), record]);
    }
    return byGene;
}
// A draft keeps its project in its own content; a published Capsule's lives in the store's private context, and only
// a context naming this hash-verified Capsule and Gene pair counts.
function projectNotesOf(gene, capsule, contexts) {
    const own = contentOf(capsule)['project_fingerprint'];
    const drafted = typeof own === 'string' && own ? [{ project: own, notes: stringList(contentOf(capsule)['project_notes']) }] : [];
    const matching = (contexts.get(capsule.asset_id) ?? [])
        .filter((context) => context.geneAssetId === gene.asset_id && context.projectFingerprint);
    const stored = matching.length > 0 && capsule['gene'] === gene.asset_id && verifyAssetId(gene) && verifyAssetId(capsule)
        ? matching.map((context) => ({ project: context.projectFingerprint, notes: [...context.notes] })) : [];
    return [...drafted, ...stored];
}
function recallUnit(gene, order, capsules, contexts) {
    const signals = [...new Set([...signalsOf(gene), ...capsules.flatMap(signalsOf)].map((signal) => signal.trim()).filter(Boolean))];
    const summaries = [stringField(gene, 'summary'), ...capsules.map((capsule) => stringField(capsule, 'summary'))];
    const notesByProject = new Map();
    const projects = new Set();
    for (const { project, notes } of capsules.flatMap((capsule) => projectNotesOf(gene, capsule, contexts))) {
        projects.add(project);
        notesByProject.set(project, [...new Set([...(notesByProject.get(project) ?? []), ...notes])]);
    }
    const description = recallTokens([...signals, ...summaries].join('\n'));
    return {
        gene,
        order,
        signals,
        prompts: capsules.map(triggerPromptOf).filter(Boolean).map(recallTokens),
        description,
        profile: new Set(description),
        projects,
        notesByProject,
        strategyChars: injectedChars(stringList(gene['strategy'])),
        distilledHere: capsules.length > 0,
    };
}
function injectable(gene) {
    const strategy = stringList(gene['strategy']);
    return strategy.length >= MIN_STRATEGY_STEPS && injectedChars(strategy) <= RECALL_STRATEGY_BUDGET_CHARS;
}
function recallUnits(records, contexts) {
    const byGene = capsulesByGene(records);
    const byCapsule = new Map();
    for (const context of contexts)
        byCapsule.set(context.capsuleAssetId, [...(byCapsule.get(context.capsuleAssetId) ?? []), context]);
    const units = [];
    records.forEach((record, order) => {
        if (record.type !== 'Gene' || !injectable(record))
            return;
        const capsules = [...(byGene.get(stringField(record, 'id')) ?? []), ...(byGene.get(record.asset_id) ?? [])];
        units.push(recallUnit(record, order, [...new Set(capsules)], byCapsule));
    });
    return units;
}
function scoreUnit(unit, query, querySet, idf) {
    const signalHits = unit.signals.filter((signal) => {
        const tokens = recallTokens(signal);
        if (!tokens.some(isContentToken) || !tokens.every((token) => querySet.has(token)))
            return false;
        const floor = tokens.length === 1 ? MIN_WORD_SIGNAL_SPECIFICITY : MIN_SIGNAL_SPECIFICITY;
        return tokens.reduce((sum, token) => sum + idf.specificity(token), 0) / tokens.length >= floor;
    });
    const promptSimilarity = Math.max(0, ...unit.prompts.map((prompt) => cosineSimilarity(query, prompt, idf)));
    const descriptionSimilarity = cosineSimilarity(query, unit.description, idf);
    const signalStrength = Math.min(1, signalHits.length / (2 * MIN_SIGNAL_HITS));
    const relevance = Math.min(1, Math.max(promptSimilarity, signalStrength) * 0.7 + descriptionSimilarity * 0.3);
    return { unit, relevance, signalHits, promptSimilarity };
}
// A store keeps every redistillation of a task, all with the task's prompt; counted once each, they would make that
// prompt's words look common and bury the very tasks that were distilled most often.
function distinctDocuments(units) {
    const documents = new Map();
    for (const tokens of units.flatMap((unit) => [unit.description, ...unit.prompts])) {
        const set = new Set(tokens);
        documents.set([...set].sort().join(' '), set);
    }
    return [...documents.values()];
}
function isStrong(scored) {
    const hitsNeeded = scored.unit.distilledHere ? MIN_SIGNAL_HITS : MIN_SIGNAL_HITS_WITHOUT_LOCAL_CAPSULE;
    return scored.signalHits.length >= hitsNeeded || scored.promptSimilarity >= MIN_PROMPT_SIMILARITY;
}
function idsOf(unit) {
    return [unit.gene.asset_id, stringField(unit.gene, 'id')].filter(Boolean);
}
// A redistilled Gene keeps its logical id, so near-duplicates can share one: each id's record counts once per cluster.
function tallyOfIds(ids, reuse) {
    let success = 0;
    let negative = 0;
    for (const id of ids) {
        success += reuse?.get(id)?.success ?? 0;
        negative += reuse?.get(id)?.negative ?? 0;
    }
    return { success, negative };
}
function tallyOf(unit, reuse) {
    return tallyOfIds(new Set(idsOf(unit)), reuse);
}
function sentiment(tally) {
    return (tally.success - tally.negative) / (tally.success + tally.negative + 2);
}
function projectKey(unit) {
    return [...unit.projects].sort().join('|');
}
function clusterNearDuplicates(scored, reuse) {
    const clusters = [];
    for (const candidate of scored) {
        // Only one known project's redistillations are one memory; Genes of no known project stay apart.
        const key = projectKey(candidate.unit);
        const home = key ? clusters.find((cluster) => projectKey(cluster.members[0].unit) === key
            && jaccard(cluster.members[0].unit.profile, candidate.unit.profile) >= DUPLICATE_PROFILE_OVERLAP) : undefined;
        const tally = tallyOf(candidate.unit, reuse);
        if (home) {
            home.members.push(candidate);
            home.tallies.push(tally);
        }
        else {
            clusters.push({ members: [candidate], tallies: [tally], reuse: tally });
        }
    }
    for (const cluster of clusters) {
        cluster.reuse = tallyOfIds(new Set(cluster.members.flatMap((member) => idsOf(member.unit))), reuse);
    }
    return clusters;
}
function representativeIndex(cluster) {
    let best = 0;
    cluster.members.forEach((member, index) => {
        const lead = cluster.members[best];
        const ahead = sentiment(cluster.tallies[index]) - sentiment(cluster.tallies[best]);
        if (ahead > 0 || (ahead === 0 && member.unit.order > lead.unit.order))
            best = index;
    });
    return best;
}
// Near-duplicates of one project are one memory: the notes any of them wrote all describe that project.
function clusterNotes(cluster, project) {
    if (!project)
        return [];
    return [...new Set(cluster.members.flatMap((member) => member.unit.notesByProject.get(project) ?? []))];
}
function notesWithinBudget(unit, notes) {
    const kept = [];
    let spent = unit.strategyChars;
    for (const note of notes) {
        const line = note.trim().slice(0, STEP_MAX_CHARS);
        if (spent + line.length > RECALL_STRATEGY_BUDGET_CHARS)
            continue;
        kept.push(line);
        spent += line.length;
    }
    return kept;
}
function hitOf(cluster, project) {
    const { reuse } = cluster;
    if (reuse.success === 0 && reuse.negative >= PRUNE_AFTER_FAILURES)
        return null;
    const chosen = cluster.members[representativeIndex(cluster)];
    const relevance = Math.max(...cluster.members.map((member) => member.relevance));
    const projectMatch = project !== undefined && chosen.unit.projects.has(project);
    return {
        gene: chosen.unit.gene,
        relevance,
        score: relevance * (1 + REUSE_WEIGHT * sentiment(reuse)) * (projectMatch ? 1 + SAME_PROJECT_BONUS : 1),
        signalHits: chosen.signalHits,
        promptSimilarity: chosen.promptSimilarity,
        projectMatch,
        reuse,
        mergedAssetIds: cluster.members.filter((member) => member !== chosen).map((member) => member.unit.gene.asset_id),
        projectNotes: projectMatch ? notesWithinBudget(chosen.unit, clusterNotes(cluster, project)) : [],
    };
}
/**
 * Picks the local Genes worth injecting for a prompt, or none. Only a strong match counts (two specific signals, or a
 * prompt like the one the Gene was distilled from), weighed against the whole local pool so the bar rises with it;
 * near-duplicates of one project collapse into one candidate carrying their combined reuse record; proven reuse lifts
 * a candidate, repeated failure without a success drops it, and a Gene from the same project gets a small lift.
 */
export function recallLocalAssets(records, query, reuse, contexts = []) {
    const units = recallUnits(records, contexts);
    const queryTokens = recallTokens(query.text);
    if (units.length === 0)
        return { hits: [], considered: 0, refusal: 'no_candidates' };
    if (queryTokens.length === 0)
        return { hits: [], considered: units.length, refusal: 'empty_query' };
    const idf = new InverseDocumentFrequency(distinctDocuments(units));
    const querySet = new Set(recallTokens(withoutFileNames(query.text)));
    const scored = units.map((unit) => scoreUnit(unit, queryTokens, querySet, idf)).sort((left, right) => right.relevance - left.relevance);
    const strong = scored.filter(isStrong);
    const hits = clusterNearDuplicates(strong, reuse).map((cluster) => hitOf(cluster, query.projectFingerprint))
        .filter((hit) => hit !== null).sort((left, right) => right.score - left.score).slice(0, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    if (hits.length > 0)
        return { hits, considered: units.length };
    const closest = scored[0];
    return { hits, considered: units.length, refusal: strong.length > 0 ? 'pruned' : 'weak_match', closest: { assetId: closest.unit.gene.asset_id,
            relevance: closest.relevance, promptSimilarity: closest.promptSimilarity, signalHits: closest.signalHits } };
}