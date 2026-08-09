type ProvidedPrefixKind = 'conditional' | 'factual' | 'none';
interface PredicateTokenStream {
    tokens: readonly {
        value: string;
    }[];
}
interface ProvidedPrefixLexicon {
    commaDelimitedPrepositions: ReadonlySet<string>;
    conditionalMarkers: ReadonlySet<string>;
    irregularPastParticiples: ReadonlySet<string>;
    irregularSimplePast: ReadonlySet<string>;
    leadingClauseModifiers: ReadonlySet<string>;
    passiveAuxiliaries: ReadonlySet<string>;
    subjectArticles: ReadonlySet<string>;
}
interface ProvidedPrefixPredicates {
    finiteClauseSubjectPolarity(source: string): 'absent' | 'negative' | 'positive';
    hasIndependentAffirmativeAction(source: string, actionForms: ReadonlySet<string>): boolean;
    isAttributiveTargetModifier(term: string): boolean;
    isFinitePredicateTerm(term: string): boolean;
    tokenize(source: string): PredicateTokenStream;
}
interface ProvidedPrefixInput {
    actionForms: ReadonlySet<string>;
    lexicon: ProvidedPrefixLexicon;
    objectForms: readonly ReadonlySet<string>[];
    predicates: ProvidedPrefixPredicates;
    source: string;
}
export declare function classifyProvidedTargetPrefix(input: ProvidedPrefixInput): ProvidedPrefixKind;
export {};