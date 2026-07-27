// Learning-trace wiring for the autoexec daemon (Learning Ops slices 2+3). Local file sinks are the
// always-on durability layer — per-run LearningPacket drafts land under ~/.evomap/evolution/learning-trace/
// (kill switch: EVOLVER_LEARNING_TRACE=0). Hub upload (slice 3) is opt-in via EVOLVER_LEARNING_TRACE_UPLOAD=1
// and rides the same OAuth credential as the other hub links; when enabled + credentialed, packets are teed
// file-first then uploaded best-effort, so a hub outage never loses the local record or affects a verdict.
import { events, trace } from '@evomap/evolver-core';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { HubLearningPacketSink, TeeLearningPacketSink, connectPublicHub, resolveHubUrl, globalFetchLike, } from '@evomap/evolver-adapter-public';
import { resolveAtpHome, resolveAtpSenderId } from './atp.js';
/** Same default node-secret resolution as trajectory export: env first, then ~/.evomap/node_secret. Best-effort —
 *  without a secret the fold still reads plaintext/metadata-only rows; encrypted envelopes are just skipped. */
function defaultNodeSecret(env) {
    const envSecret = env['EVOMAP_NODE_SECRET'] ?? env['A2A_NODE_SECRET'];
    if (typeof envSecret === 'string' && envSecret.length > 0)
        return envSecret;
    try {
        const file = join(events.evomapHome(env), 'node_secret');
        if (existsSync(file))
            return readFileSync(file, 'utf8').trim() || undefined;
    }
    catch { /* secretless fold still covers unencrypted rows */ }
    return undefined;
}
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
    // Proxy llm_turn fold (slice 5): point the per-run fold at the proxy's trace day-files. Rides the same
    // master switch — if the proxy isn't running the dir is simply empty and the fold is a no-op.
    const nodeSecret = defaultNodeSecret(env);
    return {
        enabled: true,
        upload: upload.state,
        config: {
            packetSink: upload.sink ? new TeeLearningPacketSink(fileSink, upload.sink) : fileSink,
            traceSink: new trace.FileTraceSink(join(dir, 'trace-events.jsonl')),
            sourceRepo: 'evolver-v2',
            proxyTraces: {
                dir: events.tracesDir(env),
                ...(nodeSecret ? { readOptions: { nodeSecret } } : {}),
            },
        },
    };
}