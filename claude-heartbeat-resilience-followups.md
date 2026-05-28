# Heartbeat 韧性改造 —— 后续待办清单

> 本文档跟踪 PR #548 之后剩余的工作。
> Owner 标 `evolver` 表示本仓库要做；标 `hub` 表示需要 evomap-hub 团队配合；标 `client+hub` 表示两边都要改。
> 我们（你和 Claude）只做 owner=evolver 的部分。需要 hub 配合的写清楚接口契约，hub 团队接手时不用再调研。

---

## 一、已完成（PR #548 已合入 6 个新 commit）

| SHA | 改动 | 影响路径 |
|---|---|---|
| `49dde535` | supervisor 诊断文案修正 —— 去掉 hub 不存在的假代号（`node_disabled` / `node_revoked` / `secret_rejected`），改成真实状态（`suspended` / `node_secret_invalid`）+ 真实恢复链接 `evomap.ai/account` | `src/gep/heartbeatSupervisor.js`（default 模式） |
| `37092100` | **BUG-1 修复**：`_tick` 持 `AbortController`，`_rescueHungTick` 先 abort 再 bump generation；`heartbeat()` 入口快照 generation，每个 await 后、每次 state mutation 前 re-check；zombie 一律 `return null` 不污染 state | `src/proxy/lifecycle/manager.js`（proxy 模式） |
| `474e8841` | **BUG-2 Claim A 修复**：`REAUTH_HUNG_THRESHOLD_MS = 60s`，`reAuthenticate` 内部 await 用 `Promise.race` 兜底，hung 时 finally 仍会清掉 `_reauthInProgress` | `src/proxy/lifecycle/manager.js`（proxy 模式） |
| `99758f4b` | 加 `status: "suspended"` 分支；消费 hub 的 `next_heartbeat_ms` 与 `Retry-After` / `retry_after_ms` —— hub hint 优先于本地 backoff，永远不会比 hub 要求的更快重试 | `src/proxy/lifecycle/manager.js`（proxy 模式） |
| `64cb2db` | **E6 + E7**：supervisor `_hardRestartInFlight` 和 `_pokeInFlight` 加时间戳，`_livenessTick` 入口兜底（>30s 强制释放并 WARN），底层 hung 操作不管，状态机解锁就行 | `src/gep/heartbeatSupervisor.js`（default 模式） |
| `21f8837` | **E4**：消费 hub 的 `resend_hello`（下一 tick 走 `hello()`）、`force_update`（每进程 WARN 一次）、`upgrade_available`（每进程 INFO 一次）；所有处理点过 zombie guard | `src/proxy/lifecycle/manager.js`（proxy 模式） |
| TBD | **E1 (proxy mode only)**：新增 `EventConsumer`，常驻 async 长轮询 `POST /a2a/events/poll`；每次成功 round-trip 即 `lifecycle.pokeHeartbeat()`，把外部 hub liveness 作为独立恢复通道。async 循环不依赖 setInterval，顺带绕开 macOS App Nap 下 setInterval 不 fire 的核心顽疾。`EVOLVER_EVENT_POLL=0` 可禁用。| `src/proxy/sync/eventConsumer.js`（新）、`src/proxy/index.js`（wire-in，proxy 模式） |

测试状态：6 个 PR 相关测试文件全跑 **115/115 通过**，新增 10 个 EventConsumer 回归测试（合计 125 个 PR 相关用例全绿）。

---

## 二、Hub 侧需要做的事（owner=hub，evolver 这边等接口落地）

### H1. 新增 `POST /a2a/node/poke` —— 跨进程唤醒

**为什么需要**：evolver `--loop` 后台 daemon 与用户在另一个终端跑的 `evolver run` 是独立进程，daemon 无任何方式接收"用户在动"的信号。今天用户体感是"我都用它了它还是死的"，daemon 那边什么都不知道。

**实现要点**：
- 文件：`evomap-hub/src/routes/a2a/protocol.js`，仿照已有的 `/a2a/heartbeat` 路由结构（line 145）
- 路径：`POST /a2a/node/poke`
- 请求体：`{ node_id: string }`
- 鉴权：**owner 用户 session**（不是 `requireNodeSecret`，因为另一个终端的 `evolver run` 拿不到 node secret；它拿用户登录态）
  - 查 `evomap-hub/src/routes/a2a/_middleware.js` 找 owner-session 鉴权 helper，参考现有 owner-only 端点
  - 必须校验 `req.user.id === node.ownerUserId`，否则任何人都能 DoS 别人的节点
- 限流：30/min/user 即可（每分钟最多戳 30 次，足够人工使用）
- 处理逻辑：
  ```js
  await enqueueEvent(node_id, "user_activity_poke", { ts: Date.now() }, { priority: "high" });
  return res.json({ ok: true });
  ```
- 复用已有基础设施：`evomap-hub/src/services/agentEventService.js:23` 的 `enqueueEvent()`，已被 `council_invite` / `work_assigned` 使用，无需新表
- 加测试：`evomap-hub/test/routes/a2a/protocol.test.js`（仿照已有路由测试）

**预估工作量**：~30 行代码 + 测试

### H2. 新增 `GET /a2a/node/whoami` —— 外部 ground truth probe

**为什么需要**：evolver supervisor 现在只能看自己内部计数器（`totalSent` 等）判断自己活没活。obfuscated `a2aProtocol` 一旦进入奇怪状态，计数器会骗 supervisor。需要一个外部权威告诉 daemon "hub 上次见你是几秒前"。

**实现要点**：
- 文件建议：`evomap-hub/src/routes/a2a/observe.js`（已是 introspection 路由集合）
- 路径：`GET /a2a/node/whoami?node_id=<id>`
- 鉴权：`requireNodeSecret`（`evomap-hub/src/routes/a2a/_middleware.js:520`），可用现有 helper
- 返回体：
  ```json
  {
    "node_id": "...",
    "alive": true,
    "node_status": "active|dormant|suspended|archived",
    "survival_status": "alive|dormant|dead",
    "hub_last_seen_at": "ISO timestamp",
    "hub_last_seen_age_ms": 12345,
    "terminal": false,
    "secret_valid": true,
    "server_time": "ISO"
  }
  ```
