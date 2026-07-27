import { trace } from '@evomap/evolver-core';
export interface LearningTraceWiring {
    enabled: boolean;
    upload: 'on' | 'off' | 'no_credentials';
    config: {
        packetSink: trace.LearningPacketSink;
        traceSink?: trace.TraceSink;
        sourceRepo?: string;
    } | null;
}
export declare function resolveLearningTrace(env?: NodeJS.ProcessEnv): LearningTraceWiring;