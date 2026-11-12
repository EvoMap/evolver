import { createContext, runInContext } from 'node:vm';
import { InverseDocumentFrequency, cosineSimilarity, isContentToken, recallTokens } from '../assetstore/recallText.js';
import { computeAssetId } from '../wire/index.js';
const SIMILARITY_FLOOR = 0.3;
const MAX_SIMILAR = 3;
const MAX_REGEX_CHARS = 200;
const FULL_SIGNAL_HITS = 2;
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
const round = (value) => Math.round(value * 100) / 100;
const VARIABLE_QUANTIFIER = /^(?:[*+]|\{\d*,\d*\})/;
function classEnd(source, open) {
    let end = open + 1;
    while (end < source.length && source[end] !== ']')
        end += source[end] === '\\' ? 2 : 1;
    return end;
}
/**
 * A quantified group that contains a quantifier or an alternation, `(a+)+` or `(a|aa)+`: the shapes that can backtrack
 * exponentially on a miss. Deliberately conservative: a safe `(foo|bar)+` is refused too.
 */
function hasNestedQuantifier(source) {
    const outer = [];
    let quantifiedInside = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === '[') {
            index = classEnd(source, index);
            continue;
        }
        if (char === '(') {
            outer.push(quantifiedInside);
            quantifiedInside = false;
            continue;
        }
        if (char === ')') {
            const quantified = VARIABLE_QUANTIFIER.test(source.slice(index + 1));
            if (quantified && quantifiedInside)
                return true;
            quantifiedInside = (outer.pop() ?? false) || quantifiedInside || quantified;
            continue;
        }
        if (char === '|' || VARIABLE_QUANTIFIER.test(source.slice(index)))
            quantifiedInside = true;
    }
    return false;
}
/** A pattern that could hang the probe is treated as never matching rather than run. */
function regexOf(pattern) {
    const match = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
    if (!match || match[1].length > MAX_REGEX_CHARS || hasNestedQuantifier(match[1]))
        return null;
    try {
        return new RegExp(match[1], match[2].replace(/[gy]/g, ''));
    }
    catch {
        return null;
    }
}
const REGEX_BUDGET_MS = 50;
const PROBE_REGEX_BUDGET_MS = 1000;
/**
 * Runs an author's pattern under a time budget: no static check catches every backtracking shape (`a*a*a*…b` has no nesting),
 * so a pattern that cannot finish in time counts as not matching instead of blocking the process. The whole probe shares
 * one budget too, so many signals times many tasks cannot add up to a long block.
 */
function testWithinBudget(regex, text, budget) {
    const timeout = Math.min(REGEX_BUDGET_MS, budget.deadline - Date.now());
    if (timeout <= 0)
        return false;
    const { sandbox } = budget;
    sandbox['source'] = regex.source;
    sandbox['flags'] = regex.flags;
    sandbox['text'] = text;
    try {
        return runInContext('new RegExp(source, flags).test(text)', sandbox, { timeout }) === true;
    }
    catch {
        return false;
    }
}
/** GEP `signals_match` semantics: `/regex/flags`, else `a|b` aliases each matched as a case-insensitive substring. */
function signalPatternMatches(pattern, text, budget) {
    if (/^\/.+\/[a-z]*$/s.test(pattern)) {
        const regex = regexOf(pattern);
        return regex ? testWithinBudget(regex, text, budget) : false;
    }
    const lower = text.toLowerCase();
    return pattern.split('|').map((branch) => branch.trim().toLowerCase()).some((branch) => branch.length > 0 && lower.includes(branch));
}
/**
 * The content-recall reading of a signal, as `localRecall.scoreUnit` applies it: every recall token of the signal (stopwords
 * and one-letter words are already dropped by `recallTokens`) appears among the task's, and one of them is a content token.
 */
function tokenHit(pattern, taskTokens) {
    if (/^\/.+\/[a-z]*$/s.test(pattern))
        return false;
    return pattern.split('|').some((branch) => {
        const tokens = recallTokens(branch);
        return tokens.some(isContentToken) && tokens.every((token) => taskTokens.has(token));
    });
}
function describe(gene) {
    return recallTokens([String(gene['summary'] ?? ''), ...strings(gene['strategy']), ...strings(gene['signals_match'])].join('\n'));
}
const contentIdOf = (gene) => (typeof gene['asset_id'] === 'string' ? gene['asset_id'] : computeAssetId(gene));
function titleOf(gene) {
    const meta = gene['generation_meta'] && typeof gene['generation_meta'] === 'object' ? gene['generation_meta'] : {};
    return String(meta['title'] || gene['summary'] || gene['id'] || '');
}
/**
 * Would a task trigger this Gene, and which local Genes already say the same thing. Similarity is the IDF-weighted
 * token cosine content recall uses, over summary + strategy + signals, with the local store as the corpus: the probed
 * tasks weigh the task scores only, so the similar list does not change with them.
 */
export function probeGene(gene, tasks, local) {
    const own = describe(gene);
    const ownId = contentIdOf(gene);
    const others = local.filter((candidate) => !ownId || contentIdOf(candidate.gene) !== ownId);
    const genes = [own, ...others.map((candidate) => describe(candidate.gene))];
    const idfOf = (documents) => new InverseDocumentFrequency(documents.map((tokens) => new Set(tokens)));
    const idf = idfOf([...genes, ...tasks.map(recallTokens)]);
    const geneIdf = idfOf(genes);
    const signals = strings(gene['signals_match']);
    const budget = { sandbox: createContext({}), deadline: Date.now() + PROBE_REGEX_BUDGET_MS };
    const probed = tasks.map((text) => {
        const taskTokens = recallTokens(text);
        const tokenSet = new Set(taskTokens);
        const matchedSignals = signals.filter((signal) => signalPatternMatches(signal, text, budget) || tokenHit(signal, tokenSet));
        const coverage = Math.min(1, matchedSignals.length / FULL_SIGNAL_HITS);
        const score = round(Math.min(1, coverage * 0.8 + cosineSimilarity(taskTokens, own, idf) * 0.2));
        return { text, matched: matchedSignals.length > 0, matchedSignals, score };
    });
    const similar = others
        .map((candidate, index) => ({ candidate, similarity: round(cosineSimilarity(own, genes[index + 1], geneIdf)) }))
        .filter(({ similarity }) => similarity >= SIMILARITY_FLOOR)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SIMILAR)
        .map(({ candidate, similarity }) => ({
        assetId: contentIdOf(candidate.gene) ?? '', id: String(candidate.gene['id'] ?? ''), title: titleOf(candidate.gene),
        similarity, state: candidate.state,
    }));
    return { tasks: probed, similar };
}