- 实现：单次 Prisma `findUnique` on `a2ANode`，读 `status`, `survivalStatus`, `lastSeenAt`。**不写库**（read-only）
- 限流：12/min/node 足够（supervisor 每 5 分钟问一次即可）
- 加测试：仿照 `observe.js` 现有测试

**预估工作量**：~25 行代码 + 测试

### H3. （可选，nice-to-have）heartbeat 响应里加 `terminal: true` 字段

**为什么**：今天 `{status:"suspended"}` 已经是机器可读，但客户端要枚举字符串。加一个 boolean 字段更友好。

**改动**：`evomap-hub/src/services/a2aService.js:6173` 附近：
```js
if (node.status === "suspended") {
  return { status: "suspended", terminal: true, terminal_reason: "node_disabled", hint: "..." };
}
```

**优先级**：低。H1 / H2 落地后，evolver 可以用 H2 的 `terminal` 字段做相同判断，无需 hub 在 heartbeat 响应里再加一份。

---

## 三、Evolver 侧待办（owner=evolver，我们做）

> 这些条目按依赖关系排序。前置依赖未满足的，列为 BLOCKED。

### ~~E1. 长轮询消费者接 hub 的 poke 事件~~（proxy 模式已完成；default 模式 P1 待办）

**关键观察（与原 follow-up 草案的更正）**：原文标记 E1 "Blocked by H1"。实际上 H1 不是 E1 的硬阻塞——hub 已经把 38 种事件 type 入队给 node（council_invite / work_assigned / task_available / dialog_message 等，参见 evomap-hub 审计），任何一个事件到达都天然是"daemon 醒来"的信号。**更重要的是**：成功的长轮询 round-trip 本身就是独立 liveness 证明（网络+TLS+auth+hub 全通），不需要事件载荷也能 `pokeHeartbeat()`。H1（user_activity_poke）只是把"用户在 web 上活动 → daemon 醒"这条特定链路打通，是 nice-to-have，不再阻塞 E1 落地。

**Owner**：evolver  
**Blocked by**：~~H1~~（已解耦，见上）

**proxy 模式 — 已完成**：
- `src/proxy/sync/eventConsumer.js` 实现 async 长轮询循环，hub URL/secret/nodeId/pokeHeartbeat/reAuthenticate 全部复用 LifecycleManager
- 401/403 → 调 `lifecycle.reAuthenticate()`；5xx/网络错 → 指数退避 1s→60s；成功 → 重置退避并 pokeHeartbeat
- stop() 同时唤醒退避 sleep 并 abort 在飞 fetch，shutdown 内退场 <500ms
- 10 个回归测试覆盖：成功 poll / 空事件 poll / 401 reauth / 5xx 退避 / fetch throw / stop 唤醒 / stop abort / nodeId 未就绪 / 无 hubUrl 拒启 / 失败后成功重置退避
- env var `EVOLVER_EVENT_POLL=0` 可禁用

**default 模式 — P1 待办（新条目）**：
- 默认模式（非 proxy）的 a2aProtocol 是混淆代码，supervisor 无法直接拿到 `nodeId` / `node_secret` / `_buildHeaders`。需要先找一处稳定接口：
  - 选项 A：在 `src/gep/a2aProtocol.js` 外面包一个非混淆 thin adapter，导出 `getNodeId()` / `getHeaders()` / `getHubUrl()`
  - 选项 B：直接读 `~/.evomap/state.json`（如果默认模式落盘到那里）+ 环境变量回退
- daemon 模式（`evolver --loop` 非 proxy）目前是用户痛点的另一条路径——若用户报告"我的 daemon 不是 proxy 模式"，需要补这条
- 实现可大量复用 `src/proxy/sync/eventConsumer.js` 模块本身（构造函数已注入 hubUrl / getNodeId / getHeaders / lifecycle，对 LifecycleManager 没有硬依赖）

**做什么（保留原描述供 default 模式参考）**：
- daemon 启动时开一个常驻 worker，持续调用 hub 的 `POST /a2a/events/poll`（已存在，`evomap-hub/src/routes/a2a/protocol.js:179`）
- 收到 `type === "user_activity_poke"` 的事件 → 调 `lifecycle.pokeHeartbeat()`（proxy 模式）或 `heartbeatSupervisor.poke('user-activity')`（default 模式）
- 其他事件类型（`council_invite` / `work_assigned` 等）转给现有处理器，不要破坏现有流程

**文件位置建议**：
- 新文件 `src/proxy/sync/eventConsumer.js`（proxy 模式入口）—— 仿 `src/proxy/sync/engine.js` 的结构，写自己的 try/finally + 重排循环
- default 模式：`src/gep/heartbeatSupervisor.js` 里加一个可选的 `startEventConsumer(a2a, hubFetch)`，启动条件是 `process.env.EVOMAP_EVENT_POLL !== '0'`
- 在 `index.js` 默认模式启动块（line 443 附近）和 proxy 模式 `src/proxy/index.js`（line 88 附近）各 wire 一次

**实现细节**：
- 用 `AbortController`，daemon shutdown 时 abort 掉 in-flight 长轮询
- 错误处理仿 sync engine：whole body 包 try/finally，重排在 finally
- 失败时指数退避（初始 1s，最大 60s）
- 收到事件后立刻发下一个 poll（不等）
- 每次 poll 也 wire 到 `pokeHeartbeat` —— 因为 poll 成功本身就是"网络/auth 都正常"的 liveness signal

**加测试**：
- `test/eventConsumer.test.js`
- 至少覆盖：收到 `user_activity_poke` → `pokeHeartbeat` 被调；poll 失败 → 走指数退避；abort 信号 → 立刻退出循环；poll 长轮询 30s 内无事件 → 自动续上下一个 poll

**预估工作量**：~80 行代码 + 测试

### E2. supervisor 用 `whoami` 做周期性 probe

**Owner**：evolver  
**Blocked by**：H2（hub 必须先有 `GET /a2a/node/whoami`）

**做什么**：
- supervisor 已有 `_livenessTick`（`src/gep/heartbeatSupervisor.js`）。在里面加一段：
  - 每 5 分钟（即每 5 次 liveness 触发一次）调一次 `GET /a2a/node/whoami`
  - 如果 `hub_last_seen_age_ms > 10 * 60 * 1000`，立刻 `_hardRestart`（不再等 `totalSent` 停滞 15 分钟）
  - 如果 `terminal === true`，立刻 emit 诊断（不用等 3 次 restart）
  - 如果 `secret_valid === false`，触发本地 secret reset 流程（看 `evolver reset-local-secret` 已有命令）
