import { join } from 'node:path';
import { hub } from '@evomap/evolver-core';
import { awaitWithAbort, connectPublicHub, globalFetchLike, resolveHubUrl } from '@evomap/evolver-adapter-public';
import { createRecipeHubFromEnv, resolveRecipeHubResumeIdentityFingerprint } from './recipe.js';
import { feedbackDestinationIdentity } from './feedbackDestinationIdentity.js';
export function createBoundTriggerFeedbackHub(binding, env, signal) {
    if (![env['A2A_HUB_URL'], env['EVOMAP_HUB_URL']].some((value) => value?.trim()))
        throw new Error('trigger_feedback_destination_unbound');
    const evolverHome = join(binding.agentDir, 'evolver');
    const evomapHome = join(binding.agentDir, 'evomap');
    const scoped = {
        ...env, EVOLVER_ENV_FILE: '', EVOLVER_HOME: evolverHome, EVOMAP_HOME: evomapHome, EVOMAP_DIR: evomapHome,
        EVOLVER_PROXY_STORE: join(evolverHome, 'proxy', 'mailbox.db'),
    };
    const identify = () => {
        const identity = resolveRecipeHubResumeIdentityFingerprint(scoped, true);
        const storedEnv = { ...scoped };
        for (const key of ['A2A_NODE_ID', 'EVOMAP_NODE_ID', 'A2A_NODE_SECRET', 'EVOMAP_NODE_SECRET', 'A2A_NODE_SECRET_VERSION', 'EVOMAP_NODE_SECRET_VERSION'])
            delete storedEnv[key];
        let storedIdentity = null;
        try {
            storedIdentity = resolveRecipeHubResumeIdentityFingerprint(storedEnv, true);
        }
        catch { /* An explicit environment-only identity has no stored counterpart. */ }
        return feedbackDestinationIdentity('public', resolveHubUrl(scoped), identity, storedIdentity ?? 'environment-only');
    };
    const destinationId = identify();
    const connected = createRecipeHubFromEnv(scoped, (options) => connectPublicHub({ ...options,
        fetchFn: async (url, init) => {
            signal?.throwIfAborted();
            const requestSignal = signal ? AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) : init.signal;
            return await awaitWithAbort(globalFetchLike(url, { ...init, ...(requestSignal ? { signal: requestSignal } : {}) }), signal);
        },
    }));
    if (!('getNodeSecretVersion' in connected.auth))
        throw new Error('trigger_feedback_node_auth_required');
    const capability = connected.triggerFeedback;
    const isCurrent = () => { try {
        return identify() === destinationId;
    }
    catch {
        return false;
    } };
    const assertCurrent = () => { signal?.throwIfAborted(); if (!isCurrent())
        throw new Error('trigger_feedback_destination_changed'); };
    const assertSafePayload = async (payload, path) => {
        assertCurrent();
        const content = JSON.stringify(payload);
        const credentials = await awaitWithAbort(connected.auth.authenticate({ method: 'POST', path, body: content, ...(signal ? { signal } : {}) }), signal);
        assertCurrent();
        const secret = credentials.bodyFields?.['node_secret'];
        const known = { ...scoped, ...(typeof secret === 'string' ? { EVOMAP_FEEDBACK_AUTH_SECRET: secret } : {}) };
        const folded = Object.fromEntries(Object.entries(known).map(([key, value]) => [key, value?.toLowerCase()]));
        if (hub.fullLeakCheck(content, known).found || hub.fullLeakCheck(content.toLowerCase(), folded).found)
            throw new Error('trigger_feedback_egress_blocked');
    };
    return {
        destinationId, isCurrent,
        async commit(report) { const normalized = hub.normalizeTriggerFeedbackReport(report); await assertSafePayload({ ...normalized }, '/a2a/trigger-feedback'); assertCurrent(); return await awaitWithAbort(capability.commit(normalized), signal); },
        async get(runId) { await assertSafePayload({ run_id: runId }, '/a2a/trigger-feedback/get'); assertCurrent(); return await awaitWithAbort(capability.get(runId), signal); },
    };
}