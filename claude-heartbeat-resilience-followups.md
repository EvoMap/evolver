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

---

## Loop-survival findings (agent 1)

只列需要 hub / website 配合的内容（loop-survival 自身评估已直接交付给 caller，verdict=PARTIALLY SOLVES，没有新增 evolver-only 待办）。

- 无新增 hub 协作项。`uncaughtException` handler 现在做 `process.exit(1)`（`src/ops/crashGuards.js:32-36`），依赖的是 systemd/launchd/CLI wrapper 在 daemon mode 下的自动重启 —— 这与 hub 无关，但需要在用户文档（`evomap-website` 或 README 安装说明）里**显式建议** macOS 用 launchd `KeepAlive=true` plist、Linux 用 systemd `Restart=on-failure`。如果用户直接 `node index.js` 拉起 evolver 没有 supervisor，一次 uncaught 会让 daemon 退出且永不恢复，符合用户主诉的「死了之后什么都做不了」。
  - 建议归到 W5（新条目）：在 `evomap-website/public/skill-evolver.md` 或 setup 指南里补一段「production deployment requires a process supervisor」的说明，列 launchd plist 模版与 systemd unit 模板。优先级 P1。
- 无新增 website 待办（W5 即唯一一条）。

---

## Tick-generation findings (agent 2)

审查范围：`_tickGeneration` 反僵尸机制是否真正杜绝 hung-fetch 救援后并发 zombie tick。

**结论：PARTIALLY**。canonical hung-fetch 路径已闭合（同步 bump + abort + 严格 `!==` 比较 + 多 mutation 点 stale-gen guard 已覆盖 401/429/!ok/json/catch 全部 await 点），双重/多重 rescue chain 由严格 `!==` 自动覆盖。但有两处遗漏：

### TG-1 (LOW) — `heartbeat()` `unknown_node` 分支后 `writeInboundBatch` 缺 stale-gen check

- 位置：`src/proxy/lifecycle/manager.js:828-842`
- 复现：tick A 进入 heartbeat，`await res.json()` 后 line 776 通过 stale check，命中 `data.status==='unknown_node'` → `await this.hello()` (line 830)。hello 期间 `_rescueHungTick` 触发 bump 但 hello 仍 resolve（hello 不会因 controller.abort 立即 reject 因为 hello 不接受 abortSignal）。line 831 的 `_isStaleGen()` 会 return null —— 但如果 hello 同步返回 OK，line 831 走完后 rescue 在更晚发生（e.g. drift detector 紧接着 fire），程序流已掉到 line 834-842。该段 `Array.isArray(data?.events) && length>0 → writeInboundBatch` **没有任何 stale check**，zombie 仍可把 stale events 写入 store。低概率（events+unknown_node 同时命中且 rescue 卡在 hello 后），但属于 commit `37092100` 「every state mutation re-checks」声明的真实漏点。
- 建议：line 834 前加 `if (_isStaleGen()) return null;`（行为对称于 882/889/901 三个 hub-signal 分支）。

### TG-2 (LOW) — `stopHeartbeatLoop` 不重置 `_tickGeneration`，stop/start 翻转后 zombie 可能匹配新代际

- 位置：`src/proxy/lifecycle/manager.js:1148-1163` 与 `:943`
- 复现：tick A 入 heartbeat 后僵在 `await hubFetch`，捕获 `myGen=1`。外部触发 `stopHeartbeatLoop()` —— 不清 `_tickGeneration`。随后 `startHeartbeatLoop()` 重启把 `_tickGeneration=0`，新 tick B 进入 line 961 自增到 1。zombie A 的 hubFetch resolve 时 `myGen=1 === _tickGeneration=1`，stale check 误判为"未 stale"，zombie A 进入 line 1025-1057 reschedule，与 tick B 并存 —— 新版"双 timer 泄漏"路径。
- 实际触发概率：极低（生产路径下 stop 通常意味着 process shutdown）；若未来引入 stop/start 翻转（如 secret reset 流程或 hot config reload）将立即暴露。
- 建议：`stopHeartbeatLoop` 末尾或 `startHeartbeatLoop` 开头 `this._tickGeneration = (this._tickGeneration || 0) + 1000`（大跨度 bump 而非 reset 0），让任何 pre-stop 的 zombie 都看到 stale gen。代价 0。

### 已验证 OK 的项

- 三重以上 rescue chain：严格 `!==` 比较使任意非自身代际都判 stale，N+2 自然覆盖 N（无需链长度上限）。`rescue chain` 测试（test/lifecycleHeartbeatLoopResilience.test.js:1093）只 explicit 验证两层，但语义可推广。可选补一个 3 链测试增强信心。
- "fetch 刚好与 rescue 同时返回"：`_rescueHungTick` 的所有 mutation（abort / `_tickInFlight=false` / `_tickGeneration++` / clear timer / `_scheduleNextTick`）都是同步的，无 await。原 tick 的 `await` resume 只能排在 rescue 同步段完成之后的 microtask，没有真正并发窗口。
- bump 单调性：仅 `_tick`(:961) 与 `_rescueHungTick`(:1211) 两处 `++`，poke / drift / reauth 路径都不触碰 `_tickGeneration` 自身。`_reauthGeneration` 是独立计数器，不串扰。



## Sync-engine findings (agent 6)

仅列出需要 hub / website 协调或 evolver 内跨模式补全的事项；engine.js + eventConsumer.js 自身的循环韧性与 onLiveness wiring 已在 PR #548 内闭合（见 evidence 在 `src/proxy/sync/engine.js:105-217`、`src/proxy/index.js:90-93`、`src/proxy/sync/eventConsumer.js:212-274`），不再单独提条目。

- S1 (P1, evolver-only follow-up, but call out): `--loop` 默认（非 mailbox 模式）分支 `index.js:423-433` 走的是 `heartbeatSupervisor` + `a2a.startEventStream()`，**不实例化 SyncEngine 也不实例化 EventConsumer**。因此 onLiveness/eventConsumer 这条 #544 恢复链路只覆盖 `EVOMAP_PROXY=1 || A2A_TRANSPORT=mailbox` 用户。建议要么 (a) 在文档明确「heartbeat 自愈恢复路径需要 EVOMAP_PROXY=1」，要么 (b) 在 default 分支也起一个仅 long-poll 的 EventConsumer 来给 heartbeatSupervisor 提供 liveness 信号 —— 这是真正闭合「heartbeat 死后还能自醒」的关键，因为线上多数 `--loop` 用户并未开 mailbox 模式。
- S2 (P2, evolver-only): inbound.js:65-69 与 outbound.js:87-94 在非-Auth 错误时把 fetch 异常**吞掉返回 `{received: 0, error}`**，外层 engine 的 catch 永远捕不到这类错误。配合 #544 修复后没有真实风险（reschedule 在 finally），但 logger.error 信息流被吞，排障时 `[sync] inbound error:` 这一行只在 ackDelivered/JSON parse/AuthError 才能看到。建议把 inbound.pull / outbound.flush 的吞错点改为直接 throw 让外层统一记录（外层 engine 已有 catch + reschedule），降低观测盲点。
- S3 (P2, hub coordination, low urgency): eventConsumer.js:19-32 注释里说明 hub `/a2a/events/poll` 与 `/a2a/heartbeat` 共享 `badsec:` 缓存 + sender-ban + middleware 链，因此 EventConsumer 不是「全独立鉴权 channel」，仅能为「transport/scheduler 临时故障」提供恢复。建议把这条注释里关于鉴权耦合的事实做成正式契约写入 hub 侧 `_middleware.js` 注释顶部，避免后续 hub PR 解耦 events/poll 与 heartbeat 鉴权中间件时反而无意破坏「同步 401 才共同失败」这一前提（隐式协议）。归类到 H 系列建议条目，与 H1 同优先级以下。
- S4 (P2, hub coordination, observability): eventConsumer 在 401/403 调 `lifecycle.reAuthenticate()`，但 hub 端 sender-ban 永久挂起时 reAuthenticate 也会失败，eventConsumer 会陷入 1s × backoff×2 → 60s 上限的死循环（线程不会挂死，但永远拿不到事件）。建议 hub 在 `/a2a/events/poll` 返回 403 时携带新字段 `terminal: true`（或与 `node_secret_invalid` 同义码），eventConsumer 见到 terminal=true 直接 stop() 自身并写一条 system inbound 通知用户去 dashboard 解 ban —— 与 hub H1/H9 路径合并实现，不必单独 PR。

---

## Drift-detector findings (agent 3)

> 审查范围：`src/proxy/lifecycle/manager.js` 和 `src/gep/heartbeatSupervisor.js` 的 wall-clock drift 检测器，能否在 host wake 后 ~60s 内强制触发一次 tick。

### 结论（针对用户主诉 "stop using for a while → heartbeat never comes back"）

两个 detector 各自能在 macOS sleep/wake 后 ≤90s 内强制走一次 hub 调用。不是用户主诉的根因路径（如果只有 drift 这一层，用户最多等 90s 就恢复了），但作为兜底是 OK 的。

具体证据：

- **lifecycle**：`manager.js:1078-1142` 每 30s 采样 `Date.now()`，`gap > 90_000ms` 触发 `pokeHeartbeat()`。`pokeHeartbeat`（1297-1363）无条件清 `_consecutiveFailures` 和 `_reauthBackoffUntil`（除非 deepReauthFailure），即使被 throttle 命中也会把下一次 timer 拉到 ≤60s 内（`manager.js:1339`）。worst case wake → 30s drift fire → 60s throttle → hub call ≤ 90s。
- **supervisor**：`heartbeatSupervisor.js:264-281` 同样 30s 采样，gap > 90s 直接 `_hardRestart()`（`stop+start`），用 obfuscated 模块自身的 start 重置 cadence，无 throttle。
- **libuv catch-up 风险**：Node 的 `setInterval` 在 host suspend 后只**单次**补发（不是连续 burst），所以 wake 时 detector 只看到一次 fire，gap = 真实 skew。即使 libuv 真的连续 fire，supervisor 有 `_hardRestartInFlight` 单飞门（`heartbeatSupervisor.js:187-188`），lifecycle 有 `POKE_THROTTLE_MS` + `_tickInFlight` 门（`manager.js:1310, 1331-1354`）—— 不会 thundering herd。
- **7 天 skew 算术**：`gap` 就是 `Number` 减法，`604800000` 远低于 `Number.MAX_SAFE_INTEGER`。`Math.round(gap/1000)` 输出 `604800`，日志一行不刷屏（之后 `_lastDriftCheckAt = now` 重置）。无溢出风险。
- **proxy vs default 不并存**：`LifecycleManager.startHeartbeatLoop()` 只在 `src/proxy/index.js:193` 起；`heartbeatSupervisor.start()` 只在 `index.js:429, 755` 起。两条路径互斥，不会互相戳。

### 实际暴露的 gap（已经合并 PR 之后剩余的问题）

| Gap | 严重度 | 位置 | 描述 | 建议 |
| --- | --- | --- | --- | --- |
| **D1** | MID | `src/proxy/lifecycle/manager.js:1078, 1142` | lifecycle drift `setInterval` 的 cadence (`DRIFT_CHECK_MS`) **没有暴露为 `startHeartbeatLoop()` 的 opt**。supervisor 在 `heartbeatSupervisor.js:447-449` 已暴露 `driftCheckMs`。测试只能 monkey-patch module-level 常量或者跑真 30s 计时，审查盲点。建议同步加一个 `driftCheckMs` 参数（仅测试用，生产保留 30s 默认），并加一个 real-timer suspend 测试对应 `heartbeatSupervisor.test.js:811` 的那条。 | 改 `manager.js` `startHeartbeatLoop(intervalMs, opts)` 签名加 `opts.driftCheckMs`，测试加 `realTimer: lifecycle drift interval + synthetic clock jump triggers pokeHeartbeat`. |
| **D2** | MID | `src/proxy/lifecycle/manager.js:1145` | lifecycle drift `setInterval` **无条件** `unref()`。supervisor 在 `heartbeatSupervisor.js:491-495` 已有 `keepAlive` opt（W5/F12 修复）。proxy 模式如果跑在 daemon/webui 长生命周期里，drift 这条 interval 是恢复 sleep/wake 唯一兜底，但 App Nap / 后台 throttle 时被 coalesce 风险更高。建议同步加 `keepAlive` opt，proxy daemon 入口 opt-in `true`。 | 改 `manager.js:1145` 用 `if (!opts.keepAlive && this._driftInterval.unref)`；`src/proxy/index.js:193` 的 `startHeartbeatLoop()` 调用补 `{ keepAlive: true }`. |
| **D3** | LOW | `src/gep/heartbeatSupervisor.js:264-268` | `_driftTick` 入口就 `_lastDriftSampleAt = now`，**先于** `_hardRestart` 调用。如果 `_safeStop` / `_safeStart` 同步阻塞超过下一次 drift fire 周期（30s），下一次 fire 时 baseline 已重置为 now，看到的 gap 就只有 30s 不再触发。但 `_hardRestartInFlight` 门 + `HARDRESTART_HUNG_THRESHOLD_MS=30s` watchdog 会强制释放 latch（`heartbeatSupervisor.js:295-307`），并 WARN，所以**用户角度可恢复**，只是审计上 baseline-reset-before-action 的顺序略反直觉。不修也行，但加一行注释解释为什么先 reset baseline 更稳妥。 | 仅注释，无代码改动。 |
| **D4** | LOW | `src/proxy/lifecycle/manager.js:1119-1134` | 第二条 recovery 分支（cf > 0 且 stale）是**真正解决用户主诉**的那条 ——「sleep/wake 后第一次 tick 失败、_consecutiveFailures=1、backoff 拉到 cap」的场景。但它只在 drift fire 时再检查一次，最坏要等 `TICK_SUCCESS_STALE_MS=90s` + 一次 drift cycle 30s ≈ 2 min。这已经远好于之前的 12-30 min，**但**这个分支吞掉的所有 backoff 失败一旦不是 sleep/wake 引发（比如 hub 真的挂了 2 min），也会被吞 —— 用户看到的是 "loop 一直在试" 而不是 "loop 已经放弃"。不算 bug，是 trade-off。 | 无需改动；TICK_SUCCESS_STALE_MS=90s 的注释（`manager.js:81-84`）已经说清楚。 |