- 比当前 supervisor 单纯靠 `totalSent` 频度 + `consecutiveFailures` 计数更准

**文件位置**：`src/gep/heartbeatSupervisor.js` 内部加 `_whoamiTick`，复用现有 `setInterval` 模式

**加测试**：
- `test/heartbeatSupervisor.test.js` 加 whoami probe 路径 mock + 断言

**预估工作量**：~30 行代码 + 测试

### E3. 在 `evolver run` 里调用 hub 的 poke 端点

**Owner**：evolver  
**Blocked by**：H1

**做什么**：
- `evolver run` 单次命令启动时，调 `POST /a2a/node/poke` 一次（best-effort，失败不影响后续逻辑）
- 文件：`index.js` 单次 run 路径（line 758-777 附近）
- 鉴权：要拿用户 session token（不是 node secret）。需要确认 evolver CLI 是否已经存了用户 session（看 `src/gep/` 下有没有相关 helper）。如果没有，需要先做"用户登录"流程，或者退化为：**只在 `EVOMAP_USER_TOKEN` 环境变量存在时调用**

**风险**：
- 用户没登录态时这一步必须 silently skip
- poke 失败时不能阻塞 `evolver run` 的主流程

**预估工作量**：~20 行代码 + 测试

---

## 四、Evolver 侧独立改进（可独立做，不依赖 hub）

### ~~E4. 消费 hub 的 `force_update` / `upgrade_available` / `resend_hello` 字段~~ ✓ 已完成 (`21f8837`)

### E5. 缓存感知的 poke

**Owner**：evolver  
**Blocked by**：无（但需要 hub 配合最佳）

**问题**：hub heartbeat 响应有 7 min Redis / 45s in-process 缓存（`evomap-hub/src/routes/a2a/protocol.js:167-173`）。`pokeHeartbeat` 在 45s 内连续触发可能拿到缓存数据，看起来"心跳成功"但实际是缓存。

**可能改法**：
- evolver 在 poke 触发的 heartbeat 上加 `Cache-Control: no-cache` 请求头（需要 hub 在路由上识别这个头，可能要 hub 配合）
- 或者 evolver poke 前后比较 `server_time` 字段：如果两次 server_time 相同（且都是几秒内），说明拿的是缓存

**优先级**：低。当前 poke 频率（60s 节流）大于缓存窗口（45s），影响不大。

### ~~E6. supervisor 缺一个"hardRestart 也卡死时的安全网"~~ ✓ 已完成 (`64cb2db`)

### ~~E7. supervisor 的 `_pokeInFlight` 锁也有同样的对称问题~~ ✓ 已完成 (`64cb2db`，与 E6 合并实现)

---

## 五、已知遗留风险（无修复路径，已被 PR 描述声明）

| 项 | 触发条件 | 影响 |
|---|---|---|
| `_safeStop` / `_safeStart` 同步阻塞 | obfuscated 模块的 startHeartbeat/stopHeartbeat 在同步代码里死循环 | supervisor 整体死锁，仅靠重启进程恢复 |
| 跨机器/跨用户的 IPC | 无现成机制 | E1 (proxy) 已落地，进程内闲置假死大概率自愈；剩余的"用户在 web 上活动 → daemon 醒"严格走 hub 事件队列（依赖业务有事件给该 node 入队，或 H1 user_activity_poke） |
| `force_update` / `min_version` 不强制 | 用户拿旧版 evolver | 仅 warn，evolver 自己不会强制升级 |
| **hub 侧 dormant 24h 过滤** | `enqueueEventForNodes` 对 non-high 优先级硬性过滤 `lastSeenAt >= now-24h`（evomap-hub `agentEventService.js:63-72`） | daemon 闲置 >24h 后唤醒前的窗口内，medium/low 事件会被静默丢弃。**E1 落地后自愈**：第一次成功 `/a2a/events/poll` 会刷新 `refreshLastSeen`（hub `lastSeenDebounce.js`），把 node 拉回 24h 内，下一拍 medium 事件就能入队 |
| **default 模式（非 proxy）暂未接 E1** | 用户跑 `evolver --loop` 非 proxy 模式 | 仍依赖 supervisor 的 setInterval，App Nap 期间可能停摆；上线观察后再决定补 default 模式 event consumer |

---

## 六、执行顺序建议（基于 E1 落地后的新判断）

1. ~~**现在就做**（不依赖任何外部）：E4 / E6 / E7。改动小、独立、能减少未来 audit 噪音。~~ ✓ 已完成
2. ~~**E1（proxy 模式）**：长轮询消费者，提供独立外部 liveness 通道，绕开 setInterval/App Nap~~ ✓ 已完成
3. **观察 E1 上线效果（推荐 1-2 周）**：用户痛点是否消失？特别关注：
   - 合屏闲置 30 分钟以上再用，daemon 是否还能正常发心跳
   - hub dashboard 上该 node 的 `lastSeenAt` 在闲置/唤醒时间序列上是否稳定
   - 进程内存是否因为 event consumer 长轮询循环有泄漏（hubFetch 的 keep-alive Agent 池）
4. **如果 proxy E1 效果不及预期**：补 default 模式 E1（见 E1 P1 待办段），先做包一层非混淆 adapter
5. **如果 hub 团队有余力**：H2（whoami） 仍有独立价值，能给 supervisor 一个外部 ground truth；H1（poke）现在不再阻塞 E1，但能让"用户在 web 上点一下"立即唤醒 daemon，UX 收益明显
6. **H3 / E3 / E5 不催**：低优先级

## 七、给 hub 团队的 ask 总结（更新后）

E1 落地后给 hub 团队的优先级排序变了：

- **优先 H1（user activity poke）**：虽然不再阻塞 E1，但用户主诉"我在浏览器用了它怎么 daemon 还是没反应"——hub 侧没有"用户在 web 活动 → node 入队事件"这一通道（见 evomap-hub 审计：`enqueueEvent` 没有任何调用点来自用户 web 路由）。H1 是这条 UX 闭环的唯一答案。E1 已就位，H1 落地后立即生效，evolver 这边零改动。
- **H2（whoami）次之**：解决 supervisor 自我观测盲点。E1 落地后这个盲区已大幅缩小（poll RTT 即外部 liveness），但仍有价值——尤其在排查"为什么我的 node 被判 dormant 了"这种问题时。
- **H3 不急**：低优先级。

