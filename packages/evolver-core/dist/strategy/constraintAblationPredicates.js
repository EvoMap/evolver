const FACTUAL_TAIL_PREFIX_TERMS = new Set([
    'after', 'although', 'as', 'because', 'before', 'however', 'since', 'than', 'though',
    'whereas', 'yet',
]);
const RELATIVE_TERMS = new Set(['that', 'which', 'who']);
const SUBORDINATOR_TERMS = new Set(['after', 'as', 'before']);
const NOMINAL_MODIFIER_TERMS = new Set([
    'access', 'audit', 'backup', 'cold', 'data', 'offline', 'ongoing',
    'policy', 'remote', 'secure', 'security', 'token',
]);
const NOMINAL_HEAD_TERMS = new Set([
    'access', 'approval', 'archive', 'audit', 'auditor', 'credentials', 'data', 'details',
    'leak', 'leaks', 'metadata', 'policy', 'receipt', 'records', 'request', 'review', 'server',
    'storage', 'system', 'transit',
]);
const MATRIX_NOMINAL_COLLOCATIONS = new Set(['access:policy']);
const OBJECT_COORDINATOR_TERMS = new Set(['and', 'or', 'then']);
const FACTUAL_COORDINATOR_TERMS = new Set(['and', 'but', 'then']);
const TRAILING_MODIFIER_TERMS = new Set([
    'earlier', 'here', 'now', 'soon', 'today', 'tonight', 'there', 'yesterday',
]);
const MATRIX_PREDICATE_TERMS = new Set([
    'arrive', 'arrives', 'become', 'becomes', 'exist', 'exists', 'expire', 'expires',
    'leak', 'leaks', 'match', 'matches', 'pass', 'passes', 'remain', 'remains', 'trigger', 'triggers',
]);
class ProvidedTargetPrefixClassifier {
    input;
    tokens;
    matchedObjectForms = new Set();
    matchedObjectIndexes = new Set();
    constructor(input) {
        this.input = input;
        this.tokens = input.predicates.tokenize(input.source).tokens;
    }
    classify() {
        const objectPrefixEnd = this.matchObjectPrefix();
        if (objectPrefixEnd < 0)
            return 'none';
        if (this.hasFiniteNonObjectPrefix(objectPrefixEnd))
            return 'conditional';
        const tailStart = this.consumeRemainingObjectTerms(objectPrefixEnd + 1);
        return this.classifyObjectTail(tailStart);
    }
    matchObjectPrefix() {
        const requiredMatches = Math.min(2, this.input.objectForms.length);
        const deferredOverlaps = [];
        for (let tokenIndex = 0; tokenIndex < this.tokens.length; tokenIndex += 1) {
            const [formIndex, ...overlaps] = this.unmatchedObjectFormIndexes(this.valueAt(tokenIndex));
            if (formIndex === undefined)
                continue;
            this.matchedObjectForms.add(formIndex);
            this.matchedObjectIndexes.add(tokenIndex);
            deferredOverlaps.push(...overlaps.map((overlap) => ({ formIndex: overlap, tokenIndex })));
            if (this.matchedObjectForms.size >= requiredMatches)
                return tokenIndex;
        }
        for (const { formIndex, tokenIndex } of deferredOverlaps) {
            if (this.matchedObjectForms.has(formIndex))
                continue;
            this.matchedObjectForms.add(formIndex);
            this.matchedObjectIndexes.add(tokenIndex);
            if (this.matchedObjectForms.size >= requiredMatches) {
                return Math.max(...this.matchedObjectIndexes);
            }
        }
        return -1;
    }
    unmatchedObjectFormIndexes(value) {
        return this.input.objectForms.flatMap((forms, candidateIndex) => (!this.matchedObjectForms.has(candidateIndex) && forms.has(value) ? [candidateIndex] : []));
    }
    hasFiniteNonObjectPrefix(objectPrefixEnd) {
        const prefix = this.tokens
            .slice(0, objectPrefixEnd + 1)
            .filter((_, index) => !this.matchedObjectIndexes.has(index))
            .map((token) => token.value)
            .join(' ');
        return this.input.predicates.finiteClauseSubjectPolarity(prefix) !== 'absent'
            || this.input.predicates.hasIndependentAffirmativeAction(prefix, this.input.actionForms);
    }
    skipModifiers(initialIndex) {
        let index = initialIndex;
        while (index < this.tokens.length && this.isSkippableModifier(this.valueAt(index)))
            index += 1;
        return index;
    }
    isSkippableModifier(term) {
        return this.input.lexicon.leadingClauseModifiers.has(term)
            || TRAILING_MODIFIER_TERMS.has(term)
            || /ly$/u.test(term);
    }
    consumeRemainingObjectTerms(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        const remaining = new Set(this.input.objectForms.keys());
        for (const matched of this.matchedObjectForms)
            remaining.delete(matched);
        while (index < this.tokens.length) {
            const candidate = [...remaining].find((formIndex) => (this.input.objectForms[formIndex]?.has(this.valueAt(index))));
            if (candidate === undefined)
                break;
            remaining.delete(candidate);
            index = this.skipModifiers(index + 1);
        }
        return index;
    }
    isPastPredicate(term) {
        return term.endsWith('ed')
            || this.input.lexicon.irregularSimplePast.has(term)
            || this.input.lexicon.irregularPastParticiples.has(term);
    }
    consumeNominal(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        if (this.input.lexicon.subjectArticles.has(this.valueAt(index)))
            index += 1;
        while (index + 1 < this.tokens.length && this.isSimpleNominalModifier(this.valueAt(index)))
            index += 1;
        if (index < this.tokens.length)
            index += 1;
        return this.skipModifiers(index);
    }
    isSimpleNominalModifier(term) {
        return this.input.predicates.isAttributiveTargetModifier(term) || NOMINAL_MODIFIER_TERMS.has(term);
    }
    isObjectForm(term) {
        return this.input.objectForms.some((forms) => forms.has(term));
    }
    isMatrixPredicate(term) {
        return MATRIX_PREDICATE_TERMS.has(term)
            || this.input.predicates.isFinitePredicateTerm(term)
            || (this.input.actionForms.has(term) && !this.isObjectForm(term));
    }
    isNominalHead(term) {
        return NOMINAL_HEAD_TERMS.has(term) || this.isObjectForm(term);
    }
    isNominalModifier(term) {
        return this.input.predicates.isAttributiveTargetModifier(term)
            || NOMINAL_MODIFIER_TERMS.has(term)
            || this.isObjectForm(term);
    }
    reachesKnownNominalHead(initialIndex, genericModifierBudget) {
        let index = initialIndex;
        let remainingBudget = genericModifierBudget;
        while (index < this.tokens.length) {
            const term = this.valueAt(index);
            if (this.isNominalHead(term))
                return true;
            if (!this.isNominalModifier(term)) {
                if (remainingBudget <= 0)
                    return false;
                remainingBudget -= 1;
            }
            index = this.skipModifiers(index + 1);
        }
        return false;
    }
    isMatrixNominalCollocation(initialIndex) {
        const modifier = this.valueAt(initialIndex);
        let index = this.skipModifiers(initialIndex + 1);
        while (index < this.tokens.length) {
            const term = this.valueAt(index);
            if (this.isNominalHead(term))
                return MATRIX_NOMINAL_COLLOCATIONS.has(`${modifier}:${term}`);
            if (!this.isNominalModifier(term))
                return false;
            index = this.skipModifiers(index + 1);
        }
        return false;
    }
    consumeNominalPhrase(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        const hadArticle = this.input.lexicon.subjectArticles.has(this.valueAt(index));
        if (hadArticle)
            index += 1;
        const prenominal = this.consumePrenominalModifiers(index, hadArticle ? 2 : 1);
        index = prenominal.index;
        const head = this.valueAt(index);
        if (!this.isValidNominalHead(head, prenominal.sawModifier))
            return index;
        return this.consumeGerundComplements(this.skipModifiers(index + 1));
    }
    consumePrenominalModifiers(initialIndex, genericLimit) {
        let index = initialIndex;
        let genericModifiers = 0;
        let sawModifier = false;
        while (index + 1 < this.tokens.length) {
            const nextIndex = this.skipModifiers(index + 1);
            const term = this.valueAt(index);
            if (this.isPrenominalBoundary(nextIndex))
                break;
            const knownModifier = this.isNominalModifier(term);
            const genericModifier = !knownModifier
                && !this.isNominalHead(term)
                && genericModifiers < genericLimit
                && this.reachesKnownNominalHead(nextIndex, genericLimit - genericModifiers - 1);
            if (!knownModifier && !genericModifier)
                break;
            if (genericModifier)
                genericModifiers += 1;
            sawModifier = true;
            index = nextIndex;
        }
        return { index, sawModifier };
    }
    isPrenominalBoundary(nextIndex) {
        const next = this.valueAt(nextIndex);
        return nextIndex >= this.tokens.length
            || RELATIVE_TERMS.has(next)
            || this.input.lexicon.conditionalMarkers.has(next)
            || this.isFactualTailPrefix(next)
            || this.input.lexicon.subjectArticles.has(next)
            || (this.isMatrixPredicate(next) && !this.isMatrixNominalCollocation(nextIndex));
    }
    isValidNominalHead(head, sawPrenominalModifier) {
        return Boolean(head)
            && !RELATIVE_TERMS.has(head)
            && !this.input.lexicon.conditionalMarkers.has(head)
            && !this.isFactualTailPrefix(head)
            && !this.input.lexicon.subjectArticles.has(head)
            && !this.isMatrixPredicate(head)
            && (!sawPrenominalModifier || this.isNominalHead(head));
    }
    consumeGerundComplements(initialIndex) {
        let index = initialIndex;
        while (this.valueAt(index).endsWith('ing')) {
            const complementStart = this.skipModifiers(index + 1);
            const complementEnd = this.consumeNominalPhrase(complementStart);
            if (complementEnd <= complementStart)
                break;
            index = complementEnd;
        }
        return index;
    }
    consumeTerminalNominal(initialIndex) {
        const nominalEnd = this.consumeNominalPhrase(initialIndex);
        if (nominalEnd >= this.tokens.length)
            return nominalEnd;
        const prefixHead = this.firstNominalHead(initialIndex, nominalEnd);
        return this.isNominalHead(this.valueAt(nominalEnd))
            && prefixHead === nominalEnd
            && this.skipModifiers(nominalEnd + 1) >= this.tokens.length
            ? this.tokens.length
            : nominalEnd;
    }
    firstNominalHead(initialIndex, nominalEnd) {
        let index = this.skipModifiers(initialIndex);
        if (this.input.lexicon.subjectArticles.has(this.valueAt(index))) {
            index = this.skipModifiers(index + 1);
        }
        while (index < nominalEnd && !this.isNominalHead(this.valueAt(index))) {
            index = this.skipModifiers(index + 1);
        }
        return index;
    }
    classifyRelativeTail(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        const first = this.valueAt(index);
        if (this.input.lexicon.subjectArticles.has(first)) {
            index = this.consumeNominal(index);
        }
        else if (this.hasElidedPastSubject(index)) {
            index = this.skipModifiers(index + 1);
        }
        while (this.input.lexicon.passiveAuxiliaries.has(this.valueAt(index))) {
            index = this.skipModifiers(index + 1);
        }
        if (!this.isPastPredicate(this.valueAt(index)))
            return 'conditional';
        index = this.skipModifiers(index + 1);
        return this.isFactualTerminalNominal(index);
    }
    hasElidedPastSubject(index) {
        const first = this.valueAt(index);
        return !this.isPastPredicate(first)
            && !this.input.lexicon.passiveAuxiliaries.has(first)
            && this.isPastPredicate(this.valueAt(index + 1));
    }
    classifySubordinateTail(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        if (index >= this.tokens.length)
            return 'factual';
        if (this.isPastPredicate(this.valueAt(index)))
            index = this.skipModifiers(index + 1);
        return this.isFactualTerminalNominal(index);
    }
    isFactualTerminalNominal(index) {
        if (index >= this.tokens.length)
            return 'factual';
        return this.consumeTerminalNominal(index) >= this.tokens.length ? 'factual' : 'conditional';
    }
    classifyObjectTail(initialIndex) {
        const index = this.skipModifiers(initialIndex);
        if (index >= this.tokens.length)
            return 'factual';
        const term = this.valueAt(index);
        if (OBJECT_COORDINATOR_TERMS.has(term))
            return this.classifyCoordinatedTail(index + 1);
        if (RELATIVE_TERMS.has(term))
            return this.classifyRelativeTail(index + 1);
        if (this.input.lexicon.commaDelimitedPrepositions.has(term)) {
            return this.classifyObjectTail(this.consumeTerminalNominal(index + 1));
        }
        if (this.input.lexicon.conditionalMarkers.has(term))
            return 'conditional';
        if (SUBORDINATOR_TERMS.has(term))
            return this.classifySubordinateTail(index + 1);
        if (this.isFactualTailPrefix(term))
            return 'factual';
        if (term.endsWith('ing'))
            return this.classifyObjectTail(this.consumeTerminalNominal(index + 1));
        return 'conditional';
    }
    classifyCoordinatedTail(initialIndex) {
        let index = this.skipModifiers(initialIndex);
        if (index >= this.tokens.length)
            return 'factual';
        const coordinatedTerm = this.valueAt(index);
        if (this.input.actionForms.has(coordinatedTerm) && this.isPastPredicate(coordinatedTerm)) {
            index = this.skipModifiers(index + 1);
            if (index >= this.tokens.length)
                return 'factual';
            if (this.input.lexicon.commaDelimitedPrepositions.has(this.valueAt(index))) {
                return this.classifyObjectTail(index);
            }
        }
        return this.classifyObjectTail(this.consumeTerminalNominal(index));
    }
    isFactualTailPrefix(term) {
        return FACTUAL_TAIL_PREFIX_TERMS.has(term)
            || this.input.lexicon.commaDelimitedPrepositions.has(term)
            || FACTUAL_COORDINATOR_TERMS.has(term);
    }
    valueAt(index) {
        return this.tokens[index]?.value ?? '';
    }
}
export function classifyProvidedTargetPrefix(input) {
    if (!input.source || input.objectForms.length === 0)
        return 'none';
    return new ProvidedTargetPrefixClassifier(input).classify();
}