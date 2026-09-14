<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver v2</h1>

<p align="center">
  <a href="https://trendshift.io/repositories/26015?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-26015" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/26015" alt="EvoMap%2Fevolver | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="https://github.com/EvoMap/evolver/stargazers"><img src="https://img.shields.io/badge/Stars-9k-2b3137?logo=github&amp;logoColor=white" alt="GitHub stars"/></a>
  <a href="https://opensource.org/licenses/GPL-3.0"><img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="License: GPL-3.0"/></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-V2%20engine%20range-green.svg" alt="Node.js 版本要求见下文"/></a>
  <a href="https://www.npmjs.com/package/@evomap/evolver"><img src="https://img.shields.io/npm/dm/@evomap/evolver.svg" alt="npm downloads"/></a>
  <a href="https://arxiv.org/abs/2604.15097"><img src="https://img.shields.io/badge/arXiv-2604.15097-b31b1b.svg" alt="arXiv"/></a>
</p>

**[evomap.ai](https://evomap.ai)** | [V2 使用指南](#evolver-v2-使用指南) | [Wiki](https://evomap.ai/wiki) | [GitHub](https://github.com/EvoMap/evolver) | [Releases](https://github.com/EvoMap/evolver/releases)

---

> **Notice — Moving Toward Source-Available**
>
> Evolver has been fully open source since our first release on 2026-02-01 (initially MIT, and GPL-3.0-or-later since 2026-04-09). In March 2026, another project in the same lane released a system with strikingly similar memory / skill / evolution-asset design — without any attribution to Evolver. Full analysis: [Hermes Agent Self-Evolution vs. Evolver: A Detailed Similarity Analysis](https://evomap.ai/en/blog/hermes-agent-evolver-similarity-analysis).
>
> To protect the integrity of the work and keep investing in this direction, future Evolver releases will transition from fully open source to source-available. **Our commitment to users is unchanged**: we will keep shipping the best agent self-evolution capability in the industry — faster iteration, deeper GEP integration, stronger memory and skill systems. All already-published MIT and GPL-3.0 versions remain freely usable under their original terms. You can still `npm install @evomap/evolver` or clone this repo. V1 与 V2 的命令和运行方式存在差异，升级前请按下文核对。
>
> Questions or concerns: open an issue or reach us at [evomap.ai](https://evomap.ai).

---

> **Research — The theory behind Evolver**
>
> **From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution** · [arXiv:2604.15097](https://arxiv.org/abs/2604.15097) · [PDF](https://arxiv.org/pdf/2604.15097)
>
> Across 4,590 controlled trials on 45 scientific code-solving scenarios, the paper shows that documentation-oriented **Skill** packages provide unstable, sparse control signal, while a compact **Gene** representation delivers the strongest overall performance, stays robust under structural perturbation, and is a far better carrier for iterative experience accumulation. On CritPt, gene-evolved systems lift their paired base models from 9.1% to 18.57% and from 17.7% to 27.14%.
>
> Evolver is the open-source engine that puts this result into practice: it encodes agent experience as Genes and Capsules under the GEP protocol, not as ad hoc prompts or skill docs. If you've ever wondered *why* Evolver insists on Genes instead of longer skill docs, this is the paper to read.
>
> Want the applied version? [OpenClaw x EvoMap: CritPt Evaluation Report](https://evomap.ai/blog/openclaw-critpt-report) walks through how the same Gene-based evolution loop drives an OpenClaw agent from 9.1% to 18.57% on CritPt Physics Solver across five versions (Beta -> v2.2), with full token-cost trajectories, gene activation mapping, and the "tokens rise then fall" signature of reasoning getting compressed into reusable genes.

---

## Evolver v2 使用指南

Evolver 将 agent 的运行材料整理为可审核、可追溯的 Gene、Capsule 和 EvolutionEvent，并通过本地资产、MCP 与 Hub 接口复用经验。安装程序、接通工具、认证成功和真正执行任务是不同的步骤。

本指南面向 V2 发行包。上面的研究结果及历史 OpenClaw 实验不代表当前 V2 已具备免配置 OpenClaw 接线或自主执行能力。升级前保留原配置与资产，核对实际安装版本的 `--help` 和能力清单；不要把尚未发布的主线修复当作本机已有功能。

## 环境要求与安装

- npm 发行包的 Node.js engines 合同是 `^22.13.0 || >=23.4.0`：支持22.x中的22.13.0及以上版本，或23.4.0及以上版本；Node18、Node20及23.0至23.3不满足要求。
- Git 用于需要仓库上下文、差异与回滚证明的操作；显示帮助或能力清单不等于已经运行进化任务。
- npm安装会访问registry并写入所选安装前缀。遇到权限错误时使用用户自有的npm前缀，不要以管理员安装来掩盖服务用户、PATH或身份目录不同的问题。

```bash
npm install -g @evomap/evolver
```

升级前记录旧版本、安装方式和服务实际使用的可执行文件路径；完成升级后重新核对 PATH。CLI显示新版本不证明后台服务已经重启到同一版本。

## 先进行只读检查

<!-- v2-safe-quickstart:start -->

下面三条命令只检查当前CLI和能力清单，不执行任务、不登录Hub，也不授权花费：

```bash
evolver --version
evolver --help
evolver cycle capabilities --json
```

<!-- v2-safe-quickstart:end -->

能力清单逐项区分 `ingest`、`inject`、`execute`、`verify` 和 `resume`。能读transcript不代表能启动runner；能发现MCP工具也不代表有经过验证的自主执行路径。`unsupported` 必须保留为未支持，不能靠改用另一个runtime或关闭安全检查变成成功。

## 选择实际支持的接入方式

MCP由外部agent主动调用；受支持的hook或规则提供各自的注入入口。需要安装配置时先查看：

```bash
evolver setup-hooks --help
```

V2推荐使用 `--runtime` 选择入口，`--platform` 仍是兼容别名。确认runtime、`--scope` 和 `--root` 后再决定安装；真正安装会修改对应配置文件，需要操作者明确同意。

`--dry-run` 目前仅适用于 `opencode` 和 `kiro`。Claude Code、Codex、Cursor、Antigravity等入口会拒绝该legacy预览参数，不要把它作为所有runtime通用的第一步。OpenCode/Kiro的JSON预览结果带 `dryRun:true`，即使 `outcome` 为 `installed` 也不表示已经写入配置。

| 入口 | V2边界 |
| --- | --- |
| Claude Code / Codex | MCP及受支持的SessionStart、UserPromptSubmit hook；仍受runtime的信任与hook审核约束。 |
| Cursor | 受管理的规则注入；不承诺V1 hooks.json路径或安全自主执行已就绪。 |
| Antigravity / Kiro / OpenCode | 已有MCP配置入口不自动等于transcript、执行或恢复能力全部可用；逐列查看能力清单。 |
| OpenClaw | 有 `setup-hooks` 手动入口，返回 `manual` 接线指引，不自动写配置；尚无自动installer或专用runtime执行合同。 |

OpenClaw用户可以先取得手动MCP/HTTP接线说明：

```bash
evolver setup-hooks --runtime=openclaw --json
```

成功返回 `outcome:manual`、空 `files` 和 `instructions`，不代表已经安装、认证或执行任务。HTTP/A2A的具体endpoint由相应adapter提供，不从任意输出推断或替换账户身份。

<!-- v2-openclaw-native:start -->

**OpenClaw 2026.8.1 注意事项：不要将 `instructions` 中的通用 `mcpServers` 片段直接粘贴到 OpenClaw 的 `openclaw.json`。** 该版本管理的是 `mcp.servers`，直接粘贴会被配置校验拒绝。当前指引仍显示通用片段；请通过宿主 CLI 注册。

以下 Bash 示例已用 OpenClaw 2026.8.1（ea80657）、Ubuntu24.04.4 和 Node22.23.1 验证。先从上面本机输出的片段读取 `command` 和 `args[0]`（默认 npm 入口为一个 stdio 脚本参数），核对都是本机安装产物的绝对路径，再替换下面五个路径。不要根据 `npm root -g` 猜测局部安装或不同服务用户的路径。若自定义了其他 args/env，必须逐项保留，并按本机 `openclaw mcp add --help` 确认；私密env-file只传绝对路径指针，不要内联 token 或 node secret。

在 OpenClaw 实际使用的用户、profile和workspace中执行。若已有同名 `evolver`，先检查 `openclaw mcp show evolver`，不要盲目覆盖。`add` 会启动 MCP probe，成功后写入配置，**不是只读检查**；它需要操作者同意。后续 `probe` 可能连接当前profile中的其他已配置服务器，执行前确认范围。

```bash
EVOLVER_MCP_NODE='/absolute/path/from/command'
EVOLVER_MCP_ENTRY='/absolute/path/from/args/0'
EVOLVER_MCP_WORKSPACE='/absolute/path/to/workspace'
EVOLVER_IDENTITY_DIR='/absolute/path/to/identity'
EVOLVER_STATE_DIR='/absolute/path/to/state'

openclaw mcp add evolver \
  --command "$EVOLVER_MCP_NODE" \
  --arg "$EVOLVER_MCP_ENTRY" \
  --cwd "$EVOLVER_MCP_WORKSPACE" \
  --env "EVOMAP_HOME=$EVOLVER_IDENTITY_DIR" \
  --env "EVOLVER_HOME=$EVOLVER_STATE_DIR" \
  --include evolver_recall \
  --approval prompt \
  --connect-timeout 10 \
  --timeout 10 &&
openclaw mcp probe &&
openclaw mcp doctor
```

此示例仅暴露 `evolver_recall` 来验证连接及本地经验读取，不等于完整学习闭环、agent任务、Hub认证或计费验收；需要其他工具时另行审核其权限与副作用。空store返回零条经验是有效结果，不是未登录。若 agent 报 runtime plugin/provider auth 缺失，应分别检查 OpenClaw 运行时与模型配置，不要据此删除 Evolver 凭据。上面的 `manual/files=[]` 只描述 Evolver 生成指引的那一步，不描述后续宿主写入。

<!-- v2-openclaw-native:end -->

外部宿主若自行支持MCP或通用日志格式，仍需单独配置并验证工具发现、材料输入和结果回传。通用接口的存在不能代替OpenClaw端到端验收。

## V1调用迁移与常驻任务

<!-- v2-compatibility:start -->

| 历史调用 | 当前V2行为 |
| --- | --- |
| 裸 `evolver` 或 `evolver run` | one-shot没有安全等价实现，提示必须迁移并退出2；不会启动任务。 |
| `evolver run --json` | 同一失败结果以JSON返回，`ok:false`、`mode:one_shot`。 |
| `evolver --loop` 或 `evolver run --loop` | 兼容映射到常驻 `autoexec`，不是原one-shot prompt生成器。 |
| `evolver --review` | 不能作为V2通用的“先审核再运行”入口。审核是独立的命令及资产状态合同。 |
| `--mad-dog` | 要求显式迁移，不会自动切换到可能丢弃工作树修改的solo模式。 |

OpenClaw旧skill、cron或shell脚本若期待裸命令打印GEP prompt或 `sessions_spawn(...)`，必须先迁移调用合同。不要把 `migration_required` 当作成功、可重试的Hub认证错误，或持续重启的理由。

`autoexec` 是常驻守护进程。它需要真实队列、明确的仓库 `allowedRoots` 和受支持的runner/containment；默认空allowlist会拒绝执行。把one-shot脚本替换成常驻进程会改变启动、停止和重复实例语义，必须由operator审核，不能直接作为免配置修复。

`WORKER_*`、V1 OpenClaw bridge和历史validator默认轮询/收益说明不能直接套用到V2。不要为恢复旧worker行为而开启buyer自动消费。已有的 `EVOLVER_ATP_AUTODELIVER` 与 `EVOLVER_ATP_AUTOBUY` 也代表不同的授权与工作流。

<!-- v2-compatibility:end -->

## Hub认证与进程上下文

<!-- v2-auth-context:start -->

EvoX登录、外部agent的模型认证、Evolver Hub OAuth和legacy节点身份并不是同一份会话。桌面应用可用，不证明由另一个用户、service或容器启动的Evolver已取得相同凭据。

Evolver的CLI login和ATP身份目录按以下顺序选择首个非空值：

1. `EVOMAP_HOME`
2. `EVOMAP_DIR`
3. `EVOLVER_HOME`
4. 当前进程用户HOME下的 `.evomap`

OAuth保存在该身份目录的 `token.json`。身份目录和运行状态目录可以分离；例如EvoX组合环境可分别配置身份与任务状态。比较配置是否一致时不要公开文件内容或绝对私有路径。

V2不搜索工作目录中的 `.env`。对支持Evolver loader的入口，显式传递 `EVOLVER_ENV_FILE`；该文件的值可覆盖已有进程配置。直接使用Node内置env-file loader时则有不同的覆盖规则，不要同时依赖两条路径覆盖同一键。不要把“文件放在当前目录”当作已经加载的证据。

ATP客户端存在显式 `nodeSecret` 时选择legacy认证，否则使用OAuth。完整的 `EVOMAP_NODE_ID` / `EVOMAP_NODE_SECRET` 身份对优先于完整的A2A别名；不应把一套namespace的ID与另一套secret拼在一起。残留legacy配置可能意味着重新OAuth登录后，该入口仍在使用legacy路径。

先查看登录命令的无副作用帮助：

```bash
evolver login --help
```

确认Hub地址和执行用户后，只有需要授权时才显式运行 `evolver login`。它会发起device flow、等待浏览器批准并写凭据，不是只读诊断步骤。缺少token时 `authenticate` 明确失败；接近过期时有可用refresh token则尝试refresh，刷新失败不能当作已登录或继续使用旧token。

默认公共Hub为 `https://evomap.ai`，可由 `A2A_HUB_URL`、`EVOMAP_HUB_URL` 等受支持配置覆盖。OAuth授权的Hub、legacy节点归属和服务实际访问地址必须一致。不要连续重新登录、删除凭据、reset secret或跟随一个未验证的node identity来排除所有认证错误。

<!-- v2-auth-context:end -->

## 不执行任务或认证失败时

先区分返回结果，而不是根据“账户余额有没有变化”判断系统是否工作：

| 现象 | 应核对的证据 |
| --- | --- |
| Node引擎或模块启动错误 | 实际Node版本、PATH、安装方法以及后台服务使用的binary；不要只查看交互式终端。 |
| `migration_required` | OpenClaw或脚本实际调用的V1命令；该结果不表示Hub token失效。 |
| `oauth 未登录` | 进程用户与身份目录是否正确、是否有可用token；不要发送token文件。 |
| refresh错误、401或403 | 错误码、Hub地址、请求时间和脱敏request ID；区分缺凭据、过期、权限和身份状态。 |
| `node_merged` | Hub返回的节点终态，需按服务端身份协议确认；不等同于普通密码失效。 |
| daemon运行但没有任务 | 队列、allowlist、runner能力、外部调度及明确授权；存活和heartbeat不证明任务已执行。 |

向维护者提供旧版本和新版本、OpenClaw版本、操作系统、Node版本、实际命令与脱敏错误。说明这里的“task”指本地队列、OpenClaw会话任务还是Hub订单；不要贴完整环境变量、原始transcript、token、node secret或支付资料。

## 经济行为与本地活动

自动ATP花费默认关闭，受 `EVOLVER_ATP_AUTOBUY` 或显式ack控制；`evolver atp enable` 是授权动作，不是恢复认证的普通排障步骤。手动购买、自动buyer、autodelivery和本地经验复用必须分别审核。

Credits账单需要按交易类型、时间及请求标识核对。登录附近出现扣款不能单独证明登录本身收费；无账单也不能证明没有本地活动。本指南不要求运行付费任务来证明安装有效。

## 本地数据与安全

升级前备份已有配置、身份和资产，并保留旧版本及启动命令。V1与V2的目录、资产格式、环境变量和服务生命周期不保证一对一兼容；不要手工改写asset ID或用删除账本解决迁移错误。

V2区分来源trust、内容review/quarantine与实际执行证据。新起草的经验不因存在于磁盘而自动可信；MCP recall和本地日志读取不能被写成执行、验证或获得收益的证明。

对外发布必须先脱敏并保持内容身份一致。真实执行需要明确权限、验证和恢复边界；不要通过禁用门禁或提高权限让不受支持的runner“看起来能跑”。本地只读能力可独立于Hub使用，网络发布、订单和认证仍有各自的外部依赖。

## 公开包与源码入口

公开npm包提供 `evolver`、`evolver-mcp`、`evolver-proxy` 和 `evolver-llm-proxy` 入口。其根 `index.js` 导出V2 API，不是V1 CLI替身；不要把旧指南中的 `node index.js` 脚本机械复制到V2。

公开分发代码位于 [EvoMap/evolver 的 v2-beta 分支](https://github.com/EvoMap/evolver/tree/v2-beta)，安装入口与资源以所选release为准。维护源码工作区使用锁定的pnpm workspace构建；公开分发包与维护源码工作区不是同一种安装目录。

## 后续支持

本指南纠正发行说明，不自动安装OpenClaw接线，也不证明某个客户的认证或额度问题已经解决。新增runtime能力必须有实际接线和验收；发布后仍应以安装版本的manifest、命令帮助和能力矩阵对齐。问题反馈入口为 [GitHub Issues](https://github.com/EvoMap/evolver/issues)。

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=EvoMap/evolver&type=Date)](https://star-history.dera.page/#EvoMap/evolver&Date)

## Acknowledgments

- [onthebigtree](https://github.com/onthebigtree) -- Inspired the creation of evomap evolution network. Fixed three runtime and logic bugs (PR [#25](https://github.com/EvoMap/evolver/pull/25)); contributed hostname privacy hashing, portable validation paths, and dead code cleanup (PR [#26](https://github.com/EvoMap/evolver/pull/26)).
- [lichunr](https://github.com/lichunr) -- Contributed thousands of dollars in tokens for our compute network to use for free.
- [shinjiyu](https://github.com/shinjiyu) -- Submitted numerous bug reports and contributed multilingual signal extraction with snippet-carrying tags (PR [#112](https://github.com/EvoMap/evolver/pull/112)).
- [voidborne-d](https://github.com/voidborne-d) -- Hardened pre-broadcast sanitization with 11 new credential redaction patterns (PR [#107](https://github.com/EvoMap/evolver/pull/107)); added 45 tests for strategy, validationReport, and envFingerprint (PR [#139](https://github.com/EvoMap/evolver/pull/139)).
- [blackdogcat](https://github.com/blackdogcat) -- Fixed missing dotenv dependency and implemented intelligent CPU load threshold auto-calculation (PR [#144](https://github.com/EvoMap/evolver/pull/144)).
- [LKCY33](https://github.com/LKCY33) -- Fixed .env loading path and directory permissions (PR [#21](https://github.com/EvoMap/evolver/pull/21)).
- [hendrixAIDev](https://github.com/hendrixAIDev) -- Fixed performMaintenance() running in dry-run mode (PR [#68](https://github.com/EvoMap/evolver/pull/68)).
- [toller892](https://github.com/toller892) -- Independently identified and reported the events.jsonl forbidden_paths bug (PR [#149](https://github.com/EvoMap/evolver/pull/149)).
- [WeZZard](https://github.com/WeZZard) -- Added A2A_NODE_ID setup guide to SKILL.md and a console warning in a2aProtocol when NODE_ID is not explicitly configured (PR [#164](https://github.com/EvoMap/evolver/pull/164)).
- [Golden-Koi](https://github.com/Golden-Koi) -- Added cron/external runner keepalive best practice to README (PR [#167](https://github.com/EvoMap/evolver/pull/167)).
- [upbit](https://github.com/upbit) -- Played a vital role in popularizing evolver and evomap technologies.
- [Chi Jianqiang](https://mowen.cn) -- Made significant contributions to promotion and user experience improvements.

## License

[GPL-3.0-or-later](https://opensource.org/licenses/GPL-3.0)

> Core evolution engine modules are distributed in obfuscated form to protect intellectual property. Source: [EvoMap/evolver](https://github.com/EvoMap/evolver).

## Download History

Evolver ships through three channels — the [npm package](https://www.npmjs.com/package/@evomap/evolver), prebuilt binaries on [GitHub Releases](https://github.com/EvoMap/evolver/releases), and the [ClawHub](https://skill-history.com/autogame-17/evolver) skill registry:

[![npm](https://img.shields.io/npm/dm/@evomap/evolver?logo=npm&label=npm)](https://www.npmjs.com/package/@evomap/evolver)
[![npm total](https://img.shields.io/npm/d18m/@evomap/evolver?logo=npm&label=npm%20total)](https://npm-stat.com/charts.html?package=@evomap/evolver)
[![GitHub releases](https://img.shields.io/github/downloads/EvoMap/evolver/total?logo=github&label=GitHub%20releases)](https://github.com/EvoMap/evolver/releases)

[![ClawHub download history](https://skill-history.com/chart/autogame-17/evolver.svg)](https://skill-history.com/autogame-17/evolver)
