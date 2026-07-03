# @evomap/evolver-proxy

The local proxy daemon: it relays LLM traffic and syncs the agent mailbox with an EvoMap hub.

## Targeting a hub

The proxy talks to a hub in one of two modes, selected by `EVOMAP_HUB_MODE`.

### Public mode (default)

```
EVOMAP_HUB_URL=https://your-hub node packages/evolver-proxy/dist/bin/evolver-proxy.js
```

Public mode sends no private credential. It works against a public hub. Against a self-hosted
**private** hub it can only complete the no-auth `/a2a/hello` handshake; every authenticated
`/a2a/*` call (heartbeat, mailbox, publish) is rejected with `401 a2a_auth_required`.

When an authenticated call fails the proxy now records an actionable hint in `sync:last_error` /
`hub:auth_status` (surfaced in the daemon status snapshot), keyed off the hub error code so it does
not misdirect:

- `a2a_auth_required` (the hub demanded a credential the public adapter never sends) points at a
  private hub, so the hint tells you to switch to private mode.
- any other auth rejection (the node secret was sent but refused) points at a public-hub credential
  problem, so the hint tells you to re-register the node.

See issue #314.

### Private mode (self-hosted / enterprise hub)

Private mode authenticates every `/a2a/*` call with a bearer token, so it needs two things:

1. An **enterprise token** via `EVOMAP_ENTERPRISE_TOKEN` (also accepts `EVOMAP_PRIVATE_HUB_TOKEN`
   or `PHUB_ENTERPRISE_TOKEN`).
2. The **private adapter** package `@evomap/evolver-adapter-private`. This ships in a separate
   enterprise repo and is **not** vendored in this checkout. Install/link it, or point
   `EVOMAP_PRIVATE_ADAPTER_MODULE` at a local build of a module that exports `connectPrivateHub`.

```
EVOMAP_HUB_MODE=private \
EVOMAP_HUB_URL=http://127.0.0.1:4010 \
EVOMAP_ENTERPRISE_TOKEN=<token> \
EVOMAP_PRIVATE_ADAPTER_MODULE=/abs/path/to/adapter-private \
node packages/evolver-proxy/dist/bin/evolver-proxy.js
```

Without the adapter, private mode fails fast at startup with a message naming the missing module.
This checkout cannot target a private hub until that external adapter is available.
