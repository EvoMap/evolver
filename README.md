# evolver-v2

Evolver v2 — hub-无关进化 core + 按需 hub 适配。设计见 `~/evolver-v2-*.md`（总索引 + 硬化与执行计划）。

monorepo（pnpm workspaces）：
- `@evomap/evolver-core` — hub 无关核心（算法/原材料/mailbox/资产库/workflow）。**边界铁律**：不得 import 任何 adapter/proxy。
- `@evomap/evolver-adapter-public` — 公共 Hub adapter，负责 public economy/marketplace/auth wire。
- `@evomap/evolver-hub-conformance` — test-only HubCapability contract suite，public/private adapter 共用。
- `evolver-proxy` `evolver-mcp` `evolver-cli` `evolver-runtime-adapters` `evolver-webui`。

企业私有化不维护第二套 v2 产品线；`evolver-v2-enterprise-dev` 只持有 private protocol + private Hub adapter，
并通过 `@evomap/evolver-hub-conformance` 证明它仍实现同一份 core contract。

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## ATP manual commands
v2 restores the v1 consumer-side ATP loop without putting economic wire details into core. Authenticate once,
then place/list/verify orders through the public adapter:

```bash
evolver login
evolver buy code_review,bug_fix --budget 10 --question "Review the latest patch"
evolver orders --role consumer --status settled --limit 5
evolver verify ord_xxx --action confirm
```

`EVOMAP_NODE_ID` is optional for `buy`, but recommended for query commands that filter by node. `EVOMAP_NODE_SECRET`
keeps legacy auth working; otherwise the CLI uses the OAuth token from `evolver login`. Auto-spend consent is explicit:
`evolver atp status|enable|disable` records the ack file, and defaults to OFF when unset.

Hub egress defaults to `EVOMAP_HUB_IP_FAMILY=ipv4first`: Hub calls try IPv4 first to avoid VPN/TUN setups leaking
over local IPv6 and tripping Cloudflare country/ASN rules, then fall back to dual-stack if IPv4 cannot connect. Set
`EVOMAP_HUB_IP_FAMILY=auto` to restore dual-stack as the primary path, or `ipv4-only` to disable fallback.

## Prerequisites（批注#30）
Evolver v2 期望 Agent 至少有 **Sonnet / GPT-4o-mini 同等归纳能力**——v2 不再为低配 LLM 包揽信号提取等职责（那是 v1 的负担，收益甚微）。

## Abstract（批注#36）
进化的本质 = **与外界环境交互得到反馈，从反馈中筛选有效的经验信号**。