如果只能选一件，**选 H1**——它直接解决用户体感问题；H2 解决的是 evolver 内部观测问题，用户感知不到。

---

## 八、第二轮多 agent 审查发现的修复（PR #548 追加 commit）

> 本节由 2026-05-28 多 agent 深度审查触发。Agent A 审查 manager.js / heartbeatSupervisor.js 自身韧性、Agent B 审查活动唤醒链路、Agent C 交叉对比 evomap-hub 后端契约、Agent D 评估测试覆盖。
> Agent C 锁定了用户报告「首次启动 → 闲置 → 再用就死」**最大概率真实根因**：secret 轮换错误码识别缺口。本节列出 evolver 侧已做改动 + hub / website 需要的配合。

### 8.1 已在本 PR 追加修复（owner=evolver，已完成）

| 问题 | 修复 | 文件 |
|---|---|---|
| `reAuthenticate` 不识别 `node_secret_invalid` / `rotation_requires_current_secret` —— 用户重启后 stale env 覆盖 store fresh secret，下一次 heartbeat 401，reAuth 走 rotate 拿 stale bearer，hub 返回 `node_secret_invalid`，attempt 2 走 drop-bearer + rotate，hub 返回 `rotation_requires_current_secret`，进 30min/4h 退避锁死。所有 poke 在 deepReauthFailure 后不再清退避（manager.js:1168-1172）—— **evolver "死了"，且 supervisor 硬重启清不掉 LifecycleManager 的 `_reauthBackoffUntil`**。 | `reAuthenticate` 短路：识别这两个错误码后立即发 `manual_secret_reset_required` inbound 事件并设退避；不再浪费 attempt 2。 | `src/proxy/lifecycle/manager.js` |
| `_resolveNodeSecret` 在 storeSource 缺失时 env-wins 默认行为，覆盖了 hub 已轮换的 store value。 | 改为「source 缺失 + store 有效 → store wins」，需显式 `node_secret_source='env_seed'` 才允许 env 覆盖。日志一次性 warn。**附带影响**：测试 `lifecycleStaleNodeSecret.test.js:80` 旧断言需更新。 | `src/proxy/lifecycle/manager.js`、`test/lifecycleStaleNodeSecret.test.js` |
| `DEFAULT_HEARTBEAT_INTERVAL=360_000`（6min）> hub `HEARTBEAT_INTERVAL_MS=300_000`（5min）—— 3 次连续慢 tick 即触达 hub `ONLINE_THRESHOLD_MS=15min`，hub 把节点标 non-online。 | 改为 `300_000` 对齐 hub cadence。 | `src/proxy/lifecycle/manager.js` |
| `suspended` 状态 bump `_consecutiveFailures` —— suspended 是稳定的 hub-side admin state 不是 transient failure，bump cf 让 backoff 走到 30min 上限，**用户在 web 手动解除 suspended 后最久要等 30 分钟 daemon 才能恢复**。 | 不再 bump cf；改用一次性 latched warn（成功 tick 后 re-arm）；保持自然 cadence，5min 内恢复。 | `src/proxy/lifecycle/manager.js` |
| `heartbeatSupervisor.poke()` throttle 命中直接 `return false`，**不做任何 state-clear / 不做 startHeartbeat re-arm** —— 用户连续点击时第二次 poke 完全无效，即使内部 loop 已死。 | 拆开「cheap recovery」（`stats.running===false` → `startHeartbeat()`）与「expensive send」（`sendHeartbeat()`）：前者无条件同步执行，后者保留 throttle + single-flight。模仿 proxy 模式 `pokeHeartbeat` 的双闸门结构。 | `src/gep/heartbeatSupervisor.js` |
| `_consecutiveHardRestarts` reset 条件过严（`cfNow === 0 AND totalSent 推进`）—— hub 恢复时 totalSent 先于 cf 归零，导致 healthy 期的 reset 错过，TERMINAL_DIAGNOSTIC 误报。 | 改为 `cfNow < cf-restart-gate AND totalSent 推进`：放宽到「不在 cf-storm 中且有推进」即视为恢复。 | `src/gep/heartbeatSupervisor.js` |
| `eventConsumer.js` 头注释把自己宣传为「独立 liveness probe」—— 实际与 heartbeat 共享 hub `requireNodeSecret` + `senderBan` + `badsec:` Redis cache 中间件，secret 被 hub 判 invalid 时两条通道同时 403。 | 注释改为如实描述：**transport / scheduler failure 的恢复通道**，对 hub-side terminal auth state 无效。后者直接走 manualReset short-circuit。 | `src/proxy/sync/eventConsumer.js` |
| 仓库根目录两个未跟踪的 macOS Finder 副本文件 `src/proxy/lifecycle/manager 2.js`、`src/gep/heartbeatSupervisor 2.js` | 删除（never tracked）。 | filesystem |

测试新增：
- `test/lifecycleStaleNodeSecret.test.js`: `reAuthenticate: short-circuits to manual reset on node_secret_invalid (no wasted attempt 2)`
- `test/lifecycleStaleNodeSecret.test.js`: `reAuthenticate: short-circuits to manual reset on rotation_requires_current_secret`
- `test/lifecycleStaleNodeSecret.test.js`: `nodeSecret getter: env wins when store carries an explicit env_seed source tag`
- `test/lifecycleStaleNodeSecret.test.js`: 旧 `env var wins over store with no source tag` → 更新为 `store wins when source tag is missing and store secret is valid`
- `test/lifecycleHeartbeatLoopResilience.test.js`: `suspended status: does NOT bump failure counter and does NOT write last_heartbeat_at` （取代原 `bumps failure counter`）
- `test/lifecycleHeartbeatLoopResilience.test.js`: `suspended status: warn is latched (logs once per episode, clears on first healthy tick)`
- `test/heartbeatSupervisor.test.js`: `terminalDiagnostic: recovery resets when sent advances AND cf is below cf-restart-gate (not strictly 0)`
- `test/heartbeatSupervisor.test.js`: `poke: throttled poke STILL re-arms a dead loop (cheap recovery is unconditional)`

