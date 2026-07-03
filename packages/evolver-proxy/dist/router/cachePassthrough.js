// Cache-preserving model rewrite (ported from v1 proxy/router/cache_passthrough.js). Swaps ONLY the top-level
// `model` string on an Anthropic /v1/messages body, never the `messages`/`system`/`tools` arrays — so every
// `cache_control: { type: "ephemeral" }` breakpoint the client placed stays intact and the prompt-cache prefix
// the client established with prior turns keeps hitting. Pure: returns a shallow clone, never mutates input.
export function rewriteModel(body, newModel) {
    if (!body || typeof body !== 'object')
        return body;
    if (!newModel || typeof newModel !== 'string')
        return body;
    if (body.model === newModel)
        return body;
    return { ...body, model: newModel };
}