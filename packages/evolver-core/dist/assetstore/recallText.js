const HAN_RUN = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;
const HAN = /\p{Script=Han}/u;
const MIN_LATIN_TOKEN_CHARS = 2;
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have', 'how', 'if', 'in',
    'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to',
    'using', 'use', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your', 'not', 'no', 'all',
    'any', 'each', 'than', 'so', 'but', 'they', 'them', 'he', 'she', 'his', 'her', 'my', 'me', 'i', 'up', 'out', 'also',
]);
function stem(word) {
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
        return word.slice(0, -1);
    return word;
}
function hanBigrams(run) {
    const chars = Array.from(run);
    if (chars.length === 1)
        return chars;
    const out = [];
    for (let i = 0; i < chars.length - 1; i += 1)
        out.push(chars[i] + chars[i + 1]);
    return out;
}
/** Recall tokens: lower-cased Latin words without stopwords (plural `s` folded), Han text as character bigrams. */
export function recallTokens(text) {
    const out = [];
    for (const match of text.normalize('NFKC').toLowerCase().matchAll(HAN_RUN)) {
        const run = match[0];
        if (HAN.test(run))
            out.push(...hanBigrams(run));
        else if (run.length >= MIN_LATIN_TOKEN_CHARS && !STOPWORDS.has(run))
            out.push(stem(run));
    }
    return out;
}
const PATH = /(?:[A-Za-z]:)?(?:[\w.-]*[\\/])+[\w.-]+/g;
const FILE_NAME = /\b[\w-]+(?:\.[\w-]+)+\b|\.[a-z][\w.-]*\b/gi;
const FILE_EXTENSION = /\.[a-z][a-z0-9]{0,5}(?:\.|$)/i;
/** The prompt without the paths and file names it lists: they name this project's files, not the kind of task. */
export function withoutFileNames(text) {
    return text.replace(PATH, ' ').replace(FILE_NAME, (name) => name.startsWith('.') || FILE_EXTENSION.test(name) ? ' ' : name);
}
const MIN_CONTENT_TOKEN_CHARS = 3;
const DIGITS = /^\d+$/;
/** A token that names something on its own: Han text, or a Latin word of three or more characters that is not a number. */
export function isContentToken(token) {
    return HAN.test(token) || (token.length >= MIN_CONTENT_TOKEN_CHARS && !DIGITS.test(token));
}
// A small store says little about which words are common: it is read as if this many unrelated documents, none of
// them containing the word, stood beside it, so two copies of one task in a fresh store still look specific.
const BACKGROUND_DOCUMENTS = 50;
export class InverseDocumentFrequency {
    documentFrequency = new Map();
    documents;
    constructor(documents) {
        this.documents = Math.max(documents.length, BACKGROUND_DOCUMENTS);
        for (const tokens of documents) {
            for (const token of tokens)
                this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        }
    }
    weight(token) {
        return Math.log((this.documents + 1) / ((this.documentFrequency.get(token) ?? 0) + 1)) + 1;
    }
    /** Weight relative to a token no indexed document contains, in (0, 1]. */
    specificity(token) {
        return this.weight(token) / (Math.log(this.documents + 1) + 1);
    }
}
function weightedVector(tokens, idf) {
    const vector = new Map();
    for (const token of tokens)
        vector.set(token, (vector.get(token) ?? 0) + 1);
    for (const [token, count] of vector)
        vector.set(token, (1 + Math.log(count)) * idf.weight(token));
    return vector;
}
export function cosineSimilarity(left, right, idf) {
    if (left.length === 0 || right.length === 0)
        return 0;
    const a = weightedVector(left, idf);
    const b = weightedVector(right, idf);
    let dot = 0;
    for (const [token, value] of a)
        dot += value * (b.get(token) ?? 0);
    const norm = (vector) => Math.sqrt([...vector.values()].reduce((sum, v) => sum + v * v, 0));
    return dot / (norm(a) * norm(b));
}
export function jaccard(left, right) {
    if (left.size === 0 && right.size === 0)
        return 0;
    let shared = 0;
    for (const token of left)
        if (right.has(token))
            shared += 1;
    return shared / (left.size + right.size - shared);
}