### 建议优先级

- **D1 + D2 一起做**：proxy 模式与 default 模式 drift 检测器对称性，测试覆盖一致性。半小时工作量。归 P2。
- **D3 / D4**：纯文档/注释，可忽略到下次集中清理时再做。


---

## webui + HTTP-poke findings (agent 7)

**Scope**: (a) supervisor wired into `evolver webui`? (b) does inbound HTTP actually poke?

### Entry-point coverage table (`index.js`)

| Command / flag | File:line | Supervisor / lifecycle started | Activity poke wire |
|---|---|---|---|
| `--loop` (proxy on, `EVOMAP_PROXY=1` or `A2A_TRANSPORT=mailbox`) | `index.js:414-421` | `startProxy()` -> `LifecycleManager.startHeartbeatLoop()` (`proxy/index.js:193`) + `EventConsumer` poll (`proxy/index.js:200-207`) | proxy HTTP handler pokes `lifecycle.pokeHeartbeat()` (`proxy/server/http.js:176-179`); `sync.onLiveness` poke (`proxy/index.js:90-93`); event-poll poke |
| `--loop` (no proxy) | `index.js:423-432` | `heartbeatSupervisor.start(a2a, { keepAlive: true })` | per-cycle poke `heartbeatSupervisor.poke('evolve-cycle')` (`index.js:540-541`) |
| `run` / `/evolve` / default (no proxy, single run) | `index.js:751-762` | `heartbeatSupervisor.start(a2a)` (intervals unref'd) | one-shot `poke('single-run')` then `evolve.run()` returns -> process exits |
| `run` / default (proxy mode, single run) | `index.js:752` guard skips supervisor | **none in this process** (relies on a separate proxy daemon) | none |
| `webui` (no proxy reachable) | `index.js:1697-1704` | `heartbeatSupervisor.start(a2a, { keepAlive: true })` -- NEW in PR #548 | `onWebuiRequest = () => supervisor.poke('webui-request')` (`index.js:1716-1719`) fed into `WebUiServer.onRequest` (`webui/server/http.js:55-57`, fires before route dispatch incl. 404s/static) |
| `webui` (proxy probe at `/proxy/status` succeeds within 500ms) | `index.js:1681-1696, 1705-1707` | supervisor **skipped**; assumes proxy daemon owns heartbeat | `onWebuiRequest === undefined`, no-op (intended) |
| `solidify` / `distill` / `review` / `fetch` / `sync` / `asset-log` / `setup-hooks` / `reset-local-secret` / `atp-complete` / `buy` / `orders` / `verify` | various | none (short-lived CLI) | n/a |

Crash guards (`index.js:239-242`) cover every mode now -- previously webui/proxy silently died on uncaught.

### 1. webui supervisor wiring -- VERDICT: correct
- New block `index.js:1658-1728` probes proxy at `getProxyUrl()`/`/proxy/status` (500ms abort), and **only skips** the local supervisor when the probe returns *any* HTTP status. If unreachable / no settings.json / probe throws, supervisor starts unconditionally with `keepAlive: true`. This fixes the F5 false-skip class where `EVOMAP_PROXY=1` was exported globally but no proxy daemon was running.
- `keepAlive: true` is the right choice: webui blocks on `await new Promise(() => {})` (`index.js:1728`), HTTP listener is the only natural keep-alive owner, supervisor intervals must not be unref'd alongside it.
- Shutdown path stops the supervisor (`index.js:1723`).

### 2. Double-supervision risk -- LOW but not zero
- A user starting `evolver --loop` (proxy on) AND a separate `evolver webui` in another terminal: the webui's 500ms probe hits the loop daemon's proxy port -> webui skips its supervisor. Correct.
- Race window: if webui starts within 500ms of the proxy daemon binding its port (or before `writeSettings` flushes `proxy.url`), `getProxyUrl()` returns null and webui spins up its own supervisor. Result is two supervisors poking the same hub via two different a2a singletons in two separate processes -- not the same process, so no in-memory contention. Hub-side rate-limit handles burst. Acceptable.
- Inside one process, only ever one supervisor: the `webui` branch never calls `startProxy()`, and the `--loop` branch never falls through to webui code. No double-wire.

### 3. HTTP poke wiring
- Proxy (`src/proxy/server/http.js:176-179`): pokes `lifecycle.pokeHeartbeat()` for any authenticated, route-matched request *unless* path is in `POKE_EXCLUDED_PATHS = { /proxy/status, /proxy/config, /proxy/hub-status }`. Exclusion is **by exact path**, not method. 401s and 404s are correctly excluded by ordering (auth check at line 155, route match at 162, poke at 176). Test pins all 6 paths (`test/proxyHttpPokesLifecycle.test.js:90-135`).
- Webui (`src/webui/server/http.js:55-57`): `onRequest` fires **before route dispatch** for every inbound request, including static assets, 404s, malformed paths. **No method/path filter.** Hook is wrapped in try/catch so a throwing supervisor cannot break requests (covered by test L237-250).

### 4. Read-only exclusion soundness
- Proxy: exact-string set on `url.pathname`. Cannot be bypassed by query string. Can be defeated trivially by hitting any *other* path (e.g. `/proxy/status?x=1` -- still excluded because `pathname` strips query; `/proxy/status/` -- not excluded, but that 404s before poke now that match runs first... actually look: poke runs AFTER `paramMatch` check at line 162, so a 404 path that isn't matched returns early at line 165 *before* the poke at 176. Confirmed not a bypass.).
- Webui: **no exclusion at all**. A curious user `curl http://127.0.0.1:19821/` in a loop will fire poke() per request, but the supervisor's `POKE_THROTTLE_MS=60_000` (`heartbeatSupervisor.js:50`) caps actual hub sends to 1/min. Cheap startHeartbeat re-arm is unthrottled but synchronous and cheap. No starvation vector.

### 5. End-to-end user-click trace (webui, idle for hours)
1. Browser issues `GET /webui/status` (or any UI poll).
2. `WebUiServer._handle` runs `onRequest` synchronously before route dispatch (`webui/server/http.js:55`).
3. `onWebuiRequest -> _webuiSupervisor.poke('webui-request')` (`index.js:1717`).
4. `heartbeatSupervisor.poke()` (`heartbeatSupervisor.js:510-590`):
   - Cheap recovery: if `_safeStats().running === false`, calls `a2a.startHeartbeat()` synchronously -- timer re-armed THIS event-loop turn (the critical fix at L543-549; un-throttled and not gated by `_pokeInFlight`).
   - Send path: if `now - _lastPokeAt >= 60s` AND `!_pokeInFlight`, fires `a2a.sendHeartbeat()` with `SEND_TIMEOUT_MS` race; otherwise the cheap path already covers the "timer dead" symptom.

User-perceived bound on heartbeat after the click: **synchronous re-arm** of the in-process timer; first hub send within the supervisor's normal cadence after re-arm, or up to 60s if the previous poke was recent. Worst case (idle for hours -> `_lastPokeAt` is stale, so the 60s throttle does NOT block) the send goes out immediately. Matches the PR's claim.

### Verdict

- (a) Supervisor IS wired into `webui` (`index.js:1679-1707`) with the correct skip condition and `keepAlive: true`. Closes the prior gap.
- (b) Inbound HTTP DOES poke: proxy at `proxy/server/http.js:176` (with sound read-only exclusions), webui at `webui/server/http.js:55` (no exclusions, throttle handles burst).

No bugs found in this scope. Two minor residual notes:
- `webui` probe assumes any HTTP status from `/proxy/status` means "proxy alive". If a stale `settings.json` points to a port now owned by an unrelated service that returns 200, webui will skip its supervisor incorrectly. The PR comment acknowledges this trade-off ("something is listening; assume proxy owns the heartbeat"). Low likelihood, not blocking.
- No exclusion on webui means a frontend bug that polls `/webui/status` every 100ms will hammer `supervisor.poke()` -- but throttle caps real damage at 1 send/min. Acceptable.

## pokeHeartbeat findings (agent 4)

Verdict: MOSTLY SOLVES (CORE bug addressed; two residual risks).

Paths traced:
- src/proxy/lifecycle/manager.js:1297-1363 pokeHeartbeat (POKE_THROTTLE_MS=60s)
- src/proxy/lifecycle/manager.js:1235-1252 _scheduleNextTick (sets _nextTickAt)
- src/proxy/lifecycle/manager.js:1189-1220 _rescueHungTick (60s watchdog + 1s fallback)
- src/proxy/lifecycle/manager.js:545-598 reauth watchdog (REAUTH_HUNG_THRESHOLD_MS=60s)
- src/proxy/server/http.js:176-179 per-request poke wiring
- src/proxy/sync/eventConsumer.js:252-257 long-poll poke

Q1 (throttle pull-in): correct. manager.js:1339-1352 computes waitMs = 60_000 - sinceLast, gates with F11 (_nextTickAt - now <= waitMs => leave existing timer alone), otherwise clears _heartbeatTimer and _scheduleNextTick(waitMs). pulled-in timer is never later than existing one.

Q2 (rapid pokes): safe. During _tickInFlight, returns true at L1310 with no state/timer mutation. After tick, successive throttled pokes each recompute waitMs against the same _lastTickAttemptAt; F11 (_nextTickAt < waitMs) short-circuits with no setTimeout reset. No setTimeout-reset-pushes-out hazard. In-flight gate keeps concurrent ticks at 1 (test L336-370).

Q3 (reauth gate escape): manager.js:1318 returns true when _reauthInProgress. REAUTH_HUNG_THRESHOLD_MS=60s watchdog at L546-555 forces finally at L596-599 to clear _reauthInProgress. Worst case: two consecutive watchdog cycles (~120s) before _consecutiveReauthFailures>=2 freezes the backoff. Acceptable, but means in deepest-pathology user sees ~2 min before backoff engages.

Q4 (deep backoff): NOT solved during deep backoff. When _consecutiveReauthFailures>=2 the poke preserves _reauthBackoffUntil (manager.js:1325-1327) but still pulls the timer in to ~60s (L1339-1352). The pulled-in _tick STILL calls heartbeat(), which fetches /a2a/heartbeat unconditionally; only reAuthenticate (L442-446) honors the backoff. So during the 30min - 4h reauth backoff, the hub still receives a heartbeat every ~60s. With hub limit 6/300s that is borderline (60s vs 50s avg) and likely 429-able under jitter. The backoff prevents the reauth hammer, not the heartbeat hammer. 

User impact: if hub genuinely invalidated the secret, _every_ user action triggers a hub heartbeat attempt (~60s throttled). User does not get a worse-than-30min stuck window, but cannot recover without a server-side Reset Secret in the dashboard. PR description claim "bounded to ~60s" only holds when backoff is shallow (<2 reauth failures). REAUTH_BACKOFF doubles 30m -> 60m -> 2h -> 4h cap; first deep state is 30 min, so worst case user sees "no matter what I click, heartbeat keeps 401-ing every 60s for up to 4h" until they hit the dashboard. This matches the manualResetRequired short-circuit path at L497, which already calls _emitManualResetNeeded() to surface to UI.

Q5 (state-clear ordering): correct. manager.js:1310 (_tickInFlight) and :1318 (_reauthInProgress) return BEFORE the state-clear at :1324-1327, so in-flight pokes do not corrupt failure history (test L858-909). deep-backoff state-clear is gated by _consecutiveReauthFailures>=2 (L1323), preserving the backoff. _consecutiveFailures is cleared so the rescheduled tick uses fresh backoff math; _hubRetryAfterMs and _lastHubNextHeartbeatMs are NOT cleared by poke (intentional — hub rate-limit hints should survive). _lastTickAttemptAt is NOT cleared so the throttle remains coherent.

Residual risks:
- R1: deep-backoff heartbeat hammer. Pulled-in _tick fires /a2a/heartbeat every ~60s while reauth is gated. If hub starts 429-ing the heartbeat path, _hubRetryAfterMs picks it up (L761-764). But during the gap before the first 429, ~5 heartbeats/300s reach the hub. Consider gating the pull-in itself on _reauthBackoffUntil>Date.now() when _consecutiveReauthFailures>=2: if reauth cannot run, the immediate heartbeat will also fail and re-arm a 60s poke loop with no recovery payoff. (evolver-only, P2.)
- R2: rapid poke recomputes waitMs, but `_lastTickAttemptAt` is read each call from a still-fresh stamp from the just-finished failing tick. Sequence: tick finishes at T0, fails, _lastTickAttemptAt=T0. _scheduleNextTick(finalDelay, "tick-finally") sets _nextTickAt=T0+30min (deep backoff math). Poke at T0+1s: waitMs=59s, _nextTickAt - now=29min59s, F11 false, pull-in to T0+60s. Subsequent pokes at T0+2..30s all compute waitMs slightly smaller, _nextTickAt is now T0+60s, F11 evaluates remainingMs<=waitMs (both ~58s) -> return false without rescheduling. Correct, but the equality is timing-dependent; if Date.now() resolution drift causes remainingMs to round up by 1ms past waitMs the timer gets cleared and re-scheduled with no change in fire time. Not a bug, just timer churn under sustained activity. Cheap, ignore.
- R3: pokeHeartbeat at L1304 calls _rescueHungTick UNCONDITIONALLY (no _tickInFlight pre-check). _rescueHungTick is itself guarded at L1190 (`!this._tickInFlight || !this._tickStartedAt`). Fine, just an extra branch on every poke.

No new hub/website coordination items from this review.

## Default-mode supervisor findings (agent 5)

Scope: does `src/gep/heartbeatSupervisor.js` actually rescue a wedged obfuscated `a2aProtocol` heartbeat in default (non-proxy) mode?

Verdict: It rescues the *common* wedge modes (sleep/wake drift, stopped attempts, null stats, latched in-flight gates, cf-storm). It does NOT rescue (a) terminal hub-side disable states beyond emitting a console.warn, (b) a true sync-deadlock inside the obfuscated `stopHeartbeat`, or (c) users whose env has stale `EVOMAP_PROXY=1` while `--loop`/single-run runs without an actual proxy. Worst-case recovery time for default mode is 15 min, not 60s — the PR description's "60s" applies to the drift path and the poke window only.

### Call-site verification
- `--loop`: `index.js:413-433`. Supervisor starts iff NOT `EVOMAP_PROXY=1` AND NOT `A2A_TRANSPORT=mailbox`. Default mode: yes, with `keepAlive: true`. Per-cycle `poke('evolve-cycle')` at `index.js:539-542`.
- Single run: `index.js:743-762`. Same env gate. `keepAlive` defaults to false (intervals unref'd) so the process can still exit after evolve.run() returns. Single `poke('single-run')` at `index.js:759-762`.
- webui: `index.js:1679-1707`. Probes `proxy/status`; supervisor starts iff probe fails. Per-request `poke('webui-request')` at `index.js:1716-1719`.
- Proxy/mailbox mode: lifecycle manager owns heartbeat (`src/proxy/lifecycle/manager.js:927`); supervisor not used.

### Obfuscation status
`src/gep/a2aProtocol.js` is fully obfuscated (407KB minified, `_0x4262` indirection table — see `head -c 500`). All five greps for `sendHeartbeat`/`startHeartbeat`/`stopHeartbeat`/`getHeartbeatStats`/`totalSent` return zero. Symbol names referenced by the supervisor cannot be audited from source; the integration test at `test/heartbeatSupervisorIntegration.test.js` is the only verification that the obfuscated module exports them with the expected shape.

### Integration-test coverage
The integration test DOES drive the real module: requires `'../src/gep/a2aProtocol'` (line 87), starts a stub HTTP hub with hello+heartbeat endpoints, observes `a2a.getHeartbeatStats()` directly, and asserts uptimeMs reset across stop+start (lines 161-165). Four tests cover (1) sleep-wake drift recovery + post-restart poke, (2) totalSent reset semantics across stop+start, (3) wedge-path with a 2s threshold override, (4) documentation test that totalSent counts attempts not successes against a 503 hub (lines 417-472).

### Gap inventory (default-mode)

| Gap | Severity | Location | Description | Recommendation |
|---|---|---|---|---|
| **A5-1** | MID | `src/gep/heartbeatSupervisor.js:228-240` | Terminal-diagnostic is `console.warn` only — not written to a file, not surfaced via webui, not emitted as a hub event. A daemon `--loop` running detached (nohup / launchd) will buffer/discard stderr; the user reporting "heartbeat is dead" cannot see it. The very state this exists for (silent-death after idle) is also the state most likely to lose the warning. | Mirror to `paths.cycleProgressPath` sibling (`heartbeat_supervisor_state.json`) with `{terminal_suspected_at, restart_count, last_message}`. Surface in webui status panel and `evolver doctor`. Optionally emit a `support.diagnostic` hub event (best-effort, single shot) so the hub can correlate the client's view with its own `survival_status`. |
| **A5-2** | MID | `index.js:414, 752` | Default-mode supervisor is gated on `EVOMAP_PROXY !== '1' && A2A_TRANSPORT !== 'mailbox'`. A user who exports `EVOMAP_PROXY=1` globally (shellrc) and then runs `evolver --loop` without a proxy daemon gets NO supervisor at all — the heartbeat is owned by nothing. webui has a 500ms HTTP probe (`index.js:1681-1696`) but `--loop` and single-run trust env alone. | Apply the same `getProxyUrl()` + probe pattern at `index.js:413-433` and `index.js:751-757`. If env claims proxy but probe fails, fall back to in-process supervisor and log a warning. |
| **A5-3** | MID | `src/gep/heartbeatSupervisor.js:289-307` | Watchdog at `_livenessTick` start clears stale `_hardRestartInFlight`/`_pokeInFlight` latches, but ONLY runs when `_livenessTick` itself runs. If `_safeStop()` is genuinely synchronous and hangs (the threat model the supervisor admits at lines 78-84), the JS event loop cannot service the next `setInterval` fire — the watchdog is dead weight in that scenario. Documentation acknowledges this, but there is no out-of-band escape hatch (worker_thread health pinger, SIGUSR signal handler, child watchdog process). | Add an `out-of-band` health writer (write `heartbeat_supervisor_state.json` from a small `worker_threads.Worker`, or write timestamp from the obfuscated module's own loop into a file the parent re-reads). `evolver doctor` / an external systemd-style supervisor can then catch a wedged main thread. Lower priority unless production telemetry shows actual sync-hang occurrences. |
| **A5-4** | LOW | `src/gep/heartbeatSupervisor.js:389-411` | The wedge path (totalSent freshness) has worst-case recovery 15 min (`WEDGE_THRESHOLD_MS = 15 * 60 * 1000`). The cf-gate path also runs at most every 15 min after a fired restart (cooldown uses `_wedgeThresholdMs`). PR description's "bounded to ~60s" applies only to drift/poke, not to the wedge. User-facing docs / PR description should be consistent — a user who reports "stayed dead for 12 minutes" is within spec, not a bug. | Either lower `WEDGE_THRESHOLD_MS` to ~5 min (the obfuscated module's documented 30-min backoff cap allows this; the cost is at most 3 extra restarts during a real outage), OR update PR/user docs to advertise "up to 15 min" recovery, not "60s". |
| **A5-5** | LOW | `src/gep/heartbeatSupervisor.js:223-241` | `TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD = 3` with cf-gate cooldown = 15 min means the user-visible "your node may be terminal" warning fires after **~45 min** of stuck-state minimum (3 × 15-min cooldown). For a user who reported "I came back after lunch and it's still dead", lunch was probably ≤45 min. | Trigger the diagnostic also on a single `consecutiveHardRestarts >= 2` if `consecutiveFailures` has stayed >= cf-restart-gate for two consecutive ticks — this gets the user advice in ~16 min rather than ~46 min. Alternatively, surface state to webui/file (A5-1) so the user finds it even if the threshold hasn't fired. |
| **A5-6** | LOW | `src/gep/heartbeatSupervisor.js:170-184` | `_safeStart()` and `_safeStop()` swallow exceptions to `console.warn`. If the obfuscated module's `startHeartbeat` synchronously throws on every call (corrupt state, missing config), the supervisor restart-loops every 15 min logging the same warning. cf-gate accounting still advances and the terminal diagnostic eventually fires — but the underlying loop never recovers. | Have `_hardRestart` track `_safeStart` failure count separately; if it has thrown N times consecutively, escalate to the terminal-diagnostic path immediately (don't wait for cf-gate cooldown × 3). |

### Re-entrancy + deadlock-between-gates trace (Q1, Q3)
- `_hardRestart` (L186-247) sets `_hardRestartInFlight = true` BEFORE `_safeStop()`; resets `_lastObservedSent = -1`, `_lastSuccessfulSendAt = now`, `_pokeInFlight = null`. The `try/finally` releases `_hardRestartInFlight = false` and `_hardRestartStartedAt = 0` even on throw (L243-246).
- cf-gate cooldown (L407-408): `_lastHardRestartAt` is set in `_hardRestart` to `now`. Next cf-gate restart blocked until `now - _lastHardRestartAt > _wedgeThresholdMs`. Cannot tight-loop.
- Wedge-gate vs cf-gate interaction: after `_hardRestart`, the wedge timer is reset (via `_lastSuccessfulSendAt = now`). cf-gate cooldown is also reset. So the two gates do NOT deadlock each other; both fire at most every 15 min on a permanently-failing hub.
- Re-entrancy test (`heartbeatSupervisor.test.js:722-762`) directly monkey-patches `stopHeartbeat` to re-enter `_driftTick` — single-flight gate verified.
- The `try/finally` is verified to clear the latch on exception path by the test at `heartbeatSupervisor.test.js:1111-1147` (synthetic `console.warn` throw inside `_hardRestart`).

### Cross-checked claims
- "stopHeartbeat is synchronous": indirect evidence — supervisor calls without `await` (L180), but `sendHeartbeat` IS awaited (L569-573). Integration test relies on `getHeartbeatStats().uptimeMs` resetting immediately after `_driftTick` (L156-165), implying stop+start complete synchronously before the next assertion. Direct grep impossible due to obfuscation. SEND_TIMEOUT_MS is correctly applied where the call is async (L569-573); not applied to stop/start because they are sync. Pattern is consistent with the comment at L78-84.
- "totalSent counts attempts": verified in integration test `heartbeatSupervisor.test.js:417-472` against a 503 stub hub — totalSent advances. Wedge gate's blind spot to "fast attempts all 503" is real and is the entire justification for the cf-gate companion.
- "supervisor poke path runs unconditionally even when proxy mode active": NO — single-run path at `index.js:752` guards the start() call on env vars but the `poke('single-run')` at `index.js:759-762` runs unconditionally. Because `poke()` short-circuits when `!_started`, this is a no-op in proxy mode — safe but slightly misleading; future maintainers might wire something here assuming the supervisor is up.

### Residual risks needing hub-side support
- **H-A5-α**: getHeartbeatStats() exposes only `{running, uptimeMs, totalSent, totalFailed, consecutiveFailures}`. No `last_response_status`, `last_response_body`, `last_recovery_action_url`. The supervisor cannot tell `503 (transient)` from `403 node_secret_invalid (terminal)` from outside the obfuscated module. To close this gap WITHOUT modifying the obfuscated bundle, the hub could echo `recovery_action.url` and `terminal: true` in **every** heartbeat error response (it already does for `node_secret_invalid` at `/_middleware.js`), and the supervisor could parse via a new `getLastHeartbeatError()` accessor on the obfuscated module — but that requires either de-obfuscating or hub-source-coordination plus a new exported helper.
- **H-A5-β**: the wedge cooldown (15 min) means the worst-case user-perceived "supervisor isn't doing anything visible" window is ~15 min between fires. If the hub returned `Retry-After` for terminal states (H7 from prior agents), the supervisor could read that via a new accessor and shorten the diagnostic threshold dynamically.
- **H-A5-γ**: the terminal diagnostic is `console.warn` only. To make this actually reach the user, the hub could send a one-shot `notify_user` message via the existing hub event stream (`/a2a/events/poll`) carrying `{kind: "node_terminal", recovery_url, reason}`. The proxy mode's EventConsumer would surface this; the **default-mode supervisor has no event consumer at all** (cross-references S1 in prior agent's section). Either start a minimal long-poll EventConsumer in default mode (the option S1 already raised) OR have the supervisor surface the diagnostic via a file (A5-1) and a future `evolver doctor` reads it.



---

## End-to-end verdict (agent 13)

> 范围：把用户主诉「首次启动 + 发心跳 + 闲置一阵 + 之后无论怎么用都死」拆成最可能的事件链，逐环节检查 PR #548 是否真闭合，最后给中文判决。

### 假设排序（按可能性，结合 12 agent 报告交叉判断）

1. **B + F 组合（最可能，~50%）**：macOS lid close / App Nap 让 libuv 监控时钟在闲置期被冻结。wake 后第一次 setTimeout 触发，第一拍 tick 失败（WiFi/DNS 未就绪），`_consecutiveFailures=1` 把 backoff 推到 30min cap。**PR 的关键阀**：drift detector + race-recovery 分支 (`manager.js:1078-1142`)。`DRIFT_CHECK_MS=30s` + `TICK_SUCCESS_STALE_MS=90s`，理论最坏 90-120s 内 poke 一次（**不是 60s，PR 早期文案有口径误差**，F13 已修注释）。但**前提：drift `setInterval` 在 App Nap 下还能 fire**。default 模式 supervisor 已加 `keepAlive` opt-in（F12），lifecycle 还未加（D2，proxy 模式 daemon 风险高）。

2. **secret 轮换误覆盖（~25%）**：第二轮 audit 锁定的真根因——stale env 覆盖 store 已轮换的 secret，触发 `node_secret_invalid` → reauth attempt 2 走 `rotation_requires_current_secret` → `_reauthBackoffUntil` 锁 30min/4h，**所有 poke 在 deepReauthFailure 后保留 backoff**（manager.js:1323-1327）。**PR 已加 manualReset short-circuit**（§8.1）+ `_resolveNodeSecret` env-wins 改为 store-wins，并 emit system inbound。**但**：用户必须在 dashboard 看到 banner 才能恢复——W1 未落地前用户看不到信号。

3. **D（obfuscated 心跳循环静默停跑，~10%）**：PR 加了 `heartbeatSupervisor`（外部看门狗），通过 `totalSent` freshness + cf 阈值 + null-stats 阈值 + 单飞门 watchdog 闭合。

4. **E（uncaught exception 杀心跳，~8%）**：F1 修复前 proxy/webui 模式没装 crashGuards；F1 已修，全局 install（`src/ops/crashGuards.js`），但 handler 是 `process.exit(1)`——**依赖外部 supervisor 重启**（systemd/launchd/`evolver --loop` wrapper），裸跑 `node index.js` 会真死。

5. **A（App Nap 节流，~5%）**：D2 + F12 之前 drift `setInterval` 全 `unref()`，App Nap 下被合并/抑制。F12 给 supervisor 加了 `keepAlive`，**lifecycle drift 还没加**（D2 P2 待办）。

6. **C（网络抖动，~2%）**：sync engine + eventConsumer 指数退避都闭合，无遗留。

### 关键链条逐环节检查

| 链条 | PR 闭合 | 时长 |
|---|---|---|
| HTTP 请求到达 proxy → poke | ✅ `proxy/server/http.js:176` | <1s |
| webui 请求 → poke | ✅ F5 修复（端口探测 500ms） | <1s |
| evolve cycle → poke | ✅ `index.js:540` | <1s |
| EventConsumer poll round-trip → poke | ✅（proxy 模式）；default 模式未接 | ≤50s |
| drift detector wake | ✅，但 lifecycle 缺 keepAlive | 90-120s |
| reauth hung → 退避 | ✅ F3 修复 watchdog 分支 | 60s |
| terminal `node_secret_invalid` → manualReset emit | ✅ §8.1 short-circuit | 1 tick |
| crash → 进程退出后重启 | ✅ F1（前提：外部有 supervisor） | 取决于 launchd/systemd |

### 中文最终判决

**1. 这次 PR 是否真的解决了你的问题？**

**部分解决**。最确定能解决的场景是「Proxy 模式 + 用户从 IDE/Cursor/Claude Code/curl 等任意客户端打到 proxy 端口」——HTTP 请求触发 poke，一拍内恢复。最不确定的场景是「lid 关上、电脑睡 1 小时以上、wake 后什么都不动」——drift detector 在理论上 90-120s 内能救回来，但**lifecycle 的 drift `setInterval` 仍 `unref()`**（D2 待办），App Nap 期间可能被 OS 合并。

**2. 在什么前提下「真解决」成立？**

- 你跑的是 **proxy 模式**（`EVOMAP_PROXY=1` 或 `A2A_TRANSPORT=mailbox`），不是 default `--loop` 模式
- wake 后**会主动用 evolver**（一次 HTTP/CLI 请求即可），而不是 wake 后继续闲置等它自愈
- 你的 secret 没有发生 stale env 覆盖 store 的情况（如果有，需要去 dashboard 点 Reset Secret，**W1 未上线之前你看不到这个 banner**）
- 你部署在有外部 process supervisor 的环境（macOS launchd `KeepAlive=true` 或 systemd `Restart=on-failure`），裸跑 `node index.js` 进程崩溃后不会自起

**3. 最大残留风险路径（按严重度排序）**

1. **Default 模式 (`evolver --loop` 非 proxy) + 长睡眠**：EventConsumer 没接 default 模式（§六.4），只有 supervisor `setInterval` 保底；F12 给 supervisor 加了 `keepAlive` 但 lifecycle 还没（D2）。proxy 模式 daemon 长跑也踩这条。
2. **secret 轮换 deep reauth backoff (≥2 次失败 → 30min-4h)**：PR 加了 manualReset short-circuit，但 W1（dashboard banner）未落地前用户看不到任何信号，体感就是「死了无法恢复」。R1（pulled-in tick 仍每 60s 打 `/a2a/heartbeat`）期间 hub 可能 429，但不会更糟。
3. **跨进程**：`evolver --loop` daemon 收不到另一终端 `evolver run` 的活动信号（H1 user_activity_poke 未落地）。
4. **`/a2a/events/poll` 与 heartbeat 共享 `badsec:` 缓存**（§8.1 / H4）：secret 被判 invalid 时 EventConsumer 同时 403，名义上的「独立通道」失效。
5. **crash guards 是 `process.exit(1)`**：必须有外部 supervisor 才能重启，文档（W5）未补。

### 用户合并后手动验证清单（按从易到难）

```sh
# 场景 1：proxy 模式 + 请求触发恢复（最容易复现，最稳）
EVOMAP_PROXY=1 evolver --loop &
sleep 60
curl -i http://127.0.0.1:$(cat ~/.evomap/settings.json | jq -r .proxy.port)/proxy/status
# wait 5+ min idle
sleep 600
curl -i http://127.0.0.1:$(cat ~/.evomap/settings.json | jq -r .proxy.port)/proxy/hub-status
tail -100 ~/.evomap/logs/evolver.log  # 看 [lifecycle] tick 是否 ok

# 场景 2：模拟 OS sleep/wake（drift detector 验证）
EVOMAP_PROXY=1 evolver --loop &
sleep 30
sudo pmset sleepnow                    # macOS 强制睡眠（lid 关也可）
# 唤醒 1h 后
date && tail -50 ~/.evomap/logs/evolver.log | grep -E "drift|wall-clock|pokeHeartbeat"

# 场景 3：default 模式（最容易踩残留风险）
unset EVOMAP_PROXY
evolver --loop &
sleep 300
# lid 关 1h+ → 开 lid → 不主动操作 → 观察 90s 内是否恢复
# 若 90s 内日志无新 [heartbeat] tick → 命中 D2/§六.4 残留风险

# 场景 4：secret 轮换 stale env 路径
# 这步只能模拟：手动把 ~/.evomap/state.json 的 node_secret 改成无效值，重启 daemon
# 期待：60s 内日志出现 manual_secret_reset_required + system inbound 写入
grep -r manual_secret_reset_required ~/.evomap/inbound* 2>/dev/null
```

如果上述 4 个场景都恢复了，PR 对你这台机器有效。如果场景 3 失败（最可能），等 default 模式 EventConsumer + D2 修复。



---

## Cross-process / IPC gap (agent 8)

> Scope: take the user's verbatim complaint ("First boot + heartbeat works. Then I leave it for a while (not using evolver). After that, no matter what I do, evolver is dead.") and map it against the recovery primitives this PR actually ships.

### Most-likely user workflow (reconstructed from index.js)

1. User starts `evolver --loop` (`index.js:250, 281`) or `evolver webui` (`index.js:1658`) in terminal A. Daemon stays resident; `heartbeatSupervisor.start(a2a, { keepAlive: true })` is wired at `index.js:429` (loop) and `index.js:1703` (webui).
2. User walks away. No macOS sleep necessarily — just app idle / backgrounded.
3. Hours later user runs `evolver run` / `fetch` / `sync` / `review` / `solidify` / `distill` in terminal B. Each is a **brand-new process** (`index.js:241 main(); index.js:243 args = process.argv.slice(2)`). None of these commands open a connection to the daemon, write a marker file, or otherwise signal the daemon that the user is alive.
4. User expects the daemon to recover. Daemon's only knowledge of user
is
back is whatever its own `setInterval`s decide to do.

### PR's recovery primitives vs this workflow

| Mechanism | Trigger source | Helps this scenario? |
| --- | --- | --- |
| Drift detector (`heartbeatSupervisor.js:264-281`, `setInterval(driftFn, 30s)` at L483) | setInterval firing inside daemon | Only if setInterval is still firing. macOS App Nap / background throttle on a long-idle Node process can coalesce timers into minutes; nothing in the PR is non-setInterval (see line 483-484). No timer-fire watchdog tracks did
_driftTick
actually
run
when
expected. |
| `totalSent` 15-min wedge (`heartbeatSupervisor.js:389-392`) | `_livenessTick` setInterval @ 60s | Same setInterval dependency. Co-dies with drift detector. |
| `consecutiveFailures` >= 10 gate (`heartbeatSupervisor.js:406-411`) | `_livenessTick` + hub returning errors | Requires the daemon to actually be attempting sends. If the timer is dead, cf never increments. Useless for alive
process,
dead
timer. |
| HTTP poke into lifecycle (`pokeHeartbeat`, proxy mode only) | Inbound HTTP on daemon's port | Terminal-B commands don't know the daemon's port, don't make HTTP requests to it. **Not triggered**. |
| EventConsumer long-poll (`src/proxy/sync/eventConsumer.js`) | async `while` loop, no setInterval | Triggered by hub-side event push or 30s poll completion. **Only wired in proxy / mailbox mode** (`index.js:414-422`). Default `--loop` users do not get it. |

### Concrete failure paths PR #548 still does NOT cover

1. **Node's setInterval got coalesced / throttled by the OS and never recovered.** PR has no `timer freshness watchdog` — no code path records "last _driftTick wall-clock" and compares it to a deadline; the entire supervisor is gated by setInterval (`heartbeatSupervisor.js:483-484`). If the OS pauses timer dispatch, every recovery primitive is silent. This is the literal "alive process, dead heartbeat, no PR mechanism notices" repro.
2. **DNS cache permanently bad.** `_hardRestart` (`heartbeatSupervisor.js:186-247`) calls `_safeStop()` + `_safeStart()` on the obfuscated module only — no `dns.setServers` refresh, no socket pool teardown, no Node process restart. If `dns.lookup` cached a hub IP that is now unreachable, every `_hardRestart` retries against the same broken IP and consecutiveFailures keeps the cf-gate firing forever (now bounded by `TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD=3` * 15-min cooldown = the user only sees a WARN at the ~45-min mark; before that, every reproduction "feels dead").
3. **WiFi disconnect/reconnect.** `grep -nE 'fs.watch|net.createServer|networkInterfaces|os\.networkInterfaces' src/gep/heartbeatSupervisor.js` returns 0. Node has no native "network up" event. The PR does not poll `/etc/resolv.conf` or any link-state marker. On reconnect, the daemon must wait for drift (if still firing), cf-gate (needs failed attempts), or do nothing.
4. **Cross-process `evolver run` activity.** PR body's own admitted limitation. `heartbeatSupervisor.js` has no `fs.watch`, no `net.createServer` (unix socket), no `process.on('SIGUSR2'`), no PID file watcher. Terminal-B commands are completely invisible to the daemon.

### Hub-side terminal-signal capability (for completeness)

Hub already returns `node_status`, `survival_status`, `resend_hello`, `force_update`, `upgrade_available` in every heartbeat response (`evomap-hub/src/services/a2aService.js:6302-6313, 6315-6325, 6362-6376`). `evolver/src/proxy/lifecycle/manager.js:882-905` (commit `21f8837`) reads them in proxy mode. **Default-mode `a2aProtocol.js` (obfuscated) does NOT expose them**: `grep -cE 'node_status|survival_status|resend_hello|force_update|upgrade_available' src/gep/a2aProtocol.js` = 0. So even when the heartbeat does land, default-mode users get no terminal signal — confirming the PR body's second limitation.

### Verdict

PR #548 ships a **defensive bundle** that genuinely fixes adjacent bugs (single-tick exception kills loop, zombie ticks doubling the loop, sleep/wake 30-min backoff). It does **not** address the literal root cause of the user's complaint. The user reported "I leave it alone, it dies, nothing I do brings it back" — every PR recovery mechanism is either:
- gated on setInterval still firing (drift, wedge, cf-gate), or
- gated on hub-bound traffic the dead daemon can't generate (cf-gate, terminal diagnostic), or
- gated on inbound HTTP / mode-specific (lifecycle poke = proxy-only, EventConsumer = proxy-only).

**Most likely remaining failure path**: user runs default-mode `evolver --loop` (no `EVOMAP_PROXY=1`), macOS backgrounds the daemon for 1+ hour, setInterval is coalesced to minute-cadence or rarer, returns and runs `evolver run` in terminal B — daemon never observes terminal-B activity, drift detector may or may not fire (depending on OS throttle aggressiveness; on Sonoma+ Apple Silicon backgrounded Node processes can see setInterval delayed by 60+ seconds), and the user's perception is "it's still dead no matter what I do". The PR's only non-setInterval recovery path (EventConsumer) is locked behind proxy mode the user isn't running.

### Followup proposals (this agent)

| ID | Severity | What | Where |
| --- | --- | --- | --- |
| **X1** | HIGH | **Local IPC poke channel**. Daemon opens `~/.evomap/daemon.sock` (unix socket) in main loop / webui mode. Every short-lived `evolver` subcommand (`run`, `fetch`, `sync`, `review`, `solidify`, `distill`, `atp-complete`, `buy`, `orders`, `verify`, `asset-log`) writes one byte and disconnects. Daemon's accept handler calls `heartbeatSupervisor.poke('cli-activity')`. ~50 lines, evolver-only, no hub coordination. This is the direct fix for the user's complaint. | new `src/gep/daemonIpc.js` + wires in `index.js` main()/loop/webui branches |
| **X2** | HIGH | **EventConsumer in default mode**. Lift `src/proxy/sync/eventConsumer.js` out of proxy-only and start it in the default `--loop` branch (`index.js:423-433`) and webui branch (`index.js:1697-1707`). Needs `getNodeId()`/`getHubNodeSecret()` accessors already exported by `a2aProtocol` (used at `index.js:361-362`). long-poll is setInterval-throttle immune. **Duplicate of S1 in agent-6 notes** — promote to a single P1 ticket. | `src/gep/heartbeatSupervisor.js` start() + `index.js` |
| **X3** | MID | **Timer-fire watchdog**. Stamp `_lastDriftFireAt = Date.now()` at top of `_driftTick`. Add a separate `setTimeout` chain (re-armed after each fire) that asserts `Date.now() - _lastDriftFireAt < 2*DRIFT_CHECK_MS`. On violation: log + force-call `_driftTick({})` immediately. setTimeout can also be throttled but the chain pattern is observably faster to catch up after wake than a fixed setInterval. Belt-and-suspenders for X1/X2. | `src/gep/heartbeatSupervisor.js` |
| **X4** | MID | **Force-refresh DNS on `_hardRestart`**. Add `dns.setServers(dns.getServers())` to `_hardRestart` body to bust the resolver cache. Three lines. | `src/gep/heartbeatSupervisor.js:186-247` |
| **X5** | LOW | **Network-up signal via `fs.watch('/etc/resolv.conf')`** (macOS/Linux). VPN/WiFi switches rewrite the file. On change, `poke('network-up')`. Polyfill needed for Windows but daemon use on Windows is rare. | `src/gep/heartbeatSupervisor.js` |

### Coordination with existing items in this document

- **X1 vs H1**: not duplicates. H1 (`POST /a2a/node/poke`) covers the "user signed into dashboard from another machine" / "cross-device wake" case. X1 covers single-machine local CLI activity (the actual reported scenario). Do BOTH; X1 first because it doesn't require hub work.
- **X2 vs S1**: same proposal under different labels. Merge into one P1 ticket; assign to evolver.
- **X3 / X4 / X5**: pure evolver-side; no hub coordination. X4 is the lowest-effort highest-leverage of the three.



---

## Concurrency + leak findings (agent 12)

Scope: timers/latches/promise leaks in manager.js, heartbeatSupervisor.js, eventConsumer.js that could themselves wedge heartbeat over hours/days.

Verdict: MAJOR ISSUES (1 silent-death bug in eventConsumer, 1 latch-clobber race in supervisor, 1 cf double-bump race in reauth). Other paths reviewed cleanly.

### MAJOR-1 — EventConsumer dies permanently on first deadline abort
File: `src/proxy/sync/eventConsumer.js:173-201`

Repro: hub long-poll exceeds `pollTimeoutMs + FETCH_DEADLINE_PADDING_MS` (60s) without responding (network blip, hub bug, NAT idle drop after the configured deadline). Deadline timer fires `_abortCtrl.abort()`. `fetch` rejects with `AbortError`. L197 `!this._running` is false (consumer is still meant to be running). L201 unconditional `break` exits the `while (this._running)` loop. The `_runPromise.catch()` at L130 only triggers on a thrown loop body — a clean `break` is silent. `_running` stays true, `_runPromise` stays resolved, `start()` early-returns on every future call because `_running` is true. **Consumer is permanently dead with no log line.**

Fix: distinguish stop-driven abort from deadline-driven abort. E.g. track a `_deadlineFired` flag set in the deadline callback, treat that as a transport error (backoff + continue), reserve the bare `break` for `!this._running` (already handled at L197).

```js
// Suggested patch
let deadlineFired = false;
const deadline = setTimeout(() => { deadlineFired = true; try { this._abortCtrl?.abort(); } catch (_e) {} }, deadlineMs);
// ...
if (fetchErr) {
  if (!this._running) break;  // stop() path
  if (fetchErr.name === 'AbortError' && !deadlineFired) break;  // external abort (test)
  // deadlineFired OR generic transport error -> backoff and continue
  ...
}
```

Severity: high. Recreates the exact "silently dies after idle" symptom this PR targets, on the independent-liveness-channel itself.

### MAJOR-2 — `_pokeInFlight` / `_pokeStartedAt` clobbered by stale finally after `_hardRestart`
File: `src/gep/heartbeatSupervisor.js:206-207, 560-587`

Repro:
1. T0: poke#1 begins, IIFE assigned to `_pokeInFlight = P1`, `_pokeStartedAt = T0`, `sendHeartbeat()` awaits forever.
2. T0+5s: `_hardRestart` fires from `_driftTick` (host wake or wedge). L206 sets `_pokeInFlight = null; _pokeStartedAt = 0`.
3. T0+5.1s: throttle window (60s) has not opened. But the SUPERVISOR EXTERNAL `poke()` from eventConsumer.pokeHeartbeat() does NOT enter the supervisor — this is a separate module. So a re-entry would have to come from `index.js` poking. Suppose evolve-cycle ends at T0+65s, calls `heartbeatSupervisor.poke('evolve-cycle')`. Now: `_lastPokeAt = T0`, `now - _lastPokeAt = 65s > POKE_THROTTLE_MS`, gate passes. New poke#2 begins: `_pokeInFlight = P2`, `_pokeStartedAt = T0+65s`.
4. T0+70s: P1's underlying promise finally settles (transport recovered, or `_withTimeout` rejection chain propagates). P1's `.finally` IIFE block (L578-581) runs: `_pokeInFlight = null; _pokeStartedAt = 0`. **Clobbers P2's latch even though P2 is still in flight.**
5. T0+71s: poke#3 enters, gate `_pokeInFlight` is falsy, runs another `sendHeartbeat()` concurrently with P2's still-pending `sendHeartbeat()`. **Two concurrent send-paths against the same node_secret.** Hub may treat one as a duplicate; cadence becomes 2x.

Fix: have the IIFE check identity before clearing. E.g. capture the IIFE's own promise into a local at construction time and only null the slot if `_pokeInFlight === selfRef`:

```js
let selfPromise;
selfPromise = (async function () {
  try { ... } finally {
    if (_pokeInFlight === selfPromise) { _pokeInFlight = null; _pokeStartedAt = 0; }
  }
})();
_pokeInFlight = selfPromise;
_pokeStartedAt = Date.now();
```

Same identity-guard pattern needed in `_hardRestart` at L206 if we want strict invariants.

Severity: medium. Requires `_hardRestart` to fire between two pokes 60s apart AND P1 to outlive P2's start. Concrete after a TLS-hung sendHeartbeat that recovers post-restart.

### MAJOR-3 — `reAuthenticate` watchdog double-bumps `_consecutiveReauthFailures` in tight race
File: `src/proxy/lifecycle/manager.js:527-543, 558-586`

Repro: `run()` reaches L531 (`_consecutiveReauthFailures += 1; _reauthBackoffUntil = ...`) at almost the same instant the watchdog setTimeout fires. `Promise.race([run(), watchdog])` — if `watchdog` rejects first (microtask ordering puts the timer-driven reject ahead of run()'s already-resolved value), the catch path at L560 ALSO bumps `_consecutiveReauthFailures += 1` (L572) and overwrites `_reauthBackoffUntil` (L577) with a new larger backoff because `_consecutiveReauthFailures` is now 2x.

Concretely: run() completed with cf=1 → backoff=30 min. Watchdog catch sees cf=1 already, bumps to cf=2 → backoff=60 min. Two real consecutive failure cycles now look like four; first deep-backoff (4h cap) is reached after 3 real failures instead of 4. Minor exponential acceleration.

Fix: tag run() completion with a flag (e.g. `let runCommitted = false; ... runCommitted = true; return false;` right after L541). In the watchdog catch branch, gate the cf-bump on `!runCommitted`.

Severity: low. Race window is essentially a single tick; concrete effect is one extra step on the backoff ladder. Listed for completeness.

### MINOR-1 — Orphaned `_pokeStartedAt` from no-op poke leaves stale timestamp
File: `src/gep/heartbeatSupervisor.js:560-587`

When `_a2a.sendHeartbeat` is missing (test mode / partial transport stub), the IIFE's body completes synchronously inside `try/finally`. Finally runs as a microtask AFTER the synchronous tail at L587. Final state: `_pokeInFlight = null`, `_pokeStartedAt = Date.now()` (non-zero, dangling). Watchdog short-circuits on `_pokeInFlight` falsy, so no false fire. Next real poke overwrites `_pokeStartedAt`. Cosmetic only.

### Clean

- **manager.js `_tickGeneration`**: comprehensive `_isStaleGen()` guard before every mutation site post-await (L704, L714, L744, L758, L776, L831, L883, L890, L902, L917). Confirmed coverage.
- **manager.js `_heartbeatTimer`**: single setTimeout owner via `_scheduleNextTick`. Cleared at L1213, L1349, L1358 before any replacement. `stopHeartbeatLoop` clears at L1151. No leak path found.
- **manager.js `_driftInterval`**: setInterval, cleared at L1155. unref'd at L1145.
- **manager.js `_inflightAbortController`**: per-tick, identity-guarded clear at L1032. Rescue path nullifies at L1207. No leak.
- **manager.js reauth `watchdogTimer`**: cleared in finally at L597. Promise rejected after clearTimeout has no further effect.
- **eventConsumer `_sleep`**: setTimeout cleared by `_wakeSleep()` on stop. Sequential awaits in `_loop` mean `_sleep` is never called concurrently with itself; no `_wakeSleep` reference leak.
- **eventConsumer deadline timer**: cleared in finally at L193 on every branch.
- **heartbeatSupervisor `_driftInterval` / `_livenessInterval`**: cleared in stop() at L594-595 and `_resetForTesting` at L613-614.
- **heartbeatSupervisor `_consecutiveHardRestarts` / `_consecutiveNullStats`**: scalars, bounded by the recovery branches at L385-388 (cf < threshold ⇒ reset).
- **No unbounded arrays** in any of the three files. Verified by grep `.push(` / array literal accumulation — none on the hot paths.
- **Multiple supervisors active**: confirmed gating is correct.
  - `index.js:413-422` (loop): `if (EVOMAP_PROXY||A2A_TRANSPORT==='mailbox')` starts proxy; ELSE starts heartbeatSupervisor. Mutually exclusive.
  - `index.js:752` (single-run): same env gate, supervisor only when not proxy.
  - `index.js:1697-1707` (webui): probe-based — if proxy HTTP listener responds at `/proxy/status`, supervisor is NOT started. Race exists: webui boots before proxy listener binds → probe fails → supervisor starts alongside proxy.LifecycleManager. Both would emit heartbeats against the same node_secret at independent cadences. Recommend hard env gate (`EVOMAP_PROXY`) instead of, or in addition to, the HTTP probe.

### Recommended priorities

1. **MAJOR-1 (eventConsumer silent death)** — fix this PR. Trivial change. Without it, the "independent liveness channel" can die exactly as the heartbeat it was meant to monitor.
2. **MAJOR-2 (supervisor latch clobber)** — fix this PR. Identity-guard the finally.
3. **MAJOR-3 (reauth double-bump)** — defer. Small exponential acceleration; rare race; safe in practice.
4. **MINOR-1** — defer. Cosmetic.
5. **webui supervisor probe race** — file separate followup. Env gate is the durable fix.

---

## Test-quality findings (agent 9)

审查范围：PR #548 新增 76 个测试是否真正 pin down user-visible「heartbeat permanently dies after idle」行为。审查文件：`test/heartbeatSupervisor.test.js`、`test/heartbeatSupervisorIntegration.test.js`、`test/lifecycleHeartbeatLoopResilience.test.js`、`test/proxyHttpPokesLifecycle.test.js`、`test/proxySyncEngineResilience.test.js`、`test/crashGuards.test.js`、`test/eventConsumer.test.js`。

### 9.A 总体判断

整体质量明显高于「fn.toString test sniffing」基线。Fake `a2a` 严格按 obfuscated 模块语义建模（`totalSent` 只在 `sendHeartbeat` 时 +1，`uptimeMs` 由 `nowFn` 驱动，非 freshness 信号）。`heartbeatSupervisorIntegration.test.js` 真的 `require('../src/gep/a2aProtocol')` 且起一个 `127.0.0.1` HTTP stub hub 观察 `/a2a/hello` 与 `/a2a/heartbeat` 真实 hit（lines 42-71, 84-200）—— 这条 critical 集成路径不是 mock-only，`stop+start` 后 `uptimeMs` 重置作为「真实 obfuscated 模块响应」的行为证据（line 162-165）站得住脚。`onTickReschedule` hook 测试（lifecycle test 84-145）解决了 fn.toString sniff 的脆弱性，hook 与 setTimeout 真实链式回调耦合，验证 >=5 次连续重排可观测。drift wedge 通过注入 `nowFn` 跳钟 + 一个真实 setInterval 的实测（supervisor test 811-851 `realTimer`）也避免了「全部靠手动调 _driftTick」的指控。

但有几处实质性弱项需要 hub 侧或额外集成基建覆盖。

### 9.B 三个最可疑的测试（file:line）

1. **`test/heartbeatSupervisorIntegration.test.js:148-189` —— 「simulated sleep/wake」用 manual `_driftTick()`，不是真实 setInterval fire**
   - 测试自称 real obfuscated module + simulated sleep/wake，但 sleep/wake 通过 `now += 60*60*1000; handles._driftTick();` 同步注入。production `setInterval(_driftTick, 30000)` 路径没有走，所以 obfuscated 模块在 `stop+start` 时是否真在 setInterval reentrancy 下与 module 自身 internal cadence race 未验证。`realTimer` 测试（supervisor test 811）走了真实 setInterval 但只对 fake `a2a`。两者无交集。

2. **`test/heartbeatSupervisor.test.js:722-762` `hardRestart: concurrent drift and liveness ticks do not interleave` —— 测的是同一 stack 的同步重入，不是真正并发**
   - 通过 monkey-patch `stopHeartbeat` 在内部同步调 `handles._driftTick()` 模拟「near-simultaneous」。Node 单线程模型下两条真实 setInterval callback 永远以 macrotask 顺序串行执行，不可能在同一 stack 重入。该测试实测的是 stack-reentrant 是否被 latch 阻止（结论 yes），但 PR 描述的实际 race 是两个 macrotask 排队 —— 那种情况 Node 本来就串行，latch 没有保护作用。测试 sanity-check 与生产 race scenario 不对应。

3. **wedge / drift 测试全部依赖合成时钟，无 fake-timer 或真实 process suspend**
   - `test/heartbeatSupervisor.test.js:201-222`（wedge fire）与 `test/lifecycleHeartbeatLoopResilience.test.js:428-480`（drift detector）全靠注入 `nowFn`/直接 patch `Date.now`。fake-timer fast-forward（Node 22+ `mock.timers.tick`）一次都没用，所有「15 min 已过」都是合成。production 真实 setInterval 在 macOS App Nap suspend 时是否 wake 后补 fire 还是只 fire 一次，没有任何测试验证 —— 而这正是 user-reported bug 的物理触发点。`crashGuards.test.js` 已用 `spawnSync` 子进程模式，但没人写 `kill -STOP/-CONT` 真实 suspend 实验。

### 9.C 「no error thrown」类弱断言列表

下列测试断言「行为不抛」但没有同时断言「恢复确实发生」：

- `test/heartbeatSupervisor.test.js:493-514` errors from start/stop during ticks：只断言不抛，没有断言下一次 tick 仍能 fire 或 latch 被正确释放。
- `test/heartbeatSupervisor.test.js:1111-1147` drift/liveness tick throw inside body：只断言不 escape，没有断言 terminal diagnostic latch 没被错误地标为 fired。
- `test/lifecycleHeartbeatLoopResilience.test.js:1265-1315` drift detector throw from logger.warn：只断言不 escape，未断言 detector 在下一个 tick 仍能 fire 且 pokeHeartbeat 仍被调用。
- `test/proxyHttpPokesLifecycle.test.js:137-146` survives a throwing pokeHeartbeat：只断言 HTTP 200，未断言请求处理逻辑里依赖 lifecycle 状态的部分仍正确执行。
- `test/proxySyncEngineResilience.test.js:49-65` (`installRescheduleStub`)、`test/lifecycleHeartbeatLoopResilience.test.js:160-194` 多处依赖 `src.includes('_scheduleOutbound')` / `src.includes('_tickInFlight')` 来识别 reschedule。若 build pipeline 引入 minify/obfuscate，matcher 失效，chain 跑不满 TARGET 时测试会失败（这点 OK）；但若有人加 OR 兜底，minified 上 silent skip 误判通过。建议全面替换为 `_onTickReschedule` hook 风格（lifecycle test 84-145 已示范）。

### 9.D 真正的覆盖空白（需要 hub 侧或集成测试基建）

- **T1 (P1, evolver+hub coordination)** — **没有真实 macOS suspend/resume 测试**。`crashGuards.test.js` 已展示 `spawnSync` 子进程模式可用。建议加一个 OPT-IN（CI 跳过、本地 macOS only）测试：spawn evolver 子进程 → 等 hello 完成 → `kill -STOP pid` → 真实 sleep 5min → `kill -CONT pid` → 观察 hub stub 端在 30s 内收到 wake 后的第一条 heartbeat。这是 user-visible bug 唯一真实 end-to-end 复现路径。需 hub stub 配合精确时间戳。
- **T2 (P1, hub coordination)** — **`heartbeatSupervisorIntegration.test.js` stub hub 永远返回 200**。无法回答「hub 503 风暴 + 15min 后 wedge fire 后真实 obfuscated 模块是否恢复」。建议加 integration test：stub hub 前 20 min 全 503，第 21 分钟切 200，断言 `totalSent` 在 60s 内推进（证明 wedge 路径在真实模块上恢复有效）。第 20 分钟时段需 fake-timer 推进。
- **T3 (P2, hub coordination)** — **`A2A_NODE_SECRET` rotation 路径未集成测**。`integration` test 只跑 happy hello（line 52-54 stub 返回固定 `node_secret`），未测「hub-side rotate secret 后 wake → supervisor restart → store 是否真正更新本地 secret」。该路径正是 commit `8dab697` 修的 secret-rotation auth-loop trap，目前仅单元 mock 验证，未端到端。
- **T4 (P2, evolver+hub)** — **`eventConsumer.test.js` 完全 mock fetch，没跑到真实 long-poll HTTP/2 keep-alive 路径**。建议用 real `http.createServer` + 真实 `fetch` 的测试，模拟 hub 慢响应（25s timeout 边界）下 abort 是否真能切断 socket。fetchImpl 注入的 mock signal 与真实 socket abort 的内核行为不同。
- **T5 (P2, evolver-only)** — **`fake-timer` 完全未使用**。Node 22+ 支持 `mock.timers.enable({apis:['setInterval']})` + `mock.timers.tick(900000)`，可不污染 wall-clock 推进 setInterval 验证 15-min wedge fire。建议把至少 wedge/drift 测试改为真实 fake-timer + 真实 `setInterval`，闭合「process suspend 期间 setInterval 行为」与 wedge 在真实 timer 上的实测空白。
- **T6 (P3, evolver-only)** — **没有 chaos test 验证 `_pokeInFlight` + `_hardRestartInFlight` watchdog 在 latch 反复 stuck/clear 的稳定性**。当前 E6/E7 各跑 1 次。建议 fuzz：1000 次随机交错 `_setLatchForTesting` + `_livenessTick`，断言无 latch 永久泄漏、无 double-clear、无 startedAt 漂移。

### 9.E Verdict

PR #548 的 76 个测试**部分** pin down 用户主诉。已经稳健覆盖：loop-reschedule 存活（multi-tick chain）、stale-gen zombie 不污染 state、hung-fetch watchdog、cf-gate cooldown、null-stats 计数器、E6/E7 latch watchdog 单次行为。未稳健覆盖：真实 OS suspend/resume、真实 setInterval 在 wall-clock 跳变时的 fire 行为、hub 503 风暴 + wedge 在真实 obfuscated 模块上的恢复、secret-rotation 端到端、minified build 下 toString matcher 失效后的回归。

具体建议：将 T1/T2/T5 列为合并前 blocker，T3/T4/T6 列为 P2 follow-up。

---

## Reauth / secret-rotation findings (agent 11)

Verdict: **reauth state machine itself has no remaining in-process "permanent latch" trap, but the deep-backoff escape hatch contradicts the PR's "no matter what I do" framing.** Watchdog + generation guards close the in-process wedge cleanly; the user-visible trap that survives is "daemon is in 30min–4h backoff and the documented recovery (`evolver reset-local-secret`) requires a daemon restart that the user might not do".

### What is sound

1. **Watchdog timer cleared on success.** `manager.js:545-558,596-599`. `watchdogTimer` is registered before `Promise.race`, and the `finally` block unconditionally calls `clearTimeout(watchdogTimer)` then `_reauthInProgress = false`. Both the success path (`run()` resolves first) and the timeout path (`watchdog` rejects first) reach the same `finally`. The watchdog cannot fire after a successful resolve and cannot leave `_reauthInProgress` permanently latched.
2. **`_reauthGeneration` invalidates zombies.** `manager.js:448-449,564,593`. Both the watchdog catch and the unexpected-throw catch bump `_reauthGeneration`, so a hung inner `run()` that resolves later sees `isStale()=true` after every await (`manager.js:461,464,508,527`) and refuses to mutate `_consecutiveReauthFailures` / `_reauthBackoffUntil` / re-emit `manual_secret_reset_required`.
3. **Secret-rotation terminal-rejection short-circuit.** `manager.js:480-499`. `node_secret_invalid` and `rotation_requires_current_secret` both stop after attempt 1, emit `manual_secret_reset_required` inbound, install 30-min backoff. Tests at `test/lifecycleStaleNodeSecret.test.js:339-427` lock this in. The "401 → reauth → hello fails (old secret rejected) → reauth fails → loop" failure shape is correctly collapsed into a single short-circuit + manual-reset event.
4. **`pokeHeartbeat` honors backoff after persistent failures.** `manager.js:1323-1327`. `deepReauthFailure = _consecutiveReauthFailures >= 2` gates the `_reauthBackoffUntil = 0` clear, so user activity cannot wipe backoff after two confirmed deep failures. Defensible.

### Residual traps (ordered by severity)

1. **No in-process escape from deep backoff. `evolver reset-local-secret` REQUIRES daemon restart, and there is no IPC/SIGUSR mechanism to clear `_reauthBackoffUntil` in a running daemon.** `index.js:1798-1849`. The subcommand only mutates `state.json` on disk; `MailboxStore._state` is loaded once at construction (`src/proxy/mailbox/store.js:104,110-113`) and never re-read. The CLI message at `index.js:1847` says "Restart the daemon" only as the closing line. If the user runs `reset-local-secret` and forgets to restart, the daemon keeps its in-memory stale secret AND the 30min–4h backoff. **This is the user-visible "no matter what I do" path that PR #548 claims to close but does not.** Options: (a) make `reset-local-secret` send SIGUSR1 to the running daemon (or POST `/proxy/admin/reset-secret` on the local proxy port) to clear `_reauthBackoffUntil` and `_consecutiveReauthFailures` and reload `_state` from disk; (b) make the CLI message a hard requirement, not a closing footnote.
2. **`resend_hello` is NOT an escape hatch from deep backoff.** `manager.js:882-887`. The flag is set ONLY in `heartbeat()`'s success branch. In deep backoff every heartbeat returns 401/403 → never hits the success branch → hub's `resend_hello` is never consumed. Independently, `eventConsumer.js:212-225` on 401/403 calls `lifecycle.reAuthenticate()`, which immediately returns false at `manager.js:441-446` while `_reauthBackoffUntil` is in the future. The "hub-driven recovery" channel is therefore inert during deep backoff. The PR description's framing of `resend_hello` as a manual escape is only correct when heartbeats already work — i.e., when escape is not needed.
3. **`_consecutiveReauthFailures` is reset only by a successful `reAuthenticate()`** (`manager.js:511`). A successful HEARTBEAT after stale-secret recovery (e.g. zombie hello eventually wrote the new secret to store, next heartbeat succeeds at `manager.js:778`) does NOT decrement the counter. Subsequent reauth attempts therefore start from `consecutiveReauthFailures=N` and immediately compound to deep-backoff (30min/2h/4h) on the next single failure. Cheap fix: clear `_consecutiveReauthFailures = 0` alongside `_consecutiveFailures = 0` at `manager.js:778` (symmetric with the comment at `manager.js:512-517`).
4. **`hello()` has no generation guard** at `manager.js:388-406`. A zombie hello that resolves after the watchdog fires WILL still call `store.setState('node_secret', ...)` and flip `_suppressEnvSecret = true`. The `_reauthGeneration` guard inside `run()` catches the next post-await branch but the writes inside `hello()` have already happened. Usually benign (hub-issued secret is fresh) but if hub rotated again between the hung call and resolve, the zombie overwrites the newer secret with the older one. Capture `myGen` from the outer scope (passed into `hello()`) or wrap the setState calls in an `isStale()` check.
5. **Stale comment at `manager.js:41-42`** says "failing nodes (consecutiveFailures > 0 or active reauth backoff) bypass the throttle". The code at `manager.js:1331` only bypasses throttle when `didRescue` is true. Cosmetic, but in this state machine the comments are load-bearing for the next reader.

### File:line summary

- Watchdog correctness: `src/proxy/lifecycle/manager.js:545-599`
- Terminal-rejection short-circuit: `src/proxy/lifecycle/manager.js:480-499`
- Backoff constants (30-min base, 4-h cap, 2 attempts): `src/proxy/lifecycle/manager.js:31-36`
- Deep-failure poke gate: `src/proxy/lifecycle/manager.js:1323-1327`
- `reset-local-secret` CLI (no IPC, requires restart): `index.js:1798-1849`, `src/proxy/mailbox/store.js:104,110-113`
- `resend_hello` set-site (heartbeat success only): `src/proxy/lifecycle/manager.js:882-887`
- EventConsumer 401 path (backoff-gated): `src/proxy/sync/eventConsumer.js:212-225`
- Missing `_consecutiveReauthFailures = 0` on heartbeat success: `src/proxy/lifecycle/manager.js:778`
- `hello()` lacks generation guard: `src/proxy/lifecycle/manager.js:388-406`



---

## Hub + website coordination required (agent 10)

Scope: this section enumerates every hub-side (`evomap-hub`) and website-side (`evomap-website`) change that is required to fully close the "evolver heartbeat permanently dies after idle period" bug. PR #548 is client-only. The signals it consumes, the recovery paths it relies on, and the user-visible diagnostics it emits all have unfixed counterparts in the other two repos. Each item below is written as a concrete cross-repo spec: file, endpoint/schema, behaviour.

All hub paths quoted are absolute paths in `/Users/jianwei.bao/Desktop/workinginEvoMap/evomap-hub`. All website paths are absolute in `/Users/jianwei.bao/Desktop/workinginEvoMap/evomap-website`.

---

### 1. Coordination map: client-consumed signals vs hub emission sites

| Client signal (evolver consumes) | Hub emission site verified | Status |
| --- | --- | --- |
| `next_heartbeat_ms` (number) | `src/services/a2aService.js:6312` (constant `HEARTBEAT_INTERVAL_MS=300_000`), bumped to `60_000` at `:6513` when `has_pending_events` | EMITTED |
| `resend_hello` (boolean) | `src/services/a2aService.js:6316`, `:6372` (when fingerprint missing or `unknown_version` force-update branch) | EMITTED |
| `force_update` (object: `{ required_version, deadline_ms, reason, update_channels, release_url }`) | `src/services/a2aService.js:6362`, `:6370`; built by `deriveHeartbeatForceUpdate` at `:242` | **EMITTED AS OBJECT — client expects boolean (bug, see G1)** |
| `upgrade_available` (object: `{ current_version, required_version, urgency, blocked_features, ... }`) | `src/services/a2aService.js:6360` and 6+ other sites (line 1012, 1145, 1209, 1267, 1338, 1417, 1622, 1901) | **EMITTED AS OBJECT — client expects boolean (bug, see G1)** |
| `status === "suspended"` | `src/services/a2aService.js:6236-6238` returns `{ status: "suspended", hint }` with HTTP 200 | EMITTED (but see G2: wrong HTTP status) |
| `Retry-After` (header) | `src/middleware/circuitBreaker.js:67`, `src/lib/rateLimitHints.js:40` | EMITTED on 429/503 from circuit-breaker / rate-limit paths only. NOT emitted by the heartbeat handler for non-rate-limit failures. |
| Terminal codes (`node_disabled`, `node_revoked`, `secret_rejected`) | NOT EMITTED — see G3, G4 | **GAP** |
| "Am I alive" probe | NO ENDPOINT EXISTS — see G5 | **GAP** |

`/a2a/events/poll` long-poll: hub exposes `POST /a2a/events/poll` at `src/routes/a2a/protocol.js:179`. Caller-supplied `timeout_ms` is clamped to `[1000, 55000]` (line 194). `pollEvents` in `src/services/agentEventService.js:207` polls the DB every `2000ms` until the deadline. **No TCP keepalive write inside the long poll**; if the connection is silently dropped by a NAT/LB after >55s without data, the client cannot detect it before its own AbortController fires at `pollTimeoutMs + FETCH_DEADLINE_PADDING_MS` (see G7).

---

### G1. force_update / upgrade_available type mismatch (BLOCKING — fix in hub OR client)

**Symptom on user's box:** the PR claims "client now consumes hub-provided force_update / upgrade_available." It does not. The hub emits these as objects, the client checks `data?.force_update === true` / `data?.upgrade_available === true`. The triple-equals strict comparison against `true` fails for any object, so the user-visible warnings (`'[lifecycle] hub requires evolver upgrade ...'` and the upgrade-available info log) NEVER fire even when the hub has emitted them.

**Evidence:**
- Hub emission shape: `src/services/a2aService.js:252-258` (`forceUpdate: { required_version, reason, deadline_ms, update_channels, release_url }`).
- Hub emission shape: `src/services/a2aService.js:248` (`upgrade` comes from `buildUpgradeNotice` — an object with `urgency`, `current_version`, etc.).
- Client check: `evolver/src/proxy/lifecycle/manager.js:889` (`if (data?.force_update === true)`) and `:901` (`if (data?.upgrade_available === true)`).

**Resolution options (one of):**

(a) **Client-side fix (cheaper, recommended)** — change strict `=== true` to truthy check + extract object fields. In `evolver/src/proxy/lifecycle/manager.js`:
```js
if (data?.force_update) { ... use data.force_update.required_version, .deadline_ms ... }
if (data?.upgrade_available) { ... use data.upgrade_available.required_version, .urgency ... }
```

(b) **Hub-side fix** — add a `force_update_required: true` boolean co-emitted with the object, keeping the object as `force_update` for the upgrade-aware UI. This is a strictly additive protocol change. Schema change in `src/schemas/a2a.js` heartbeat response (currently does not declare `force_update`/`upgrade_available` keys).

**Preferred:** (a) — single-line bugfix in evolver. Open follow-up PR.

---

### G2. Heartbeat returns 200 OK for suspended state (HUB FIX)

**Symptom:** when a node is admin-suspended the hub returns `200 OK` with body `{ status: "suspended", hint }` (`src/services/a2aService.js:6236-6238`). The supervisor's `_consecutiveFailures` gate keys off HTTP non-2xx / network errors. A `200 OK { status: "suspended" }` reply does not increment any failure counter and the `totalSent` wedge keeps advancing, so the supervisor never enters the diagnostic restart loop. The client lifecycle DOES branch on `data?.status === 'suspended'` in `manager.js:797` (proxy mode only). Default-mode `a2aProtocol` is obfuscated and the PR confirms it cannot read response bodies.

**Required hub change** in `src/services/a2aService.js` `handleHeartbeat`:
- Return HTTP **403** with body `{ error: "node_suspended", hub_state: "suspended", suspended_reason, suspended_until, recovery_url: "https://evomap.ai/account" }` instead of `200 OK`.
- Also include a `Retry-After` header (suggested 300 seconds) so clients that don't parse the body still back off correctly.
- Keep the prior 200 shape behind `req.headers["x-legacy-suspended-shape"] === "1"` for one release if rollout safety matters.

**Schema change** in `src/schemas/a2a.js`:
- Add `node_suspended` to `publicError.js` (already in `src/lib/publicError.js:99` — present).
- Document the 403 path in the heartbeat OpenAPI section of `src/lib/openApiSpec.js`.

This is the cleanest fix because the heartbeat-supervisor's existing `consecutiveFailures >= CONSECUTIVE_FAILURE_RESTART_THRESHOLD` gate then trips after a few suspended ticks, the terminal-diagnostic warning fires, and the user sees "[Heartbeat] supervisor has restarted ... Check https://evomap.ai/account ... node_secret_invalid ..." in stdout (see G6 for UI surfacing).

---

### G3. Terminal error codes not exposed in heartbeat response body (HUB FIX)

**Symptom:** PR limitation 3 ("`node_disabled` / `node_revoked` are still not auto-detected"). PR says the obfuscated bundle does not expose hub error codes "in plaintext" so client-side detection is impossible. This is half-true — the deeper cause is that the hub never returns these codes in a place the supervisor watches.

What the hub currently does on bad secret (`src/routes/a2a/_middleware.js:531`, `:582`): returns HTTP 403 with `buildInvalidNodeSecretBody(nodeId)` → body `error: "node_secret_invalid"` + `recovery_action: { action: "web_recovery", url: "https://evomap.ai/account" }`. This IS terminal information, but the obfuscated `a2aProtocol.sendHeartbeat` discards the response body before the supervisor wrapper sees it.

**Required hub change — extend HTTP status semantics so the supervisor can detect terminal state by status code alone, no body parsing required:**

| State | Current | Required (hub change) |
| --- | --- | --- |
| `node_secret_invalid` | 403 + body | **410 Gone** + body. Supervisor / fetch wrapper treats 410 as TERMINAL. |
| node admin-suspended | 200 + body (G2) | **403 + Retry-After** (see G2) |
| `survival_status === "dead"` | 200 + body (`updates.survivalStatus = "alive"` resurrects it at `:6252`, so this case is mostly self-healing on heartbeat — but the dashboard-side "node was archived for inactivity" path needs the same 410) | **410 Gone** during the archived state, then 201 on first successful re-hello |
| `node_revoked` (admin force-revoke) | not currently a node state | New status enum value; emit 410 |
| Force-update version block | 426 + body (`src/routes/a2a/_middleware.js:685`, `:723`) | KEEP 426 — supervisor can already treat 426 as upgrade-required |

**Why 410 specifically:** RFC 9110 §15.5.10 says 410 is "permanently removed, no forwarding address known"; semantically aligned with "we don't recognise your secret, go re-auth via web." Critically, 410 is in the 4xx class so it bumps the heartbeat supervisor's `consecutiveFailures` AND is structurally distinct from 401/403 (which the client might retry with the same credentials).

**File touchpoints in hub:**
- `src/routes/a2a/_middleware.js:531`, `:582` — change `res.status(403)` to `res.status(410)` for `node_secret_invalid`. Keep 403 for `auth_scope_mismatch` (G2 also uses 403 for `node_suspended`).
- `src/routes/a2a/protocol.js:145` heartbeat handler — emit 410 if `handleHeartbeat` returns `{ status: "unknown_node" }` (currently emits 200).

**Required client change after hub ships:**
- `evolver/src/proxy/lifecycle/manager.js` — on `res.status === 410`, emit a one-shot terminal warning + raise the WallcLock backoff to e.g. 6 hours (terminal isn't really transient).
- `evolver/src/gep/heartbeatSupervisor.js` — supervisor can ask the unobfuscated default-mode HTTP wrapper to expose `lastStatus`/`lastBody` to the supervisor (the wrapper can do this even though the loop itself is obfuscated). Add a callback `onHeartbeatStatus(httpStatus)` invoked by whatever wraps `fetch` in the obfuscated bundle's HTTP layer. If wrapping `fetch` itself is not feasible, ship a thin shim at `src/gep/a2aTransport.js` that the obfuscated bundle imports.

---

### G4. EventConsumer long-poll has no in-band keepalive (HUB FIX)

**What the PR adds:** `evolver/src/proxy/sync/eventConsumer.js` long-polls `POST /a2a/events/poll` at hub-side `timeout_ms=30000` (default; clamped 1000-55000 hub-side at `protocol.js:194`). The client sets its own AbortController deadline at `pollTimeoutMs + FETCH_DEADLINE_PADDING_MS` (see `eventConsumer.js:172-175`).

**Failure mode:** NAT/proxy idle drop on a TCP connection with zero bytes in flight for >30-60s is a real production hazard. Hub's `pollEvents` in `src/services/agentEventService.js:207-230` does `await new Promise(setTimeout, 2000)` between DB polls — the entire HTTP response is silent until the deadline or until an event arrives. If the NAT silently kills the socket mid-poll, the client only finds out at AbortController deadline (~35s) — adds 30s to recovery in the worst case. Survivable but not great.

**Required hub change** in `src/services/agentEventService.js:207`:
- Stream a `chunked` response with periodic empty JSON keepalive frames OR (preferred) write a partial JSON line like `{"keepalive":true,"ts":...}\n` every 15s. The hub SSE stream at `src/routes/a2a/agentInfra.js:499-501` already does `: keepalive\n\n` every 15s — copy that pattern.
- Alternative: switch the consumer from JSON-body long-poll to the existing SSE stream at `GET /a2a/events/stream` (`src/routes/a2a/agentInfra.js:479`). SSE already has the 15s keepalive and a `max_duration` cap of 5 minutes (line 503-506). Downside: SSE-stream is gated by `requireFeatureVersion("sse_event_stream")` so feature-version floor must be reachable.

**If the hub long-poll itself hangs forever** (e.g. hub stops the keepalive but holds the TCP socket): the client's `pollTimeoutMs + FETCH_DEADLINE_PADDING_MS` AbortController is the only safety net. After abort, the EventConsumer's `_backoffMs` doubles up to `MAX_BACKOFF_MS` and retries. This is OK as a backstop but adds noise. Hub keepalive is the proper fix.

---

### G5. "Am I alive?" status-query endpoint does not exist (HUB FIX)

**PR limitation 4** says "No hub-side 'am I alive?' query. All recovery is client-side. If the hub considers this node dead, the client cannot learn that and will retry indefinitely."

**Audit of hub routes** in `src/routes/a2a/protocol.js` and adjacent `src/routes/a2a/*.js`: no GET endpoint returns the hub's view of a node's `status` / `survivalStatus` / `lastSeenAt` to the node itself (without authenticated session). The closest existing equivalents are:
- `POST /a2a/heartbeat` — has the data, but it has side effects (touches `lastSeenAt`, recovers dormant→active in `a2aService.js:6248-6253`, increments rate-limit counters via `rateLimit({ keyPrefix: "a2a_heartbeat", limit: 6, windowMs: 300_000 })` at `protocol.js:149`).
- `GET /account/agents` — requires session auth (`src/routes/account.js:92`), not node_secret auth.

**Required hub endpoint:**

```
GET /a2a/node/self
Headers: Authorization: Bearer <node_secret>
Sender-ID: <node_id>
```

**Response (200):**
```json
{
  "node_id": "...",
  "status": "active" | "suspended" | "dormant" | "archived",
  "survival_status": "alive" | "dormant" | "dead",
  "last_seen_at": "2026-05-28T..",
  "hub_considers_alive": true,
  "online_threshold_ms": 900000,
  "next_heartbeat_ms": 300000,
  "force_update_required": false,
  "force_update": { "required_version": "...", "release_url": "..." } | null
}
```

**Response on terminal state:**
- 410 Gone if secret invalid (same shape as G3)
- 403 + Retry-After if suspended

**Why this is essential:** the PR's whole defensive posture (drift-detector, wedge, consecutive-failures gate, terminal diagnostic) is "guess from the absence of progress." With `GET /a2a/node/self` the client can ASK after `_hardRestart` doesn't help, distinguish "hub thinks I'm fine, my code is buggy" from "hub never wants to hear from me again," and emit a precise user message instead of the current "may indicate the hub considers this node terminal" hedge.

**Side benefits:**
- Rate limit at e.g. `{ limit: 30, windowMs: 60_000 }` — far cheaper than heartbeat's full enrichment.
- Read-only (no DB writes), no `lastSeenAt` touch — safe to call any time.
- Lifecycle no-op: the supervisor can call this after `TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD` restarts and refine the diagnostic message ("hub says you are suspended" vs "hub last saw you 4 days ago").

**File location:** add `router.get("/node/self", captureNodeSecret, requireNodeSecret, rateLimit({...}), safeHandler(...))` in `src/routes/a2a/protocol.js` after the existing `/events/poll` route.

---

### G6. UI surfacing: user will not see the supervisor diagnostic (WEBSITE FIX)

**PR-emitted warning:** `evolver/src/gep/heartbeatSupervisor.js:228-240` prints to `console.warn` after 3 stuck restarts, telling the user to check `https://evomap.ai/account`. Three problems:

1. Most users running `evolver --loop` in a background terminal don't tail stdout. The warning will be missed.
2. When the user DOES check `https://evomap.ai/account`, the website does not show suspended state for owned nodes. Verified in:
   - `evomap-website/src/features/agents/utils/formatNode.js:47-53` (`getNodeStatusKey`): handles only `archived` / `dormant` / `merging` / `online` / `offline`. **Suspended is not a render path.**
   - `evomap-website/src/features/agents/constants.js:1-12` (`STATUS_STYLES`): no `suspended` style. A suspended node from hub would either render as "offline" (the fallback) or as the literal `status` value with no styling.
   - `evomap-website/src/features/agents/components/node/NodeCard.jsx:84` only renders `NodeStatusBadge`; no separate banner for "your node needs reauth" / "secret rejected" / "force_update required."
3. The hub's `node_secret_invalid` recovery action (`buildInvalidNodeSecretBody` at `_middleware.js:62-73`) tells the user to "click 'Reset Secret'" — the button exists at `NodeCard.jsx:112` (`rotateSecret`) but there is no contextual hint pointing users to it from a "your node is unhealthy" banner.

**Required website changes:**

- **A. Extend `getNodeStatusKey` in `formatNode.js`:** add `suspended` branch returning `"suspended"`. Map non-self-recovering survival states too (`survival_status === "dead"` → `"dead"`).

- **B. Extend `STATUS_STYLES` in `constants.js`:** add entries:
  ```js
  suspended: { bg: "bg-red-500/15", text: "text-red-400", dot: "bg-red-400 animate-pulse" },
  dead:      { bg: "bg-rose-500/20", text: "text-rose-500", dot: "bg-rose-500" },
  needs_reauth: { bg: "bg-amber-500/20", text: "text-amber-500", dot: "bg-amber-500 animate-pulse" }
  ```
  Translation keys: `accountAgents.fields.suspended`, `.dead`, `.needsReauth`.

- **C. Add a "node health" banner on `NodeCard.jsx`:** when `node.status === "suspended"` or `node.survival_status === "dead"` or (when G5 ships) `node.hub_considers_alive === false`, render a red-bordered call-out above the action row with:
  - Clear English explanation of the state
  - Direct CTA: "Reset secret" (existing button), "Restart your evolver", or "Contact support"
  - Link to release notes if `force_update_required`

- **D. New hub endpoint for the website to call** — `GET /account/agents/:nodeId/health`. Returns the same payload as G5's `/a2a/node/self` plus `force_update` derived from current `EVOLVER_FORCE_UPDATE_VERSION`. This is the data source the banner reads from.

- **E. Toast on rotate-secret success** at `NodeCard.jsx:55` already exists. After G3 ships and the client treats 410 as terminal, instruct users via the same banner: "If you just rotated your secret, restart your evolver to pick it up." (Without this hint the rotated secret sits in the website while the evolver retries with the old secret until G3's 410 kicks in.)

---

### G7. Operational gap: "is my evolver healthy?" has no notification channel

PR's CLI diagnostic ("after 3 restarts, log warn") is for an interactive user. Users with `evolver --loop` running as launchd / systemd / a tmux pane will not see it.

**Required:**

- **Website push** — when a node owned by user X has not heartbeat'd for `ONLINE_THRESHOLD_MS` (15min from `a2aService.js:81`), send the user an email / in-app notification. Hook into the existing notification system (search `evomap-website/src` for `useNotifications`, `notifications/` — out of scope to spec exactly but the hub-side cron at `src/services/nodeLifecycleService.js:18` already runs the classification, so adding a `notifyOwner` side-effect there is the right place).
- **Webhook** — `webhookUrl` already exists on the `a2ANode` model (referenced in `nodeLifecycleService.js:47`, `:61`). When `survivalStatus` transitions to `dead`, hub fires a POST. Pre-existing infrastructure; verify it covers the transition and not just creation.

Lower priority than G1-G6. Track but don't block.

---

### Priority ranking (for cross-repo coordination)

| Priority | Gap | Owner repo | Effort |
| --- | --- | --- | --- |
| P0 BLOCKING | G1: force_update/upgrade_available type mismatch | evolver (1-line fix) | trivial |
| P0 | G2: heartbeat 200-OK suspended → 403 + Retry-After | evomap-hub | small |
| P0 | G3: terminal codes via HTTP 410 | evomap-hub + evolver | medium |
| P1 | G5: GET /a2a/node/self status-query | evomap-hub | small |
| P1 | G6.A-C: website suspended/dead/needs_reauth badges | evomap-website | small |
| P2 | G6.D: GET /account/agents/:nodeId/health | evomap-hub + evomap-website | medium |
| P2 | G4: long-poll keepalive frames | evomap-hub | trivial |
| P3 | G7: owner-notification on node-dead | evomap-hub + evomap-website | medium |

---

### Quick verification checklist (after hub + website ship)

- [ ] `curl -X POST .../a2a/heartbeat` on a suspended node returns `403` + `Retry-After: 300` + body `{ error: "node_suspended" }`
- [ ] `curl -X POST .../a2a/heartbeat` with wrong secret returns `410` (not 403)
- [ ] `curl -X GET .../a2a/node/self` with valid node_secret returns the new health payload
- [ ] `/account/agents` page renders a red "Suspended" badge + banner for a hub-suspended node
- [ ] `evolver --loop` against a hub-suspended node fires `_hardRestart` 3x within `CONSECUTIVE_FAILURE_RESTART_THRESHOLD × WEDGE_THRESHOLD_MS`, emits terminal diagnostic, and the user lands on `https://evomap.ai/account` to a clear "Suspended — click here" affordance
- [ ] `evolver --loop` against a node whose secret was rotated via the website detects 410, emits a one-shot terminal diagnostic, and stops the tight reauth loop

### Evidence pointers

- Hub heartbeat handler: `evomap-hub/src/routes/a2a/protocol.js:145`
- Hub heartbeat business logic: `evomap-hub/src/services/a2aService.js:6210` (`handleHeartbeat`)
- Hub suspended branch: `evomap-hub/src/services/a2aService.js:6236-6238`
- Hub force_update emission: `evomap-hub/src/services/a2aService.js:6360-6380`, `deriveHeartbeatForceUpdate` at `:242-272`
- Hub events long-poll: `evomap-hub/src/routes/a2a/protocol.js:179`, service `evomap-hub/src/services/agentEventService.js:207`
- Hub SSE event stream (alternative): `evomap-hub/src/routes/a2a/agentInfra.js:479-535`
- Hub invalid-secret response: `evomap-hub/src/routes/a2a/_middleware.js:62-74`, used at `:531`, `:582`
- Hub node lifecycle cron: `evomap-hub/src/services/nodeLifecycleService.js`
- Client lifecycle suspended branch: `evolver/src/proxy/lifecycle/manager.js:797-813`
- Client lifecycle force_update branch (bugged): `evolver/src/proxy/lifecycle/manager.js:889-910`
- Client EventConsumer: `evolver/src/proxy/sync/eventConsumer.js`
- Client supervisor terminal diagnostic: `evolver/src/gep/heartbeatSupervisor.js:212-241`
- Website status key derivation: `evomap-website/src/features/agents/utils/formatNode.js:47-53`
- Website status styles: `evomap-website/src/features/agents/constants.js:1-12`
- Website NodeCard: `evomap-website/src/features/agents/components/node/NodeCard.jsx`

---

## 十、第三轮 12-agent 审查的直接修复（已在本仓内落地，2026-05-28）

下面这一节由 Claude（用户委托）在 12-agent 审查的结论上直接修复完成，所有改动都已经写入代码并跑过测试（166/166 绿）。这一节是「事后清单」，不是待办。剩余的待办依然在第一到九章里跟踪。

| ID | 修复 | 文件 | 测试 |
|---|---|---|---|
| MAJOR-1 | EventConsumer 的 deadline-fired AbortError 不再 `break` 退出 while loop —— 通过 `deadlineFired` 标志区分 stop()-driven vs deadline-driven abort，前者退出，后者重连 | `src/proxy/sync/eventConsumer.js` | `test/eventConsumerDeadlineRetry.test.js`（2 tests） |
| MAJOR-2 | heartbeatSupervisor poke 的 finally 加身份保护 —— 通过 `_pokeGeneration` 计数器；`_hardRestart` 和 `stop()` 都 bump generation，IIFE finally 只在 generation 匹配时清 latch | `src/gep/heartbeatSupervisor.js` | `test/heartbeatSupervisorPokeGen.test.js`（2 tests） |
| TG-2 | `startHeartbeatLoop` 不再把 `_tickGeneration` 重置为 0；改为 +1_000_000 增量，确保跨 stop/start 边界严格单调递增 | `src/proxy/lifecycle/manager.js` | `test/lifecycleThirdPassFixes.test.js`（2 tests） |
| G1 | `force_update` 和 `upgrade_available` 改为 truthy 检查；hub 端 `a2aService.js:6360-6362` 发的是对象，原来 `=== true` 是 dead code。`resend_hello` 保持 `=== true` 严格（hub 那边发的是字面 boolean） | `src/proxy/lifecycle/manager.js` | `test/lifecycleThirdPassFixes.test.js`（5 tests）+ 既有 E4 测试已更新 |
| D2 | `startHeartbeatLoop(intervalMs, { keepAlive })` 暴露 keepAlive 选项；proxy daemon 启动时传 `keepAlive: true`，drift detector 不再 `unref()`，App Nap 不再能把它降级 | `src/proxy/lifecycle/manager.js`、`src/proxy/index.js` | `test/lifecycleThirdPassFixes.test.js`（2 tests） |
| X1 | **跨进程 IPC poke 通道** —— 闭合用户原投诉的最大缺口：A 终端 `evolver --loop` 闲置，B 终端跑任意 `evolver <cmd>`，B 通过 `~/.evomap/poke.sock` 戳醒 A 的 heartbeat。Daemon 侧在 `--loop` (proxy + default) 和 `webui` 三处启动 server；CLI 侧在 main() 顶部对所有非 daemon-starting 命令发 best-effort poke。Stale socket 自动回收；live socket 不覆盖；macOS / Linux 支持，Windows 跳过 | `src/ops/localPokeSocket.js`（新）、`index.js`（4 处 wire-up） | `test/localPokeSocket.test.js`（5 tests） |

### 本轮没修的（明确不在 evolver 仓内可解的）

下列项目依然待办，因为它们要 hub 或 website 配合。详见第二章「Hub 侧需要做的事」和第十章 agent 10 输出：

- **G2** hub 把 `status: "suspended"` 从 200 OK 改成 403 + Retry-After
- **G3** hub 终端错误码用 410 Gone 返回（让混淆 bundle 通过 status code 识别）
- **G5** hub 新增 `GET /a2a/node/self` 探活接口
- **G6** website 的 NodeCard 加 `suspended` / `needs_reauth` 红色 banner
- **X3** Node 进程内 "timer 实际是否 fire" 的 watchdog（影响有限，App Nap 已通过 D2 keepAlive 缓解大部分）
- **X4** `_hardRestart` 时刷 DNS / 销毁 HTTP agent（小杠杆，DNS 永久毒化场景罕见）

### 用户验证清单

合并这一轮修复后，用户应按下面顺序复现，确认核心问题已闭合：

```bash
# 1. 跨终端 poke（PR 主修目标）—— 应通过
evolver --loop &                                # 终端 A
sleep 600                                       # 让 A 进入闲置
ls ~/.evomap/poke.sock                          # 应该存在
evolver fetch                                   # 终端 B —— 这一下应该把 A 戳醒
tail -f ~/.evomap/mailbox/*.log | grep ipc-     # A 应该出现 "ipc-fetch" tag

# 2. macOS sleep/wake（D2 + 既有 drift detector）
EVOMAP_PROXY=1 evolver --loop &
pmset sleepnow
# 等 5 分钟后唤醒；60-120s 内应有 /a2a/heartbeat 触发

# 3. hub 端 force_update 真的能被 evolver 看到了（G1）
# 假设 hub admin 给该节点开启了 force_update，下一次 heartbeat 后
# evolver 的 stderr 必须 WARN 一行带 hub 提供的 message 和 url

# 4. EventConsumer 在 NAT 长闲置下不死（MAJOR-1）
# 不容易手工复现；测试 test/eventConsumerDeadlineRetry.test.js 等价于此场景
```

### 测试结果

```
PR-touched + 新增 = 166/166 绿（0 fail, 0 skip）
覆盖文件：
  test/eventConsumer.test.js
  test/heartbeatSupervisor.test.js
  test/heartbeatSupervisorIntegration.test.js（真混淆 bundle）
  test/lifecycleHeartbeatLoopResilience.test.js
  test/lifecycleStaleNodeSecret.test.js
  test/proxyHttpPokesLifecycle.test.js
  test/proxySyncEngineResilience.test.js
  test/crashGuards.test.js
  test/webuiServer.test.js
  test/eventConsumerDeadlineRetry.test.js（新）
  test/heartbeatSupervisorPokeGen.test.js（新）
  test/localPokeSocket.test.js（新）
  test/lifecycleThirdPassFixes.test.js（新）
```
