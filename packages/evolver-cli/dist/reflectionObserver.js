import { observers } from '@evomap/evolver-core';
export function resolveReflectionObserver(env = process.env, opts) {
    if (env['EVOLVER_REFLECTION'] === '0')
        return { enabled: false, observer: null };
    return { enabled: true, observer: observers.reflectionObserver({ ingestor: opts.ingestor }) };
}