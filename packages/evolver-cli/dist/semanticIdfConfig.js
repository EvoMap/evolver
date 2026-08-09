/** Semantic IDF is default-on; exact `0` is the emergency rollback value. */
export function semanticIdfEnabled(env = process.env) {
    return env['EVOLVER_SEMANTIC_IDF'] !== '0';
}