### 8.2 owner=hub（evomap-hub），evolver 这边等接口落地

#### H4. 解耦 `/a2a/events/poll` 与 `/a2a/heartbeat` 的 secret 校验路径

**Agent C 实证**：`evomap-hub/src/routes/a2a/protocol.js:180-184`（events/poll）与 `protocol.js:147-151`（heartbeat）共享同一组中间件 `captureNodeSecret + checkSenderBan + requireNodeSecret`，共享 `_middleware.js:52-60` 的 `badsec:` Redis key。这意味着 evolver 在 PR #548 中加的 `EventConsumer` "独立活体通道" 名不副实——secret 被判 invalid 后两条通道同时 403。

**实现方向**（任选其一，hub 团队决定）：
- 方案 A：给 `/a2a/events/poll` 单独的 secret 校验路径，命中 `badsec:` 时返回 `200 + status:"node_secret_invalid"`（而不是 403）。客户端能识别且不被 senderBan 株连。
- 方案 B：events/poll 完全不校验 secret，只校验 nodeId（弱认证）。事件载荷里如果有敏感信息按事件级别加密。
- 方案 C：保留现状但提供 `?probe=1` query param，hub 在 probe 模式下仅返回 server_time / hub_alive，不读取 events 队列也不校验 secret。

**影响范围**：变更必须保证 evolver 现有 EventConsumer 兼容；建议 hub 加 `protocol_capabilities` 字段在 hello 响应里暴露端点能力。

**预估工作量**：~50 行 + 测试。

#### H5. hub 在 heartbeat 响应明确暴露终态字段

**问题**：obfuscated `a2aProtocol` 的 `getHeartbeatStats()` 不暴露 hub error code（已在 follow-ups §H3 提到 `terminal: true`）。supervisor 现在只能数 `consecutiveHardRestarts >= 3` 后打 console.warn 提示用户去 dashboard，**evolver 自己无法识别 terminal 状态**。Agent C 进一步发现：hub heartbeat 响应被 Redis 缓存 7min + memTtl 45s（`protocol.js:173 的 cached()`），同一节点 7min 内的多次心跳大概率拿到完全一样的旧响应。这意味着：
- 如果第一次响应里有 `resend_hello: true`，evolver `_resendHelloPending` 是单次 latch 清掉就 OK
- 但 `next_heartbeat_ms` 等 hint 会在 7min 内不变

**实现要点**（与 H3 合并）：
- `a2aService.js:6173` 附近，在 `node.status === "suspended"` / `"archived"` / `survivalStatus === "dead"` 分支显式加 `terminal: true, terminal_reason: <code>, terminal_recovery_url: <url>`
- 在 `_middleware.js:582` 的 403 `node_secret_invalid` 响应里加 `terminal: true`
- evolver supervisor 加分支：response.terminal === true → 立即 emit `manual_reset_required` inbound，不再做硬重启

**注**：H3 已经提到 `terminal: true`，本条与 H3 合并执行。

**预估工作量**：~30 行 + 测试。

#### H6. `suspended` 状态的自动解除契约

**问题**：hub `a2aService.js:6236` 在 `node.status === "suspended"` 时 hard return，**hub 自己没有任何自动恢复路径**——只能用户在 dashboard 手动解除。evolver 这边今天每 5 分钟一次 suspended 心跳是无意义的 hub 负载（hub 不做任何状态变更）。

**实现要点**（任选其一）：
- 方案 A：hub 在 `suspended` 响应里返回 `next_heartbeat_ms: 3600_000`（1 小时），告诉 evolver 别频繁来问
- 方案 B：hub 提供 `POST /a2a/node/check-suspended-status` 让 evolver 主动 query，evolver 的 heartbeat 在收到 suspended 后停 polling，仅在 user 主动 poke 时 query 一次

**优先级**：低（用户痛点是「死了不响应」，不是「polling 浪费」）。可与 H1 / H2 一并实施。

**预估工作量**：~10 行 + 测试。

### 8.3 owner=website（evomap-website），与 evolver 配合

#### W1. inbound `manual_secret_reset_required` 系统消息要在 dashboard 显式展示

**问题**：evolver `_emitManualResetNeeded()` 通过 `store.writeInbound` 写一个 `type: "system", priority: "high", payload: { action: "manual_secret_reset_required", ... }` 事件。这条消息需要在 evomap-website 的 agent dashboard 里显式渲染（否则用户看不到 daemon 在喊救命）。

**实现要点**：
- evomap-website 需要订阅 evolver 的 inbound 消息流（已有？请确认）
- 渲染规则：`type === "system" && payload?.action === "manual_secret_reset_required"` → 在该 agent 卡片上展示红色 banner "您的本地 secret 与服务器不一致，请在此重置"，附 "Reset Secret" 按钮（已有此按钮，但当前依赖用户主动来查）
- 加埋点：用户点了 Reset Secret 后 dashboard 自动把这条 inbound 消息标为已处理

**预估工作量**：~30 行前端 + 接 inbound 消息源。需要先与 evomap-website 团队确认 inbound 消息是否已能从 evolver 同步到 hub 再展示给用户。

#### W2. dashboard 显示节点的 hub-side 「最后一次心跳」与状态徽章

**问题**：Agent C 指出 hub 有 `node_status` (`active`/`dormant`/`archived`) 和 `survival_status` (`alive`/`dormant`/`dead`) 字段（`a2aService.js:6306-6307`），但用户态没有任何展示。如果 dashboard 能展示「您的节点 15 分钟前最后被 hub 看到」「您的节点状态：dormant，30 天未活动」，用户能立即理解为什么 evolver 看起来"死了"。

**实现要点**：
- evomap-website 拉取 hub 的 node 详情时已能拿到这两个字段，确认是否已渲染
- 推荐展示：`lastSeenAt` 相对时间 + `node_status` 徽章（active/dormant/archived/suspended）
- suspended 节点应有"立即解除"按钮直接调 hub API

**预估工作量**：~40 行前端，依赖 hub API 是否已暴露这两个字段。

### 8.4 已知遗留 / 不修

