// Learning-trace wiring for the autoexec daemon (Learning Ops slices 2+3). Local file sinks are the
// always-on durability layer — per-run LearningPacket drafts land under ~/.evomap/evolution/learning-trace/
// (kill switch: EVOLVER_LEARNING_TRACE=0). Hub upload (slice 3) is opt-in via EVOLVER_LEARNING_TRACE_UPLOAD=1
// and rides the same OAuth credential as the other hub links; when enabled + credentialed, packets are teed
// file-first then uploaded best-effort, so a hub outage never loses the local record or affects a verdict.
import { events, trace } from '@evomap/evolver-core';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { HubLearningPacketSink, TeeLearningPacketSink, connectPublicHub, resolveHubUrl, globalFetchLike, } from '@evomap/evolver-adapter-public';
import { resolveAtpHome, resolveAtpSenderId } from './atp.js';
function resolveHubUpload(env) {
    if (env['EVOLVER_LEARNING_TRACE_UPLOAD'] !== '1')
        return { sink: null, state: 'off' };
    const dir = resolveAtpHome(env) ?? join(homedir(), '.evomap');
    if (!existsSync(join(dir, 'token.json')))
        return { sink: null, state: 'no_credentials' };
    try {
        const hubUrl = resolveHubUrl(env);
        const senderId = resolveAtpSenderId(env);
        const { auth } = connectPublicHub({ hubUrl, authMode: 'oauth', evomapDir: dir, senderId: () => senderId });
        return {
            sink: new HubLearningPacketSink({ baseUrl: hubUrl, auth, fetchFn: globalFetchLike, nodeId: () => senderId }),
            state: 'on',
        };
    }
    catch {
        return { sink: null, state: 'no_credentials' };
    }
}
export function resolveLearningTrace(env = process.env) {
    if (env['EVOLVER_LEARNING_TRACE'] === '0')
        return { enabled: false, upload: 'off', config: null };
    const dir = events.learningTraceDir(env);
    const fileSink = new trace.FileLearningPacketSink(dir);
    const upload = resolveHubUpload(env);
    return {
        enabled: true,
        upload: upload.state,
        config: {
            packetSink: upload.sink ? new TeeLearningPacketSink(fileSink, upload.sink) : fileSink,
            traceSink: new trace.FileTraceSink(join(dir, 'trace-events.jsonl')),
            sourceRepo: 'evolver-v2',
        },
    };
}