import { observers, type events } from '@evomap/evolver-core';
export interface ReflectionObserverWiring {
    enabled: boolean;
    observer: ReturnType<typeof observers.reflectionObserver> | null;
}
export declare function resolveReflectionObserver(env: NodeJS.ProcessEnv | undefined, opts: {
    ingestor: events.Ingestor;
}): ReflectionObserverWiring;