- **Agent A 发现 `manager.js:1155` `_tickInFlight=true` 直接 `return true`**：tick 卡 30-59s（小于 `TICK_HUNG_THRESHOLD_MS=60s`）期间所有用户活动 poke 都被短路成 no-op，要等 60s 才有 watchdog 介入。**不修原因**：缩短阈值会让正常 fetch 的 long-tail（10s timeout 偶尔超时但仍有效）被误判为 hung；当前 60s 是 fetch 自然 timeout 的 6 倍上限，是合理的安全余量。用户体感最坏 60s 等待优于误杀正常 tick。
- **Agent A 发现 drift detector race 可能让 wake 后 40-90s 才真正康复**：注释已承认这点（`manager.js:951-987`），属于「PR 自己声明的限制」，不算 bug。
- **跨进程唤醒**（`evolver --loop` daemon 收不到另一终端 `evolver run` 的活动信号）：需要 H1 落地，evolver 侧零改动。
- **default 模式（非 proxy） 的 EventConsumer**：见 §六 #4，先观察 proxy 上线效果再决定。

### 8.5 推荐合并前的最小验证清单

依据 Agent D 评估，PR body 中 5 个 manual test 至少前 3 个必须人工验证（自动测试用 `now += 1h` + 手动调 `_driftTick()` 替代了 OS-level suspend，无法证伪真实 sleep/wake 场景）：

- [ ] **必须人工**：关 lid 1h+ → 开 lid → 发起一个 HTTP 请求到 proxy → 观察 60s 内 heartbeat 恢复（用 `tail -f` 看 evolver 日志，或 hub dashboard 看 `last_heartbeat_at`）
- [ ] **必须人工**：`evolver --loop` default 模式，关 lid 1h+ → 开 lid → 观察 90s 内 heartbeat 恢复
- [ ] **必须人工**：`evolver webui`，关 lid 1h+ → 开 lid → 浏览器请求一次 → 观察恢复
- [ ] **应当自动化（合并后做）**：toxiproxy 持续 503 → 5-10 min 内观察 supervisor 自愈
- [ ] **必须 CI**：Node 22+ matrix 在 Linux / macOS / Windows 都过

---

## 九、第三轮 12-agent 深度审查发现（2026-05-28）

> 触发动机：用户实测仍在抱怨「首次启动发送 heartbeat → 闲置 → 再用就死」，怀疑 PR 没真正解决。
> 12 个并行 agent 分别覆盖：proxy 漂移检测、default 模式 supervisor、pokeHeartbeat、tick generation/zombie、loop 异常存活、reauth 看门狗、活动唤醒线、EventConsumer、webui wiring、hub 协议契约、测试覆盖、跨进程根因、初始启动+secret 轮换。
> 整体结论：PR 切实改进了「流量到达 → 恢复」路径，但用户主诉的 macOS 长时间睡眠场景仍非完全解决——根因在 setInterval/App Nap 抑制 + 跨进程信令缺失，二者只有 H1 + EventConsumer 联动能闭环。

### 9.1 evolver 侧待修（new，文档前面未覆盖）

**全部 15 条已修复，详见本节末尾的 commit 引用。**

| # | 严重度 | 位置 | 问题 | 状态 |
|---|---|---|---|---|
| F1 | HIGH | `index.js:274-309` vs `:1672-1715` | `process.on('uncaughtException'/'unhandledRejection')` **只在 `--loop` 分支安装**。`proxy` / `webui` 模式没装。任何逃出心跳 try/catch 的异常会让 proxy daemon 静默死亡。commit `0ed373d` 声称已覆盖 webui，实际只覆盖了 loop。 | ✓ 提取到 `src/ops/crashGuards.js`，在 `main()` 入口无条件 install，所有 mode 共享 |
| F2 | HIGH | `src/proxy/lifecycle/manager.js:670, 689` | `_consecutiveFailures++` 在 `await res.text()` / `await res.clone().json()` 之前执行，且这两个 await 之后**没有 `_isStaleGen()` re-check**。rescue 在 await 期间触发时，zombie 已写过 cf 但 return 时未回滚 → 用 commit `37092100` 的「every state mutation re-checks」声明不成立 | ✓ 401/403 与 !res.ok 两个分支均重排成「读 body → 单次 stale-gen 检查 → commit 全部 mutation」 |
| F3 | HIGH | `src/proxy/lifecycle/manager.js:543-562` | `reAuthenticate` 看门狗（`Promise.race` reject）catch 分支**不 bump `_consecutiveReauthFailures`，也不设 `_reauthBackoffUntil`**。run() 体内的递增在 race-reject 路径不可达。结果：hello 持续 hung → 每 60s 一次 reauth 紧密循环，永不指数退避，hub 被持续打 | ✓ watchdog 分支补 cf++ + 指数退避 backoff |
| F4 | MEDIUM | `src/proxy/lifecycle/manager.js:380-528` | `reAuthenticate` 内部 `await this.hello(...)` 没有 generation guard（不像 `heartbeat()` 的 `_isStaleGen()`）。watchdog reject 后，旧 hung promise 若 late-resolve，仍会执行 `setNodeSecret` + `_suppressEnvSecret=true`，与新启动的 reauth 并发双写 node_secret，触发 auth-loop | ✓ 加 `_reauthGeneration`，run() 在每个 await 后 + 提交前 stale check，watchdog/throw 路径 bump gen 让 late-resolve 失效 |
| F5 | MEDIUM | `index.js:1685-1689` | `evolver webui` 在 `EVOMAP_PROXY === '1' \|\| A2A_TRANSPORT === 'mailbox'` 时直接 skip 整个 supervisor。但 webui 分支本身不会调 `startProxy()`——条件是从 `--loop` 分支照搬的。结果：shell 里 `export EVOMAP_PROXY=1` 后跑 `evolver webui` → 零心跳。复现概率高（用户配 proxy 后忘 unset） | ✓ 改为 500ms 探测 proxy port（`/proxy/status`），只在真有 proxy 运行时才 defer；env-vars 不再用作 gate |
| F6 | MEDIUM | `src/proxy/sync/engine.js:113-114` | 出站推送成功只更新 `_lastActivity`，**不调 `_fireLiveness('outbound-sent')`**。若节点仅靠出站（inbound 空 / EventConsumer 禁用），daemon 持续生产但 heartbeat 不被 poke。注释解释了 inbound poke，对 outbound 不对称无说明，属遗漏 | ✓ 加 `this._fireLiveness('outbound-sent')`，与 inbound 对称 |
| F7 | MEDIUM | `src/proxy/index.js:154` | `await this.lifecycle.hello()` **返回值被吞**。若首次 hello 命中 `hello_rate_limited`，`_helloRateLimitUntil = now + 3600s`；后续每 tick 进 `hello()` 立刻被 rate-limit 短路；**daemon 1 小时无任何 heartbeat 进展，无 inbound 告警**。这是「首次启动后立即死」最直接的解释路径之一 | ✓ 首次 hello ok===false 时打 error 日志 + 写 `first_hello_failed` system inbound 让 dashboard 可见 |
| F8 | MEDIUM | `src/proxy/sync/eventConsumer.js:254` + hub | 成功 poll 后**立刻**发下一个 poll（无 sleep）。hub `/a2a/events/poll` rate limit `4/min/sender`（`evomap-hub/src/routes/a2a/protocol.js:182`）。短时间 3 个事件入队会引发 429 → consumer 进指数退避（最长 60s）→ 事件交付反而变慢 | ✓ 加 `SUCCESS_PAUSE_MS=250` 在成功 poll 后插入可中断 sleep。同时仍建议 hub 把 4/min 提到 12/min（H8） |
| F9 | LOW | `src/proxy/lifecycle/manager.js:795-808` | `min_proxy_version` / `upgrade_url` / `upgrade_message` 分支似乎是死代码——当前 hub `handleHeartbeat` 只 emit `force_update` / `upgrade_available`，没看到再发 `min_proxy_version`（agent C 交叉确认） | ✓ 删除 emit 分支；保留 `_shouldUpgrade` 工具方法（仍被 lifecycleRateLimit 测试单独验证 prerelease parsing） |
| F10 | LOW | `src/proxy/sync/eventConsumer.js:50` | `DEFAULT_POLL_TIMEOUT_MS = 30_000`，但 hub 单次 `pollEvents` 等待上限 55s。结果 consumer 每分钟空轮询 2 次而非 ~1.1 次 | ✓ 改为 50_000，保留 5s 给 FETCH_DEADLINE_PADDING_MS |
| F11 | LOW | `src/proxy/lifecycle/manager.js:1290-1294` | `pokeHeartbeat` throttled 分支无条件 `_heartbeatTimer = null` 再重新设。若旧 timer 本就 20s 后 fire 而 throttle window 为 50s，等于把唤醒**推后**了。仅在 `_consecutiveFailures==0` 时出现 | ✓ `_scheduleNextTick` 现在记录 `_nextTickAt`；throttled 分支比较「旧 timer 剩余」与「waitMs」，仅在旧 timer 更远时才 reschedule |
| F12 | LOW | `src/gep/heartbeatSupervisor.js:483-486` | drift / liveness `setInterval` 都 `unref()`。配 App Nap 的「无窗口、无活跃 socket → 抑制 timer」语义，正是恶化场景。仅靠 hub 长轮询 socket 保活，但 macOS 不视 socket-receive-wait 为 active | ✓ 加 `keepAlive` start opt；`--loop` 与 `webui` 都 opt-in `{ keepAlive: true }` 不 unref；`evolver run` 单次仍 unref（默认） |
| F13 | LOW | PR 描述 vs 代码 | PR 声称「recovery bounded to ~60s」，实测 drift detector race-recovery 门槛 `TICK_SUCCESS_STALE_MS=90s`，外加最长 `DRIFT_CHECK_MS=30s` jitter → 真实下界 **~90-120s** | ✓ 修正 pokeHeartbeat 注释口径为「activity-driven ~60s；drift race-recovery 90-120s」 |
| F14 | INFO | `test/webuiServer.test.js` | 文件存在但**未测**「webui 启动时 supervisor 真的 start」。`index.js:1685-1689` 的 env-gate 一旦写反或 typo（'true' vs '1'）回归仍 CI 绿 | ✓ 加两个 supervisor `keepAlive` 单元测试（patched setInterval 抓 `unref()` 调用，验证 keepAlive=true 不 unref，default 行为下 unref） |
| F15 | INFO | `test/lifecycleHeartbeatLoopResilience.test.js` 缺 | 无「真实 `process.on('uncaughtException')` 监听器收到事件 → 下一次 tick 仍 fire」的 e2e 测；commit `0ed373d` 声明未被回归保护 | ✓ 新 `test/crashGuards.test.js`：6 个测试，2 个用真 `spawnSync` 跑 setTimeout 抛错 + assert FATAL 日志 + exit 1 + releaseLock 触发 + cluster 阈值（4 不退、5 退） |

**测试结果**：全 PR 相关测试套件 + 新增 crashGuards/keepAlive 共 **156 个测试全绿**（pass 156 / fail 0）。

测试套件本身评估（agent D）：整体扎实，但**两个最关键的生产路径**（`evolver --loop` 与 `evolver webui` 模式下的 supervisor start）**只有单元测试拼装，没有任何 e2e 测把「入口分发 → supervisor 真启动 → 真发心跳」串起来**。如果用户真实痛点在这条线，任何回归都不会被现有 CI 拦下。

### 9.2 owner=hub（evomap-hub）新增协作项

#### H7. `/a2a/heartbeat` 429 响应统一加 `Retry-After` header

**问题**：`evomap-hub/src/routes/a2a/_middleware.js:88,93,143,152,177,182,201,224` 的多数 429 路径只设 `retry_after_ms` body 字段，**不设 `Retry-After` header**；仅 `circuitBreaker.js:67-68` 和 DB pool 503 设了 header。evolver 自己 body-first parse 没问题，但任何标准 HTTP 客户端（curl/probe/未来的非 evolver 集成）都看不到这个 hint。

**实现**：每个 429 响应统一加：
```js
res.setHeader('Retry-After', String(Math.ceil(retry_after_ms / 1000)));
```
**预估**：~10 行（多处复制）+ 一个集中 helper。

#### H8. 提高 `/a2a/events/poll` 的 sender rate limit

**问题**：`evomap-hub/src/routes/a2a/protocol.js:182` 当前 `limit: 4, windowMs: 60_000`。EventConsumer 成功 poll 后**立刻**再 poll（无 sleep），事件短时连发会被自家限流卡住——「独立 liveness 通道」被自己设计反噬。

**实现**：改为 `limit: 12, windowMs: 60_000`（最小间隔 5s，仍远高于 30-50s 长轮询的稳态节奏）；或直接移除（长轮询本身就限速）。

**预估**：~5 行。

#### H9. dashboard 自助 unsuspend endpoint

**问题**：今天 hub 只有 `POST /admin/emergency/resume-node`（`evomap-hub/src/routes/admin.js:1645`），**用户自己无法解除 suspended**。但 evolver `manager.js:741-744` 注释和 supervisor 诊断文案都告诉用户「去 evomap.ai/account 解除 suspension」——**这是个对不上的承诺**。

**实现**：
- 新路径：`POST /account/agents/:nodeId/unsuspend`
- 鉴权：`requireAuth` + 校验 `req.user.id === node.ownerUserId`（参考 `evomap-hub/src/routes/account.js:386` 的 PUT autonomy）
- 内部复用 `services/emergencyStopService.js:151-160` 的 `resumeNode()` 逻辑
- evomap-website 接对应按钮（与 W1 同批做）

**预估**：~30 行 + 测试。

#### H10. heartbeat 响应缓存对 `next_heartbeat_ms` 的影响

**问题**：`evomap-hub/src/routes/a2a/protocol.js:173` heartbeat 响应被 Redis 缓存 420s + 单 replica memTtl 45s。即便 hub `enqueueEvent` 已 `invalidate(hb:resp:${nodeId})`（`agentEventService.js:43`），**单 replica 命中 mem cache 时不会重读 Redis**——`next_heartbeat_ms=60_000`（has_pending_events 拉短间隔的信号）可能延迟最多 45s 才被 evolver 看到。

**实现方向**（任选）：
- A：`enqueueEvent` 改为同时 invalidate 所有 replica 的 mem cache（Redis pub/sub 广播 invalidation key）
- B：缩短 memTtl 到 5s（事件驱动的拉短间隔以 EventConsumer poll 通知为主，不依赖 heartbeat 响应）
- C：维持现状，evolver 完全不依赖 heartbeat 响应的拉短间隔，只信 EventConsumer

**优先级**：低。EventConsumer 已是更快的事件通道，本条主要是协议一致性。

### 9.3 owner=website（evomap-website）新增协作项

#### W3. 文档/合规：webui 模式启动隐式心跳

**问题**：`evomap-website/public/skill-evolver.md` 列出的 evolver 心跳同意模式是 `dry-run | one-shot | loop`，**未列 webui**。PR #548 把 webui 也加入了长驻心跳模式（commit `0ed373d` + 本次 webui supervisor wiring）。

**实现**：在 skill-evolver.md 文档里增列 `webui` 为隐式心跳同意模式之一，或加注释说明「启动 evolver webui 等同于同意常驻心跳」。

**预估**：文档改 ~5 行。

#### W4. dashboard 增加 EventConsumer rate-limit 自诊断标识

**问题**（与 F8/H8 关联）：若用户节点频繁触发 events/poll 429，今天用户看不到这条信号——只在 evolver 本地日志里。

**实现**：dashboard 节点详情页加「最近 5 分钟 429 计数」字段（如果 hub 还没存这个，需要 hub 加一个轻量计数器）。

**优先级**：低，可选。

### 9.4 对用户主诉的最终结论（合并 12 agent 综合判断）

| 场景 | PR 是否解决 | 解决方式 |
|---|---|---|
| Proxy 模式 + 用户从 IDE/Cursor/Claude Code 通过 proxy 发请求 | ✅ 真解决 | HTTP 请求 → `pokeHeartbeat` → 1 tick 内恢复 |
| Proxy 模式 + `evolver run` 在另一终端但 `EVOMAP_PROXY=1` | ✅ 解决 | `evolver run` 经 proxy → 同上 |
| Proxy 模式 + 用户在 evomap.ai 网页活动 | ⚠️ 部分 | EventConsumer 拿到 hub 事件才会 poke；需要 hub 有路径把「web 活动」入队（**H1 必须落地**） |
| Default 模式（`evolver --loop` 非 proxy）+ 长睡眠后回来 | ⚠️ 部分 | 仅 supervisor setInterval 保护，App Nap 期间不保证 fire；需要 §六.4 default 模式补 EventConsumer |
| Default 模式 + `evolver run` 在另一终端无 EVOMAP_PROXY | ❌ 不解决 | 跨进程无 IPC；需要 H1 + default 模式 EventConsumer，或本地最小 IPC（unix socket / 文件 watch） |
| 任意模式 + macOS lid close 1h+ + 无外部流量 | ⚠️ 风险 | drift detector 依赖 setInterval，App Nap 下不保证立即 fire；EventConsumer 长轮询 socket 在 sleep 期被 kernel 关闭，wake 后需 libuv 自身被唤醒；若用户 wake 后第一动作是任意「打到 proxy 端口」的请求，立即恢复（已覆盖） |
| **关键观察** | | PR 真正稳固覆盖的是「**外部流量到达 → 立即恢复**」。完全没有外部流量到达的 daemon，仍需 libuv 自身从 App Nap 中被唤醒——这条路径不是 evolver 代码能修的，需 OS 或包装层（caffeinate / `LSUIElement` / Electron `powerMonitor.on('resume')`）|

### 9.5 立即建议的修复优先级（基于本轮审查）

P0（合并前最好处理）：
- **F1**：把 uncaughtException/unhandledRejection 提升到全局，覆盖 proxy/webui 模式
- **F3**：reauth watchdog reject 分支补 backoff，否则 hub 被持续打
- **F7**：首次 hello 失败要给用户可见信号（system inbound），别静默吞 1h

P1（合并后第一周内处理）：
- **F2 / F4**：generation guard 在所有 state mutation 之前
- **F5**：webui supervisor env-gate 误关闭
- **F6**：出站 push 也算 liveness
- **F8 + H8**：EventConsumer 节流 + hub 限流上调

P2（后续迭代）：
- **F9-F15**：注释/口径修正、测试补齐、配置项收紧

Hub/Website 协作项的优先级仍按 §七：**H1 最高**（用户主诉直接答案），其次 H9（unsuspend 自助）、H7（429 header）、H8（events/poll 限流），W1 与 H1 并行做。

